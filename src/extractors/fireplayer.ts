import axios from 'axios';
import { cacheGet, cacheSetTtl } from '../utils/cache';
import {
  cleanHlsUrl,
  fetchAndParseHlsMaster,
  formatAudioLangName,
  HlsAudioTrack,
  HlsQuality,
  HlsSubtitleTrack,
  normalizeAudioIso639_1,
  normalizeAudioLangCode,
} from '../utils/hls';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// Signed ravok.buzz URLs carry md5 + expires tokens. Keep any cache very short (2 min).
const FIREPLAYER_CACHE_TTL_SEC = 120;

export interface FirePlayerStream {
  embedUrl: string;
  m3u8: string;
  referer: string;
  subtitles: HlsSubtitleTrack[];
  qualities: HlsQuality[];
  audioTracks: HlsAudioTrack[];
  languages: string[]; // ISO 639-2 codes (backward-compatible)
  isoLanguages: string[]; // ISO 639-1 codes
  videoImage: string | null;
  serverName: string;
  type: 'hls';
}

export function extractFirePlayerHash(embedUrl: string): { origin: string; hash: string } | null {
  try {
    const parsed = new URL(embedUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const match = parsed.pathname.match(/\/video\/([a-f0-9A-Z_-]{8,128})/i);
    if (!match) return null;
    return { origin: parsed.origin, hash: match[1] };
  } catch {
    return null;
  }
}

export function isFirePlayerUrl(embedUrl: string): boolean {
  try {
    const parsed = new URL(embedUrl.trim());
    const host = parsed.hostname.toLowerCase();
    return (
      (host.includes('ravok.buzz') || host.includes('as-cdn') || host.includes('zephyrflick')) &&
      /\/video\/[a-f0-9A-Z_-]{8,128}/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Parses real subtitle entries embedded in FirePlayer's `/video/{hash}` HTML
 * (`var playerjsSubtitle = "[English]https://..."`).
 *
 * Returns an empty array when the episode carries no subtitles — never
 * fabricates subtitle tracks.
 */
export function parseFirePlayerEmbedSubtitles(html: string): HlsSubtitleTrack[] {
  if (!html || typeof html !== 'string') return [];

  const subMatch = html.match(/var\s+playerjsSubtitle\s*=\s*(["'])([\s\S]*?)\1/);
  if (!subMatch || !subMatch[2] || !subMatch[2].trim()) return [];

  const defMatch = html.match(/var\s+playerjsDefaultSubtitle\s*=\s*(["'])([\s\S]*?)\1/);
  const defaultName = defMatch?.[2]?.trim().toLowerCase() || '';

  const rawValue = subMatch[2].replace(/\\\//g, '/').trim();
  const tracks: HlsSubtitleTrack[] = [];
  const seenUrls = new Set<string>();

  for (const match of rawValue.matchAll(/\[([^\]]+)\]\s*(https?:\/\/[^,\s"'<>]+)/gi)) {
    const rawLabel = match[1].trim();
    const url = cleanHlsUrl(match[2]);
    if (!url || !/^https?:\/\//i.test(url) || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const name = rawLabel || formatAudioLangName('eng');
    const languageCode = normalizeAudioLangCode(rawLabel) || rawLabel.toLowerCase();
    const language = normalizeAudioIso639_1(rawLabel) || rawLabel.toLowerCase();

    tracks.push({
      id: tracks.length,
      name,
      lang: name,
      language,
      languageCode,
      originalLanguageCode: languageCode,
      url,
      uri: url,
      default: defaultName ? name.toLowerCase() === defaultName : false,
      autoselect: false,
    });
  }

  return tracks;
}

async function fetchFirePlayerEmbedSubtitles(embedUrl: string, referer: string): Promise<HlsSubtitleTrack[]> {
  try {
    const res = await axios.get<string>(embedUrl, {
      timeout: 8000,
      responseType: 'text',
      transformResponse: [(data) => data],
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: referer,
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });
    return parseFirePlayerEmbedSubtitles(String(res.data ?? ''));
  } catch {
    return [];
  }
}

/**
 * Reusable FirePlayer (ravok.buzz) stream extractor shared by AnimeSalt & Hindi Anime.
 *
 * Calls `POST {origin}/player/index.php?data={hash}&do=getVideo` with the
 * mandatory `X-Requested-With: XMLHttpRequest` header, extracts the fresh
 * signed master `.m3u8`, parses all audio/quality/subtitle tracks, and inspects
 * `/video/{hash}` in parallel for real `playerjsSubtitle` tracks.
 */
export async function extractFirePlayer(
  embedUrl: string,
  providerOrigin: string,
  serverName = 'FirePlayer'
): Promise<FirePlayerStream | null> {
  const info = extractFirePlayerHash(embedUrl);
  if (!info) {
    console.warn('[fireplayer] Invalid FirePlayer embed URL:', embedUrl);
    return null;
  }

  const normalizedOrigin = providerOrigin.endsWith('/') ? providerOrigin : `${providerOrigin}/`;
  const cacheKey = `fireplayer:v2:${info.origin}:${info.hash}:${normalizedOrigin}`;
  const cached = cacheGet<FirePlayerStream>(cacheKey);
  if (cached) return cached;

  const endpoint = `${info.origin}/player/index.php?data=${encodeURIComponent(info.hash)}&do=getVideo`;
  const formBody = new URLSearchParams({
    hash: info.hash,
    r: normalizedOrigin,
  }).toString();

  try {
    const [res, embedSubtitles] = await Promise.all([
      axios.post(endpoint, formBody, {
        timeout: 12000,
        headers: {
          'User-Agent': UA,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          Referer: embedUrl,
          Origin: info.origin,
        },
        validateStatus: (status) => status >= 200 && status < 500,
      }),
      fetchFirePlayerEmbedSubtitles(embedUrl, normalizedOrigin),
    ]);

    if (res.status !== 200) {
      console.warn('[fireplayer] Non-200 getVideo response', {
        embedUrl,
        status: res.status,
      });
      return null;
    }

    let data: any = res.data;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (trimmed.startsWith('<')) {
        console.warn('[fireplayer] Received HTML instead of JSON from getVideo', { embedUrl });
        return null;
      }
      try {
        data = JSON.parse(trimmed);
      } catch {
        console.warn('[fireplayer] Failed to parse JSON from getVideo', {
          embedUrl,
          snippet: trimmed.slice(0, 150),
        });
        return null;
      }
    }

    const rawM3u8: unknown = data?.securedLink || data?.videoSource;
    if (typeof rawM3u8 !== 'string' || !/^https?:\/\//i.test(rawM3u8)) {
      console.warn('[fireplayer] No playable HLS URL in getVideo payload', {
        embedUrl,
        hls: data?.hls,
      });
      return null;
    }

    const m3u8 = rawM3u8.replace(/\\\//g, '/').trim();
    const referer = `${info.origin}/`;

    let parsedMaster = {
      qualities: [] as HlsQuality[],
      audioTracks: [] as HlsAudioTrack[],
      subtitles: [] as HlsSubtitleTrack[],
      languages: [] as string[],
      isoLanguages: [] as string[],
    };
    try {
      parsedMaster = await fetchAndParseHlsMaster(m3u8, referer);
    } catch (err: any) {
      console.warn('[fireplayer] Failed to fetch/parse HLS master metadata (returning raw m3u8):', err?.message || String(err));
    }

    // Merge real subtitles from master HLS manifest + FirePlayer embed HTML (deduped by URL)
    const mergedSubs: HlsSubtitleTrack[] = [];
    const seenSubUrls = new Set<string>();
    for (const sub of [...parsedMaster.subtitles, ...embedSubtitles]) {
      if (!sub?.url || seenSubUrls.has(sub.url)) continue;
      seenSubUrls.add(sub.url);
      mergedSubs.push({ ...sub, id: mergedSubs.length });
    }

    const result: FirePlayerStream = {
      embedUrl,
      m3u8,
      referer,
      subtitles: mergedSubs,
      qualities: parsedMaster.qualities,
      audioTracks: parsedMaster.audioTracks,
      languages: parsedMaster.languages,
      isoLanguages: parsedMaster.isoLanguages,
      videoImage: typeof data?.videoImage === 'string' ? data.videoImage.replace(/\\\//g, '/') : null,
      serverName,
      type: 'hls',
    };

    cacheSetTtl(cacheKey, result, FIREPLAYER_CACHE_TTL_SEC);
    return result;
  } catch (err: any) {
    console.warn('[fireplayer] Extraction failed', {
      embedUrl,
      status: err?.response?.status,
      message: err?.message || String(err),
    });
    return null;
  }
}
