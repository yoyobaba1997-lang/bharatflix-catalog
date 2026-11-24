# BharatFlix Hindi Catalog for Nuvio

An India-region, Hindi-original-language catalog addon for Nuvio. It creates separate movie and series catalogs for Netflix, Prime Video, ZEE5, Hotstar/JioHotstar, JioCinema, SonyLIV, Sun NXT, and Aha, plus combined catalogs.

**This addon is catalog/metadata only.** It does not provide video streams, bypass subscriptions, or download copyrighted media.

## How it works

- Uses TMDB's public API for catalog discovery and title metadata.
- Resolves provider IDs from TMDB's live India watch-provider list instead of hard-coding IDs.
- Filters by India availability (`watch_region=IN`) and Hindi original language (`with_original_language=hi`).
- Returns Stremio-compatible catalog and metadata resources understood by Nuvio.
- Sends permissive CORS headers for client access.

Provider names can change in TMDB's provider directory. If a selected provider is not listed there for India, that provider's catalog will return an empty list rather than causing an HTTP 404.

## Deploy on Render

1. Create a new **public or private GitHub repository** named `bharatflix-catalog` in your account.
2. Upload all files in this folder to the repository root.
3. In Render, choose **New → Blueprint** and select that repository. Render reads `render.yaml`.
4. In the Render service's Environment settings, add `TMDB_API_KEY` with your TMDB API Read Access Token or API key. Keep it secret; do not commit it to GitHub.
5. Deploy. Wait for the service to become healthy.
6. Test `https://YOUR-SERVICE.onrender.com/health` and `https://YOUR-SERVICE.onrender.com/manifest.json`.
7. Install this URL in Nuvio: `https://YOUR-SERVICE.onrender.com/manifest.json`.

## Local test

Requires Node.js 20+.

```bash
npm install
TMDB_API_KEY='your_tmdb_v3_api_key' npm start
```

Then open:

- `http://localhost:3000/health`
- `http://localhost:3000/manifest.json`
- `http://localhost:3000/catalog/movie/hi-movies-netflix.json`
- `http://localhost:3000/meta/movie/tmdb%3A550.json`

## Catalogs created

- Hindi Movies • Netflix / Prime Video / ZEE5 / JioHotstar-Hotstar / JioCinema / SonyLIV / Sun NXT / Aha
- Hindi Series • same eight services
- Hindi Movies • Selected Indian OTT
- Hindi Series • Selected Indian OTT

## Notes

- Results depend on TMDB's provider availability data for India and may not exactly match each OTT service's live catalogue.
- TMDB metadata and images are subject to TMDB's terms. This product uses the TMDB API but is not endorsed or certified by TMDB.
- Nuvio requires a valid HTTPS manifest URL. Deploy first; a GitHub repository URL itself is not an addon manifest endpoint.
