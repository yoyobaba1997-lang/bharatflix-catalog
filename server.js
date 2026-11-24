'use strict';

const express = require('express');
const app = express();
const PORT = Number(process.env.PORT || 3000);
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const PAGE_SIZE = 20;

// Provider IDs are resolved from TMDB's live India provider list at runtime.
// This avoids hard-coding IDs that may change or differ by service naming.
const SERVICES = [
  { slug: 'netflix', label: 'Netflix', aliases: ['netflix'] },
  { slug: 'prime-video', label: 'Prime Video', aliases: ['amazon prime video', 'prime video', 'amazon video'] },
  { slug: 'zee5', label: 'ZEE5', aliases: ['zee5', 'zee 5'] },
  { slug: 'hotstar', label: 'JioHotstar / Hotstar', aliases: ['jiohotstar', 'hotstar', 'disney plus hotstar', 'disney+ hotstar'] },
  { slug: 'jiocinema', label: 'JioCinema', aliases: ['jiocinema', 'jio cinema'] },
  { slug: 'sonyliv', label: 'SonyLIV', aliases: ['sonyliv', 'sony liv'] },
  { slug: 'sunnxt', label: 'Sun NXT', aliases: ['sun nxt', 'sunnxt'] },
  { slug: 'aha', label: 'Aha', aliases: ['aha'] }
];

const cache = new Map();
const providerMap = { movie: null, tv: null };
const providerMapFetchedAt = { movie: 0, tv: 0 };

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Cache-Control', 'public, max-age=300');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function sendJson(res, payload, maxAge = 300) {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Cache-Control', `public, max-age=${maxAge}`);
  return res.status(200).json(payload);
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function tmdb(path, params = {}) {
  if (!TMDB_API_KEY) {
    const error = new Error('TMDB_API_KEY is not configured. Add it as a server environment variable.');
    error.status = 503;
    throw error;
  }
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`TMDB request failed (${response.status}). ${detail.slice(0, 300)}`);
    error.status = response.status === 401 ? 502 : 502;
    throw error;
  }
  return response.json();
}

async function getProviderIds(type) {
  const now = Date.now();
  if (providerMap[type] && now - providerMapFetchedAt[type] < CACHE_TTL_MS) return providerMap[type];
  const endpoint = type === 'movie' ? '/watch/providers/movie' : '/watch/providers/tv';
  const data = await tmdb(endpoint, { watch_region: 'IN', language: 'en-US' });
  const rows = Array.isArray(data.results) ? data.results : [];
  const result = {};
  for (const service of SERVICES) {
    const matches = rows.filter(row => {
      const name = normalize(row.provider_name);
      return service.aliases.some(alias => name === normalize(alias) || name.includes(normalize(alias)) || normalize(alias).includes(name));
    });
    result[service.slug] = [...new Set(matches.map(item => Number(item.provider_id)).filter(Number.isFinite))];
  }
  providerMap[type] = result;
  providerMapFetchedAt[type] = now;
  return result;
}

function slugToService(slug) {
  return SERVICES.find(service => service.slug === slug) || null;
}

function poster(path) { return path ? `https://image.tmdb.org/t/p/w500${path}` : undefined; }
function backdrop(path) { return path ? `https://image.tmdb.org/t/p/w1280${path}` : undefined; }
function year(value) { return value && String(value).length >= 4 ? String(value).slice(0, 4) : undefined; }
function itemType(type) { return type === 'tv' ? 'series' : 'movie'; }
function tmdbId(id) {
  const raw = decodeURIComponent(String(id || ''));
  const match = raw.match(/^tmdb:(\d+)(?::.*)?$/);
  return match ? match[1] : null;
}
function catalogItem(row, type) {
  const date = type === 'tv' ? row.first_air_date : row.release_date;
  const title = type === 'tv' ? row.name : row.title;
  const item = {
    id: `tmdb:${row.id}`,
    type: itemType(type),
    name: title || 'Untitled',
    poster: poster(row.poster_path),
    background: backdrop(row.backdrop_path),
    description: row.overview || '',
    releaseInfo: year(date),
    genres: Array.isArray(row.genre_ids) ? row.genre_ids.map(String) : []
  };
  for (const key of Object.keys(item)) if (item[key] === undefined) delete item[key];
  return item;
}

function parseExtras(value) {
  const result = {};
  if (!value) return result;
  for (const part of String(value).split('&')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    result[decodeURIComponent(part.slice(0, at))] = decodeURIComponent(part.slice(at + 1));
  }
  return result;
}

function catalogDefinitions() {
  const catalogs = [];
  for (const service of SERVICES) {
    catalogs.push({ type: 'movie', id: `hi-movies-${service.slug}`, name: `Hindi Movies • ${service.label}`, extra: [] });
    catalogs.push({ type: 'series', id: `hi-series-${service.slug}`, name: `Hindi Series • ${service.label}`, extra: [] });
  }
  catalogs.push({ type: 'movie', id: 'hi-movies-all-india', name: 'Hindi Movies • Selected Indian OTT', extra: [] });
  catalogs.push({ type: 'series', id: 'hi-series-all-india', name: 'Hindi Series • Selected Indian OTT', extra: [] });
  catalogs.push({ type: 'movie', id: 'anime-movies', name: 'Anime Movies • Japanese Originals', extra: [] });
  catalogs.push({ type: 'series', id: 'anime-series', name: 'Anime Series • Japanese Originals', extra: [] });
  catalogs.push({ type: 'series', id: 'anime-on-air', name: 'Currently Airing Anime', extra: [] });
  catalogs.push({ type: 'series', id: 'anime-latest-on-air', name: 'Latest On-Air Anime', extra: [] });
  catalogs.push({ type: 'series', id: 'anime-completed', name: 'Completed Anime Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'latest-indian-movies', name: 'Latest Indian Movie Releases', extra: [] });
  catalogs.push({ type: 'movie', id: 'latest-worldwide-movies', name: 'Latest Worldwide Movie Releases', extra: [] });
  catalogs.push({ type: 'movie', id: 'upcoming-indian-movies', name: 'Upcoming Indian Movies', extra: [] });
  catalogs.push({ type: 'movie', id: 'upcoming-worldwide-movies', name: 'Upcoming Worldwide Movies', extra: [] });
  return catalogs;
}

app.get('/health', (req, res) => sendJson(res, { ok: true, addon: 'BharatFlix Catalog', tmdbKeyConfigured: Boolean(TMDB_API_KEY) }, 30));

app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: 'in.bharatflix.nuvio.catalog',
    version: '2.0.0',
    name: 'BharatFlix India, Anime & New Releases',
    description: 'Hindi OTT catalogs, Japanese-original anime, currently airing and completed anime, and latest Indian and worldwide movie releases. Catalog and metadata only; no streams are provided.',
    logo: 'https://raw.githubusercontent.com/yoyobaba1997-lang/bharatflix-catalog/main/assets/logo.png',
    types: ['movie', 'series'],
    idPrefixes: ['tmdb:'],
    resources: [
      'catalog',
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tmdb:'] }
    ],
    catalogs: catalogDefinitions(),
    behaviorHints: { configurable: false }
  };
  return sendJson(res, manifest, 300);
});

app.get('/catalog/:type/:catalogId/:extra.json', async (req, res, next) => {
  try {
    return await handleCatalog(req, res, next);
  } catch (error) { next(error); }
});
app.get('/catalog/:type/:catalogId.json', async (req, res, next) => {
  try {
    return await handleCatalog(req, res, next);
  } catch (error) { next(error); }
});

async function handleCatalog(req, res) {
  const requestedType = req.params.type;
  const type = requestedType === 'series' ? 'tv' : requestedType === 'movie' ? 'movie' : null;
  if (!type) return sendJson(res, { metas: [] });
  const catalogId = req.params.catalogId;
  const extras = parseExtras(req.params.extra || '');
  const skip = Math.max(0, Number(extras.skip || 0) || 0);
  const page = Math.floor(skip / PAGE_SIZE) + 1;

  // TMDB genre 16 plus original language ja is the available anime proxy.
  // TMDB does not expose reliable Hindi/English dub-track availability.
  const animeCatalogs = ['anime-movies', 'anime-series', 'anime-on-air', 'anime-latest-on-air', 'anime-completed'];
  if (animeCatalogs.includes(catalogId)) {
    const animeType = catalogId === 'anime-movies' ? 'movie' : 'tv';
    if (type !== animeType) return sendJson(res, { metas: [] });
    const params = {
      language: 'en-US',
      with_genres: '16',
      with_original_language: 'ja',
      sort_by: catalogId === 'anime-latest-on-air' || catalogId === 'anime-completed'
        ? 'first_air_date.desc' : 'popularity.desc',
      page,
      include_adult: 'false'
    };
    if (catalogId === 'anime-on-air' || catalogId === 'anime-latest-on-air') {
      params.with_status = '0';
      params['first_air_date.lte'] = new Date().toISOString().slice(0, 10);
    } else if (catalogId === 'anime-completed') {
      params.with_status = '3';
    }
    const data = await tmdb(`/discover/${animeType}`, params);
    const metas = (Array.isArray(data.results) ? data.results : []).map(row => catalogItem(row, animeType));
    return sendJson(res, { metas }, 600);
  }

  const releaseCatalogs = {
    'latest-indian-movies': { country: 'IN', mode: 'latest' },
    'latest-worldwide-movies': { country: null, mode: 'latest' },
    'upcoming-indian-movies': { country: 'IN', mode: 'upcoming' },
    'upcoming-worldwide-movies': { country: null, mode: 'upcoming' }
  };
  if (releaseCatalogs[catalogId]) {
    if (type !== 'movie') return sendJson(res, { metas: [] });
    const config = releaseCatalogs[catalogId];
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const recent = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
    const params = {
      language: 'en-US',
      sort_by: config.mode === 'latest' ? 'primary_release_date.desc' : 'primary_release_date.asc',
      page,
      include_adult: 'false',
      'primary_release_date.gte': config.mode === 'latest' ? recent : today,
      'primary_release_date.lte': config.mode === 'latest' ? today : horizon
    };
    if (config.country) params.with_origin_country = config.country;
    const data = await tmdb('/discover/movie', params);
    const metas = (Array.isArray(data.results) ? data.results : []).map(row => catalogItem(row, 'movie'));
    return sendJson(res, { metas }, 900);
  }

  const all = catalogId === (type === 'movie' ? 'hi-movies-all-india' : 'hi-series-all-india');
  const prefix = type === 'movie' ? 'hi-movies-' : 'hi-series-';
  if (!all && !catalogId.startsWith(prefix)) return sendJson(res, { metas: [] });
  const slug = all ? null : catalogId.slice(prefix.length);
  const service = slug ? slugToService(slug) : null;
  if (slug && !service) return sendJson(res, { metas: [] });

  const params = {
    language: 'en-US',
    region: 'IN',
    watch_region: 'IN',
    with_original_language: 'hi',
    sort_by: 'popularity.desc',
    page,
    include_adult: 'false'
  };
  const providerIds = await getProviderIds(type);
  const selectedIds = all
    ? [...new Set(SERVICES.flatMap(s => providerIds[s.slug] || []))]
    : (providerIds[service.slug] || []);
  if (!selectedIds.length) return sendJson(res, { metas: [] }, 1800);
  params.with_watch_providers = selectedIds.join('|');
  const data = await tmdb(`/discover/${type}`, params);
  const metas = (Array.isArray(data.results) ? data.results : []).map(row => catalogItem(row, type));
  return sendJson(res, { metas }, 900);
}

app.get('/meta/:type/:id.json', async (req, res, next) => {
  try {
    const requestedType = req.params.type;
    const type = requestedType === 'series' ? 'tv' : requestedType === 'movie' ? 'movie' : null;
    const id = tmdbId(req.params.id);
    if (!type || !id) return sendJson(res, { meta: null });
    const data = await tmdb(`/${type}/${id}`, { language: 'en-US', append_to_response: 'credits,videos,external_ids,content_ratings,release_dates' });
    const title = type === 'tv' ? data.name : data.title;
    const date = type === 'tv' ? data.first_air_date : data.release_date;
    const videos = Array.isArray(data.seasons) ? data.seasons : [];
    const meta = {
      id: `tmdb:${data.id}`,
      type: itemType(type),
      name: title || 'Untitled',
      poster: poster(data.poster_path),
      background: backdrop(data.backdrop_path),
      description: data.overview || '',
      releaseInfo: year(date),
      genres: Array.isArray(data.genres) ? data.genres.map(g => g.name) : [],
      runtime: type === 'movie' ? data.runtime : (data.episode_run_time || [])[0],
      country: (data.production_countries || []).map(c => c.name).join(', '),
      language: data.original_language,
      imdbRating: data.vote_average ? Number(data.vote_average).toFixed(1) : undefined,
      videos: type === 'tv' ? videos.map(s => ({
        id: `tmdb:${data.id}:${s.season_number}:1`,
        title: s.name || `Season ${s.season_number}`,
        season: s.season_number,
        episode: 1,
        released: s.air_date ? `${s.air_date}T00:00:00.000Z` : undefined,
        overview: s.overview || ''
      })) : undefined,
      app_extras: {
        cast: (data.credits?.cast || []).slice(0, 15).map(p => ({ name: p.name, character: p.character, photo: poster(p.profile_path) })),
        directors: (data.credits?.crew || []).filter(p => p.job === 'Director').slice(0, 5).map(p => ({ name: p.name })),
        writers: (data.credits?.crew || []).filter(p => ['Writer', 'Screenplay', 'Story'].includes(p.job)).slice(0, 8).map(p => ({ name: p.name }))
      }
    };
    for (const key of Object.keys(meta)) if (meta[key] === undefined || meta[key] === '') delete meta[key];
    return sendJson(res, { meta }, 1800);
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}:`, error.message);
  const status = Number(error.status) || 500;
  res.set('Access-Control-Allow-Origin', '*');
  return res.status(status).json({ error: 'BharatFlix addon request failed', message: error.message });
});

app.listen(PORT, () => console.log(`BharatFlix Catalog listening on ${PORT}`));
