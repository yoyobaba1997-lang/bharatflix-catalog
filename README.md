# BharatFlix Complete Streaming Discovery for Nuvio

A streaming-style discovery catalogue inspired by Netflix, Prime Video, and other major services. Metadata/catalogue only; no streams, subscriptions, downloads, or access bypass are provided.

## Discovery shelves

- Worldwide Trending Movies and Series
- Popular and Top-Rated Movies and Series
- Latest and Upcoming Movie and Series releases
- Indian Movies, Bollywood, Latest Bollywood, Upcoming Bollywood, and Top-Rated Indian Movies
- New on Streaming (India; combined providers)
- Genre shelves: Action, Adventure, Animation, Comedy, Crime, Documentary, Drama, Family, Fantasy, Horror, Mystery, Romance, Sci-Fi, Sports, Thriller, War, Western, Music, Reality, Talk, and Soap/Drama
- Family and Kids shelves
- Classics and decade shelves (1990s, 2000s, 2010s, 2020s)
- Anime: Popular, Movies, Series, Currently Airing, Latest On-Air, Completed
- All 22 scheduled Indian languages: Assamese, Bengali, Bodo, Dogri, Gujarati, Hindi, Kannada, Kashmiri, Konkani, Maithili, Malayalam, Manipuri/Meitei, Marathi, Nepali, Odia, Punjabi, Sanskrit, Santali, Sindhi, Tamil, Telugu, and Urdu
- For each scheduled language: Movies, Series, Popular Movies, Latest Movies, Upcoming Movies, Popular Series, Latest Series
- Provider × language shelves for Netflix, Prime Video, ZEE5, JioHotstar/Hotstar, JioCinema, SonyLIV, Sun NXT, and Aha (where TMDB provider metadata supports it)

## Data source and limitations

TMDB discovery and metadata APIs power the catalogues. India-region OTT availability depends on TMDB's provider listings and can be incomplete or change. Language shelves use TMDB original-language metadata; some smaller-language shelves may have few or no results. Provider-language shelves are metadata discovery, not proof that a title is currently streamable.

## Install / deploy

Deploy the service to Render or another Node.js host. Set the `TMDB_API_KEY` environment variable securely. Then add the HTTPS `/manifest.json` URL in Nuvio.

## Health and manifest

- `/health`
- `/manifest.json`

## Disclaimer

BharatFlix is an independent catalogue addon, not affiliated with Netflix, Amazon Prime Video, TMDB, or other providers. TMDB metadata and images are subject to their terms.