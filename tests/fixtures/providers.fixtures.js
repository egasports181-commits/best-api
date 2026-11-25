'use strict';

// Deterministic offline fixtures modeled directly on live verified responses

function makeSyntheticMpegTsBuffer(packetCount = 6) {
  const buf = Buffer.alloc(packetCount * 188, 0x00);
  for (let i = 0; i < packetCount; i++) {
    buf[i * 188] = 0x47;
    buf[i * 188 + 1] = 0x40;
    buf[i * 188 + 2] = 0x11;
    buf[i * 188 + 3] = 0x10 + (i & 0x0f);
  }
  return buf;
}

const SAMPLE_MULTI_AUDIO_MASTER_M3U8 = `#EXTM3U
#EXT-X-VERSION:3
#
#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="jpn",NAME="Japanese",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/audio-jpn"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="eng",NAME="English",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/audio-eng"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="tel",NAME="Telugu",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/audio-tel"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="tam",NAME="Tamil",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/audio-tam"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="hin",NAME="Hindi",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/audio-hin"
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=750000,RESOLUTION=842x480,NAME="480p",CODECS="avc1.4D401E,mp4a.40.2",AUDIO="audio"
/hls/video-480p
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2048000,RESOLUTION=1280x720,NAME="720p",CODECS="avc1.4D401F,mp4a.40.2",AUDIO="audio"
/hls/video-720p
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=4096000,RESOLUTION=1920x1080,NAME="1080p",CODECS="avc1.640028,mp4a.40.2",AUDIO="audio"
/hls/video-1080p
`;

const SAMPLE_ONE_PIECE_MASTER_M3U8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="jpn",NAME="Japanese",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/op-jpn"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="eng",NAME="English",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/op-eng"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="kan",NAME="Kannada",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/op-kan"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="mal",NAME="Malayalam",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/op-mal"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="tel",NAME="Telugu",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/op-tel"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="tam",NAME="Tamil",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/op-tam"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="hin",NAME="Hindi",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/op-hin"
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2048000,RESOLUTION=1280x720,NAME="720p",AUDIO="audio"
/hls/op-720p
`;

const SAMPLE_VARIANT_M3U8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.002,
/seg/chunk001.js
#EXTINF:2.002,
/seg/chunk002.ts
#EXT-X-ENDLIST
`;

const ANIMESALT_SEARCH_NARUTO_HTML = `
<html><body>
  <article class="post dfx fcl movies">
    <header class="entry-header"><h2 class="entry-title">Boruto: Naruto Next Generations</h2></header>
    <div class="post-thumbnail"><figure><img data-src="//image.tmdb.org/t/p/w500/boruto.jpg" /></figure></div>
    <a href="https://animesalt.cx/series/boruto-naruto-next-generations/" class="lnk-blk"></a>
  </article>
  <article class="post dfx fcl movies">
    <header class="entry-header"><h2 class="entry-title">Naruto Shippuden</h2></header>
    <div class="post-thumbnail"><figure><img data-src="//image.tmdb.org/t/p/w500/shippuden.jpg" /></figure></div>
    <a href="https://animesalt.cx/series/naruto-shippuden/" class="lnk-blk"></a>
  </article>
  <article class="post dfx fcl movies">
    <header class="entry-header"><h2 class="entry-title">Naruto</h2></header>
    <div class="post-thumbnail"><figure><img data-src="//image.tmdb.org/t/p/w500/naruto.jpg" /></figure></div>
    <a href="https://animesalt.cx/series/naruto/" class="lnk-blk"></a>
  </article>
</body></html>`;

const ANIMESALT_SEARCH_SOLO_HTML = `
<html><body>
  <article class="post dfx fcl movies">
    <header class="entry-header"><h2 class="entry-title">Solo Leveling</h2></header>
    <div class="post-thumbnail"><figure><img data-src="//image.tmdb.org/t/p/w500/solo.jpg" /></figure></div>
    <a href="https://animesalt.cx/series/solo-leveling/" class="lnk-blk"></a>
  </article>
</body></html>`;

const ANIMESALT_SEARCH_ONE_PIECE_HTML = `
<html><body>
  <article class="post dfx fcl movies">
    <header class="entry-header"><h2 class="entry-title">LEGO One Piece</h2></header>
    <a href="https://animesalt.cx/series/lego-one-piece/" class="lnk-blk"></a>
  </article>
  <article class="post dfx fcl movies">
    <header class="entry-header"><h2 class="entry-title">ONE PIECE Live Action</h2></header>
    <a href="https://animesalt.cx/series/one-piece-live-action/" class="lnk-blk"></a>
  </article>
  <article class="post dfx fcl movies">
    <header class="entry-header"><h2 class="entry-title">One Piece</h2></header>
    <a href="https://animesalt.cx/series/one-piece/" class="lnk-blk"></a>
  </article>
</body></html>`;

const ANIMESALT_SEARCH_YOUR_NAME_HTML = `
<html><body>
  <article class="post dfx fcl movies">
    <header class="entry-header"><h2 class="entry-title">Your Name.</h2></header>
    <a href="https://animesalt.cx/movies/your-name/" class="lnk-blk"></a>
  </article>
</body></html>`;

const ANIMESALT_SERIES_SOLO_HTML = `
<html><head><meta property="og:image" content="https://image.tmdb.org/t/p/w500/solo.jpg" /></head>
<body>
  <h1>Solo Leveling</h1>
  <a href="javascript:void(0)" class="season-btn sel-temp active" data-post="292" data-season="1">Season 1 • 1-12 (12)</a>
  <a href="javascript:void(0)" class="season-btn sel-temp" data-post="292" data-season="2">Season 2 • 1-13 (13)</a>
</body></html>`;

const ANIMESALT_SERIES_ONE_PIECE_HTML = `
<html><body>
  <h1>One Piece</h1>
  <a href="javascript:void(0)" class="season-btn" data-post="294" data-season="1">Season 1 • 1-61 (61)</a>
  <a href="javascript:void(0)" class="season-btn" data-post="294" data-season="20">Season 20 • 892-1088 (197)</a>
  <a href="javascript:void(0)" class="season-btn" data-post="294" data-season="21">Season 21 • 1089-1155 (67)</a>
</body></html>`;

const ANIMESALT_SERIES_NARUTO_HTML = `
<html><body>
  <h1>Naruto</h1>
  <a href="javascript:void(0)" class="season-btn" data-post="332" data-season="1">Season 1 • 1-57 (57)</a>
  <a href="javascript:void(0)" class="season-btn" data-post="332" data-season="2">Season 2 • 58-100 (43)</a>
</body></html>`;

const ANIMESALT_AJAX_SOLO_S1 = `
<li><article class="post episodes"><header><span class="num-epi">1</span><h2 class="entry-title">Solo Leveling 1x1</h2></header><a href="https://animesalt.cx/episode/solo-leveling-1x1/" class="lnk-blk"></a></article></li>
<li><article class="post episodes"><header><span class="num-epi">2</span><h2 class="entry-title">Solo Leveling 1x2</h2></header><a href="https://animesalt.cx/episode/solo-leveling-1x2/" class="lnk-blk"></a></article></li>`;

const ANIMESALT_AJAX_SOLO_S2 = `
<li><article class="post episodes"><header><span class="num-epi">1</span><h2 class="entry-title">Solo Leveling 2x1</h2></header><a href="https://animesalt.cx/episode/solo-leveling-2x1/" class="lnk-blk"></a></article></li>
<li><article class="post episodes"><header><span class="num-epi">2</span><h2 class="entry-title">Solo Leveling 2x2</h2></header><a href="https://animesalt.cx/episode/solo-leveling-2x2/" class="lnk-blk"></a></article></li>`;

const ANIMESALT_AJAX_ONE_PIECE_S21 = `
<li><article class="post episodes"><header><span class="num-epi">1089</span><h2 class="entry-title">One Piece 21x1089</h2></header><a href="https://animesalt.cx/episode/one-piece-21x1089/" class="lnk-blk"></a></article></li>
<li><article class="post episodes"><header><span class="num-epi">1090</span><h2 class="entry-title">One Piece 21x1090</h2></header><a href="https://animesalt.cx/episode/one-piece-21x1090/" class="lnk-blk"></a></article></li>`;

const ANIMESALT_AJAX_NARUTO_S1 = `
<li><article class="post episodes"><header><span class="num-epi">1</span><h2 class="entry-title">Naruto 1x1</h2></header><a href="https://animesalt.cx/episode/naruto-1x1/" class="lnk-blk"></a></article></li>`;

const ANIMESALT_AJAX_NARUTO_S2 = `
<li><article class="post episodes"><header><span class="num-epi">58</span><h2 class="entry-title">Naruto 2x58</h2></header><a href="https://animesalt.cx/episode/naruto-2x58/" class="lnk-blk"></a></article></li>`;

function makeAnimesaltEpisodeHtml(ravokHash, abyssEntries) {
  const b64 = Buffer.from(JSON.stringify(abyssEntries), 'utf8').toString('base64');
  return `
  <html><body>
    <h1>Episode</h1>
    <div id="options-0" class="video"><iframe src="https://ravok.buzz/video/${ravokHash}" data-src="https://ravok.buzz/video/${ravokHash}"></iframe></div>
    <div id="options-1" class="video"><iframe data-src="https://animesalt.cx/wp-content/themes/torofilm/public/plyr/player.php?data=${encodeURIComponent(b64)}"></iframe></div>
  </body></html>`;
}

const HINDIANIME_SEARCH_INDEX = [
  { id: 'naruto', slug: 'naruto', title: 'Naruto', type: 'TV', seasons: 5, languages: ['hindi'], poster: 'https://img/naruto.jpg' },
  { id: 'naruto-shippuden', slug: 'naruto-shippuden', title: 'Naruto Shippuden', type: 'TV', seasons: 22, languages: ['hindi'], poster: 'https://img/ship.jpg' },
  { id: 'boruto-naruto-next-generations', slug: 'boruto-naruto-next-generations', title: 'Boruto: Naruto Next Generations', type: 'TV', seasons: 1, languages: ['hindi'] },
  { id: 'one-piece', slug: 'one-piece', title: 'One Piece', type: 'TV', seasons: 21, languages: ['hindi'] },
  { id: 'one-piece-live-action', slug: 'one-piece-live-action', title: 'ONE PIECE Live Action', type: 'TV', seasons: 1, languages: ['hindi'] },
  { id: 'solo-leveling', slug: 'solo-leveling', title: 'Solo Leveling', type: 'TV', seasons: 2, languages: ['hindi'] },
  { id: 'your-name', slug: 'your-name', title: 'Your Name', type: 'Movie', seasons: 1, languages: ['hindi'] },
];

const PLAYZEN_HTML = `
<html><body>
  <video>
    <source src="https://player.animeinfinity.me/abc480/%5BAnime%20Infinity%5D%20Solo%20Leveling%20S01E01%20480p%20WEB-DL%20Multi%20Audio%20ESub.mkv" type="video/x-matroska" />
    <source src="https://player.animeinfinity.me/abc720/%5BAnime%20Infinity%5D%20Solo%20Leveling%20S01E01%20720p%20HD%20WEB-DL%20Multi%20Audio%20ESub.mkv" type="video/x-matroska" />
  </video>
</body></html>`;

module.exports = {
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
};
