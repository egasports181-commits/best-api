import * as cheerio from 'cheerio';
import { makeClient, makeAjaxClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';
import { extractSeasonHint } from './tmdb';
import { extractFirePlayer, isFirePlayerUrl } from '../extractors/fireplayer';
import {
  HlsAudioTrack,
  HlsQuality,
  HlsSubtitleTrack,
  normalizeAudioIso639_1,
  normalizeAudioLangCode,
} from '../utils/hls';

// ══════════════════════════════════════════════════════════════
// ANIMESALT.CX — WordPress Torofilm Multi-Audio Anime Scraper
//   /?s={query}                               → primary HTML search
//   /wp-admin/admin-ajax.php (POST)           → action_tr_search_suggest fallback
//   /series/{slug}/ & /movies/{slug}/         → details + season buttons + postId
//   /wp-admin/admin-ajax.php (GET)            → action_select_season&season=&post=
//   /episode/{epSlug}/ & /movies/{slug}/      → #options-0 (ravok.buzz) + #options-1 (Abyss)
// ══════════════════════════════════════════════════════════════

const BASE = (process.env.ANIMESALT_BASE_URL || 'https://animesalt.cx').replace(/\/+$/, '');
const http = makeClient(BASE, BASE + '/');
const ajax = makeAjaxClient(BASE, BASE + '/');

export interface AnimesaltSearchResult {
  slug: string;
  mediaType: 'series' | 'movies';
  title: string;
  url: string;
  image?: string;
}

export interface AnimesaltSeasonInfo {
  season: number;
  label: string;
  rangeStart: number | null;
  rangeEnd: number | null;
  count: number | null;
  subOnly: boolean;
}

export interface AnimesaltDetails {
  slug: string;
  mediaType: 'series' | 'movies';
  postId: string | null;
  title: string;
  poster: string | null;
  seasons: AnimesaltSeasonInfo[];
}

export interface AnimesaltEpisode {
  num: number;
  season: number;
  id: string; // Episode slug (e.g. "solo-leveling-2x1") or "movie::{slug}"
  title: string;
  thumbnail?: string;
}

export interface AnimesaltServer {
  name: string;
  sourceId: string; // "fireplayer::{url}" or "abyss::{lang}::{url}"
  type: 'sub' | 'dub' | 'raw';
  language?: string;
  languageCode?: string;
  multiAudio?: boolean;
  playbackMode?: 'hls' | 'iframe';
  host?: string;
}

export interface AnimesaltStream {
  embedUrl: string;
  m3u8: string | null;
  mp4: null;
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

export interface ParsedAnimesaltSiteId {
  mediaType: 'series' | 'movies';
  slug: string;
  seasonHint: number | null;
}

export function parseAnimesaltSiteId(siteId: string): ParsedAnimesaltSiteId {
  const trimmed = siteId.trim();
  const match = trimmed.match(/^(series|movies):([^:]+)(?::s(\d+))?$/i);
  if (match) {
    return {
      mediaType: match[1].toLowerCase() as 'series' | 'movies',
      slug: match[2],
      seasonHint: match[3] ? parseInt(match[3], 10) : null,
    };
  }
  return { mediaType: 'series', slug: trimmed, seasonHint: null };
}

export function encodeAnimesaltSiteId(
  mediaType: 'series' | 'movies',
  slug: string,
  seasonHint: number | null = null
): string {
  if (mediaType === 'movies') return `movies:${slug}`;
  return seasonHint && seasonHint > 0 ? `series:${slug}:s${seasonHint}` : `series:${slug}`;
}

function normalizeImageUrl(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('data:')) return undefined;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('/')) return `${BASE}${trimmed}`;
  return trimmed;
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

/**
 * Extends tmdb.ts's extractSeasonHint() to also handle subtitled season names
 * like "Solo Leveling Season 2 -Arise from the Shadow-" where the season number
 * appears before a subtitle rather than strictly at the end of the string.
 */
export function extractSeasonHintExtended(title: string): { base: string; season: number | null } {
  const fromTmdb = extractSeasonHint(title);
  if (fromTmdb.season !== null) return fromTmdb;

  const midSeason = title.match(/^(.+?)\s+(?:season\s+(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)\s+season)\b/i);
  if (midSeason) {
    const base = midSeason[1].replace(/[:\-–|]\s*$/, '').trim();
    const season = parseInt(midSeason[2] || midSeason[3], 10);
    if (base.length >= 2 && Number.isFinite(season) && season >= 1) {
      return { base, season };
    }
  }

  return { base: title.trim(), season: null };
}

function scoreTitleMatch(query: string, candidateTitle: string, candidateSlug: string): number {
  const needle = normalizeTitle(query);
  const hay = normalizeTitle(candidateTitle);
  const slugHay = normalizeTitle(candidateSlug.replace(/-/g, ' '));
  if (!needle || !hay) return 0;

  if (hay === needle || slugHay === needle) return 100;

  const queryWords = new Set(significantWords(needle));
  const candWords = significantWords(hay);
  const hasUnrequestedPenalty = candWords.some((w) => PENALTY_WORDS.has(w) && !queryWords.has(w));
  if (hasUnrequestedPenalty) return 10;

  // Guard against live-action / spinoff mismatches (e.g. "One Piece" vs "One Piece Live Action")
  if (hay.includes('live action') && !needle.includes('live action')) return 5;

  const qCompact = needle.replace(/\s+/g, '');
  const hCompact = hay.replace(/\s+/g, '');
  if (qCompact === hCompact) return 98;

  const ratio = Math.min(qCompact.length, hCompact.length) / Math.max(qCompact.length, hCompact.length);

  // Prefix matches (e.g. "Solo Leveling" vs "Solo Leveling - Watch Now...")
  if (hay.startsWith(needle + ' ') || hay.startsWith(needle + ':')) {
    return ratio >= 0.65 ? 88 : Math.floor(ratio * 65);
  }
  if (needle.startsWith(hay + ' ') || needle.startsWith(hay + ':')) {
    // Reject short franchise matches when query explicitly asks for a sequel/different entry
    // (e.g., query "Naruto Shippuden" must NOT match candidate "Naruto")
    const missingWords = significantWords(needle).length - candWords.length;
    if (missingWords >= 1) return Math.floor(ratio * 45);
    return 75;
  }

  const qTokens = needle.split(' ').filter(Boolean);
  const hTokens = hay.split(' ').filter(Boolean);
  if (qTokens.length >= 2 && hTokens.length >= 2) {
    const overlap = qTokens.filter((t) => hTokens.includes(t)).length;
    const qCov = overlap / qTokens.length;
    const hCov = overlap / hTokens.length;
    if (qCov >= 0.9 && hCov >= 0.65) return 78;
    if (qCov >= 0.75 && hCov >= 0.65) return 65;
  }

  return 0;
}

// ══════════════════════════════════════════════════════════════
// SEARCH
// ══════════════════════════════════════════════════════════════

export async function searchAnimesalt(query: string): Promise<AnimesaltSearchResult[]> {
  const cleaned = query.trim();
  if (!cleaned) return [];

  const cacheKey = `animesalt:search:${cleaned.toLowerCase()}`;
  const cached = cacheGet<AnimesaltSearchResult[]>(cacheKey);
  if (cached) return cached;

  const results: AnimesaltSearchResult[] = [];
  const seen = new Set<string>();

  const pushResult = (item: AnimesaltSearchResult) => {
    const key = `${item.mediaType}:${item.slug}`;
    if (!item.slug || !item.title || seen.has(key)) return;
    seen.add(key);
    results.push(item);
  };

  // 1. Primary HTML search: GET /?s={query}
  try {
    const res = await http.get('/', {
      params: { s: cleaned },
      timeout: 12000,
    });
    const $ = cheerio.load(String(res.data ?? ''));

    $('article').each((_, el) => {
      const $el = $(el);
      const href =
        $el.find('a.lnk-blk').attr('href') ||
        $el.find('a[href*="/series/"], a[href*="/movies/"]').first().attr('href') ||
        '';
      const match = href.match(/\/(series|movies)\/([^/?#]+)/i);
      if (!match) return;

      const mediaType = match[1].toLowerCase() as 'series' | 'movies';
      const slug = match[2].replace(/\/+$/, '');
      const title =
        $el.find('.entry-title, h2, h3').first().text().trim() ||
        $el.find('img').first().attr('alt')?.replace(/^Image\s+/i, '').trim() ||
        '';
      const img = $el.find('img').first();
      const image = normalizeImageUrl(img.attr('data-src') || img.attr('src'));

      pushResult({
        slug,
        mediaType,
        title,
        url: `${BASE}/${mediaType}/${slug}/`,
        image,
      });
    });

    // Fallback scan if article cards differ on some search layouts
    if (results.length === 0) {
      $('a[href*="/series/"], a[href*="/movies/"]').each((_, el) => {
        const $el = $(el);
        const href = $el.attr('href') || '';
        const match = href.match(/\/(series|movies)\/([^/?#]+)/i);
        if (!match) return;
        const mediaType = match[1].toLowerCase() as 'series' | 'movies';
        const slug = match[2].replace(/\/+$/, '');
        const title =
          $el.attr('title')?.trim() ||
          $el.text().trim() ||
          slug.replace(/-/g, ' ');
        pushResult({
          slug,
          mediaType,
          title,
          url: `${BASE}/${mediaType}/${slug}/`,
        });
      });
    }
  } catch (err: any) {
    console.warn('[animesalt] Primary HTML search failed:', err?.response?.status ?? err?.message ?? String(err));
  }

  // 2. Fallback AJAX search: POST /wp-admin/admin-ajax.php (action_tr_search_suggest)
  if (results.length === 0) {
    try {
      const body = new URLSearchParams({
        action: 'action_tr_search_suggest',
        term: cleaned,
      }).toString();
      const res = await ajax.post('/wp-admin/admin-ajax.php', body, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 12000,
      });
      const $ = cheerio.load(String(res.data ?? ''));
      $('a[href*="/series/"], a[href*="/movies/"]').each((_, el) => {
        const $el = $(el);
        const href = $el.attr('href') || '';
        const match = href.match(/\/(series|movies)\/([^/?#]+)/i);
        if (!match) return;
        const mediaType = match[1].toLowerCase() as 'series' | 'movies';
        const slug = match[2].replace(/\/+$/, '');
        const clone = $el.clone();
        clone.find('span').remove();
        const title = clone.text().trim() || $el.text().trim();
        pushResult({
          slug,
          mediaType,
          title,
          url: `${BASE}/${mediaType}/${slug}/`,
        });
      });
    } catch (err: any) {
      console.warn('[animesalt] Fallback AJAX search failed:', err?.response?.status ?? err?.message ?? String(err));
    }
  }

  if (results.length > 0) {
    cacheSet(cacheKey, results, 'episodes');
  }
  return results;
}

export async function findAnimesaltSlug(title: string, altTitle?: string | null): Promise<string | null> {
  const rawTitles = Array.from(
    new Set([title, altTitle].filter((t): t is string => typeof t === 'string' && t.trim().length >= 2))
  );
  if (!rawTitles.length) return null;

  // Pass 1: try exact/full titles first (preserves "Naruto Shippuden" vs "Naruto")
  for (const raw of rawTitles) {
    const clean = raw.replace(/[’']/g, '').trim();
    const candidates = await searchAnimesalt(clean).catch(() => []);
    const ranked = candidates
      .map((c) => ({ item: c, score: scoreTitleMatch(raw, c.title, c.slug) }))
      .filter((r) => r.score >= 80)
      .sort((a, b) => b.score - a.score);

    if (ranked.length > 0) {
      const topScore = ranked[0].score;
      const topMatches = ranked.filter((r) => r.score === topScore);
      const uniqueSlugs = new Set(topMatches.map((r) => `${r.item.mediaType}:${r.item.slug}`));
      if (uniqueSlugs.size === 1) {
        return encodeAnimesaltSiteId(ranked[0].item.mediaType, ranked[0].item.slug, null);
      }
    }
  }

  // Pass 2: strip season markers via extractSeasonHintExtended and keep the season hint
  let bestOverall: { item: AnimesaltSearchResult; score: number; seasonHint: number | null } | null = null;
  let ambiguous = false;

  for (const raw of rawTitles) {
    const { base, season } = extractSeasonHintExtended(raw);
    const searchVariants = Array.from(
      new Set([base, base.split(/[:|–—]/)[0]?.trim()].filter((v): v is string => Boolean(v && v.length >= 3)))
    );

    for (const variant of searchVariants) {
      const candidates = await searchAnimesalt(variant).catch(() => []);
      if (!candidates.length) continue;

      const ranked = candidates
        .map((c) => ({
          item: c,
          score: Math.max(scoreTitleMatch(base, c.title, c.slug), scoreTitleMatch(variant, c.title, c.slug)),
          seasonHint: season,
        }))
        .filter((r) => r.score >= 70)
        .sort((a, b) => b.score - a.score);

      if (!ranked.length) continue;

      const top = ranked[0];
      const tied = ranked.filter(
        (r) => r.score === top.score && `${r.item.mediaType}:${r.item.slug}` !== `${top.item.mediaType}:${top.item.slug}`
      );
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
  return encodeAnimesaltSiteId(bestOverall.item.mediaType, bestOverall.item.slug, bestOverall.seasonHint);
}

// ══════════════════════════════════════════════════════════════
// DETAILS & SEASONS
// ══════════════════════════════════════════════════════════════

function parseSeasonButton(seasonAttr: string, text: string): AnimesaltSeasonInfo | null {
  const season = parseInt(seasonAttr, 10);
  if (!Number.isFinite(season) || season < 0) return null;

  const cleanText = text.replace(/\s+/g, ' ').trim();
  const rangeMatch = cleanText.match(/(\d+)\s*[-–]\s*(\d+)/);
  const countMatch = cleanText.match(/\((\d+)\)/);
  const subOnly = /\[sub\]/i.test(cleanText);

  return {
    season,
    label: cleanText || `Season ${season}`,
    rangeStart: rangeMatch ? parseInt(rangeMatch[1], 10) : null,
    rangeEnd: rangeMatch ? parseInt(rangeMatch[2], 10) : null,
    count: countMatch ? parseInt(countMatch[1], 10) : null,
    subOnly,
  };
}

export async function getAnimesaltDetails(siteId: string): Promise<AnimesaltDetails | null> {
  const { mediaType, slug } = parseAnimesaltSiteId(siteId);
  const cacheKey = `animesalt:details:${mediaType}:${slug}`;
  const cached = cacheGet<AnimesaltDetails>(cacheKey);
  if (cached) return cached;

  try {
    const res = await http.get(`/${mediaType}/${encodeURIComponent(slug)}/`, { timeout: 12000 });
    const html = String(res.data ?? '');
    const $ = cheerio.load(html);

    const title =
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content')?.replace(/\s*-\s*Anime Salt.*$/i, '').trim() ||
      slug.replace(/-/g, ' ');

    const poster =
      normalizeImageUrl($('meta[property="og:image"]').attr('content')) ||
      normalizeImageUrl($('.post-thumbnail img').first().attr('data-src') || $('.post-thumbnail img').first().attr('src')) ||
      null;

    let postId: string | null = null;
    const seasons: AnimesaltSeasonInfo[] = [];
    const seenSeasons = new Set<number>();

    $('a.season-btn, [data-season][data-post]').each((_, el) => {
      const $el = $(el);
      const p = $el.attr('data-post')?.trim();
      const s = $el.attr('data-season')?.trim();
      if (p && !postId) postId = p;
      if (!s) return;
      const info = parseSeasonButton(s, $el.text());
      if (info && !seenSeasons.has(info.season)) {
        seenSeasons.add(info.season);
        seasons.push(info);
      }
    });

    if (!postId) {
      const m = html.match(/data-post=["'](\d+)["']/i) || html.match(/postid-(\d+)/i);
      if (m) postId = m[1];
    }

    seasons.sort((a, b) => a.season - b.season);

    const details: AnimesaltDetails = {
      slug,
      mediaType,
      postId,
      title,
      poster,
      seasons,
    };

    cacheSet(cacheKey, details, 'episodes');
    return details;
  } catch (err: any) {
    console.warn('[animesalt] Failed to load details', {
      siteId,
      status: err?.response?.status,
      message: err?.message || String(err),
    });
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// EPISODES
// ══════════════════════════════════════════════════════════════

function parseEpisodeHtmlList(html: string, fallbackSeason: number): AnimesaltEpisode[] {
  const $ = cheerio.load(html);
  const episodes: AnimesaltEpisode[] = [];
  const seen = new Set<string>();

  $('article, li').each((_, el) => {
    const $el = $(el);
    const href =
      $el.find('a.lnk-blk').attr('href') ||
      $el.find('a[href*="/episode/"]').first().attr('href') ||
      ($el.is('a') ? $el.attr('href') : '') ||
      '';
    const epMatch = href.match(/\/episode\/([^/?#]+)/i);
    if (!epMatch) return;

    const epSlug = epMatch[1].replace(/\/+$/, '');
    if (!epSlug || seen.has(epSlug)) return;

    const title = $el.find('.entry-title, h2, h3').first().text().trim() || epSlug;
    const numEpiText = $el.find('.num-epi').first().text().trim();
    const imgEl = $el.find('img').first();
    const thumbnail = normalizeImageUrl(imgEl.attr('data-src') || imgEl.attr('src'));

    // Prefer SxE pattern from slug or title (handles both relative 2x1 and absolute 2x58 / 21x1089)
    const sxeSlug = epSlug.match(/-(\d+)x(\d+(?:\.\d+)?)$/i);
    const sxeTitle = title.match(/\b(\d+)\s*[xX]\s*(\d+(?:\.\d+)?)\b/);
    const sxe = sxeSlug || sxeTitle;

    let season = fallbackSeason;
    let num: number;
    if (sxe) {
      season = parseInt(sxe[1], 10) || fallbackSeason;
      num = parseFloat(sxe[2]);
    } else if (numEpiText && /^\d+(?:\.\d+)?$/.test(numEpiText)) {
      num = parseFloat(numEpiText);
    } else {
      const trailing = epSlug.match(/(\d+(?:\.\d+)?)$/);
      num = trailing ? parseFloat(trailing[1]) : episodes.length + 1;
    }

    if (!Number.isFinite(num)) return;
    seen.add(epSlug);
    episodes.push({ num, season, id: epSlug, title, thumbnail });
  });

  episodes.sort((a, b) => a.season - b.season || a.num - b.num);
  return episodes;
}

export async function getAnimesaltSeasonEpisodes(
  postId: string,
  season: number,
  slug: string
): Promise<AnimesaltEpisode[]> {
  const cacheKey = `animesalt:eps:${postId}:s${season}`;
  const cached = cacheGet<AnimesaltEpisode[]>(cacheKey);
  if (cached) return cached;

  try {
    const res = await ajax.get('/wp-admin/admin-ajax.php', {
      params: {
        action: 'action_select_season',
        season: String(season),
        post: postId,
      },
      headers: {
        Referer: `${BASE}/series/${encodeURIComponent(slug)}/`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 12000,
    });
    const episodes = parseEpisodeHtmlList(String(res.data ?? ''), season);
    if (episodes.length > 0) cacheSet(cacheKey, episodes, 'episodes');
    return episodes;
  } catch (err: any) {
    console.warn('[animesalt] Season AJAX fetch failed', {
      postId,
      season,
      slug,
      status: err?.response?.status,
      message: err?.message || String(err),
    });
    return [];
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

export async function getAnimesaltEpisodes(
  siteId: string,
  opts: { season?: number; targetEp?: number } = {}
): Promise<AnimesaltEpisode[]> {
  const parsed = parseAnimesaltSiteId(siteId);
  const details = await getAnimesaltDetails(siteId);
  if (!details) return [];

  // Movie entries are treated as a single episode (ep 1) without season AJAX calls
  if (details.mediaType === 'movies') {
    return [
      {
        num: 1,
        season: 1,
        id: `movie::${details.slug}`,
        title: details.title,
        thumbnail: details.poster ?? undefined,
      },
    ];
  }

  const effectiveSeason = opts.season ?? parsed.seasonHint;

  // Single-season target (explicit ?season= or seasonHint from title mapping)
  if (effectiveSeason && details.postId) {
    const seasonExists =
      details.seasons.length === 0 || details.seasons.some((s) => s.season === effectiveSeason);
    if (!seasonExists) return [];
    return getAnimesaltSeasonEpisodes(details.postId, effectiveSeason, details.slug);
  }

  // Fast path for /servers & /watch: use parsed season button ranges (e.g. "Season 21 • 1089-1155")
  // to fetch ONLY the single season containing targetEp instead of all 21 seasons!
  if (opts.targetEp !== undefined && details.postId && details.seasons.length > 0) {
    const matchingSeason = details.seasons.find(
      (s) => s.rangeStart !== null && s.rangeEnd !== null && opts.targetEp! >= s.rangeStart && opts.targetEp! <= s.rangeEnd
    );
    if (matchingSeason) {
      const seasonEps = await getAnimesaltSeasonEpisodes(details.postId, matchingSeason.season, details.slug);
      if (seasonEps.some((e) => Math.round(e.num) === opts.targetEp)) {
        return seasonEps;
      }
    }
  }

  // Full episode list (or range fallback): fetch seasons with bounded concurrency (4)
  if (details.postId && details.seasons.length > 0) {
    const allCacheKey = `animesalt:eps:all:${details.postId}`;
    const cachedAll = cacheGet<AnimesaltEpisode[]>(allCacheKey);
    if (cachedAll) return cachedAll;

    const perSeason = await runBounded(details.seasons, 4, (s) =>
      getAnimesaltSeasonEpisodes(details.postId!, s.season, details.slug)
    );
    const merged: AnimesaltEpisode[] = [];
    const seen = new Set<string>();
    for (const list of perSeason) {
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

  // Fallback: scrape episodes directly from the series page if no AJAX postId was found
  try {
    const res = await http.get(`/series/${encodeURIComponent(details.slug)}/`, { timeout: 12000 });
    return parseEpisodeHtmlList(String(res.data ?? ''), 1);
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// SERVERS & WATCH STREAM EXTRACTION
// ══════════════════════════════════════════════════════════════

function decodePlayerPhpLinks(iframeSrc: string): Array<{ language: string; link: string }> {
  try {
    const parsed = new URL(iframeSrc, BASE);
    const rawData = parsed.searchParams.get('data');
    if (!rawData) return [];
    const padded = rawData + '='.repeat((4 - (rawData.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const entries = JSON.parse(decoded);
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e: any) => typeof e?.link === 'string' && /^https?:\/\//i.test(e.link))
      .map((e: any) => ({
        language: String(e.language || 'Unknown').trim(),
        link: String(e.link).replace(/\\\//g, '/').trim(),
      }));
  } catch {
    return [];
  }
}

export async function getAnimesaltServers(episodeId: string): Promise<AnimesaltServer[]> {
  const cacheKey = `animesalt:servers:${episodeId}`;
  const cached = cacheGet<AnimesaltServer[]>(cacheKey);
  if (cached) return cached;

  const isMovie = episodeId.startsWith('movie::');
  const slug = isMovie ? episodeId.slice('movie::'.length) : episodeId;
  const path = isMovie ? `/movies/${encodeURIComponent(slug)}/` : `/episode/${encodeURIComponent(slug)}/`;

  const fireServers: AnimesaltServer[] = [];
  const abyssServers: AnimesaltServer[] = [];
  const seenUrls = new Set<string>();

  try {
    const res = await http.get(path, { timeout: 12000 });
    const $ = cheerio.load(String(res.data ?? ''));

    // Inspect #options-0, #options-1, and any additional #options-* player panes
    const iframes = $('[id^="options-"] iframe, .video iframe');
    iframes.each((_, el) => {
      const rawSrc = ($(el).attr('src') || $(el).attr('data-src') || '').trim();
      if (!rawSrc || seenUrls.has(rawSrc)) return;
      seenUrls.add(rawSrc);

      if (isFirePlayerUrl(rawSrc)) {
        // Multi-audio HLS master contains both dubs (Hindi/Tamil/Telugu/English/...) and Japanese audio
        for (const streamType of ['dub', 'sub', 'raw'] as const) {
          fireServers.push({
            name: 'FirePlayer (Multi-Audio)',
            sourceId: `fireplayer::${rawSrc}`,
            type: streamType,
            multiAudio: true,
            playbackMode: 'hls',
            host: 'ravok.buzz',
          });
        }
        return;
      }

      if (rawSrc.includes('player.php') && rawSrc.includes('data=')) {
        const langLinks = decodePlayerPhpLinks(rawSrc);
        for (const entry of langLinks) {
          const langCode = normalizeAudioLangCode(entry.language) || entry.language.toLowerCase();
          const isoLang = normalizeAudioIso639_1(entry.language) || langCode;
          const serverType: 'sub' | 'dub' = langCode === 'jpn' ? 'sub' : 'dub';
          abyssServers.push({
            name: `AbyssPlayer (${entry.language})`,
            sourceId: `abyss::${encodeURIComponent(entry.language)}::${entry.link}`,
            type: serverType,
            language: isoLang,
            languageCode: langCode,
            multiAudio: false,
            playbackMode: 'iframe',
            host: 'abyssplayer',
          });
          if (langCode === 'jpn') {
            abyssServers.push({
              name: `AbyssPlayer (${entry.language})`,
              sourceId: `abyss::${encodeURIComponent(entry.language)}::${entry.link}`,
              type: 'raw',
              language: isoLang,
              languageCode: langCode,
              multiAudio: false,
              playbackMode: 'iframe',
              host: 'abyssplayer',
            });
          }
        }
      }
    });
  } catch (err: any) {
    console.warn('[animesalt] Failed to fetch servers', {
      episodeId,
      status: err?.response?.status,
      message: err?.message || String(err),
    });
  }

  // Prioritize Hindi first among Abyss fallbacks, after FirePlayer multi-audio HLS
  abyssServers.sort((a, b) => {
    const rank = (lang?: string) => (lang === 'hin' ? 1 : lang === 'eng' ? 2 : lang === 'tam' ? 3 : lang === 'tel' ? 4 : 5);
    return rank(a.languageCode || a.language) - rank(b.languageCode || b.language);
  });

  const servers = [...fireServers, ...abyssServers];
  if (servers.length > 0) cacheSet(cacheKey, servers, 'episodes');
  return servers;
}

export async function getAnimesaltStream(sourceId: string): Promise<AnimesaltStream | null> {
  if (sourceId.startsWith('fireplayer::')) {
    const embedUrl = sourceId.slice('fireplayer::'.length);
    const extracted = await extractFirePlayer(embedUrl, `${BASE}/`, 'FirePlayer (Multi-Audio)');
    if (!extracted) return null;
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

  if (sourceId.startsWith('abyss::')) {
    const rest = sourceId.slice('abyss::'.length);
    const sep = rest.indexOf('::');
    const langLabel = sep >= 0 ? decodeURIComponent(rest.slice(0, sep)) : 'Unknown';
    const embedUrl = sep >= 0 ? rest.slice(sep + 2) : rest;
    if (!/^https?:\/\//i.test(embedUrl)) return null;
    const langCode = normalizeAudioLangCode(langLabel);
    const isoLang = normalizeAudioIso639_1(langLabel);
    // AbyssPlayer produces chunked MP4 metadata, not a direct HLS/standard MP4 URL.
    // Return as an iframe fallback without fabricating or proxying an abyss:// pseudo-URL.
    return {
      embedUrl,
      m3u8: null,
      mp4: null,
      referer: `${BASE}/`,
      subtitles: [],
      qualities: [],
      audioTracks: [],
      languages: langCode ? [langCode] : [],
      isoLanguages: isoLang ? [isoLang] : [],
      singleLanguage: isoLang || null,
      singleLanguageCode: langCode || null,
      serverName: `AbyssPlayer (${langLabel})`,
      type: 'iframe',
    };
  }

  return null;
}
