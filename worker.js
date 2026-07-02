// Cloudflare Worker — CORS-enabled proxy for the US Census geocoder.
// Consumed by samiprehn.github.io/my_reps/ (the Census API sends no CORS headers,
// so a browser can't call it directly).
//
// Usage:  GET /?address=3109 S Fernwood Ave, Sioux Falls, SD 57110
// Proxies to the Census onelineaddress geographies endpoint and adds the
// Access-Control-Allow-Origin header browsers need.

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

export default {
  async fetch(request) {
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json(405, { error: 'Method not allowed' }, request);
    }

    const url = new URL(request.url);
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
