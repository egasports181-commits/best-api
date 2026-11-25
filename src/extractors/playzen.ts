import axios from 'axios';
import * as cheerio from 'cheerio';
import { cacheGet, cacheSetTtl } from '../utils/cache';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const PLAYZEN_CACHE_TTL_SEC = 180;

export interface PlayZenSource {
  url: string;
  quality: string;
  height: number;
  mimeType: string;
}

export interface PlayZenStream {
  embedUrl: string;
  directUrl: string | null;
  quality: string | null;
  mimeType: string | null;
  sources: PlayZenSource[];
  referer: string;
  playbackMode: 'iframe';
  serverName: string;
}

function detectQuality(url: string, label?: string): { quality: string; height: number } {
  const combined = `${label || ''} ${decodeURIComponent(url)}`;
  const match = combined.match(/\b(2160|1440|1080|720|480|360|240)p\b/i);
  if (match) {
    const height = parseInt(match[1], 10);
    return { quality: `${height}p`, height };
  }
  return { quality: 'unknown', height: 0 };
}

export function isPlayZenUrl(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host.includes('animeinfinity.me');
  } catch {
    return false;
  }
}

/**
 * PlayZen (`archive.animeinfinity.me`) extractor.
 *
 * Parses `<source>` elements from the player HTML (typically 480p and 720p
 * `video/x-matroska` streams). Prefers 720p when available, otherwise 480p.
 *
 * Returns `playbackMode: 'iframe'` for safe web playback (MKV lacks universal
 * browser `<video>` support), while exposing `directUrl`, `quality`, `mimeType`,
 * and `sources` so Android Media3/ExoPlayer clients can play direct MKV.
 */
export async function extractPlayZen(
  embedUrl: string,
  referer = 'https://hindi-anime.com/'
): Promise<PlayZenStream | null> {
  const trimmed = embedUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;

  const cacheKey = `playzen:v1:${trimmed}`;
  const cached = cacheGet<PlayZenStream>(cacheKey);
  if (cached) return cached;

  try {
    const res = await axios.get<string>(trimmed, {
      timeout: 12000,
      responseType: 'text',
      transformResponse: [(d) => d],
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: referer,
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const html = String(res.data ?? '');
    const $ = cheerio.load(html);
    const sources: PlayZenSource[] = [];
    const seen = new Set<string>();

    $('source').each((_, el) => {
      const src = $(el).attr('src')?.trim() || '';
      if (!/^https?:\/\//i.test(src) || seen.has(src)) return;
      seen.add(src);
      const mimeType = $(el).attr('type')?.trim() || (src.toLowerCase().includes('.mkv') ? 'video/x-matroska' : 'video/mp4');
      const sizeAttr = $(el).attr('size')?.trim() || $(el).attr('label')?.trim();
      const { quality, height } = detectQuality(src, sizeAttr ? `${sizeAttr}p` : undefined);
      sources.push({ url: src, quality, height, mimeType });
    });

    // Prefer 720p first, then 480p, then highest remaining resolution
    const preferred =
      sources.find((s) => s.height === 720) ||
      sources.find((s) => s.height === 480) ||
      [...sources].sort((a, b) => b.height - a.height)[0] ||
      null;

    const embedOrigin = new URL(trimmed).origin + '/';
    const result: PlayZenStream = {
      embedUrl: trimmed,
      directUrl: preferred?.url ?? null,
      quality: preferred?.quality ?? null,
      mimeType: preferred?.mimeType ?? null,
      sources,
      referer: embedOrigin,
      playbackMode: 'iframe',
      serverName: 'PlayZen',
    };

    cacheSetTtl(cacheKey, result, PLAYZEN_CACHE_TTL_SEC);
    return result;
  } catch (err: any) {
    console.warn('[playzen] Extraction failed', {
      embedUrl: trimmed,
      status: err?.response?.status,
      message: err?.message || String(err),
    });
    return null;
  }
}
