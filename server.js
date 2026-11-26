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
  // Curated home rows inspired by the supplied Castle-style reference:
  // compact, clearly named discovery shelves; Nuvio controls the actual layout.
  for (const service of SERVICES) {
    catalogs.push({ type: 'movie', id: `hi-movies-${service.slug}`, name: `Hindi Movies • ${service.label}`, extra: [] });
    catalogs.push({ type: 'series', id: `hi-series-${service.slug}`, name: `Hindi Series • ${service.label}`, extra: [] });
  }
  catalogs.push({ type: 'movie', id: 'hi-movies-all-india', name: 'Hindi Movies • Selected Indian OTT', extra: [] });
  catalogs.push({ type: 'series', id: 'hi-series-all-india', name: 'Hindi Series • Selected Indian OTT', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-as-movies', name: 'Assamese Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-as-series', name: 'Assamese Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-bn-movies', name: 'Bengali Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-bn-series', name: 'Bengali Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-brx-movies', name: 'Bodo Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-brx-series', name: 'Bodo Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-doi-movies', name: 'Dogri Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-doi-series', name: 'Dogri Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-gu-movies', name: 'Gujarati Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-gu-series', name: 'Gujarati Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-hi-movies', name: 'Hindi Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-hi-series', name: 'Hindi Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-kn-movies', name: 'Kannada Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-kn-series', name: 'Kannada Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-ks-movies', name: 'Kashmiri Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-ks-series', name: 'Kashmiri Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-kok-movies', name: 'Konkani Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-kok-series', name: 'Konkani Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-mai-movies', name: 'Maithili Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-mai-series', name: 'Maithili Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-ml-movies', name: 'Malayalam Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-ml-series', name: 'Malayalam Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-mni-movies', name: 'Manipuri (Meitei) Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-mni-series', name: 'Manipuri (Meitei) Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-mr-movies', name: 'Marathi Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-mr-series', name: 'Marathi Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-ne-movies', name: 'Nepali Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-ne-series', name: 'Nepali Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-or-movies', name: 'Odia Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-or-series', name: 'Odia Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-pa-movies', name: 'Punjabi Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-pa-series', name: 'Punjabi Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-sa-movies', name: 'Sanskrit Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-sa-series', name: 'Sanskrit Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-sat-movies', name: 'Santali Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-sat-series', name: 'Santali Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-sd-movies', name: 'Sindhi Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-sd-series', name: 'Sindhi Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-ta-movies', name: 'Tamil Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-ta-series', name: 'Tamil Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-te-movies', name: 'Telugu Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-te-series', name: 'Telugu Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'lang-ur-movies', name: 'Urdu Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'lang-ur-series', name: 'Urdu Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'anime-movies', name: 'Anime Movies • Japanese Originals', extra: [] });
  catalogs.push({ type: 'series', id: 'popular-anime', name: 'Popular Anime • Japanese Originals', extra: [] });
  catalogs.push({ type: 'series', id: 'anime-series', name: 'Anime Series • Japanese Originals', extra: [] });
  catalogs.push({ type: 'series', id: 'anime-on-air', name: 'Currently Airing Anime', extra: [] });
  catalogs.push({ type: 'series', id: 'anime-latest-on-air', name: 'Latest On-Air Anime', extra: [] });
  catalogs.push({ type: 'series', id: 'anime-completed', name: 'Completed Anime Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'trending-movies', name: 'Trending Movies • Worldwide', extra: [] });
  catalogs.push({ type: 'movie', id: 'trending-indian-movies', name: 'Trending Indian Movies', extra: [] });
  catalogs.push({ type: 'movie', id: 'popular-bollywood-movies', name: 'Popular Bollywood Movies', extra: [] });
  catalogs.push({ type: 'movie', id: 'top-rated-indian-movies', name: 'Top Rated Indian Movies', extra: [] });
  catalogs.push({ type: 'movie', id: 'latest-indian-movies', name: 'Latest Indian Movies', extra: [] });
  catalogs.push({ type: 'movie', id: 'latest-worldwide-movies', name: 'Latest Movie Releases • Worldwide', extra: [] });
  catalogs.push({ type: 'movie', id: 'upcoming-indian-movies', name: 'Upcoming Indian Movies', extra: [] });
  catalogs.push({ type: 'movie', id: 'upcoming-worldwide-movies', name: 'Upcoming Worldwide Movies', extra: [] });
  catalogs.push({ type: 'movie', id: 'bollywood-movies', name: 'Bollywood Movies • Hindi', extra: [] });
  catalogs.push({ type: 'movie', id: 'latest-bollywood-releases', name: 'Latest Bollywood Releases', extra: [] });
  catalogs.push({ type: 'movie', id: 'upcoming-bollywood-movies', name: 'Upcoming Bollywood Movies', extra: [] });
  catalogs.push({ type: 'movie', id: 'new-on-streaming', name: 'New on Streaming • India', extra: [] });
  catalogs.push({ type: 'movie', id: 'top-rated-worldwide-movies', name: 'Top Rated Movies • Worldwide', extra: [] });
  catalogs.push({ type: 'series', id: 'trending-series', name: 'Trending Series • Worldwide', extra: [] });
  catalogs.push({ type: 'series', id: 'popular-series', name: 'Popular Series • Worldwide', extra: [] });
  catalogs.push({ type: 'series', id: 'top-rated-series', name: 'Top Rated Series • Worldwide', extra: [] });
  catalogs.push({ type: 'series', id: 'latest-series', name: 'Latest Series Releases • Worldwide', extra: [] });
  catalogs.push({ type: 'series', id: 'upcoming-series', name: 'Upcoming Series • Worldwide', extra: [] });
  catalogs.push({ type: 'movie', id: 'family-movies', name: 'Family Movies', extra: [] });
  catalogs.push({ type: 'movie', id: 'kids-movies', name: 'Kids Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'family-series', name: 'Family Series', extra: [] });
  catalogs.push({ type: 'series', id: 'kids-series', name: 'Kids Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'documentary-movies', name: 'Documentary Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'documentary-series', name: 'Documentary Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'animation-movies', name: 'Animation Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'animation-series', name: 'Animation Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'horror-movies', name: 'Horror Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'horror-series', name: 'Horror Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'thriller-movies', name: 'Thriller Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'thriller-series', name: 'Thriller Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'romance-movies', name: 'Romance Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'romance-series', name: 'Romance Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'action-movies', name: 'Action Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'action-series', name: 'Action Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'comedy-movies', name: 'Comedy Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'comedy-series', name: 'Comedy Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'drama-movies', name: 'Drama Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'drama-series', name: 'Drama Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'crime-movies', name: 'Crime Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'crime-series', name: 'Crime Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'sci-fi-movies', name: 'Sci-Fi Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'sci-fi-series', name: 'Sci-Fi Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'fantasy-movies', name: 'Fantasy Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'fantasy-series', name: 'Fantasy Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'mystery-movies', name: 'Mystery Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'mystery-series', name: 'Mystery Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'war-movies', name: 'War Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'war-series', name: 'War Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'western-movies', name: 'Western Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'western-series', name: 'Western Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'sports-movies', name: 'Sports Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'sports-series', name: 'Sports Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'music-movies', name: 'Music Movies', extra: [] });
  catalogs.push({ type: 'series', id: 'music-series', name: 'Music Series', extra: [] });
  catalogs.push({ type: 'series', id: 'reality-series', name: 'Reality Series', extra: [] });
  catalogs.push({ type: 'series', id: 'talk-series', name: 'Talk Shows', extra: [] });
  catalogs.push({ type: 'series', id: 'soap-series', name: 'Soap & Drama Series', extra: [] });
  catalogs.push({ type: 'movie', id: 'classic-movies', name: 'Classic Movies', extra: [] });
  catalogs.push({ type: 'movie', id: '90s-movies', name: 'Movies from the 1990s', extra: [] });
  catalogs.push({ type: 'movie', id: '2000s-movies', name: 'Movies from the 2000s', extra: [] });
  catalogs.push({ type: 'movie', id: '2010s-movies', name: 'Movies from the 2010s', extra: [] });
  catalogs.push({ type: 'movie', id: '2020s-movies', name: 'Movies from the 2020s', extra: [] });
  catalogs.push({ type: 'series', id: 'classic-series', name: 'Classic Series', extra: [] });
  // Each scheduled language receives Popular, Latest and Upcoming movie shelves, plus Popular and Latest series.
  const languageCodes = ['as','bn','brx','doi','gu','hi','kn','ks','kok','mai','ml','mni','mr','ne','or','pa','sa','sat','sd','ta','te','ur'];
  const languageNames = ['Assamese','Bengali','Bodo','Dogri','Gujarati','Hindi','Kannada','Kashmiri','Konkani','Maithili','Malayalam','Manipuri (Meitei)','Marathi','Nepali','Odia','Punjabi','Sanskrit','Santali','Sindhi','Tamil','Telugu','Urdu'];
  for (let i = 0; i < languageCodes.length; i++) {
    const code = languageCodes[i], label = languageNames[i];
    catalogs.push({ type: 'movie', id: `lang-${code}-popular-movies`, name: `Popular ${label} Movies`, extra: [] });
    catalogs.push({ type: 'movie', id: `lang-${code}-latest-movies`, name: `Latest ${label} Movies`, extra: [] });
    catalogs.push({ type: 'movie', id: `lang-${code}-upcoming-movies`, name: `Upcoming ${label} Movies`, extra: [] });
    catalogs.push({ type: 'series', id: `lang-${code}-popular-series`, name: `Popular ${label} Series`, extra: [] });
    catalogs.push({ type: 'series', id: `lang-${code}-latest-series`, name: `Latest ${label} Series`, extra: [] });
    for (const service of SERVICES) {
      catalogs.push({ type: 'movie', id: `stream-${service.slug}-${code}-movies`, name: `${service.label} • ${label} Movies`, extra: [] });
      catalogs.push({ type: 'series', id: `stream-${service.slug}-${code}-series`, name: `${service.label} • ${label} Series`, extra: [] });
    }
  }
  return catalogs;
}

app.get('/health', (req, res) => sendJson(res, { ok: true, addon: 'BharatFlix Catalog', tmdbKeyConfigured: Boolean(TMDB_API_KEY) }, 30));

app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: 'in.bharatflix.nuvio.catalog',
    version: '2.2.0',
    name: 'BharatFlix • Complete Streaming Discovery',
    description: 'Streaming-style discovery catalogs for India and worldwide: OTT providers, all 22 scheduled Indian languages, genres, trending, popular, top-rated, latest, upcoming, family, kids, documentaries, anime and more. Catalog and metadata only; no streams are provided.',
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

  const languageCatalogMatch = catalogId.match(/^lang-([a-z]+)-(movies|series|popular-movies|latest-movies|upcoming-movies|popular-series|latest-series)$/);
  if (languageCatalogMatch) {
    const languageCodes = {as:'as',bn:'bn',brx:'brx',doi:'doi',gu:'gu',hi:'hi',kn:'kn',ks:'ks',kok:'kok',mai:'mai',ml:'ml',mni:'mni',mr:'mr',ne:'ne',or:'or',pa:'pa',sa:'sa',sat:'sat',sd:'sd',ta:'ta',te:'te',ur:'ur'};
    const lang = languageCatalogMatch[1];
    const suffix = languageCatalogMatch[2];
    const originalLanguage = languageCodes[lang];
    const expectedType = suffix.endsWith('series') || suffix === 'series' ? 'tv' : 'movie';
    if (!originalLanguage || type !== expectedType) return sendJson(res, { metas: [] });
    const mode = suffix.includes('latest') ? 'latest' : suffix.includes('upcoming') ? 'upcoming' : 'popular';
    const today = new Date().toISOString().slice(0,10);
    const horizon = new Date(Date.now()+365*86400000).toISOString().slice(0,10);
    const recent = new Date(Date.now()-180*86400000).toISOString().slice(0,10);
    const dateKey = expectedType === 'tv' ? 'first_air_date' : 'primary_release_date';
    const params = { language:'en-US', with_original_language:originalLanguage, sort_by:mode==='latest' ? `${dateKey}.desc` : mode==='upcoming' ? `${dateKey}.asc` : 'popularity.desc', page, include_adult:'false' };
    if (mode === 'latest') { params[`${dateKey}.gte`] = recent; params[`${dateKey}.lte`] = today; }
    if (mode === 'upcoming' && expectedType === 'movie') { params[`${dateKey}.gte`] = today; params[`${dateKey}.lte`] = horizon; }
    if (mode === 'upcoming' && expectedType === 'tv') { params[`${dateKey}.gte`] = today; params[`${dateKey}.lte`] = horizon; }
    const data = await tmdb(`/discover/${type}`, params);
    const metas = (Array.isArray(data.results) ? data.results : []).map(row => catalogItem(row,type));
    return sendJson(res,{metas},900);
  }
  const streamLangMatch = catalogId.match(/^stream-([a-z0-9-]+)-([a-z]+)-(movies|series)$/);
  if (streamLangMatch) {
    const service = slugToService(streamLangMatch[1]);
    const lang = streamLangMatch[2];
    const expectedType = streamLangMatch[3] === 'series' ? 'tv' : 'movie';
    const languageCodes = {as:'as',bn:'bn',brx:'brx',doi:'doi',gu:'gu',hi:'hi',kn:'kn',ks:'ks',kok:'kok',mai:'mai',ml:'ml',mni:'mni',mr:'mr',ne:'ne',or:'or',pa:'pa',sa:'sa',sat:'sat',sd:'sd',ta:'ta',te:'te',ur:'ur'};
    if (!service || !languageCodes[lang] || type !== expectedType) return sendJson(res,{metas:[]});
    const ids=(await getProviderIds(type))[service.slug]||[];
    if(!ids.length) return sendJson(res,{metas:[]},1800);
    const data=await tmdb(`/discover/${type}`,{language:'en-US',region:'IN',watch_region:'IN',with_watch_providers:ids.join('|'),with_original_language:languageCodes[lang],sort_by:'popularity.desc',page,include_adult:'false'});
    return sendJson(res,{metas:(Array.isArray(data.results)?data.results:[]).map(row=>catalogItem(row,type))},900);
  }
  const genreCatalogMatch = catalogId.match(/^([a-z0-9-]+)-(movies|series)$/);
  const genreMap = {action:28,comedy:35,drama:18,crime:80,documentary:99,animation:16,family:10751,horror:27,thriller:53,romance:10749,'sci-fi':878,fantasy:14,mystery:9648,war:10752,western:37,sports:10770,music:10402,kids:10751};
  const genreName = genreCatalogMatch && genreCatalogMatch[1];
  if (genreCatalogMatch && genreMap[genreName] && (catalogId.endsWith('-movies') || catalogId.endsWith('-series'))) {
    const expectedType=genreCatalogMatch[2]==='series'?'tv':'movie';
    if(type!==expectedType) return sendJson(res,{metas:[]});
    const data=await tmdb(`/discover/${type}`,{language:'en-US',with_genres:String(genreMap[genreName]),sort_by:'popularity.desc',page,include_adult:'false'});
    return sendJson(res,{metas:(Array.isArray(data.results)?data.results:[]).map(row=>catalogItem(row,type))},900);
  }
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

  const discoveryCatalogs = {
    'trending-movies': { path: '/trending/movie/week', params: {} },
    'trending-indian-movies': { path: '/discover/movie', params: { with_origin_country: 'IN', sort_by: 'popularity.desc' } },
    'popular-bollywood-movies': { path: '/discover/movie', params: { with_origin_country: 'IN', with_original_language: 'hi', sort_by: 'popularity.desc' } },
    'top-rated-indian-movies': { path: '/discover/movie', params: { with_origin_country: 'IN', 'vote_count.gte': 50, sort_by: 'vote_average.desc' } },
    'popular-anime': { path: '/discover/tv', params: { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc' } },
    'top-rated-worldwide-movies': { path: '/discover/movie', params: { 'vote_count.gte': 100, sort_by: 'vote_average.desc' } },
    'trending-series': { path: '/trending/tv/week', params: {} },
    'popular-series': { path: '/discover/tv', params: { sort_by: 'popularity.desc' } },
    'top-rated-series': { path: '/discover/tv', params: { 'vote_count.gte': 100, sort_by: 'vote_average.desc' } },
    'family-movies': { path: '/discover/movie', params: { with_genres: '10751', sort_by: 'popularity.desc' } },
    'kids-movies': { path: '/discover/movie', params: { with_genres: '10751', sort_by: 'popularity.desc' } },
    'family-series': { path: '/discover/tv', params: { with_genres: '10751', sort_by: 'popularity.desc' } },
    'kids-series': { path: '/discover/tv', params: { with_genres: '10751', sort_by: 'popularity.desc' } },
    'documentary-movies': { path: '/discover/movie', params: { with_genres: '99', sort_by: 'popularity.desc' } },
    'documentary-series': { path: '/discover/tv', params: { with_genres: '99', sort_by: 'popularity.desc' } },
    'animation-movies': { path: '/discover/movie', params: { with_genres: '16', sort_by: 'popularity.desc' } },
    'animation-series': { path: '/discover/tv', params: { with_genres: '16', sort_by: 'popularity.desc' } },
    'horror-movies': { path: '/discover/movie', params: { with_genres: '27', sort_by: 'popularity.desc' } },
    'horror-series': { path: '/discover/tv', params: { with_genres: '27', sort_by: 'popularity.desc' } },
    'thriller-movies': { path: '/discover/movie', params: { with_genres: '53', sort_by: 'popularity.desc' } },
    'thriller-series': { path: '/discover/tv', params: { with_genres: '53', sort_by: 'popularity.desc' } },
    'romance-movies': { path: '/discover/movie', params: { with_genres: '10749', sort_by: 'popularity.desc' } },
    'romance-series': { path: '/discover/tv', params: { with_genres: '10749', sort_by: 'popularity.desc' } },
    'action-movies': { path: '/discover/movie', params: { with_genres: '28', sort_by: 'popularity.desc' } },
    'action-series': { path: '/discover/tv', params: { with_genres: '10759', sort_by: 'popularity.desc' } },
    'comedy-movies': { path: '/discover/movie', params: { with_genres: '35', sort_by: 'popularity.desc' } },
    'comedy-series': { path: '/discover/tv', params: { with_genres: '35', sort_by: 'popularity.desc' } },
    'drama-movies': { path: '/discover/movie', params: { with_genres: '18', sort_by: 'popularity.desc' } },
    'drama-series': { path: '/discover/tv', params: { with_genres: '18', sort_by: 'popularity.desc' } },
    'crime-movies': { path: '/discover/movie', params: { with_genres: '80', sort_by: 'popularity.desc' } },
    'crime-series': { path: '/discover/tv', params: { with_genres: '80', sort_by: 'popularity.desc' } },
    'sci-fi-movies': { path: '/discover/movie', params: { with_genres: '878', sort_by: 'popularity.desc' } },
    'sci-fi-series': { path: '/discover/tv', params: { with_genres: '10765', sort_by: 'popularity.desc' } },
    'fantasy-movies': { path: '/discover/movie', params: { with_genres: '14', sort_by: 'popularity.desc' } },
    'fantasy-series': { path: '/discover/tv', params: { with_genres: '10765', sort_by: 'popularity.desc' } },
    'mystery-movies': { path: '/discover/movie', params: { with_genres: '9648', sort_by: 'popularity.desc' } },
    'mystery-series': { path: '/discover/tv', params: { with_genres: '9648', sort_by: 'popularity.desc' } },
    'war-movies': { path: '/discover/movie', params: { with_genres: '10752', sort_by: 'popularity.desc' } },
    'war-series': { path: '/discover/tv', params: { with_genres: '10752', sort_by: 'popularity.desc' } },
    'western-movies': { path: '/discover/movie', params: { with_genres: '37', sort_by: 'popularity.desc' } },
    'western-series': { path: '/discover/tv', params: { with_genres: '37', sort_by: 'popularity.desc' } },
    'sports-movies': { path: '/discover/movie', params: { with_genres: '10770', sort_by: 'popularity.desc' } },
    'sports-series': { path: '/discover/tv', params: { with_genres: '10770', sort_by: 'popularity.desc' } },
    'music-movies': { path: '/discover/movie', params: { with_genres: '10402', sort_by: 'popularity.desc' } },
    'music-series': { path: '/discover/tv', params: { with_genres: '10402', sort_by: 'popularity.desc' } },
    'reality-series': { path: '/discover/tv', params: { with_genres: '10764', sort_by: 'popularity.desc' } },
    'talk-series': { path: '/discover/tv', params: { with_genres: '10767', sort_by: 'popularity.desc' } },
    'soap-series': { path: '/discover/tv', params: { with_genres: '10766', sort_by: 'popularity.desc' } },
'latest-series': { path: '/discover/tv', params: { sort_by: 'first_air_date.desc' } },
    'upcoming-series': { path: '/discover/tv', params: { sort_by: 'first_air_date.asc', 'first_air_date.gte': new Date().toISOString().slice(0,10) } },
  };
  if (discoveryCatalogs[catalogId]) {
    const config = discoveryCatalogs[catalogId];
    const expectedType = (catalogId === 'popular-anime' || catalogId.endsWith('-series')) ? 'tv' : 'movie';
    if (type !== expectedType) return sendJson(res, { metas: [] });
    const data = await tmdb(config.path, { language: 'en-US', page, include_adult: 'false', ...config.params });
    const metas = (Array.isArray(data.results) ? data.results : []).map(row => catalogItem(row, expectedType));
    return sendJson(res, { metas }, 600);
  }

  const yearCatalogMatch = catalogId.match(/^(classic|90s|2000s|2010s|2020s)-(movies|series)$/);
  if (yearCatalogMatch) {
    const expectedType = yearCatalogMatch[2] === 'series' ? 'tv' : 'movie';
    if (type !== expectedType) return sendJson(res,{metas:[]});
    const rangeMap = {
      classic: {gte:'1900-01-01',lte:'1989-12-31'},
      '90s': {gte:'1990-01-01',lte:'1999-12-31'},
      '2000s': {gte:'2000-01-01',lte:'2009-12-31'},
      '2010s': {gte:'2010-01-01',lte:'2019-12-31'},
      '2020s': {gte:'2020-01-01',lte:'2029-12-31'}
    };
    const dateField=expectedType==='tv'?'first_air_date':'primary_release_date';
    const range=rangeMap[yearCatalogMatch[1]];
    const data=await tmdb(`/discover/${type}`,{language:'en-US',[`${dateField}.gte`]:range.gte,[`${dateField}.lte`]:range.lte,sort_by:'popularity.desc',page,include_adult:'false'});
    return sendJson(res,{metas:(Array.isArray(data.results)?data.results:[]).map(row=>catalogItem(row,type))},900);
  }
  if (catalogId === 'new-on-streaming') {
    if (type !== 'movie') return sendJson(res,{metas:[]});
    const providerIds = await getProviderIds(type);
    const allIds=[...new Set(SERVICES.flatMap(service=>providerIds[service.slug]||[]))];
    if(!allIds.length) return sendJson(res,{metas:[]},1800);
    const recent=new Date(Date.now()-90*86400000).toISOString().slice(0,10);
    const data=await tmdb('/discover/movie',{language:'en-US',region:'IN',watch_region:'IN',with_watch_providers:allIds.join('|'),'primary_release_date.gte':recent,sort_by:'primary_release_date.desc',page,include_adult:'false'});
    return sendJson(res,{metas:(Array.isArray(data.results)?data.results:[]).map(row=>catalogItem(row,'movie'))},900);
  }
  const releaseCatalogs = {
    'latest-indian-movies': { country: 'IN', language: null, mode: 'latest' },
    'latest-worldwide-movies': { country: null, language: null, mode: 'latest' },
    'upcoming-indian-movies': { country: 'IN', language: null, mode: 'upcoming' },
    'upcoming-worldwide-movies': { country: null, language: null, mode: 'upcoming' },
    'bollywood-movies': { country: 'IN', language: 'hi', mode: 'popular' },
    'latest-bollywood-releases': { country: 'IN', language: 'hi', mode: 'latest' },
    'upcoming-bollywood-movies': { country: 'IN', language: 'hi', mode: 'upcoming' }
  };
  if (releaseCatalogs[catalogId]) {
    if (type !== 'movie') return sendJson(res, { metas: [] });
    const config = releaseCatalogs[catalogId];
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const recent = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
    const params = {
      language: 'en-US',
      sort_by: config.mode === 'latest' ? 'primary_release_date.desc'
        : config.mode === 'upcoming' ? 'primary_release_date.asc' : 'popularity.desc',
      page,
      include_adult: 'false'
    };
    if (config.mode === 'latest' || config.mode === 'upcoming') {
      params['primary_release_date.gte'] = config.mode === 'latest' ? recent : today;
      params['primary_release_date.lte'] = config.mode === 'latest' ? today : horizon;
    }
    if (config.country) params.with_origin_country = config.country;
    if (config.language) params.with_original_language = config.language;
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
