# My Reps

See how your two senators and House rep have been voting.

**Live:** https://samiprehn.github.io/my_reps/

Enter your address and you'll get a card for each of your three federal legislators with:
- Age and years in Congress
- Committee assignments
- Sponsored bills, grouped by stage (Enacted → Introduced)
- Recent votes with the final tally and a ✓/✗ for whether they voted with the majority

## Stack

Single-file HTML, fully client-side. No backend, no API keys.

- **US Census Geocoder** — address → state + congressional district (routed through a Cloudflare Worker, `my-reps.sami-prehn.workers.dev`, since the Geocoder doesn't send CORS headers)
- **congress-legislators** (unitedstates.github.io) — current members, committees, and photos as static JSON. (GovTrack's API started returning Cloudflare challenges in Oct 2026; sponsored bills and recent votes come from the Worker's `/bills` and `/votes` routes (Congress.gov API + senate.gov XML; `CONGRESS_API_KEY` secret).)
- **Tailwind via CDN** for styling
- Address persists in `localStorage`; split into street/city/state/ZIP fields so browsers offer saved-address autofill

## Run locally

```sh
python3 -m http.server 8765
open http://localhost:8765/
```
