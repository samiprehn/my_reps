// Cloudflare Worker for samiprehn.github.io/my_reps/ and /ready-set-vote/.
//
//   GET /?address=3109 S Fernwood Ave, Sioux Falls, SD 57110
//     CORS proxy for the US Census onelineaddress geocoder (it sends no CORS headers).
//   GET /bills?bioguide=P000608
//     Sponsored legislation from the Congress.gov API.
//   GET /votes?chamber=house&bioguide=P000608
//   GET /votes?chamber=senate&lis=S427
//     A member's 20 most recent roll-call votes (House via Congress.gov, Senate via senate.gov XML).
//
// Secret: CONGRESS_API_KEY (api.data.gov key for Congress.gov), set in the Cloudflare dashboard.

const UPSTREAM = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';

// Only let the app's own site use this proxy from a browser, so it can't be
// reused as a free general-purpose geocoder. (Origin is spoofable by non-browser
// clients; the Census API is free/keyless so the only risk is Worker quota.)
const ALLOWED_ORIGINS = [
  'https://samiprehn.github.io',
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.some((o) =>
    typeof o === 'string' ? origin === o : o.test(origin)
  );
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(status, body, request, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request), ...extraHeaders },
  });
}

const CONGRESS_API = 'https://api.congress.gov/v3';
const UA = { 'User-Agent': 'my-reps (https://github.com/samiprehn/my_reps)' };
const VOTE_COUNT = 20;

// Best-effort per-isolate cache (the Cache API is a no-op on *.workers.dev).
// Past roll calls never change, so those are kept for the isolate's lifetime.
const memo = new Map();
async function cached(key, ttlMs, load) {
  const hit = memo.get(key);
  if (hit && (hit.expires === Infinity || hit.expires > Date.now())) return hit.value;
  const value = await load();
  memo.set(key, { value, expires: ttlMs === Infinity ? Infinity : Date.now() + ttlMs });
  return value;
}
const HOUR = 60 * 60 * 1000;

async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.text();
}
const congressUrl = (path, env, params = '') =>
  `${CONGRESS_API}${path}?format=json&api_key=${env.CONGRESS_API_KEY}${params}`;

// Congress number + session for a year (sessions start Jan 3 of each year)
function currentSessions() {
  const now = new Date();
  const year = now.getUTCFullYear() - (now.getUTCMonth() === 0 && now.getUTCDate() < 3 ? 1 : 0);
  const cur = { congress: Math.floor((year - 1789) / 2) + 1, session: year % 2 ? 1 : 2, year };
  const prev = cur.session === 2
    ? { congress: cur.congress, session: 1, year: year - 1 }
    : { congress: cur.congress - 1, session: 2, year: year - 1 };
  return [cur, prev];
}

// Did the member vote with the winning side? Uses the result, not the tally, since
// cloture/veto overrides/amendments can fail with a majority. null for Present/Not Voting.
function withWinner(cast, result, yeas, nays) {
  const yes = cast === 'Yea' || cast === 'Aye' || cast === 'Guilty';
  const no = cast === 'Nay' || cast === 'No' || cast === 'Not Guilty';
  if (!yes && !no) return null;
  let yesWon;
  if (/\bnot\b|fail|reject|defeat/i.test(result)) yesWon = false;
  else if (/pass|agree|confirm|adopt|sustain|guilty|elected/i.test(result)) yesWon = true;
  else if (yeas !== nays) yesWon = yeas > nays;
  else return null;
  return yesWon ? yes : no;
}

async function getBills(bioguide, env) {
  return cached(`bills:${bioguide}`, 24 * HOUR, async () => {
    const data = await getJSON(congressUrl(`/member/${bioguide}/sponsored-legislation`, env, '&limit=250'));
    return {
      total: data.pagination?.count ?? 0,
      bills: (data.sponsoredLegislation || [])
        .filter(b => b.type && b.number) // drop amendments
        .map(b => ({
          type: b.type,
          number: b.number,
          congress: b.congress,
          title: b.title,
          introducedDate: b.introducedDate,
          latestAction: b.latestAction?.text || '',
        })),
    };
  });
}

const HOUSE_TYPES = { HR: 'H.R.', HRES: 'H.Res.', HJRES: 'H.J.Res.', HCONRES: 'H.Con.Res.', S: 'S.', SRES: 'S.Res.', SJRES: 'S.J.Res.', SCONRES: 'S.Con.Res.' };

async function houseRollCalls({ congress, session }, env) {
  return cached(`hlist:${congress}-${session}`, HOUR, async () => {
    const all = [];
    for (let offset = 0; offset < 2500; offset += 250) {
      const data = await getJSON(congressUrl(`/house-vote/${congress}/${session}`, env, `&limit=250&offset=${offset}`));
      all.push(...(data.houseRollCallVotes || []));
      if (!data.pagination?.next) break;
    }
    // The list isn't returned in order
    return all.sort((a, b) => b.rollCallNumber - a.rollCallNumber);
  });
}

async function getHouseVotes(bioguide, env) {
  const recent = [];
  for (const s of currentSessions()) {
    if (recent.length >= VOTE_COUNT) break;
    const list = await houseRollCalls(s, env);
    recent.push(...list.slice(0, VOTE_COUNT - recent.length).map(v => ({ ...v, year: s.year })));
  }
  return Promise.all(recent.map(async (v) => {
    const detail = await cached(`hvote:${v.congress}-${v.sessionNumber}-${v.rollCallNumber}`, Infinity, () =>
      getJSON(congressUrl(`/house-vote/${v.congress}/${v.sessionNumber}/${v.rollCallNumber}/members`, env))
        .then(d => d.houseRollCallVoteMemberVotes));
    const results = detail.results || [];
    const yeas = results.filter(r => r.voteCast === 'Yea' || r.voteCast === 'Aye').length;
    const nays = results.filter(r => r.voteCast === 'Nay' || r.voteCast === 'No').length;
    const cast = results.find(r => r.bioguideID === bioguide)?.voteCast || null;
    const bill = v.legislationType ? `${HOUSE_TYPES[v.legislationType] || v.legislationType} ${v.legislationNumber}` : '';
    return {
      date: v.startDate?.slice(0, 10),
      question: [detail.voteQuestion, bill].filter(Boolean).join(': '),
      result: v.result,
      yeas, nays, cast,
      withWinner: withWinner(cast, v.result, yeas, nays),
      link: `https://clerk.house.gov/Votes/${v.year}${v.rollCallNumber}`,
    };
  }));
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim().replace(/\s+/g, ' ').replace(/&amp;/g, '&') : '';
};

async function senateRollCalls({ congress, session, year }) {
  return cached(`slist:${congress}-${session}`, HOUR, async () => {
    const xml = await getText(`https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.xml`);
    return [...xml.matchAll(/<vote>([\s\S]*?)<\/vote>/g)].map(([, v]) => ({
      congress, session, year,
      number: tag(v, 'vote_number'),
      date: tag(v, 'vote_date'), // e.g. "30-Sep"
      question: tag(v, 'question'),
      title: tag(v, 'title'),
      result: tag(v, 'result'),
      yeas: +tag(v, 'yeas'),
      nays: +tag(v, 'nays'),
    })).sort((a, b) => b.number - a.number);
  });
}

async function getSenateVotes(lis) {
  const recent = [];
  for (const s of currentSessions()) {
    if (recent.length >= VOTE_COUNT) break;
    const list = await senateRollCalls(s);
    recent.push(...list.slice(0, VOTE_COUNT - recent.length));
  }
  return Promise.all(recent.map(async (v) => {
    const base = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${v.congress}${v.session}/vote_${v.congress}_${v.session}_${v.number}`;
    const casts = await cached(`svote:${v.congress}-${v.session}-${v.number}`, Infinity, async () => {
      const xml = await getText(`${base}.xml`);
      return Object.fromEntries([...xml.matchAll(/<member>([\s\S]*?)<\/member>/g)]
        .map(([, m]) => [tag(m, 'lis_member_id'), tag(m, 'vote_cast')]));
    });
    const cast = casts[lis] || null;
    const [day, mon] = v.date.split('-');
    const idx = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(mon);
    const month = idx < 0 ? 0 : idx / 3 + 1;
    return {
      date: month ? `${v.year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}` : null,
      question: v.title || v.question,
      result: v.result,
      yeas: v.yeas, nays: v.nays, cast,
      withWinner: withWinner(cast, v.result, v.yeas, v.nays),
      link: `${base}.htm`,
    };
  }));
}

async function handleCongress(url, env, request) {
  const bioguide = url.searchParams.get('bioguide');
  const lis = url.searchParams.get('lis');
  const okBioguide = bioguide && /^[A-Z]\d{6}$/.test(bioguide);
  try {
    if (url.pathname === '/bills') {
      if (!okBioguide) return json(400, { error: 'Missing or invalid bioguide' }, request);
      return json(200, await getBills(bioguide, env), request);
    }
    const chamber = url.searchParams.get('chamber');
    if (chamber === 'house') {
      if (!okBioguide) return json(400, { error: 'Missing or invalid bioguide' }, request);
      return json(200, { votes: await getHouseVotes(bioguide, env) }, request);
    }
    if (chamber === 'senate') {
      if (!lis || !/^S\d{3}$/.test(lis)) return json(400, { error: 'Missing or invalid lis' }, request);
      return json(200, { votes: await getSenateVotes(lis) }, request);
    }
    return json(400, { error: 'chamber must be house or senate' }, request);
  } catch (e) {
    return json(502, { error: 'Upstream fetch failed', detail: String(e.message || e) }, request);
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json(405, { error: 'Method not allowed' }, request);
    }

    const url = new URL(request.url);
    if (url.pathname === '/bills' || url.pathname === '/votes') {
      return handleCongress(url, env, request);
    }

    const address = url.searchParams.get('address');
    if (!address) return json(400, { error: 'Missing address parameter' }, request);

    const upstreamUrl =
      `${UPSTREAM}?address=${encodeURIComponent(address)}` +
      '&benchmark=Public_AR_Current&vintage=Current_Current&layers=all&format=json';

    try {
      const upstream = await fetch(upstreamUrl, {
        headers: { 'User-Agent': 'my-reps (https://github.com/samiprehn/my_reps)' },
      });

      const bodyText = await upstream.text();

      return new Response(bodyText, {
        status: upstream.status,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': upstream.ok ? 'public, max-age=86400' : 'no-store',
          ...cors,
        },
      });
    } catch (e) {
      return json(502, { error: 'Upstream fetch failed', detail: String(e) }, request);
    }
  },
};
