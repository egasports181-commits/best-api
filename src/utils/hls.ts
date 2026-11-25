import axios from 'axios';

export interface HlsSubtitleTrack {
  id?: number;
  name?: string;
  lang: string;
  language?: string;
  languageCode?: string;
  originalLanguageCode?: string;
  groupId?: string;
  url: string;
  uri?: string;
  default?: boolean;
  autoselect?: boolean;
}

export interface HlsQuality {
  label: string;
  url: string;
  bandwidth?: number;
  resolution?: string;
}

export interface HlsAudioTrack {
  id: number;
  name: string;
  language: string; // Normalized ISO 639-1 (hi, ta, te, en, ja, ml, kn, ...)
  languageCode: string; // Normalized ISO 639-2 (hin, tam, tel, eng, jpn, mal, kan, ...)
  originalLanguageCode: string; // Exact upstream LANGUAGE attribute (lowercased)
  code: string; // Backward-compatible alias for languageCode
  lang: string; // Backward-compatible alias for originalLanguageCode
  groupId: string;
  uri: string;
  url: string; // Backward-compatible alias for uri
  default: boolean;
  autoselect: boolean;
  channels?: string;
}

export interface ParsedHlsMaster {
  qualities: HlsQuality[];
  audioTracks: HlsAudioTrack[];
  subtitles: HlsSubtitleTrack[];
  languages: string[]; // Normalized ISO 639-2 codes (backward-compatible)
  isoLanguages: string[]; // Normalized ISO 639-1 codes
}

export type AudioPlaybackMode = 'japanese-sub' | 'japanese-raw' | 'dub-sub' | 'dub' | 'unknown';

export interface ResolvedAudioSelection {
  tracks: HlsAudioTrack[];
  selectedTrack: HlsAudioTrack | null;
  selectedAudio: string | null; // ISO 639-1 (e.g. "hi", "ja", "en")
  selectedAudioCode: string | null; // Upstream / ISO 639-2 code (e.g. "hin", "jpn", "eng")
  selectedAudioName: string | null;
  requestedAudio: string | null; // Requested ISO 639-1
  requestedAudioCode: string | null; // Requested ISO 639-2
  requestedAudioUnavailable: boolean;
  audioFallback: boolean;
  audioWarning: string | null;
}

const DEFAULT_HLS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

interface LangInfo {
  iso1: string;
  code: string;
  name: string;
}

const LANGUAGE_ALIASES: Record<string, LangInfo> = {
  hi: { iso1: 'hi', code: 'hin', name: 'Hindi' },
  hin: { iso1: 'hi', code: 'hin', name: 'Hindi' },
  hindi: { iso1: 'hi', code: 'hin', name: 'Hindi' },
  ta: { iso1: 'ta', code: 'tam', name: 'Tamil' },
  tam: { iso1: 'ta', code: 'tam', name: 'Tamil' },
  tamil: { iso1: 'ta', code: 'tam', name: 'Tamil' },
  te: { iso1: 'te', code: 'tel', name: 'Telugu' },
  tel: { iso1: 'te', code: 'tel', name: 'Telugu' },
  telugu: { iso1: 'te', code: 'tel', name: 'Telugu' },
  en: { iso1: 'en', code: 'eng', name: 'English' },
  eng: { iso1: 'en', code: 'eng', name: 'English' },
  english: { iso1: 'en', code: 'eng', name: 'English' },
  ja: { iso1: 'ja', code: 'jpn', name: 'Japanese' },
  jp: { iso1: 'ja', code: 'jpn', name: 'Japanese' },
  jpn: { iso1: 'ja', code: 'jpn', name: 'Japanese' },
  japanese: { iso1: 'ja', code: 'jpn', name: 'Japanese' },
  original: { iso1: 'ja', code: 'jpn', name: 'Japanese' },
  ml: { iso1: 'ml', code: 'mal', name: 'Malayalam' },
  mal: { iso1: 'ml', code: 'mal', name: 'Malayalam' },
  malayalam: { iso1: 'ml', code: 'mal', name: 'Malayalam' },
  kn: { iso1: 'kn', code: 'kan', name: 'Kannada' },
  kan: { iso1: 'kn', code: 'kan', name: 'Kannada' },
  kannada: { iso1: 'kn', code: 'kan', name: 'Kannada' },
  bn: { iso1: 'bn', code: 'ben', name: 'Bengali' },
  ben: { iso1: 'bn', code: 'ben', name: 'Bengali' },
  bengali: { iso1: 'bn', code: 'ben', name: 'Bengali' },
  mr: { iso1: 'mr', code: 'mar', name: 'Marathi' },
  mar: { iso1: 'mr', code: 'mar', name: 'Marathi' },
  marathi: { iso1: 'mr', code: 'mar', name: 'Marathi' },
  ko: { iso1: 'ko', code: 'kor', name: 'Korean' },
  kor: { iso1: 'ko', code: 'kor', name: 'Korean' },
  korean: { iso1: 'ko', code: 'kor', name: 'Korean' },
  zh: { iso1: 'zh', code: 'zho', name: 'Chinese' },
  zho: { iso1: 'zh', code: 'zho', name: 'Chinese' },
  chi: { iso1: 'zh', code: 'zho', name: 'Chinese' },
  chinese: { iso1: 'zh', code: 'zho', name: 'Chinese' },
  es: { iso1: 'es', code: 'spa', name: 'Spanish' },
  spa: { iso1: 'es', code: 'spa', name: 'Spanish' },
  spanish: { iso1: 'es', code: 'spa', name: 'Spanish' },
  fr: { iso1: 'fr', code: 'fra', name: 'French' },
  fra: { iso1: 'fr', code: 'fra', name: 'French' },
  fre: { iso1: 'fr', code: 'fra', name: 'French' },
  french: { iso1: 'fr', code: 'fra', name: 'French' },
  de: { iso1: 'de', code: 'deu', name: 'German' },
  deu: { iso1: 'de', code: 'deu', name: 'German' },
  ger: { iso1: 'de', code: 'deu', name: 'German' },
  german: { iso1: 'de', code: 'deu', name: 'German' },
  pt: { iso1: 'pt', code: 'por', name: 'Portuguese' },
  por: { iso1: 'pt', code: 'por', name: 'Portuguese' },
  portuguese: { iso1: 'pt', code: 'por', name: 'Portuguese' },
  ar: { iso1: 'ar', code: 'ara', name: 'Arabic' },
  ara: { iso1: 'ar', code: 'ara', name: 'Arabic' },
  arabic: { iso1: 'ar', code: 'ara', name: 'Arabic' },
  id: { iso1: 'id', code: 'ind', name: 'Indonesian' },
  ind: { iso1: 'id', code: 'ind', name: 'Indonesian' },
  indonesian: { iso1: 'id', code: 'ind', name: 'Indonesian' },
};

function lookupLangInfo(raw: string | undefined | null): LangInfo | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z-]/g, '');
  if (!cleaned) return null;
  if (LANGUAGE_ALIASES[cleaned]) return LANGUAGE_ALIASES[cleaned];
  const prefix = cleaned.split('-')[0];
  if (LANGUAGE_ALIASES[prefix]) return LANGUAGE_ALIASES[prefix];
  return null;
}

export function cleanHlsUrl(url: string): string {
  return url
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}

export function normalizeAudioLangCode(raw: string | undefined | null): string {
  if (!raw) return '';
  const info = lookupLangInfo(raw);
  if (info) return info.code;
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z-]/g, '');
  return cleaned;
}

export function normalizeAudioIso639_1(raw: string | undefined | null): string {
  if (!raw) return '';
  const info = lookupLangInfo(raw);
  if (info) return info.iso1;
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z-]/g, '');
  return cleaned.split('-')[0] || cleaned;
}

export function formatAudioLangName(codeOrName: string | undefined | null): string {
  if (!codeOrName) return 'Audio';
  const info = lookupLangInfo(codeOrName);
  if (info) return info.name;
  const trimmed = codeOrName.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Extracts a specific language hint from a server label (e.g. "Hindi Dub",
 * "Tamil Dub", "Japanese Sub") while returning empty string for generic labels
 * like "FirePlayer (Multi-Audio)".
 */
export function detectAudioLanguageHint(label: string | undefined | null): string {
  if (!label) return '';
  const lower = label.toLowerCase();
  if (/\bmulti[- ]?audio\b/.test(lower)) return '';
  const patterns: Array<[RegExp, string]> = [
    [/\bhindi\b/, 'hin'],
    [/\btamil\b/, 'tam'],
    [/\btelugu\b/, 'tel'],
    [/\bmalayalam\b/, 'mal'],
    [/\bkannada\b/, 'kan'],
    [/\bbengali\b/, 'ben'],
    [/\bmarathi\b/, 'mar'],
    [/\benglish\b/, 'eng'],
    [/\bjapanese\b/, 'jpn'],
    [/\bkorean\b/, 'kor'],
  ];
  for (const [regex, code] of patterns) {
    if (regex.test(lower)) return code;
  }
  return '';
}

export function parseHlsAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return attrs;
  const payload = line.slice(colonIdx + 1);
  for (const match of payload.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi)) {
    attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

export function parseHlsMaster(master: string, masterUrl: string): ParsedHlsMaster {
  const lines = master.split(/\r?\n/);
  const qualities: HlsQuality[] = [];
  const audioTracks: HlsAudioTrack[] = [];
  const subtitles: HlsSubtitleTrack[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(line)) {
      const attrs = parseHlsAttributes(line);
      if (attrs.URI) {
        const rawLangAttr = (attrs.LANGUAGE || '').trim();
        const rawCodeSource = rawLangAttr || attrs.NAME || 'audio';
        const originalLanguageCode = (rawLangAttr || rawCodeSource).toLowerCase();
        const languageCode = normalizeAudioLangCode(rawCodeSource) || originalLanguageCode;
        const language = normalizeAudioIso639_1(rawCodeSource) || originalLanguageCode;
        const name = (attrs.NAME || '').trim() || formatAudioLangName(rawCodeSource);
        const groupId = (attrs['GROUP-ID'] || 'audio').trim();
        const channels = attrs.CHANNELS ? attrs.CHANNELS.trim() : undefined;
        const isDefault = attrs.DEFAULT?.toUpperCase() === 'YES';
        const autoselect = attrs.AUTOSELECT ? attrs.AUTOSELECT.toUpperCase() === 'YES' : isDefault;
        try {
          const resolvedUri = cleanHlsUrl(new URL(attrs.URI, masterUrl).toString());
          const track: HlsAudioTrack = {
            id: audioTracks.length,
            name,
            language,
            languageCode,
            originalLanguageCode,
            code: languageCode,
            lang: originalLanguageCode,
            groupId,
            uri: resolvedUri,
            url: resolvedUri,
            default: isDefault,
            autoselect,
            ...(channels ? { channels } : {}),
          };
          audioTracks.push(track);
        } catch {
          // Ignore malformed URI
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA') && /TYPE=SUBTITLES/i.test(line)) {
      const attrs = parseHlsAttributes(line);
      if (attrs.URI) {
        const rawLangAttr = (attrs.LANGUAGE || '').trim();
        const rawName = (attrs.NAME || '').trim() || formatAudioLangName(rawLangAttr) || 'Subtitle';
        const rawSource = rawLangAttr || rawName;
        const originalLanguageCode = (rawLangAttr || normalizeAudioLangCode(rawName) || rawName).toLowerCase();
        const languageCode = normalizeAudioLangCode(rawSource) || originalLanguageCode;
        const language = normalizeAudioIso639_1(rawSource) || originalLanguageCode;
        const isDefault = attrs.DEFAULT?.toUpperCase() === 'YES';
        const autoselect = attrs.AUTOSELECT ? attrs.AUTOSELECT.toUpperCase() === 'YES' : isDefault;
        try {
          const resolvedUri = cleanHlsUrl(new URL(attrs.URI, masterUrl).toString());
          subtitles.push({
            id: subtitles.length,
            name: rawName,
            lang: rawName,
            language,
            languageCode,
            originalLanguageCode,
            groupId: (attrs['GROUP-ID'] || 'subs').trim(),
            url: resolvedUri,
            uri: resolvedUri,
            default: isDefault,
            autoselect,
          });
        } catch {
          // Ignore malformed URI
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attrs = parseHlsAttributes(line);
      const nextUri = lines
        .slice(i + 1)
        .find((candidate) => {
          const trimmed = candidate.trim();
          return trimmed && !trimmed.startsWith('#');
        })
        ?.trim();
      if (!nextUri) continue;

      const bandwidth = attrs.BANDWIDTH ? parseInt(attrs.BANDWIDTH, 10) : undefined;
      const resolution = attrs.RESOLUTION;
      const height = resolution?.match(/x(\d+)$/)?.[1];
      const explicitName = attrs.NAME;
      try {
        qualities.push({
          label: explicitName || (height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}kbps` : 'Auto'),
          url: cleanHlsUrl(new URL(nextUri, masterUrl).toString()),
          bandwidth: Number.isFinite(bandwidth) ? bandwidth : undefined,
          resolution,
        });
      } catch {
        // Ignore malformed URI
      }
    }
  }

  const dedupedQualities = Array.from(new Map(qualities.map((q) => [q.url, q])).values());
  const dedupedAudio = Array.from(
    new Map(audioTracks.map((t) => [`${t.groupId}:${t.languageCode}:${t.uri}`, t])).values()
  ).map((t, idx) => ({ ...t, id: idx }));
  const dedupedSubtitles = Array.from(new Map(subtitles.map((s) => [s.url, s])).values()).map((s, idx) => ({
    ...s,
    id: idx,
  }));
  const languages = Array.from(new Set(dedupedAudio.map((t) => t.languageCode).filter(Boolean)));
  const isoLanguages = Array.from(new Set(dedupedAudio.map((t) => t.language).filter(Boolean)));

  return {
    qualities: dedupedQualities,
    audioTracks: dedupedAudio,
    subtitles: dedupedSubtitles,
    languages,
    isoLanguages,
  };
}

export async function fetchAndParseHlsMaster(
  m3u8Url: string,
  referer?: string,
  extraHeaders?: Record<string, string>,
  timeoutMs = 12000
): Promise<ParsedHlsMaster> {
  const res = await axios.get<string>(m3u8Url, {
    headers: {
      'User-Agent': DEFAULT_HLS_UA,
      Accept: '*/*',
      ...(referer ? { Referer: referer } : {}),
      ...extraHeaders,
    },
    timeout: timeoutMs,
    responseType: 'text',
    transformResponse: [(data) => data],
  });
  const text = String(res.data ?? '');
  if (!text.trim().startsWith('#EXTM3U')) {
    return { qualities: [], audioTracks: [], subtitles: [], languages: [], isoLanguages: [] };
  }
  return parseHlsMaster(text, m3u8Url);
}

/**
 * Resolves the actual audio track to select from the parsed HLS master tracks.
 *
 * Never fabricates tracks and never silently claims an unavailable language is
 * playing. Returns the real selected track, updated `default`/`autoselect`
 * flags matching the rewritten playlist, and explicit fallback metadata when
 * the requested language is absent.
 */
export function resolveAudioSelection(
  rawTracks: HlsAudioTrack[],
  opts: {
    requestedAudio?: string | null;
    streamType?: 'sub' | 'dub' | 'raw' | string;
    preferHindiForDub?: boolean;
  } = {}
): ResolvedAudioSelection {
  if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
    const reqCode = normalizeAudioLangCode(opts.requestedAudio) || null;
    const reqIso = normalizeAudioIso639_1(opts.requestedAudio) || null;
    return {
      tracks: [],
      selectedTrack: null,
      selectedAudio: null,
      selectedAudioCode: null,
      selectedAudioName: null,
      requestedAudio: reqIso,
      requestedAudioCode: reqCode,
      requestedAudioUnavailable: Boolean(reqCode),
      audioFallback: false,
      audioWarning: reqCode
        ? `Requested audio language "${formatAudioLangName(reqCode)}" (${reqIso}) is unavailable: no selectable audio tracks were detected in this stream.`
        : null,
    };
  }

  const normalizedExplicitCode = normalizeAudioLangCode(opts.requestedAudio);
  const normalizedExplicitIso = normalizeAudioIso639_1(opts.requestedAudio);

  // Determine effective target language when none was explicitly requested:
  //  - dub on Hindi/Indian multi-audio providers → Hindi (hin)
  //  - sub or raw → Japanese (jpn)
  let targetCode = normalizedExplicitCode;
  let targetIso = normalizedExplicitIso;
  let implicitTarget = false;

  if (!targetCode) {
    if (opts.streamType === 'dub' && opts.preferHindiForDub) {
      targetCode = 'hin';
      targetIso = 'hi';
      implicitTarget = true;
    } else if (opts.streamType === 'sub' || opts.streamType === 'raw') {
      targetCode = 'jpn';
      targetIso = 'ja';
      implicitTarget = true;
    }
  }

  const findByCode = (code: string): HlsAudioTrack | undefined => {
    if (!code) return undefined;
    const normCode = normalizeAudioLangCode(code);
    const normIso = normalizeAudioIso639_1(code);
    return rawTracks.find(
      (t) =>
        t.languageCode === normCode ||
        t.language === normIso ||
        normalizeAudioLangCode(t.originalLanguageCode) === normCode ||
        normalizeAudioLangCode(t.name) === normCode
    );
  };

  let selected = targetCode ? findByCode(targetCode) : undefined;
  let requestedAudioUnavailable = false;
  let audioFallback = false;

  if (!selected) {
    if (targetCode) {
      requestedAudioUnavailable = true;
      audioFallback = true;
    }
    const fallbackOrder =
      opts.streamType === 'sub' || opts.streamType === 'raw'
        ? ['jpn', 'eng', 'hin']
        : opts.preferHindiForDub
          ? ['hin', 'eng', 'tam', 'tel', 'mal', 'kan', 'jpn']
          : ['eng', 'hin', 'jpn'];

    for (const candidateCode of fallbackOrder) {
      const hit = findByCode(candidateCode);
      if (hit) {
        selected = hit;
        break;
      }
    }
    if (!selected) {
      selected = rawTracks.find((t) => t.default) || rawTracks[0];
    }
  }

  const selectedIdx = rawTracks.findIndex((t) => t.id === selected!.id);
  const updatedTracks: HlsAudioTrack[] = rawTracks.map((track, idx) => {
    const isChosen = idx === selectedIdx;
    return {
      ...track,
      id: idx,
      default: isChosen,
      autoselect: isChosen,
    };
  });

  const chosenTrack = updatedTracks[selectedIdx] || updatedTracks[0];
  let audioWarning: string | null = null;
  if (requestedAudioUnavailable && targetCode && chosenTrack) {
    const reqName = formatAudioLangName(targetCode);
    const reasonPrefix = implicitTarget
      ? `Preferred ${opts.streamType === 'dub' ? 'Hindi Dub' : 'Japanese'} audio`
      : `Requested audio language "${reqName}" (${targetIso})`;
    audioWarning = `${reasonPrefix} is unavailable in this stream; playing "${chosenTrack.name}" (${chosenTrack.language}) instead.`;
  }

  return {
    tracks: updatedTracks,
    selectedTrack: chosenTrack,
    selectedAudio: chosenTrack?.language ?? null,
    selectedAudioCode: chosenTrack?.originalLanguageCode || chosenTrack?.languageCode || null,
    selectedAudioName: chosenTrack?.name ?? null,
    requestedAudio: targetIso || null,
    requestedAudioCode: targetCode || null,
    requestedAudioUnavailable,
    audioFallback,
    audioWarning,
  };
}

export function classifyAudioMode(
  selectedAudioIso1: string | null | undefined,
  subtitleCount: number
): AudioPlaybackMode {
  if (!selectedAudioIso1) return 'unknown';
  const iso = normalizeAudioIso639_1(selectedAudioIso1);
  const hasSubs = subtitleCount > 0;
  if (iso === 'ja') {
    return hasSubs ? 'japanese-sub' : 'japanese-raw';
  }
  return hasSubs ? 'dub-sub' : 'dub';
}

/**
 * Normalizes SRT or non-standard WebVTT (such as single-digit hours `0:00:02.74`
 * and 2-digit fractional seconds from ravok.buzz / as-cdn*.top) into strict
 * browser-compliant WebVTT (`HH:MM:SS.mmm`).
 */
export function normalizeSubtitleToWebVtt(rawText: string): string {
  let text = String(rawText ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Normalize cue timestamp lines: "H:MM:SS,mm --> H:MM:SS.mm" -> "HH:MM:SS.mmm --> HH:MM:SS.mmm"
  const normalizeTs = (h: string | undefined, m: string, s: string, frac: string): string => {
    const ms = frac.padEnd(3, '0').slice(0, 3);
    if (h !== undefined) {
      return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}.${ms}`;
    }
    return `${m.padStart(2, '0')}:${s.padStart(2, '0')}.${ms}`;
  };

  text = text.replace(
    /^(\s*)(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})(\s*-->\s*)(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/gm,
    (_m, lead, h1, m1, s1, f1, arrow, h2, m2, s2, f2) =>
      `${lead}${normalizeTs(h1, m1, s1, f1)}${arrow}${normalizeTs(h2, m2, s2, f2)}`
  );

  if (!text.trimStart().startsWith('WEBVTT')) {
    text = `WEBVTT\n\n${text.trimStart()}`;
  }
  return text;
}

/**
 * Binary MPEG-TS detector.
 *
 * Some CDNs (e.g. ravok.buzz / as-cdn*.top) disguise MPEG-TS segments with a
 * `.js` extension and `Content-Type: application/javascript`. Checking multiple
 * 188-byte MPEG-TS packet sync positions (0x47) avoids misclassifying real JS,
 * HTML, JSON, or text payloads while reliably detecting genuine TS segments.
 */
export function isMpegTsBuffer(body: Buffer): boolean {
  if (!body || body.length < 188) return false;

  // Reject obvious UTF-8 text/markup/script payloads immediately
  const headAscii = body.subarray(0, Math.min(body.length, 64)).toString('latin1').trimStart();
  if (
    headAscii.startsWith('#EXTM3U') ||
    headAscii.startsWith('WEBVTT') ||
    headAscii.startsWith('<!') ||
    headAscii.startsWith('<html') ||
    headAscii.startsWith('{') ||
    headAscii.startsWith('[')
  ) {
    return false;
  }

  // Genuine MPEG-TS packets always contain binary/control/high-bit bytes —
  // never 100% printable ASCII characters (guards against e.g. 'G'.repeat(500)
  // since 0x47 is ASCII 'G').
  const sampleLen = Math.min(body.length, 564);
  let nonPrintableCount = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = body[i];
    if (b === 0x00 || b < 0x09 || (b > 0x0d && b < 0x20) || b >= 0x7f) {
      nonPrintableCount++;
    }
  }
  if (nonPrintableCount < 8) return false;

  // Standard 188-byte MPEG-TS packet stride: verify 0x47 at packet boundaries
  const PACKET_SIZE = 188;
  const maxChecks = Math.min(5, Math.floor(body.length / PACKET_SIZE));
  if (maxChecks >= 2) {
    let allSync = true;
    for (let i = 0; i < maxChecks; i++) {
      if (body[i * PACKET_SIZE] !== 0x47) {
        allSync = false;
        break;
      }
    }
    if (allSync) return true;
  }

  // 192-byte M2TS packet stride (4-byte timestamp + 0x47 sync byte)
  const M2TS_SIZE = 192;
  const m2tsChecks = Math.min(5, Math.floor(body.length / M2TS_SIZE));
  if (m2tsChecks >= 2) {
    let allSync = true;
    for (let i = 0; i < m2tsChecks; i++) {
      if (body[i * M2TS_SIZE + 4] !== 0x47) {
        allSync = false;
        break;
      }
    }
    if (allSync) return true;
  }

  // Single-packet edge case (188..375 bytes): require 0x47 at offset 0 AND binary bytes
  if (body.length < PACKET_SIZE * 2 && body[0] === 0x47) {
    let controlCount = 0;
    for (let i = 0; i < body.length; i++) {
      const b = body[i];
      if (b === 0x00 || b < 0x09 || (b > 0x0d && b < 0x20)) controlCount++;
    }
    return controlCount >= 8;
  }

  return false;
}

function matchesAudioPreference(line: string, preferredCode: string, preferredIso: string): boolean {
  const attrs = parseHlsAttributes(line);
  const langCode = normalizeAudioLangCode(attrs.LANGUAGE);
  const langIso = normalizeAudioIso639_1(attrs.LANGUAGE);
  const nameCode = normalizeAudioLangCode(attrs.NAME);
  const nameIso = normalizeAudioIso639_1(attrs.NAME);
  return (
    (Boolean(preferredCode) && (langCode === preferredCode || nameCode === preferredCode)) ||
    (Boolean(preferredIso) && (langIso === preferredIso || nameIso === preferredIso))
  );
}

function setMediaSelectionAttrs(line: string, isSelected: boolean): string {
  const val = isSelected ? 'YES' : 'NO';
  let updated = line;

  if (/DEFAULT=(?:YES|NO)/i.test(updated)) {
    updated = updated.replace(/DEFAULT=(?:YES|NO)/gi, `DEFAULT=${val}`);
  } else {
    updated = `${updated},DEFAULT=${val}`;
  }

  // Preserve AUTOSELECT on every track, setting YES on the chosen track and NO
  // on non-selected tracks so OS/browser English locale (en-US) cannot hijack
  // playback away from Hindi/Tamil/Telugu/Japanese via RFC 8216 autoselect.
  // All tracks remain in the manifest for manual switching in HLS.js / native / ExoPlayer.
  if (/AUTOSELECT=(?:YES|NO)/i.test(updated)) {
    updated = updated.replace(/AUTOSELECT=(?:YES|NO)/gi, `AUTOSELECT=${val}`);
  } else {
    updated = `${updated},AUTOSELECT=${val}`;
  }

  return updated;
}

function isAlreadyProxiedHlsUri(uri: string): boolean {
  try {
    const parsed = new URL(uri, 'http://localhost');
    return /\/api\/proxy\/hls\/?$/i.test(parsed.pathname) && parsed.searchParams.has('url');
  } catch {
    return false;
  }
}

export function rewriteHlsPlaylistText(
  body: string,
  sourceUrl: string,
  proxyUri: (absoluteUrl: string) => string,
  preferredAudio?: string
): string {
  const base = new URL(sourceUrl);
  const resolveAndProxy = (uri: string) => {
    const cleaned = uri.trim();
    if (isAlreadyProxiedHlsUri(cleaned)) return cleaned;
    const abs = new URL(cleaned, base).toString();
    if (isAlreadyProxiedHlsUri(abs)) return abs;
    return proxyUri(abs);
  };
  const lines = body.split(/\r?\n/);

  const normalizedPrefCode = normalizeAudioLangCode(preferredAudio);
  const normalizedPrefIso = normalizeAudioIso639_1(preferredAudio);
  let matchedAudioLineIndex = -1;
  let matchedGroupId: string | null = null;
  let hasDefaultAudio = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('#EXT-X-MEDIA') || !/TYPE=AUDIO/i.test(trimmed)) continue;
    if (/DEFAULT=YES/i.test(trimmed)) hasDefaultAudio = true;
    if (
      (normalizedPrefCode || normalizedPrefIso) &&
      matchedAudioLineIndex === -1 &&
      matchesAudioPreference(trimmed, normalizedPrefCode, normalizedPrefIso)
    ) {
      matchedAudioLineIndex = i;
      matchedGroupId = parseHlsAttributes(trimmed)['GROUP-ID'] || null;
    }
  }

  let firstAudioMarked = false;
  let sawExtM3u = false;
  const output: string[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    if (!trimmed) {
      output.push(line);
      continue;
    }

    // Deduplicate redundant `#EXTM3U` headers (FirePlayer upstream emits two)
    if (trimmed === '#EXTM3U') {
      if (sawExtM3u) continue;
      sawExtM3u = true;
      output.push(line);
      continue;
    }

    let processedLine = line;
    const isAudioDirective = trimmed.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(trimmed);

    if (isAudioDirective) {
      if (matchedAudioLineIndex !== -1) {
        const lineGroupId = parseHlsAttributes(trimmed)['GROUP-ID'] || null;
        if (!matchedGroupId || !lineGroupId || lineGroupId === matchedGroupId) {
          processedLine = setMediaSelectionAttrs(processedLine, idx === matchedAudioLineIndex);
        }
      } else if (!hasDefaultAudio && !firstAudioMarked) {
        // Fallback when no language was requested (or requested language absent)
        // and the upstream playlist had no DEFAULT=YES track.
        processedLine = processedLine
          .replace(/DEFAULT=NO/gi, 'DEFAULT=YES')
          .replace(/AUTOSELECT=NO/gi, 'AUTOSELECT=YES');
        firstAudioMarked = true;
      }
    }

    if (processedLine.trim().startsWith('#') && processedLine.includes('URI=')) {
      output.push(processedLine.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${resolveAndProxy(uri)}"`));
      continue;
    }

    if (processedLine.trim().startsWith('#')) {
      output.push(processedLine);
      continue;
    }

    output.push(resolveAndProxy(trimmed));
  }

  return output.join('\n');
}
