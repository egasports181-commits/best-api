'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const {
  parseHlsMaster,
  isMpegTsBuffer,
  rewriteHlsPlaylistText,
  normalizeAudioLangCode,
  normalizeAudioIso639_1,
  resolveAudioSelection,
  classifyAudioMode,
  normalizeSubtitleToWebVtt,
} = require('../../dist/utils/hls');
const { extractFirePlayer, parseFirePlayerEmbedSubtitles } = require('../../dist/extractors/fireplayer');
const { extractPlayZen } = require('../../dist/extractors/playzen');
const { extractSeasonHintExtended } = require('../../dist/scrapers/animesalt');
const { normalizeHindiAnimeEpisodeItem } = require('../../dist/scrapers/hindianime');
const {
  makeSyntheticMpegTsBuffer,
  SAMPLE_MULTI_AUDIO_MASTER_M3U8,
  SAMPLE_ONE_PIECE_MASTER_M3U8,
  PLAYZEN_HTML,
} = require('../fixtures/providers.fixtures');

const originalAdapter = axios.defaults.adapter;

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});

describe('HLS Utilities (src/utils/hls.ts)', () => {
  it('parses multi-audio HLS master tracks with full metadata, ISO 639-1 & upstream codes, and channels', () => {
    const withChannels = SAMPLE_MULTI_AUDIO_MASTER_M3U8.replace(
      'LANGUAGE="hin",NAME="Hindi"',
      'LANGUAGE="hin",NAME="Hindi",CHANNELS="2"'
    );
    const parsed = parseHlsMaster(withChannels, 'https://ravok.buzz/cdn/hls/abc/master.m3u8');
    assert.equal(parsed.qualities.length, 3);
    assert.deepEqual(
      parsed.qualities.map((q) => q.label),
      ['480p', '720p', '1080p']
    );
    assert.equal(parsed.audioTracks.length, 5);
    assert.deepEqual(parsed.languages, ['jpn', 'eng', 'tel', 'tam', 'hin']);
    assert.deepEqual(parsed.isoLanguages, ['ja', 'en', 'te', 'ta', 'hi']);

    const hin = parsed.audioTracks[4];
    assert.equal(hin.id, 4);
    assert.equal(hin.name, 'Hindi');
    assert.equal(hin.language, 'hi');
    assert.equal(hin.languageCode, 'hin');
    assert.equal(hin.originalLanguageCode, 'hin');
    assert.equal(hin.groupId, 'audio');
    assert.equal(hin.uri, 'https://ravok.buzz/hls/audio-hin');
    assert.equal(hin.url, 'https://ravok.buzz/hls/audio-hin');
    assert.equal(hin.default, false);
    assert.equal(hin.autoselect, true);
    assert.equal(hin.channels, '2');
  });

  it('parses 7-language One Piece master playlist (incl. Kannada & Malayalam)', () => {
    const parsed = parseHlsMaster(SAMPLE_ONE_PIECE_MASTER_M3U8, 'https://ravok.buzz/cdn/hls/op/master.m3u8');
    assert.deepEqual(parsed.languages, ['jpn', 'eng', 'kan', 'mal', 'tel', 'tam', 'hin']);
    assert.deepEqual(parsed.isoLanguages, ['ja', 'en', 'kn', 'ml', 'te', 'ta', 'hi']);
  });

  it('normalizes ISO 639-1 and ISO 639-2 language codes cleanly', () => {
    const pairs = [
      ['hin', 'hi', 'hin'],
      ['Hindi', 'hi', 'hin'],
      ['tam', 'ta', 'tam'],
      ['Tamil', 'ta', 'tam'],
      ['tel', 'te', 'tel'],
      ['eng', 'en', 'eng'],
      ['jpn', 'ja', 'jpn'],
      ['Japanese', 'ja', 'jpn'],
      ['mal', 'ml', 'mal'],
      ['kan', 'kn', 'kan'],
    ];
    for (const [input, expectedIso1, expectedIso2] of pairs) {
      assert.equal(normalizeAudioIso639_1(input), expectedIso1);
      assert.equal(normalizeAudioLangCode(input), expectedIso2);
    }
  });

  it('resolveAudioSelection selects Hindi for dub, Japanese for sub/raw, explicit language, and honest fallback when unavailable', () => {
    const parsed = parseHlsMaster(SAMPLE_MULTI_AUDIO_MASTER_M3U8, 'https://ravok.buzz/cdn/hls/abc/master.m3u8');

    // 1. Hindi Dub default (no explicit ?audio=): MUST select Hindi, NOT Japanese (index 0) or English!
    const dubDefault = resolveAudioSelection(parsed.audioTracks, {
      streamType: 'dub',
      preferHindiForDub: true,
    });
    assert.equal(dubDefault.selectedAudio, 'hi');
    assert.equal(dubDefault.selectedAudioCode, 'hin');
    assert.equal(dubDefault.requestedAudioUnavailable, false);
    assert.equal(dubDefault.tracks[4].default, true);
    assert.equal(dubDefault.tracks[0].default, false);
    assert.equal(dubDefault.tracks[1].default, false);

    // 2. Sub default: MUST select Japanese!
    const subDefault = resolveAudioSelection(parsed.audioTracks, {
      streamType: 'sub',
      preferHindiForDub: true,
    });
    assert.equal(subDefault.selectedAudio, 'ja');
    assert.equal(subDefault.selectedAudioCode, 'jpn');
    assert.equal(subDefault.tracks[0].default, true);
    assert.equal(subDefault.tracks[4].default, false);

    // 3. Explicit ISO 639-1 ?audio=ta selects Tamil
    const tamilSel = resolveAudioSelection(parsed.audioTracks, {
      requestedAudio: 'ta',
      streamType: 'dub',
      preferHindiForDub: true,
    });
    assert.equal(tamilSel.selectedAudio, 'ta');
    assert.equal(tamilSel.selectedAudioCode, 'tam');
    assert.equal(tamilSel.requestedAudioUnavailable, false);

    // 4. Unavailable language reports honest fallback + warning
    const missingSel = resolveAudioSelection(parsed.audioTracks, {
      requestedAudio: 'kor',
      streamType: 'dub',
      preferHindiForDub: true,
    });
    assert.equal(missingSel.requestedAudio, 'ko');
    assert.equal(missingSel.requestedAudioUnavailable, true);
    assert.equal(missingSel.audioFallback, true);
    assert.equal(missingSel.selectedAudio, 'hi');
    assert.match(missingSel.audioWarning || '', /Korean.*unavailable.*Hindi/i);

    // 5. Audio mode classification distinguishes Japanese+subs vs Japanese without subs vs Dub+subs
    assert.equal(classifyAudioMode('ja', 1), 'japanese-sub');
    assert.equal(classifyAudioMode('ja', 0), 'japanese-raw');
    assert.equal(classifyAudioMode('hi', 1), 'dub-sub');
    assert.equal(classifyAudioMode('hi', 0), 'dub');
  });

  it('detects binary MPEG-TS segments while rejecting JS, HTML, JSON, and text', () => {
    const tsBuf = makeSyntheticMpegTsBuffer(6);
    assert.equal(isMpegTsBuffer(tsBuf), true);

    assert.equal(isMpegTsBuffer(Buffer.from('console.log("hello world");'.repeat(30), 'utf8')), false);
    assert.equal(isMpegTsBuffer(Buffer.from('G'.repeat(500), 'utf8')), false);
    assert.equal(isMpegTsBuffer(Buffer.from('function G() { return 1; }'.repeat(30), 'utf8')), false);
    assert.equal(isMpegTsBuffer(Buffer.from('<!DOCTYPE html><html><body>Hi</body></html>'.repeat(10), 'utf8')), false);
    assert.equal(isMpegTsBuffer(Buffer.from('{"hello":"world"}'.repeat(20), 'utf8')), false);
    assert.equal(isMpegTsBuffer(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n', 'utf8')), false);
    assert.equal(isMpegTsBuffer(Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n', 'utf8')), false);
    assert.equal(isMpegTsBuffer(Buffer.from('short')), false);
  });

  it('rewrites HLS playlist preserving all attributes, setting AUTOSELECT=NO on non-selected tracks, and preventing double-rewrite', () => {
    const rawWithDupHeader = `#EXTM3U\n#EXT-X-VERSION:3\n#\n${SAMPLE_MULTI_AUDIO_MASTER_M3U8.replace(
      'LANGUAGE="hin",NAME="Hindi"',
      'LANGUAGE="hin",NAME="Hindi",CHANNELS="2"'
    )}`;
    const proxyFn = (u) => `http://localhost:3000/api/proxy/hls?url=${encodeURIComponent(u)}`;
    const out = rewriteHlsPlaylistText(rawWithDupHeader, 'https://ravok.buzz/cdn/hls/abc/master.m3u8', proxyFn, 'hin');

    // Duplicate #EXTM3U stripped to exactly 1
    assert.equal(out.split('\n').filter((l) => l.trim() === '#EXTM3U').length, 1);

    const audioLines = out.split('\n').filter((l) => l.includes('TYPE=AUDIO'));
    assert.equal(audioLines.length, 5);
    assert.match(audioLines[0], /LANGUAGE="jpn".*DEFAULT=NO.*AUTOSELECT=NO/);
    assert.match(audioLines[1], /LANGUAGE="eng".*DEFAULT=NO.*AUTOSELECT=NO/);
    assert.match(audioLines[4], /GROUP-ID="audio".*LANGUAGE="hin".*NAME="Hindi".*CHANNELS="2".*DEFAULT=YES.*AUTOSELECT=YES/);
    assert.match(audioLines[4], /URI="http:\/\/localhost:3000\/api\/proxy\/hls\?url=https%3A%2F%2Fravok\.buzz%2Fhls%2Faudio-hin"/);
    assert.match(out, /#EXT-X-STREAM-INF:.*AUDIO="audio"/);

    // Running rewriteHlsPlaylistText a second time MUST NOT double-wrap already-proxied URIs!
    const outTwice = rewriteHlsPlaylistText(out, 'http://localhost:3000/api/proxy/hls?url=x', proxyFn, 'hin');
    assert.doesNotMatch(outTwice, /api%2Fproxy%2Fhls/);
  });

  it('rewrites HLS playlist with default promotion when audio param is absent or unavailable', () => {
    const proxyFn = (u) => `http://localhost:3000/api/proxy/hls?url=${encodeURIComponent(u)}`;
    const outNoAudio = rewriteHlsPlaylistText(
      SAMPLE_MULTI_AUDIO_MASTER_M3U8,
      'https://ravok.buzz/cdn/hls/abc/master.m3u8',
      proxyFn
    );
    const audioLines = outNoAudio.split('\n').filter((l) => l.includes('TYPE=AUDIO'));
    assert.equal(audioLines.length, 5);
    assert.match(audioLines[0], /LANGUAGE="jpn".*DEFAULT=YES/);
    assert.match(audioLines[4], /LANGUAGE="hin".*DEFAULT=NO/);

    const outUnavailable = rewriteHlsPlaylistText(
      SAMPLE_MULTI_AUDIO_MASTER_M3U8,
      'https://ravok.buzz/cdn/hls/abc/master.m3u8',
      proxyFn,
      'fra'
    );
    assert.match(outUnavailable.split('\n').filter((l) => l.includes('TYPE=AUDIO'))[0], /LANGUAGE="jpn".*DEFAULT=YES/);
  });

  it('normalizes ravok.buzz single-digit hour / 2-digit centisecond subtitles and SRT into valid WebVTT', () => {
    const ravokSub = '1\n0:00:02.74 --> 0:00:04.82\nWealth, fame, power...\n\n2\n0:00:04.82 --> 0:00:06.74\nGold Roger\n';
    const vtt = normalizeSubtitleToWebVtt(ravokSub);
    assert.ok(vtt.startsWith('WEBVTT\n\n'));
    assert.match(vtt, /00:00:02\.740 --> 00:00:04\.820/);
    assert.match(vtt, /00:00:04\.820 --> 00:00:06\.740/);

    const srt = '1\r\n00:00:01,500 --> 00:00:03,200\r\nHello\r\n';
    const vtt2 = normalizeSubtitleToWebVtt(srt);
    assert.ok(vtt2.startsWith('WEBVTT\n\n'));
    assert.match(vtt2, /00:00:01\.500 --> 00:00:03\.200/);
  });
});

describe('Season Hint & Hindi Anime Episode Quirk Normalization', () => {
  it('extracts season hint from trailing and subtitled titles', () => {
    assert.deepEqual(extractSeasonHintExtended('Solo Leveling Season 2'), { base: 'Solo Leveling', season: 2 });
    assert.deepEqual(extractSeasonHintExtended('Solo Leveling Season 2 -Arise from the Shadow-'), {
      base: 'Solo Leveling',
      season: 2,
    });
    assert.deepEqual(extractSeasonHintExtended('Naruto Shippuden'), { base: 'Naruto Shippuden', season: null });
  });

  it('handles cloud.hindi-anime.com episode number placed in `season` field', () => {
    const soloS2E1 = normalizeHindiAnimeEpisodeItem(
      { title: 'Solo Leveling 2x1', season: '1', image: 'https://img.animesalt.cx/image/292/2/1.webp' },
      2,
      0,
      'solo-leveling',
      false
    );
    assert.equal(soloS2E1.season, 2);
    assert.equal(soloS2E1.num, 1);
    assert.equal(soloS2E1.id, 'solo-leveling::2::1::0');

    const opS21E1089 = normalizeHindiAnimeEpisodeItem(
      { title: 'Entering a New Chapter!', season: '1089', image: 'https://img.animesalt.cx/thumb.jpg' },
      21,
      0,
      'one-piece',
      false
    );
    assert.equal(opS21E1089.season, 21);
    assert.equal(opS21E1089.num, 1089);
    assert.equal(opS21E1089.id, 'one-piece::21::1089::0');
  });
});

describe('Reusable Extractors (FirePlayer & PlayZen)', () => {
  it('parseFirePlayerEmbedSubtitles parses real playerjsSubtitle and returns [] when absent', () => {
    const htmlWithSub = `<script>var playerjsSubtitle = "[English]https://as-cdn27.top/p/sub1.jpg,[Hindi]https://as-cdn27.top/p/sub2.jpg"; var playerjsDefaultSubtitle = "English";</script>`;
    const subs = parseFirePlayerEmbedSubtitles(htmlWithSub);
    assert.equal(subs.length, 2);
    assert.equal(subs[0].name, 'English');
    assert.equal(subs[0].language, 'en');
    assert.equal(subs[0].default, true);
    assert.equal(subs[1].name, 'Hindi');
    assert.equal(subs[1].language, 'hi');
    assert.equal(subs[1].default, false);

    assert.deepEqual(parseFirePlayerEmbedSubtitles('<script>var playerjsSubtitle = "";</script>'), []);
    assert.deepEqual(parseFirePlayerEmbedSubtitles('<html><body>No subs</body></html>'), []);
  });

  it('extractFirePlayer sends X-Requested-With: XMLHttpRequest, parses master HLS, and extracts real embed subtitles', async () => {
    let capturedHeaders = null;
    let capturedBody = null;

    axios.defaults.adapter = async (config) => {
      if (config.url.includes('/player/index.php')) {
        capturedHeaders = config.headers;
        capturedBody = config.data;
        return {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          config,
          data: {
            hls: true,
            securedLink: 'https://ravok.buzz/cdn/hls/test123/master.m3u8?md5=abc&expires=9999999999',
            videoImage: 'https://as-cdn27.top/p/thumb.jpg',
          },
        };
      }
      if (config.url.includes('/video/')) {
        return {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/html' },
          config,
          data: '<script>var playerjsSubtitle = "[English]https://as-cdn27.top/p/en.jpg"; var playerjsDefaultSubtitle = "English";</script>',
        };
      }
      if (config.url.includes('master.m3u8')) {
        return {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/x-mpegURL' },
          config,
          data: SAMPLE_MULTI_AUDIO_MASTER_M3U8,
        };
      }
      throw new Error(`Unexpected URL: ${config.url}`);
    };

    const result = await extractFirePlayer(
      'https://ravok.buzz/video/abcdef1234567890abcdef1234567890',
      'https://animesalt.cx/'
    );
    assert.ok(result);
    assert.equal(capturedHeaders['X-Requested-With'], 'XMLHttpRequest');
    assert.match(String(capturedBody), /hash=abcdef1234567890abcdef1234567890/);
    assert.equal(result.type, 'hls');
    assert.equal(result.m3u8, 'https://ravok.buzz/cdn/hls/test123/master.m3u8?md5=abc&expires=9999999999');
    assert.deepEqual(result.languages, ['jpn', 'eng', 'tel', 'tam', 'hin']);
    assert.deepEqual(result.isoLanguages, ['ja', 'en', 'te', 'ta', 'hi']);
    assert.equal(result.qualities.length, 3);
    assert.equal(result.subtitles.length, 1);
    assert.equal(result.subtitles[0].name, 'English');
    assert.equal(result.subtitles[0].url, 'https://as-cdn27.top/p/en.jpg');
  });

  it('extractFirePlayer returns null if upstream returns HTML instead of JSON', async () => {
    axios.defaults.adapter = async (config) => ({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html' },
      config,
      data: '<!DOCTYPE html><html><body>Player</body></html>',
    });

    const result = await extractFirePlayer(
      'https://ravok.buzz/video/00001111222233334444555566667777',
      'https://animesalt.cx/'
    );
    assert.equal(result, null);
  });

  it('extractPlayZen prefers 720p MKV over 480p and marks web playbackMode as iframe', async () => {
    axios.defaults.adapter = async (config) => ({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html' },
      config,
      data: PLAYZEN_HTML,
    });

    const result = await extractPlayZen('https://archive.animeinfinity.me/player/testToken');
    assert.ok(result);
    assert.equal(result.playbackMode, 'iframe');
    assert.equal(result.quality, '720p');
    assert.equal(result.mimeType, 'video/x-matroska');
    assert.match(result.directUrl, /720p/);
    assert.equal(result.sources.length, 2);
  });
});
