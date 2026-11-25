import axios from 'axios';
import { cacheGet, cacheSet, cacheSetTtl } from '../utils/cache';
import { extractSeasonHintExtended } from './animesalt';
import { extractFirePlayer, isFirePlayerUrl } from '../extractors/fireplayer';
import { extractPlayZen, isPlayZenUrl, PlayZenSource } from '../extractors/playzen';
import { HlsAudioTrack, HlsQuality, HlsSubtitleTrack } from '../utils/hls';

// ══════════════════════════════════════════════════════════════
// HINDI-ANIME.COM — Public JSON Catalog + Cloudflare Worker API
//   https://hindi-anime.com/search-index.json                 → catalog (~723 titles, cached 8h)
//   https://cloud.hindi-anime.com/data/episodes?slug=&season= → episodes & season count
//   https://cloud.hindi-anime.com/sources?id=&season=&ep=&movie= → servers (ravok.buzz, PlayZen, GDrive)
//
// NOTE: Next.js SSR HTML pages & /api/* routes on hindi-anime.com are flaky
// (500 / 0-byte cached HTML) and cloud.hindi-anime.com/stream returns 401.
// Only the three verified public JSON endpoints above are used.
// ══════════════════════════════════════════════════════════════

const BASE = (process.env.HINDIANIME_BASE_URL || 'https://hindi-anime.com').replace(/\/+$/, '');
const CLOUD_BASE = (process.env.HINDIANIME_CLOUD_URL || 'https://cloud.hindi-anime.com').replace(/\/+$/, '');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// Cache search-index.json for 8 hours (within 6–12h requirement)
const SEARCH_INDEX_TTL_SEC = 8 * 60 * 60;
// Short cache for /sources (2 minutes)
const SOURCES_CACHE_TTL_SEC = 120;

const jsonHttp = axios.create({
  timeout: 12000,
  headers: {
    'User-Agent': UA,
    Accept: 'application/json, */*',
  },
});

export interface HindiAnimeIndexItem {
  id: string;
  slug: string;
  title: string;
  synopsis?: string;
  poster?: string;
  backdrop?: string;
  rating?: number;
  year?: number;
  type?: string; // "TV" | "Movie" | ...
  status?: string;
  genres?: string[];
  languages?: string[];
  seasons?: number;
}

export interface HindiAnimeSearchResult {
  slug: string;
  title: string;
  type: string;
  isMovie: boolean;
  image?: string;
  seasons: number;
  languages: string[];
  score: number;
}

export interface HindiAnimeEpisode {
  num: number;
  season: number;
  id: string; // "{slug}::{season}::{epNum}::{isMovie}"
  title: string;
  thumbnail?: string;
}

export interface HindiAnimeServer {
  name: string;
  sourceId: string; // "fireplayer::{url}" | "playzen::{url}" | "gdrive::{url}"
  type: 'sub' | 'dub' | 'raw';
  priority: number;
  host: string;
  language?: string;
  languageCode?: string;
  multiAudio?: boolean;
  playbackMode?: 'hls' | 'iframe';
}

export interface HindiAnimeStream {
  embedUrl: string;
  m3u8: string | null;
  mp4: null;
  mkv?: string | null;
  mkvQuality?: string | null;
  mkvMimeType?: string | null;
  mkvSources?: PlayZenSource[];
  referer?: string;
  subtitles: HlsSubtitleTrack[];
  qualities: HlsQuality[];
  audioTracks: HlsAudioTrack[];
  languages: string[];
  isoLanguages?: string[];
  singleLanguage?: string | null;
  singleLanguageCode?: string | null;
  serverName: string;
  type: 'hls' | 'iframe';
}

export interface ParsedHindiAnimeSiteId {
  slug: string;
  isMovie: boolean;
  seasonHint: number | null;
}

export function encodeHindiAnimeSiteId(slug: string, isMovie: boolean, seasonHint: number | null = null): string {
  const movieFlag = isMovie ? '1' : '0';
  return seasonHint && seasonHint > 0 ? `${slug}::${movieFlag}::s${seasonHint}` : `${slug}::${movieFlag}`;
}

export function parseHindiAnimeSiteId(siteId: string): ParsedHindiAnimeSiteId {
  const parts = siteId.trim().split('::');
  const slug = parts[0] || '';
  const isMovie = parts[1] === '1';
  const seasonMatch = (parts[2] || '').match(/^s(\d+)$/i);
  const seasonHint = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
  return { slug, isMovie, seasonHint };
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function significantWords(s: string): string[] {
  return normalizeTitle(s)
    .split(' ')
    .filter((w) => w.length >= 2);
}

const PENALTY_WORDS = new Set([
  'ova', 'ona', 'special', 'specials', 'recap', 'pv', 'lego', 'live', 'chibi', 'parody', 'boruto',
]);

function scoreTitle(query: string, candidateTitle: string, candidateSlug: string): number {
  const needle = normalizeTitle(query);
  const hay = normalizeTitle(candidateTitle);
  const slugHay = normalizeTitle(candidateSlug.replace(/-/g, ' '));
  if (!needle || (!hay && !slugHay)) return 0;

  if (hay === needle || slugHay === needle) return 100;

  if (hay.includes('live action') && !needle.includes('live action')) return 5;
  const queryWords = new Set(significantWords(needle));
  const candWords = significantWords(hay || slugHay);
  if (candWords.some((w) => PENALTY_WORDS.has(w) && !queryWords.has(w))) return 10;

  const qCompact = needle.replace(/\s+/g, '');
  const hCompact = hay.replace(/\s+/g, '');
  if (qCompact && hCompact && qCompact === hCompact) return 98;

  const ratio = Math.min(qCompact.length, hCompact.length) / Math.max(qCompact.length, hCompact.length, 1);

  if (hay.startsWith(needle + ' ') || hay.startsWith(needle + ':')) {
    return ratio >= 0.65 ? 88 : Math.floor(ratio * 65);
  }
  if (needle.startsWith(hay + ' ') || needle.startsWith(hay + ':')) {
    const missingWords = significantWords(needle).length - candWords.length;
    if (missingWords >= 1) return Math.floor(ratio * 45);
    return 75;
  }

  const qTokens = needle.split(' ').filter(Boolean);
  const hTokens = hay.split(' ').filter(Boolean);
  if (qTokens.length >= 1 && hTokens.length >= 1) {
    const overlap = qTokens.filter((t) => hTokens.includes(t)).length;
    const qCov = overlap / qTokens.length;
    const hCov = overlap / hTokens.length;
    if (qCov >= 0.9 && hCov >= 0.65) return 80;
    if (qCov >= 0.75 && hCov >= 0.55) return 65;
    if (qTokens.length === 1 && hay.includes(needle) && ratio >= 0.5) return 60;
  }

  return 0;
}

// ══════════════════════════════════════════════════════════════
// SEARCH INDEX (cached 8h, in-flight coalesced)
// ══════════════════════════════════════════════════════════════

let searchIndexInFlight: Promise<HindiAnimeIndexItem[]> | null = null;

export async function loadHindiAnimeIndex(): Promise<HindiAnimeIndexItem[]> {
  const cacheKey = 'hindianime:search-index:v1';
  const cached = cacheGet<HindiAnimeIndexItem[]>(cacheKey);
  if (cached) return cached;

  if (searchIndexInFlight) return searchIndexInFlight;

  const req = (async (): Promise<HindiAnimeIndexItem[]> => {
    try {
      const res = await jsonHttp.get(`${BASE}/search-index.json`, { timeout: 15000 });
      const items = Array.isArray(res.data) ? (res.data as HindiAnimeIndexItem[]) : [];
      const valid = items.filter((item) => item && typeof item.slug === 'string' && typeof item.title === 'string');
      if (valid.length > 0) {
        cacheSetTtl(cacheKey, valid, SEARCH_INDEX_TTL_SEC);
      }
      return valid;
    } catch (err: any) {
      console.warn('[hindianime] Failed to fetch search-index.json', {
        status: err?.response?.status,
        message: err?.message || String(err),
      });
      return [];
    }
  })();

  searchIndexInFlight = req;
  try {
    return await req;
  } finally {
    if (searchIndexInFlight === req) searchIndexInFlight = null;
  }
}

export async function searchHindiAnime(query: string, limit = 15): Promise<HindiAnimeSearchResult[]> {
  const cleaned = query.trim();
  if (!cleaned) return [];

  const index = await loadHindiAnimeIndex();
  if (!index.length) return [];

  const needle = normalizeTitle(cleaned);
  const scored: HindiAnimeSearchResult[] = [];

  for (const item of index) {
    let score = scoreTitle(cleaned, item.title, item.slug);
    // Allow partial substring match for user-facing search queries (but keep below strong matches)
    if (score === 0 && needle.length >= 3) {
      const hay = normalizeTitle(item.title);
      if (hay.includes(needle) && !(hay.includes('live action') && !needle.includes('live action'))) {
        score = 45;
      }
    }
    if (score < 45) continue;

    scored.push({
      slug: item.slug,
      title: item.title,
      type: item.type || 'TV',
      isMovie: String(item.type || '').toLowerCase() === 'movie',
      image: item.poster || undefined,
      seasons: Number(item.seasons) || 1,
      languages: Array.isArray(item.languages) ? item.languages : ['hindi'],
      score,
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.title.length - b.title.length)
    .slice(0, limit);
}

export async function findHindiAnimeSlug(title: string, altTitle?: string | null): Promise<string | null> {
  const rawTitles = Array.from(
    new Set([title, altTitle].filter((t): t is string => typeof t === 'string' && t.trim().length >= 2))
  );
  if (!rawTitles.length) return null;

  const index = await loadHindiAnimeIndex();
  if (!index.length) return null;

  // Pass 1: preserve full original title (so "Naruto Shippuden" matches "naruto-shippuden", not "naruto")
  for (const raw of rawTitles) {
    const ranked = index
      .map((item) => ({ item, score: scoreTitle(raw, item.title, item.slug) }))
      .filter((r) => r.score >= 80)
      .sort((a, b) => b.score - a.score);

    if (ranked.length > 0) {
      const topScore = ranked[0].score;
      const tied = ranked.filter((r) => r.score === topScore && r.item.slug !== ranked[0].item.slug);
      if (tied.length === 0) {
        const isMovie = String(ranked[0].item.type || '').toLowerCase() === 'movie';
        return encodeHindiAnimeSiteId(ranked[0].item.slug, isMovie, null);
      }
    }
  }

  // Pass 2: strip season markers via extractSeasonHintExtended and preserve seasonHint
  let bestOverall: { item: HindiAnimeIndexItem; score: number; seasonHint: number | null } | null = null;
  let ambiguous = false;

  for (const raw of rawTitles) {
    const { base, season } = extractSeasonHintExtended(raw);
    const variants = Array.from(
      new Set([base, base.split(/[:|–—]/)[0]?.trim()].filter((v): v is string => Boolean(v && v.length >= 3)))
    );

    for (const variant of variants) {
      const ranked = index
        .map((item) => ({
          item,
          score: Math.max(scoreTitle(base, item.title, item.slug), scoreTitle(variant, item.title, item.slug)),
          seasonHint: season,
        }))
        .filter((r) => r.score >= 70)
        .sort((a, b) => b.score - a.score);

      if (!ranked.length) continue;

      const top = ranked[0];
      const tied = ranked.filter((r) => r.score === top.score && r.item.slug !== top.item.slug);
      if (tied.length > 0) {
        ambiguous = true;
        continue;
      }

      if (!bestOverall || top.score > bestOverall.score) {
        bestOverall = top;
        ambiguous = false;
      }
      if (top.score >= 95) break;
    }
    if (bestOverall && bestOverall.score >= 95) break;
  }

  if (!bestOverall || ambiguous) return null;
  const isMovie = String(bestOverall.item.type || '').toLowerCase() === 'movie';
  return encodeHindiAnimeSiteId(bestOverall.item.slug, isMovie, bestOverall.seasonHint);
}

// ══════════════════════════════════════════════════════════════
// EPISODES API (cloud.hindi-anime.com/data/episodes)
// ══════════════════════════════════════════════════════════════

interface SeasonEpisodesPayload {
  totalSeasons: number;
  seasonNumbers: number[];
  episodes: HindiAnimeEpisode[];
}

export function normalizeHindiAnimeEpisodeItem(
  raw: any,
  requestedSeason: number,
  index: number,
  slug: string,
  isMovie: boolean
): HindiAnimeEpisode {
  const title = typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim() : `Episode ${index + 1}`;
  const image = typeof raw?.image === 'string' && /^https?:\/\//i.test(raw.image) ? raw.image : undefined;

  // CRITICAL QUIRK: cloud.hindi-anime.com/data/episodes often places the episode number
  // inside `raw.season` (e.g. { title: "Solo Leveling 2x1", season: "1" } or
  // One Piece S21 { season: "1089" }). Prefer an explicit SxE pattern in the title first!
  const sxeMatch = title.match(/\b(\d+)\s*[xX]\s*(\d+(?:\.\d+)?)\b/);

  let season = requestedSeason;
  let num: number;

  if (sxeMatch) {
    season = parseInt(sxeMatch[1], 10) || requestedSeason;
    num = parseFloat(sxeMatch[2]);
  } else {
    const rawEpField = raw?.episode ?? raw?.number ?? raw?.season;
    const parsedNum = rawEpField !== undefined && rawEpField !== null ? parseFloat(String(rawEpField)) : NaN;
    num = Number.isFinite(parsedNum) && parsedNum > 0 ? parsedNum : index + 1;
  }

  const movieFlag = isMovie ? '1' : '0';
  return {
    num,
    season,
    id: `${slug}::${season}::${num}::${movieFlag}`,
    title,
    thumbnail: image,
  };
}

export async function getHindiAnimeSeasonEpisodes(
  slug: string,
  season: number,
  isMovie = false
): Promise<SeasonEpisodesPayload> {
  const cacheKey = `hindianime:eps:${slug}:s${season}`;
  const cached = cacheGet<SeasonEpisodesPayload>(cacheKey);
  if (cached) return cached;

  try {
    const res = await jsonHttp.get(`${CLOUD_BASE}/data/episodes`, {
      params: { slug, season: String(season) },
      timeout: 12000,
    });

    const results = res.data?.results || res.data || {};
    const rawList: any[] = Array.isArray(results?.episodes) ? results.episodes : [];
    const totalSeasons =
      parseInt(String(results?.totalSeasons || ''), 10) ||
      (Array.isArray(results?.seasons) ? results.seasons.length : 1) ||
      1;

    const seasonNumbers: number[] = Array.isArray(results?.seasons)
      ? results.seasons
          .map((s: any) => parseInt(String(s?.season), 10))
          .filter((n: number) => Number.isFinite(n) && n > 0)
          .sort((a: number, b: number) => a - b)
      : Array.from({ length: totalSeasons }, (_, i) => i + 1);

    const episodes: HindiAnimeEpisode[] = [];
    const seen = new Set<string>();
    rawList.forEach((raw, idx) => {
      const ep = normalizeHindiAnimeEpisodeItem(raw, season, idx, slug, isMovie);
      if (!seen.has(ep.id)) {
        seen.add(ep.id);
        episodes.push(ep);
      }
    });

    episodes.sort((a, b) => a.season - b.season || a.num - b.num);

    const payload: SeasonEpisodesPayload = {
      totalSeasons: Math.max(totalSeasons, seasonNumbers.length || 1),
      seasonNumbers: seasonNumbers.length ? seasonNumbers : [season],
      episodes,
    };

    if (episodes.length > 0) cacheSet(cacheKey, payload, 'episodes');
    return payload;
  } catch (err: any) {
    console.warn('[hindianime] Failed to fetch season episodes', {
      slug,
      season,
      status: err?.response?.status,
      message: err?.message || String(err),
    });
    return { totalSeasons: 1, seasonNumbers: [season], episodes: [] };
  }
}

async function runBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function getHindiAnimeEpisodes(
  siteId: string,
  opts: { season?: number; targetEp?: number } = {}
): Promise<HindiAnimeEpisode[]> {
  const parsed = parseHindiAnimeSiteId(siteId);
  if (!parsed.slug) return [];

  if (parsed.isMovie) {
    return [
      {
        num: 1,
        season: 1,
        id: `${parsed.slug}::1::1::1`,
        title: parsed.slug.replace(/-/g, ' '),
      },
    ];
  }

  const effectiveSeason = opts.season ?? parsed.seasonHint;
  if (effectiveSeason) {
    const seasonData = await getHindiAnimeSeasonEpisodes(parsed.slug, effectiveSeason, false);
    return seasonData.episodes;
  }

  // Always start with Season 1 (gives us both S1 episodes and the exact season list)
  const s1 = await getHindiAnimeSeasonEpisodes(parsed.slug, 1, false);
  const allSeasonNums = s1.seasonNumbers.length ? s1.seasonNumbers : [1];

  // Fast path for /servers & /watch when a target episode number is requested
  if (opts.targetEp !== undefined) {
    if (s1.episodes.some((e) => Math.round(e.num) === opts.targetEp)) {
      return s1.episodes;
    }

    const remaining = allSeasonNums.filter((n) => n !== 1);
    if (remaining.length > 0) {
      // Binary search across seasons 2..N for monotonic absolute-numbered long shows
      // (e.g., One Piece S21 ep 1089 resolves in ~4 requests instead of 21!)
      let lo = 0;
      let hi = remaining.length - 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const sNum = remaining[mid];
        const data = await getHindiAnimeSeasonEpisodes(parsed.slug, sNum, false);
        if (data.episodes.some((e) => Math.round(e.num) === opts.targetEp)) {
          return data.episodes;
        }
        if (!data.episodes.length) break;
        const minEp = data.episodes[0].num;
        const maxEp = data.episodes[data.episodes.length - 1].num;
        if (opts.targetEp < minEp) {
          hi = mid - 1;
        } else if (opts.targetEp > maxEp) {
          lo = mid + 1;
        } else {
          break;
        }
      }
    }
  }

  // Full multi-season listing (bounded concurrency 4, cached 1h)
  const allCacheKey = `hindianime:eps:all:${parsed.slug}`;
  const cachedAll = cacheGet<HindiAnimeEpisode[]>(allCacheKey);
  if (cachedAll) return cachedAll;

  const restNums = allSeasonNums.filter((n) => n !== 1);
  const restPayloads = await runBounded(restNums, 4, (sNum) =>
    getHindiAnimeSeasonEpisodes(parsed.slug, sNum, false)
  );

  const merged: HindiAnimeEpisode[] = [];
  const seen = new Set<string>();
  for (const list of [s1.episodes, ...restPayloads.map((p) => p.episodes)]) {
    for (const ep of list) {
      if (!seen.has(ep.id)) {
        seen.add(ep.id);
        merged.push(ep);
      }
    }
  }
  merged.sort((a, b) => a.season - b.season || a.num - b.num);
  if (merged.length > 0) cacheSet(allCacheKey, merged, 'episodes');
  return merged;
}

// ══════════════════════════════════════════════════════════════
// SERVERS & STREAM EXTRACTION (cloud.hindi-anime.com/sources)
// ══════════════════════════════════════════════════════════════

export async function getHindiAnimeServers(episodeId: string): Promise<HindiAnimeServer[]> {
  const [slug, seasonStr, epStr, movieFlag] = episodeId.split('::');
  if (!slug || !seasonStr || !epStr) return [];

  const cacheKey = `hindianime:servers:${episodeId}`;
  const cached = cacheGet<HindiAnimeServer[]>(cacheKey);
  if (cached) return cached;

  const servers: HindiAnimeServer[] = [];
  const seen = new Set<string>();

  try {
    const res = await jsonHttp.get(`${CLOUD_BASE}/sources`, {
      params: {
        id: slug,
        season: seasonStr,
        ep: epStr,
        movie: movieFlag === '1' ? '1' : '0',
      },
      timeout: 12000,
      validateStatus: (status) => status >= 200 && status < 500,
    });

    if (res.status !== 200 || !res.data) return [];

    const rawResults: any[] = Array.isArray(res.data?.results)
      ? res.data.results
      : Array.isArray(res.data?.sources)
        ? res.data.sources
        : [];

    for (const item of rawResults) {
      const embed = String(item?.embed || item?.url || '').trim();
      if (!/^https?:\/\//i.test(embed) || seen.has(embed)) continue;
      seen.add(embed);

      // Priority 1: ravok.buzz (FirePlayer multi-audio HLS)
      if (isFirePlayerUrl(embed)) {
        for (const streamType of ['dub', 'sub', 'raw'] as const) {
          servers.push({
            name: 'FirePlayer (Multi-Audio)',
            sourceId: `fireplayer::${embed}`,
            type: streamType,
            priority: 1,
            host: 'ravok.buzz',
            multiAudio: true,
            playbackMode: 'hls',
          });
        }
        continue;
      }

      // Priority 2: PlayZen (archive.animeinfinity.me — direct MKV / iframe)
      if (isPlayZenUrl(embed) || /playzen/i.test(String(item?.sourceProvider || item?.source || ''))) {
        for (const streamType of ['dub', 'sub', 'raw'] as const) {
          servers.push({
            name: 'PlayZen (Multi-Audio)',
            sourceId: `playzen::${embed}`,
            type: streamType,
            priority: 2,
            host: 'archive.animeinfinity.me',
            multiAudio: false,
            playbackMode: 'iframe',
          });
        }
        continue;
      }

      // Priority 3: Google Drive (iframe-only fallback)
      if (embed.includes('drive.google.com') || /google.?drive/i.test(String(item?.sourceProvider || item?.source || ''))) {
        servers.push({
          name: 'GoogleDrive (Hindi Dub)',
          sourceId: `gdrive::${embed}`,
          type: 'dub',
          priority: 3,
          host: 'drive.google.com',
          language: 'hi',
          languageCode: 'hin',
          multiAudio: false,
          playbackMode: 'iframe',
        });
      }
    }
  } catch (err: any) {
    console.warn('[hindianime] Failed to fetch sources', {
      episodeId,
      status: err?.response?.status,
      message: err?.message || String(err),
    });
  }

  servers.sort((a, b) => a.priority - b.priority);
  if (servers.length > 0) cacheSetTtl(cacheKey, servers, SOURCES_CACHE_TTL_SEC);
  return servers;
}

export async function getHindiAnimeStream(sourceId: string): Promise<HindiAnimeStream | null> {
  if (sourceId.startsWith('fireplayer::')) {
    const embedUrl = sourceId.slice('fireplayer::'.length);
    const extracted = await extractFirePlayer(embedUrl, `${BASE}/`, 'FirePlayer (Multi-Audio)');
    if (!extracted) return null;
    // Use actual HLS master audio tracks as source of truth (never hardcode Hindi-only)
    return {
      embedUrl: extracted.embedUrl,
      m3u8: extracted.m3u8,
      mp4: null,
      referer: extracted.referer,
      subtitles: extracted.subtitles,
      qualities: extracted.qualities,
      audioTracks: extracted.audioTracks,
      languages: extracted.languages,
      isoLanguages: extracted.isoLanguages,
      serverName: extracted.serverName,
      type: 'hls',
    };
  }

  if (sourceId.startsWith('playzen::')) {
    const embedUrl = sourceId.slice('playzen::'.length);
    const extracted = await extractPlayZen(embedUrl, `${BASE}/`);
    if (!extracted) return null;
    return {
      embedUrl: extracted.embedUrl,
      m3u8: null,
      mp4: null,
      mkv: extracted.directUrl,
      mkvQuality: extracted.quality,
      mkvMimeType: extracted.mimeType,
      mkvSources: extracted.sources,
      referer: extracted.referer,
      subtitles: [],
      qualities: extracted.sources.map((s) => ({ label: s.quality, url: s.url })),
      audioTracks: [],
      languages: [],
      serverName: extracted.serverName,
      type: 'iframe',
    };
  }

  if (sourceId.startsWith('gdrive::')) {
    const embedUrl = sourceId.slice('gdrive::'.length);
    if (!/^https?:\/\//i.test(embedUrl)) return null;
    return {
      embedUrl,
      m3u8: null,
      mp4: null,
      referer: `${BASE}/`,
      subtitles: [],
      qualities: [],
      audioTracks: [],
      languages: ['hin'],
      isoLanguages: ['hi'],
      singleLanguage: 'hi',
      singleLanguageCode: 'hin',
      serverName: 'GoogleDrive (Hindi Dub)',
      type: 'iframe',
    };
  }

  return null;
}
