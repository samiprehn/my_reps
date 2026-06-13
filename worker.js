// Cloudflare Worker — CORS-enabled proxy for the US Census geocoder.
// Consumed by mprehn.github.io/my_reps/ (the Census API sends no CORS headers,
// so a browser can't call it directly).
//
// Usage:  GET /?address=3109 S Fernwood Ave, Sioux Falls, SD 57110
// Proxies to the Census onelineaddress geographies endpoint and adds the
// Access-Control-Allow-Origin header browsers need.

const UPSTREAM = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors, ...extraHeaders },
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json(405, { error: 'Method not allowed' });
    }

    const url = new URL(request.url);
    const address = url.searchParams.get('address');
    if (!address) return json(400, { error: 'Missing address parameter' });

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
          'Cache-Control': 'public, max-age=86400',
          ...cors,
        },
      });
    } catch (e) {
      return json(502, { error: 'Upstream fetch failed', detail: String(e) });
    }
  },
};
