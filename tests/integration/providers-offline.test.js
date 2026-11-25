'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');

const realAdapter = axios.defaults.adapter;
const resolvedRealAdapter = axios.getAdapter(realAdapter);
let activeMockAdapter = null;

// Install a delegating adapter BEFORE requiring dist/server so all axios.create()
// instances created inside scrapers/mapper inherit it cleanly.
axios.defaults.adapter = async (config) => {
  if (activeMockAdapter) return activeMockAdapter(config);
  return resolvedRealAdapter(config);
};

const app = require('../../dist/server').default;
const {
  makeSyntheticMpegTsBuffer,
  SAMPLE_MULTI_AUDIO_MASTER_M3U8,
  SAMPLE_ONE_PIECE_MASTER_M3U8,
  SAMPLE_VARIANT_M3U8,
  ANIMESALT_SEARCH_NARUTO_HTML,
  ANIMESALT_SEARCH_SOLO_HTML,
  ANIMESALT_SEARCH_ONE_PIECE_HTML,
  ANIMESALT_SEARCH_YOUR_NAME_HTML,
  ANIMESALT_SERIES_SOLO_HTML,
  ANIMESALT_SERIES_ONE_PIECE_HTML,
  ANIMESALT_SERIES_NARUTO_HTML,
  ANIMESALT_AJAX_SOLO_S1,
  ANIMESALT_AJAX_SOLO_S2,
  ANIMESALT_AJAX_ONE_PIECE_S21,
  ANIMESALT_AJAX_NARUTO_S1,
  ANIMESALT_AJAX_NARUTO_S2,
  makeAnimesaltEpisodeHtml,
  HINDIANIME_SEARCH_INDEX,
  PLAYZEN_HTML,
} = require('../fixtures/providers.fixtures');

describe('Offline Integration & Regression Suite (Express API)', () => {
  let apiServer;
  let apiBase;
  let mockCdnServer;
  let mockCdnBase;

  before(async () => {
    // Local mock upstream CDN for testing /api/proxy/hls, /api/proxy/subtitle, /api/proxy/video over real HTTP
    mockCdnServer = http.createServer((req, res) => {
      if (req.url.startsWith('/master.m3u8')) {
        res.writeHead(200, { 'Content-Type': 'application/x-mpegURL' });
        res.end(SAMPLE_MULTI_AUDIO_MASTER_M3U8);
        return;
      }
      if (req.url.startsWith('/hls/video-720p') || req.url.startsWith('/hls/audio-hin')) {
        // Deliberately send text/plain with NO .m3u8 extension to verify #EXTM3U content sniffing
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(SAMPLE_VARIANT_M3U8);
        return;
      }
      if (req.url.startsWith('/seg/chunk001.js')) {
        // Disguised MPEG-TS segment served as application/javascript
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(makeSyntheticMpegTsBuffer(8));
        return;
      }
      if (req.url.startsWith('/seg/real-script.js')) {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('window.test = function() { return 42; };'.repeat(20));
        return;
      }
      if (req.url.startsWith('/seg/chunk002.ts')) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(makeSyntheticMpegTsBuffer(4));
        return;
      }
      if (req.url.startsWith('/seg/init.woff')) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
        return;
      }
      if (req.url.startsWith('/subs/en.srt')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('1\n00:00:01,000 --> 00:00:03,500\nHello world\n');
        return;
      }
      if (req.url.startsWith('/subs/ravok.jpg')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('1\n0:00:02.74 --> 0:00:04.82\nWealth, fame, power...\n');
        return;
      }
      if (req.url.startsWith('/video/sample.mp4')) {
        const data = Buffer.from('0123456789abcdef');
        if (req.headers.range === 'bytes=0-7') {
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Range': 'bytes 0-7/16',
            'Content-Length': '8',
            'Accept-Ranges': 'bytes',
          });
          res.end(data.subarray(0, 8));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(data.length) });
        res.end(data);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise((resolve) => mockCdnServer.listen(0, '127.0.0.1', resolve));
    mockCdnBase = `http://127.0.0.1:${mockCdnServer.address().port}`;

    await new Promise((resolve) => {
      apiServer = app.listen(0, '127.0.0.1', resolve);
    });
    apiBase = `http://127.0.0.1:${apiServer.address().port}`;
  });

  after(async () => {
    activeMockAdapter = null;
    axios.defaults.adapter = realAdapter;
    apiServer.closeAllConnections?.();
    mockCdnServer.closeAllConnections?.();
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => mockCdnServer.close(resolve));
  });

  afterEach(() => {
    activeMockAdapter = null;
  });

  function installMockUpstream({ failFirePlayer = false } = {}) {
    const anilistCatalog = {
      20: { id: 20, idMal: 20, title: { english: 'Naruto', romaji: 'Naruto' } },
      1735: { id: 1735, idMal: 1735, title: { english: 'Naruto: Shippuden', romaji: 'Naruto: Shippuuden' } },
      21: { id: 21, idMal: 21, title: { english: 'One Piece', romaji: 'ONE PIECE' } },
      151807: { id: 151807, idMal: 52299, title: { english: 'Solo Leveling', romaji: 'Ore dake Level Up na Ken' } },
      176496: {
        id: 176496,
        idMal: 58567,
        title: { english: 'Solo Leveling Season 2 -Arise from the Shadow-', romaji: 'Ore dake Level Up na Ken Season 2' },
      },
      21519: { id: 21519, idMal: 32281, title: { english: 'Your Name.', romaji: 'Kimi no Na wa.' } },
    };

    const handler = async (config) => {
      const fullUrl = config.baseURL ? new URL(config.url || '', config.baseURL).toString() : String(config.url || '');
      const urlObj = new URL(fullUrl);
      if (config.params) {
        for (const [k, v] of Object.entries(config.params)) {
          if (v !== undefined) urlObj.searchParams.set(k, String(v));
        }
      }
      const url = urlObj.toString();

      // Let local mock CDN requests pass through to real HTTP
      if (url.startsWith(mockCdnBase)) {
        return resolvedRealAdapter(config);
      }

      const ok = (data, ct = 'text/html') => ({
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': ct },
        config,
        data,
      });

      // AniList GraphQL
      if (url.startsWith('https://graphql.anilist.co')) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        const vars = body?.variables || {};
        if (vars.search) {
          return ok({
            data: {
              Page: {
                media: [
                  {
                    id: 20,
                    idMal: 20,
                    episodes: 220,
                    title: { english: 'Naruto', romaji: 'Naruto' },
                    coverImage: { large: 'https://img/naruto.jpg' },
                    status: 'FINISHED',
                    format: 'TV',
                  },
                ],
              },
            },
          }, 'application/json');
        }
        const found =
          (vars.id && anilistCatalog[vars.id]) ||
          Object.values(anilistCatalog).find((m) => m.idMal === vars.malId) ||
          null;
        return ok({ data: { Media: found } }, 'application/json');
      }

      // Anify (returns empty mappings quickly in tests)
      if (url.includes('api.anify.tv')) {
        return ok({ mappings: [] }, 'application/json');
      }

      // AnimeSalt
      if (url.startsWith('https://animesalt.cx')) {
        if (urlObj.pathname === '/' && urlObj.searchParams.has('s')) {
          const q = urlObj.searchParams.get('s').toLowerCase();
          if (q.includes('naruto')) return ok(ANIMESALT_SEARCH_NARUTO_HTML);
          if (q.includes('solo')) return ok(ANIMESALT_SEARCH_SOLO_HTML);
          if (q.includes('one piece')) return ok(ANIMESALT_SEARCH_ONE_PIECE_HTML);
          if (q.includes('your name')) return ok(ANIMESALT_SEARCH_YOUR_NAME_HTML);
          return ok('<html></html>');
        }
        if (urlObj.pathname === '/series/solo-leveling/') return ok(ANIMESALT_SERIES_SOLO_HTML);
        if (urlObj.pathname === '/series/one-piece/') return ok(ANIMESALT_SERIES_ONE_PIECE_HTML);
        if (urlObj.pathname === '/series/naruto/') return ok(ANIMESALT_SERIES_NARUTO_HTML);
        if (urlObj.pathname === '/movies/your-name/') {
          return ok(
            makeAnimesaltEpisodeHtml('46a731f4af282372a4097ba1e4d76b95', [
              { language: 'Hindi', link: 'https://player.abyssplayer.com/yourname_hi' },
              { language: 'Japanese', link: 'https://player.abyssplayer.com/yourname_jp' },
            ])
          );
        }
        if (urlObj.pathname === '/wp-admin/admin-ajax.php' && urlObj.searchParams.get('action') === 'action_select_season') {
          const post = urlObj.searchParams.get('post');
          const season = urlObj.searchParams.get('season');
          if (post === '292' && season === '1') return ok(ANIMESALT_AJAX_SOLO_S1);
          if (post === '292' && season === '2') return ok(ANIMESALT_AJAX_SOLO_S2);
          if (post === '294' && season === '21') return ok(ANIMESALT_AJAX_ONE_PIECE_S21);
          if (post === '332' && season === '1') return ok(ANIMESALT_AJAX_NARUTO_S1);
          if (post === '332' && season === '2') return ok(ANIMESALT_AJAX_NARUTO_S2);
          return ok('');
        }
        if (urlObj.pathname.startsWith('/episode/')) {
          const hash = urlObj.pathname.includes('one-piece')
            ? '8757150decbd89b0f5442ca3db4d0e0e'
            : urlObj.pathname.includes('naruto')
              ? '36660e59856b4de58a219bcf4e27eba3'
              : 'ec4de54f2f3afa14175e5eabfc16ce1f';
          return ok(
            makeAnimesaltEpisodeHtml(hash, [
              { language: 'Hindi', link: 'https://player.abyssplayer.com/S8ZofkQ9_' },
              { language: 'Tamil', link: 'https://player.abyssplayer.com/6ylxO6qWC' },
              { language: 'Japanese', link: 'https://player.abyssplayer.com/DhQ01O3JN' },
            ])
          );
        }
      }

      // Hindi Anime
      if (url === 'https://hindi-anime.com/search-index.json') {
        return ok(HINDIANIME_SEARCH_INDEX, 'application/json');
      }
      if (url.startsWith('https://cloud.hindi-anime.com/data/episodes')) {
        const slug = urlObj.searchParams.get('slug');
        const season = urlObj.searchParams.get('season');
        if (slug === 'solo-leveling' && season === '1') {
          return ok({
            success: true,
            results: {
              totalSeasons: '2',
              seasons: [{ season: '1' }, { season: '2' }],
              episodes: [{ title: 'Solo Leveling 1x1', season: '1', image: 'https://img.animesalt.cx/1.webp' }],
            },
          }, 'application/json');
        }
        if (slug === 'solo-leveling' && season === '2') {
          return ok({
            success: true,
            results: {
              totalSeasons: '2',
              seasons: [{ season: '1' }, { season: '2' }],
              episodes: [{ title: 'Solo Leveling 2x1', season: '1', image: 'https://img.animesalt.cx/2x1.webp' }],
            },
          }, 'application/json');
        }
        if (slug === 'naruto-shippuden' && season === '1') {
          return ok({
            success: true,
            results: {
              totalSeasons: '22',
              seasons: [{ season: '1' }],
              episodes: [{ title: 'Homecoming', season: '1', image: 'https://img.animesalt.cx/ns1.webp' }],
            },
          }, 'application/json');
        }
        if (slug === 'naruto' && season === '1') {
          return ok({
            success: true,
            results: {
              totalSeasons: '5',
              seasons: [{ season: '1' }, { season: '2' }],
              episodes: [{ title: 'Enter: Naruto Uzumaki!', season: '1' }],
            },
          }, 'application/json');
        }
        if (slug === 'one-piece' && season === '1') {
          return ok({
            success: true,
            results: {
              totalSeasons: '21',
              seasons: Array.from({ length: 21 }, (_, i) => ({ season: String(i + 1) })),
              episodes: [{ title: 'One Piece 1x1', season: '1' }, { title: 'One Piece 1x61', season: '61' }],
            },
          }, 'application/json');
        }
        if (slug === 'one-piece' && season === '21') {
          return ok({
            success: true,
            results: {
              totalSeasons: '21',
              seasons: Array.from({ length: 21 }, (_, i) => ({ season: String(i + 1) })),
              episodes: [{ title: 'Entering a New Chapter!', season: '1089' }, { title: 'Ep 1090', season: '1090' }],
            },
          }, 'application/json');
        }
        // Mid-seasons for binary search of One Piece
        if (slug === 'one-piece') {
          const s = parseInt(season, 10);
          return ok({
            success: true,
            results: {
              totalSeasons: '21',
              seasons: Array.from({ length: 21 }, (_, i) => ({ season: String(i + 1) })),
              episodes: [{ title: `One Piece ${s}x${s * 40}`, season: String(s * 40) }],
            },
          }, 'application/json');
        }
      }
      if (url.startsWith('https://cloud.hindi-anime.com/sources')) {
        const id = urlObj.searchParams.get('id');
        const hash = id === 'one-piece'
          ? '3d43cb0230c4f1ab6b9700689a881ec5'
          : id === 'naruto-shippuden'
            ? '49182f81e6a13cf5eaa496d51fea6406'
            : id === 'naruto'
              ? '36660e59856b4de58a219bcf4e27eba3'
              : 'ec4de54f2f3afa14175e5eabfc16ce1f';
        return ok({
          success: true,
          results: [
            { server: 'Server 1', embed: `https://ravok.buzz/video/${hash}`, audioLanguage: 'hi' },
            { server: 'Server 2', sourceProvider: 'GoogleDrive', embed: 'https://drive.google.com/file/d/abc123/preview', audioLanguage: 'hi' },
            { server: 'Server 3', sourceProvider: 'PlayZen', embed: 'https://archive.animeinfinity.me/player/mockToken', audioLanguage: 'hi' },
          ],
        }, 'application/json');
      }

      // FirePlayer (ravok.buzz)
      if (url.startsWith('https://ravok.buzz/video/')) {
        // Your Name mock has NO subtitles (tests honest zero-subtitle Japanese behavior); others have real English VTT
        if (url.includes('46a731f4af282372a4097ba1e4d76b95')) {
          return ok('<html><script>var playerjsSubtitle = "";</script></html>');
        }
        return ok(`<html><script>var playerjsSubtitle = "[English]${mockCdnBase}/subs/ravok.jpg"; var playerjsDefaultSubtitle = "English";</script></html>`);
      }
      if (url.startsWith('https://ravok.buzz/player/index.php')) {
        if (failFirePlayer) {
          return { status: 500, statusText: 'Err', headers: {}, config, data: 'error' };
        }
        const hash = urlObj.searchParams.get('data');
        const isOp = hash === '8757150decbd89b0f5442ca3db4d0e0e' || hash === '3d43cb0230c4f1ab6b9700689a881ec5';
        return ok({
          hls: true,
          securedLink: isOp
            ? 'https://ravok.buzz/cdn/hls/op/master.m3u8?md5=op&expires=9999999999'
            : 'https://ravok.buzz/cdn/hls/solo/master.m3u8?md5=solo&expires=9999999999',
        }, 'application/json');
      }
      if (url.startsWith('https://ravok.buzz/cdn/hls/op/master.m3u8')) {
        return ok(SAMPLE_ONE_PIECE_MASTER_M3U8, 'application/x-mpegURL');
      }
      if (url.startsWith('https://ravok.buzz/cdn/hls/solo/master.m3u8')) {
        return ok(SAMPLE_MULTI_AUDIO_MASTER_M3U8, 'application/x-mpegURL');
      }

      // PlayZen
      if (url.startsWith('https://archive.animeinfinity.me/player/')) {
        return ok(PLAYZEN_HTML);
      }

      // ZokoAnime (existing provider regression)
      if (url.startsWith('https://zokoanime.video/stream/mal/')) {
        const payload = JSON.stringify({
          src: 'https://cdn.zoko.test/master.m3u8',
          subtitles: [{ lang: 'en', label: 'English', default: true, src: 'https://cdn.zoko.test/en.vtt' }],
          download_url: null,
          video_id: 42,
          skip: { intro: { start: 0, end: 90 }, outro: null },
        });
        const key = 'otaku-embed-v1';
        const raw = Buffer.from(payload, 'utf8');
        const enc = Buffer.alloc(raw.length);
        for (let i = 0; i < raw.length; i++) enc[i] = raw[i] ^ key.charCodeAt(i % key.length);
        return ok(`<script>window.__P = "${enc.toString('base64')}";</script>`);
      }

      // AnimeHeaven (existing provider regression)
      if (url.startsWith('https://animeheaven.me/anime.php')) {
        return ok(`<a href="gate.php" onclick="gateh('epkey123')"><div class="watch2">1</div></a>`);
      }
      if (url.startsWith('https://animeheaven.me/gate.php')) {
        return ok(`<video><source src="https://cdn.ah.test/ep1.mp4" type="video/mp4" /></video>`);
      }

      // Anikoto (existing provider regression — /info, /episodes, /servers, /watch)
      if (url.startsWith('https://anikototv.to/filter')) {
        return ok(`<div class="film_list-wrap"><div class="flw-item"><a href="/watch/naruto-123" class="name">Naruto</a></div></div>`);
      }
      if (url.startsWith('https://anikototv.to/watch/naruto-123')) {
        return ok(`<div id="watch-main" data-id="123"><div id="w-episodes"><ul class="ep-range"><li><a href="/watch/naruto-123/ep-1" data-num="1" data-ids="srv1" title="Episode 1">1</a></li></ul></div></div>`);
      }
      if (url.startsWith('https://anikototv.to/ajax/server/list')) {
        return ok({ result: `<div class="type"><label>Sub</label><li class="server" data-link-id="lnk1" data-sv-id="4">Megaplay</li></div>` }, 'application/json');
      }
      if (url.startsWith('https://anikototv.to/ajax/server')) {
        return ok({ result: { url: 'https://megaplay.buzz/stream/s-2/1/sub' } }, 'application/json');
      }

      // MegaPlay (shared by Anikoto & MegaPlay Direct regression)
      if (url.startsWith('https://megaplay.buzz/stream/getSources')) {
        return ok({
          sources: { file: 'https://cdn.megaplay.test/ep1.m3u8' },
          tracks: [{ file: 'https://cdn.megaplay.test/en.vtt', label: 'English', default: true }],
        }, 'application/json');
      }
      if (url.startsWith('https://megaplay.buzz/stream/')) {
        return ok(`<html><head><title>File 999</title></head><body></body></html>`);
      }

      // DesiDub (existing provider regression — reuses src/utils/hls.ts)
      if (url.startsWith('https://www.desidubanime.me')) {
        if (urlObj.pathname === '/' && !urlObj.search) return ok(`<script>var x={"search_actions":"deadbeef12"};</script>`);
        if (urlObj.pathname === '/wp-admin/admin-ajax.php') {
          return ok({ data: { html: `<a href="https://www.desidubanime.me/anime/naruto/"><h3><span>Naruto</span></h3></a>` } }, 'application/json');
        }
        if (urlObj.pathname === '/anime/naruto/') {
          return ok(`<div class="episodelist"><ul><li><a href="https://www.desidubanime.me/watch/naruto-episode-1/">Episode 1</a></li></ul></div>`);
        }
        if (urlObj.pathname === '/watch/naruto-episode-1/') {
          const n = Buffer.from('VMoly (Hindi Dub)').toString('base64');
          const u = Buffer.from('https://vidmoly.net/embed-naruto1.html').toString('base64');
          return ok(`<button data-embed-id="${n}:${u}">VMoly</button>`);
        }
      }
      if (url.startsWith('https://vidmoly.net/embed-naruto1.html')) {
        return ok(`<script>sources: [{file:"https://cdn.vidmoly.test/master.m3u8"}]</script>`);
      }
      if (url.startsWith('https://cdn.vidmoly.test/master.m3u8')) {
        return ok(SAMPLE_MULTI_AUDIO_MASTER_M3U8, 'application/x-mpegURL');
      }

      throw new Error(`Unhandled mocked URL: ${url}`);
    };

    activeMockAdapter = handler;
  }

  it('GET /api/health preserves status.anivault.co shape and lists all 6 main sources', async () => {
    const res = await fetch(`${apiBase}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.checks.process.ok, true);
    assert.equal(body.checks.cache.ok, true);
    assert.deepEqual(body.meta.sources, ['animeheaven', 'anikoto', 'desidub', 'megaplay', 'animesalt', 'hindianime']);
  });

  it('AnimeSalt: Hindi Dub auto-selects Hindi, Japanese Sub auto-selects Japanese + real subs, zero-sub honesty, unavailable fallback, and movies', async () => {
    installMockUpstream();

    // 1. Solo Leveling S1 DUB *WITHOUT* ?audio= -> MUST select Hindi (hi/hin), NOT English or Japanese!
    const sl1 = await fetch(`${apiBase}/api/watch/animesalt/151807/1/dub`);
    assert.equal(sl1.status, 200);
    const sl1Data = await sl1.json();
    assert.equal(sl1Data.source, 'animesalt');
    assert.equal(sl1Data.playbackMode, 'hls');
    assert.equal(sl1Data.iframeOnly, false);
    assert.equal(sl1Data.selectedAudio, 'hi');
    assert.equal(sl1Data.selectedAudioCode, 'hin');
    assert.equal(sl1Data.requestedAudioUnavailable, false);
    assert.match(sl1Data.hlsProxyUrl, /\/api\/proxy\/hls\?.*audio=hin/);
    assert.equal(sl1Data.streamUrl, sl1Data.hlsProxyUrl);
    assert.deepEqual(sl1Data.languages, ['ja', 'en', 'te', 'ta', 'hi']);
    assert.deepEqual(sl1Data.originalLanguages, ['jpn', 'eng', 'tel', 'tam', 'hin']);
    assert.equal(sl1Data.audioTracks.length, 5);
    assert.equal(sl1Data.audioTracks[4].language, 'hi');
    assert.equal(sl1Data.audioTracks[4].originalLanguageCode, 'hin');
    assert.equal(sl1Data.audioTracks[4].default, true);
    assert.equal(sl1Data.audioTracks[0].default, false);
    assert.equal(sl1Data.audioTracks[1].default, false);
    assert.equal(sl1Data.hasSubtitles, true);
    assert.equal(sl1Data.subtitleTracks.length, 1);
    assert.equal(sl1Data.subtitleTracks[0].default, false); // dub does not force subs on
    assert.ok(sl1Data.availableServers.includes('FirePlayer (Multi-Audio)'));
    assert.ok(sl1Data.availableServers.some((s) => s.includes('AbyssPlayer')));

    // 2. Solo Leveling S1 SUB *WITHOUT* ?audio= -> MUST select Japanese (ja/jpn) + default English subtitle
    const sl1Sub = await fetch(`${apiBase}/api/watch/animesalt/151807/1/sub`);
    assert.equal(sl1Sub.status, 200);
    const sl1SubData = await sl1Sub.json();
    assert.equal(sl1SubData.selectedAudio, 'ja');
    assert.equal(sl1SubData.selectedAudioCode, 'jpn');
    assert.equal(sl1SubData.audioMode, 'japanese-sub');
    assert.equal(sl1SubData.hasSubtitles, true);
    assert.equal(sl1SubData.subtitleTracks[0].default, true);
    assert.match(sl1SubData.hlsProxyUrl, /audio=jpn/);

    // 3. RAW endpoint works & selects Japanese without forcing subtitles
    const sl1Raw = await fetch(`${apiBase}/api/watch/animesalt/151807/1/raw`);
    assert.equal(sl1Raw.status, 200);
    const sl1RawData = await sl1Raw.json();
    assert.equal(sl1RawData.selectedAudio, 'ja');
    assert.equal(sl1RawData.subtitleTracks[0].default, false);

    // 4. Unavailable language reports honest fallback + warning
    const sl1Missing = await fetch(`${apiBase}/api/watch/animesalt/151807/1/dub?audio=kor`);
    assert.equal(sl1Missing.status, 200);
    const sl1MissingData = await sl1Missing.json();
    assert.equal(sl1MissingData.requestedAudio, 'ko');
    assert.equal(sl1MissingData.requestedAudioUnavailable, true);
    assert.equal(sl1MissingData.audioFallback, true);
    assert.equal(sl1MissingData.selectedAudio, 'hi');
    assert.match(sl1MissingData.audioWarning, /Korean.*unavailable.*Hindi/i);
    assert.match(sl1MissingData.hlsProxyUrl, /audio=hin/);

    // 5. Solo Leveling S2 (different AniList ID 176496 -> maps to series:solo-leveling:s2)
    const sl2Eps = await fetch(`${apiBase}/api/episodes?anilistId=176496&source=animesalt`);
    assert.equal(sl2Eps.status, 200);
    const sl2EpsData = await sl2Eps.json();
    assert.equal(sl2EpsData.siteId, 'series:solo-leveling:s2');
    assert.equal(sl2EpsData.episodes[0].id, 'solo-leveling-2x1');

    // 6. One Piece Season 21 ep 1089 (7 audio languages!)
    const opWatch = await fetch(`${apiBase}/api/watch/animesalt/21/1089/dub`);
    assert.equal(opWatch.status, 200);
    const opData = await opWatch.json();
    assert.equal(opData.playbackMode, 'hls');
    assert.equal(opData.selectedAudio, 'hi');
    assert.deepEqual(opData.languages, ['ja', 'en', 'kn', 'ml', 'te', 'ta', 'hi']);
    assert.deepEqual(opData.originalLanguages, ['jpn', 'eng', 'kan', 'mal', 'tel', 'tam', 'hin']);

    // 7. Naruto S1 + S2 absolute numbering (ep 58) + enriched /api/servers
    const narutoServers = await fetch(`${apiBase}/api/servers?anilistId=20&ep=58&type=dub&source=animesalt`);
    assert.equal(narutoServers.status, 200);
    const narutoData = await narutoServers.json();
    assert.ok(narutoData.servers.length >= 2);
    assert.equal(narutoData.servers[0].name, 'FirePlayer (Multi-Audio)');
    assert.equal(narutoData.servers[0].multiAudio, true);
    assert.deepEqual(narutoData.servers[0].languages, ['ja', 'en', 'te', 'ta', 'hi']);

    // 8. Your Name movie SUB with ZERO subtitles -> honest japanese-raw + subtitleNotice (never fabricates subs!)
    const ynSub = await fetch(`${apiBase}/api/watch/animesalt/21519/1/sub`);
    assert.equal(ynSub.status, 200);
    const ynData = await ynSub.json();
    assert.equal(ynData.siteId, 'movies:your-name');
    assert.equal(ynData.playbackMode, 'hls');
    assert.equal(ynData.selectedAudio, 'ja');
    assert.equal(ynData.hasSubtitles, false);
    assert.equal(ynData.subtitleTracks.length, 0);
    assert.equal(ynData.audioMode, 'japanese-raw');
    assert.match(ynData.subtitleNotice, /no subtitle tracks/i);

    // 9. Strict AbyssPlayer fallback returns iframe-only (never fake abyss:// MP4!)
    const abyssWatch = await fetch(`${apiBase}/api/watch/animesalt/151807/1/dub?server=AbyssPlayer&strict=1`);
    assert.equal(abyssWatch.status, 200);
    const abyssData = await abyssWatch.json();
    assert.equal(abyssData.playbackMode, 'iframe');
    assert.equal(abyssData.iframeOnly, true);
    assert.equal(abyssData.m3u8, null);
    assert.match(abyssData.embedUrl, /^https:\/\/player\.abyssplayer\.com\//);
  });

  it('Hindi Anime: Naruto, Shippuden, One Piece S21 ep 1089, Solo Leveling S1/S2, auto Hindi/Japanese audio, and FirePlayer -> PlayZen fallback', async () => {
    installMockUpstream();

    // Solo Leveling S2 DUB without ?audio= -> automatically selects Hindi!
    const sl2 = await fetch(`${apiBase}/api/watch/hindianime/176496/1/dub`);
    assert.equal(sl2.status, 200);
    const sl2Data = await sl2.json();
    assert.equal(sl2Data.source, 'hindianime');
    assert.equal(sl2Data.siteId, 'solo-leveling::0::s2');
    assert.equal(sl2Data.playbackMode, 'hls');
    assert.equal(sl2Data.selectedAudio, 'hi');
    assert.match(sl2Data.hlsProxyUrl, /audio=hin/);
    assert.deepEqual(sl2Data.languages, ['ja', 'en', 'te', 'ta', 'hi']);
    assert.deepEqual(sl2Data.availableServers, [
      'FirePlayer (Multi-Audio)',
      'PlayZen (Multi-Audio)',
      'GoogleDrive (Hindi Dub)',
    ]);

    // Solo Leveling S2 SUB without ?audio= -> automatically selects Japanese!
    const sl2Sub = await fetch(`${apiBase}/api/watch/hindianime/176496/1/sub`);
    assert.equal(sl2Sub.status, 200);
    const sl2SubData = await sl2Sub.json();
    assert.equal(sl2SubData.selectedAudio, 'ja');
    assert.match(sl2SubData.hlsProxyUrl, /audio=jpn/);

    // Naruto Shippuden (must NOT collapse to Naruto)
    const nsEps = await fetch(`${apiBase}/api/episodes?anilistId=1735&source=hindianime`);
    assert.equal(nsEps.status, 200);
    const nsData = await nsEps.json();
    assert.equal(nsData.siteId, 'naruto-shippuden::0');

    // One Piece S21 ep 1089 via binary search
    const op = await fetch(`${apiBase}/api/watch/hindianime/21/1089/dub`);
    assert.equal(op.status, 200);
    const opData = await op.json();
    assert.equal(opData.playbackMode, 'hls');
    assert.equal(opData.selectedAudio, 'hi');
    assert.deepEqual(opData.languages, ['ja', 'en', 'kn', 'ml', 'te', 'ta', 'hi']);

    // When FirePlayer fails (HTTP 500), falls back cleanly to PlayZen (Priority 2) without failing the request!
    installMockUpstream({ failFirePlayer: true });
    const fb = await fetch(`${apiBase}/api/watch/hindianime/20/1/dub`);
    assert.equal(fb.status, 200);
    const fbData = await fb.json();
    assert.equal(fbData.server, 'PlayZen (Multi-Audio)');
    assert.equal(fbData.playbackMode, 'iframe');
    assert.equal(fbData.mkvQuality, '720p');
    assert.equal(fbData.mkvMimeType, 'video/x-matroska');
    assert.match(fbData.mkv, /720p/);
  });

  it('HLS Proxy: ?audio=hin selection, extensionless #EXTM3U rewrite, .js MPEG-TS -> video/mp2t, real JS preserved, and burst >60 req/min', async () => {
    // 1. Master playlist with ?audio=hin sets DEFAULT=YES,AUTOSELECT=YES on Hindi and DEFAULT=NO,AUTOSELECT=NO on English/Japanese
    const mRes = await fetch(`${apiBase}/api/proxy/hls?url=${encodeURIComponent(`${mockCdnBase}/master.m3u8`)}&audio=hin`);
    assert.equal(mRes.status, 200);
    const mText = await mRes.text();
    const audioLines = mText.split('\n').filter((l) => l.includes('TYPE=AUDIO'));
    assert.equal(audioLines.length, 5);
    assert.match(audioLines.find((l) => l.includes('LANGUAGE="hin"')), /DEFAULT=YES.*AUTOSELECT=YES/);
    assert.match(audioLines.find((l) => l.includes('LANGUAGE="eng"')), /DEFAULT=NO.*AUTOSELECT=NO/);
    assert.match(audioLines.find((l) => l.includes('LANGUAGE="jpn"')), /DEFAULT=NO.*AUTOSELECT=NO/);

    // 2. Extensionless /hls/video-720p variant playlist (sent as text/plain) still rewritten!
    const vRes = await fetch(`${apiBase}/api/proxy/hls?url=${encodeURIComponent(`${mockCdnBase}/hls/video-720p`)}`);
    assert.equal(vRes.status, 200);
    assert.match(vRes.headers.get('content-type'), /mpegurl/i);
    const vText = await vRes.text();
    assert.match(vText, /\/api\/proxy\/hls\?url=.*chunk001\.js/);

    // 3. Disguised .js MPEG-TS segment -> Content-Type: video/mp2t!
    const tsJsRes = await fetch(`${apiBase}/api/proxy/hls?url=${encodeURIComponent(`${mockCdnBase}/seg/chunk001.js`)}`);
    assert.equal(tsJsRes.status, 200);
    assert.match(tsJsRes.headers.get('content-type'), /video\/mp2t/i);
    const tsBuf = Buffer.from(await tsJsRes.arrayBuffer());
    assert.equal(tsBuf[0], 0x47);
    assert.equal(tsBuf[188], 0x47);

    // 4. Genuine JavaScript text is NOT misclassified as video/mp2t
    const realJsRes = await fetch(`${apiBase}/api/proxy/hls?url=${encodeURIComponent(`${mockCdnBase}/seg/real-script.js`)}`);
    assert.equal(realJsRes.status, 200);
    assert.match(realJsRes.headers.get('content-type'), /javascript/i);

    // 5. Existing .woff -> video/mp4 preserved
    const woffRes = await fetch(`${apiBase}/api/proxy/hls?url=${encodeURIComponent(`${mockCdnBase}/seg/init.woff`)}`);
    assert.equal(woffRes.status, 200);
    assert.match(woffRes.headers.get('content-type'), /video\/mp4/i);

    // 6. Subtitle proxy SRT & ravok.buzz single-digit hour timestamps -> strict WEBVTT
    const subRes = await fetch(`${apiBase}/api/proxy/subtitle?url=${encodeURIComponent(`${mockCdnBase}/subs/en.srt`)}`);
    assert.equal(subRes.status, 200);
    assert.match(subRes.headers.get('content-type'), /text\/vtt/i);
    const subText = await subRes.text();
    assert.ok(subText.startsWith('WEBVTT'));
    assert.match(subText, /00:00:01\.000 --> 00:00:03\.500/);

    const ravokSubRes = await fetch(`${apiBase}/api/proxy/subtitle?url=${encodeURIComponent(`${mockCdnBase}/subs/ravok.jpg`)}`);
    assert.equal(ravokSubRes.status, 200);
    assert.match(ravokSubRes.headers.get('content-type'), /text\/vtt/i);
    const ravokSubText = await ravokSubRes.text();
    assert.ok(ravokSubText.startsWith('WEBVTT'));
    assert.match(ravokSubText, /00:00:02\.740 --> 00:00:04\.820/);

    // 7. Video proxy Range/206 regression
    const vidRes = await fetch(`${apiBase}/api/proxy/video?url=${encodeURIComponent(`${mockCdnBase}/video/sample.mp4`)}`, {
      headers: { Range: 'bytes=0-7' },
    });
    assert.equal(vidRes.status, 206);
    assert.equal((await vidRes.text()), '01234567');

    // 8. Burst test: 75 proxy requests succeed without hitting the 60 req/min API scraper limit
    const burstStatuses = await Promise.all(
      Array.from({ length: 75 }, () =>
        fetch(`${apiBase}/api/proxy/hls?url=${encodeURIComponent(`${mockCdnBase}/seg/chunk002.ts`)}`).then((r) => r.status)
      )
    );
    assert.ok(burstStatuses.every((s) => s === 200), `Expected all 75 proxy requests to return 200, got: ${burstStatuses.filter((s) => s !== 200)}`);
  });

  it('Existing Provider Regressions: /api/search, AnimeHeaven direct MP4, and ZokoAnime legacy routes', async () => {
    installMockUpstream();

    // /api/search
    const srch = await fetch(`${apiBase}/api/search?q=naruto`);
    assert.equal(srch.status, 200);
    const srchData = await srch.json();
    assert.equal(srchData.source, 'anilist');
    assert.equal(srchData.results[0].malId, 20);

    // AnimeHeaven direct MP4 legacy schema preserved verbatim
    const ah = await fetch(`${apiBase}/api/watch/animeheaven/ukr6y/1/sub`);
    assert.equal(ah.status, 200);
    const ahData = await ah.json();
    assert.equal(ahData.playbackMode, 'mp4');
    assert.equal(ahData.siteId, 'ukr6y');
    assert.equal(ahData.mp4, 'https://cdn.ah.test/ep1.mp4');
    assert.match(ahData.mp4ProxyUrl, /\/api\/proxy\/video\?url=/);
    assert.equal(ahData.streamUrl, ahData.mp4ProxyUrl);
    assert.equal(ahData.rawStreamUrl, 'https://cdn.ah.test/ep1.mp4');

    // ZokoAnime legacy endpoints & response keys preserved verbatim
    const zs = await fetch(`${apiBase}/api/providers/zokoanime/servers?malId=20&ep=1`);
    assert.equal(zs.status, 200);
    const zsData = await zs.json();
    assert.equal(zsData.source, 'zokoanime');
    assert.equal(zsData.servers.length, 2);

    const zw = await fetch(`${apiBase}/api/providers/zokoanime/watch?serverId=20::1::sub`);
    assert.equal(zw.status, 200);
    const zwData = await zw.json();
    assert.equal(zwData.source, 'zokoanime');
    assert.equal(zwData.serverName, 'ZokoAnime');
    assert.equal(zwData.iframeOnly, false);
    assert.ok(zwData.skip && zwData.skip.intro);
    assert.equal(zwData.subtitles[0].src, 'https://cdn.zoko.test/en.vtt');
    assert.match(zwData.subtitles[0].url, /\/api\/proxy\/subtitle\?url=/);

    // /api/info + Anikoto watch regression
    const info = await fetch(`${apiBase}/api/info?anilistId=20`);
    assert.equal(info.status, 200);
    const infoData = await info.json();
    assert.equal(infoData.malId, 20);
    assert.equal(infoData.siteIds.anikoto, 'naruto-123');

    const ak = await fetch(`${apiBase}/api/watch/anikoto/20/1/sub`);
    assert.equal(ak.status, 200);
    const akData = await ak.json();
    assert.equal(akData.source, 'anikoto');
    assert.equal(akData.playbackMode, 'hls');
    assert.equal(akData.m3u8, 'https://cdn.megaplay.test/ep1.m3u8');

    // MegaPlay Direct regression
    const mp = await fetch(`${apiBase}/api/watch/megaplay/20/1/sub`);
    assert.equal(mp.status, 200);
    const mpData = await mp.json();
    assert.equal(mpData.source, 'megaplay');
    assert.equal(mpData.playbackMode, 'hls');
    assert.equal(mpData.m3u8, 'https://cdn.megaplay.test/ep1.m3u8');

    // DesiDub regression (verifies reused src/utils/hls.ts parser keeps DesiDub working)
    const dd = await fetch(`${apiBase}/api/watch/desidub/20/1/dub`);
    assert.equal(dd.status, 200);
    const ddData = await dd.json();
    assert.equal(ddData.source, 'desidub');
    assert.equal(ddData.playbackMode, 'hls');
    assert.equal(ddData.m3u8, 'https://cdn.vidmoly.test/master.m3u8');
  });
});
