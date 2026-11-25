'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../../dist/server').default;
const { isMpegTsBuffer } = require('../../dist/utils/hls');

describe('Live End-to-End Verification (All 6 Target Episodes + Audio/Subtitle/Proxy/Regression)', () => {
  let server;
  let baseUrl;

  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  async function verifyAudioTrackPlayback(label, watchUrl, expectedIso1, expectedOriginalCode) {
    const wRes = await fetch(watchUrl);
    const wData = await wRes.json();
    assert.equal(wRes.status, 200, `[${label}] /watch returned ${wRes.status}: ${JSON.stringify(wData)}`);
    assert.equal(wData.playbackMode, 'hls', `[${label}] expected hls, got ${wData.playbackMode}`);
    assert.ok(wData.hlsProxyUrl, `[${label}] missing hlsProxyUrl`);
    assert.equal(wData.selectedAudio, expectedIso1, `[${label}] expected selectedAudio=${expectedIso1}, got ${wData.selectedAudio}`);
    assert.equal(wData.selectedAudioCode, expectedOriginalCode, `[${label}] expected selectedAudioCode=${expectedOriginalCode}, got ${wData.selectedAudioCode}`);
    assert.equal(wData.requestedAudioUnavailable, false, `[${label}] unexpected requestedAudioUnavailable`);

    // Verify default flag in JSON matches selected audio ONLY
    const defaultTracks = wData.audioTracks.filter((t) => t.default);
    assert.equal(defaultTracks.length, 1, `[${label}] expected exactly 1 default track in audioTracks`);
    assert.equal(defaultTracks[0].language, expectedIso1, `[${label}] default track mismatch`);

    // 1. Fetch rewritten master playlist from /api/proxy/hls
    const masterRes = await fetch(wData.hlsProxyUrl);
    assert.equal(masterRes.status, 200, `[${label}] master returned ${masterRes.status}`);
    assert.match(masterRes.headers.get('content-type') || '', /mpegurl/i);
    const masterText = await masterRes.text();
    assert.ok(masterText.trim().startsWith('#EXTM3U'), `[${label}] master not #EXTM3U`);
    assert.equal(masterText.split(/\r?\n/).filter((l) => l.trim() === '#EXTM3U').length, 1, `[${label}] duplicate #EXTM3U`);

    // Verify selected track has DEFAULT=YES,AUTOSELECT=YES and ALL others have DEFAULT=NO,AUTOSELECT=NO
    const audioLines = masterText.split(/\r?\n/).filter((l) => l.includes('TYPE=AUDIO'));
    assert.equal(audioLines.length, wData.audioTracks.length, `[${label}] audio track count preserved`);
    const targetLine = audioLines.find((l) => new RegExp(`LANGUAGE="${expectedOriginalCode}"`, 'i').test(l));
    assert.ok(targetLine, `[${label}] missing LANGUAGE="${expectedOriginalCode}" in rewritten master`);
    assert.match(targetLine, /DEFAULT=YES.*AUTOSELECT=YES/, `[${label}] target track must be DEFAULT=YES,AUTOSELECT=YES`);
    for (const other of audioLines.filter((l) => l !== targetLine)) {
      assert.match(other, /DEFAULT=NO.*AUTOSELECT=NO/, `[${label}] non-selected track must be DEFAULT=NO,AUTOSELECT=NO: ${other}`);
    }

    // 2. Fetch proxied video variant playlist + video segment (verify MPEG-TS + video/mp2t)
    const variantUrl = masterText.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'));
    assert.ok(variantUrl && variantUrl.includes('/api/proxy/hls?'), `[${label}] missing rewritten variant URL`);
    const varRes = await fetch(variantUrl.trim());
    assert.equal(varRes.status, 200);
    const varText = await varRes.text();
    const vSegUrl = varText.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'));
    const vSegRes = await fetch(vSegUrl.trim());
    assert.equal(vSegRes.status, 200);
    assert.match(vSegRes.headers.get('content-type') || '', /video\/mp2t/i);
    const vSegBuf = Buffer.from(await vSegRes.arrayBuffer());
    assert.equal(isMpegTsBuffer(vSegBuf), true, `[${label}] video segment failed MPEG-TS check`);

    // 3. Fetch proxied audio playlist for the SELECTED language + audio segment (verify MPEG-TS + video/mp2t)
    const audioPlUrl = targetLine.match(/URI="([^"]+)"/)?.[1];
    assert.ok(audioPlUrl && audioPlUrl.includes('/api/proxy/hls?'), `[${label}] missing proxied audio playlist URI`);
    const aPlRes = await fetch(audioPlUrl);
    assert.equal(aPlRes.status, 200);
    const aPlText = await aPlRes.text();
    assert.ok(aPlText.trim().startsWith('#EXTM3U'), `[${label}] audio playlist not #EXTM3U`);
    const aSegUrl = aPlText.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'));
    const aSegRes = await fetch(aSegUrl.trim());
    assert.equal(aSegRes.status, 200);
    assert.match(aSegRes.headers.get('content-type') || '', /video\/mp2t/i);
    const aSegBuf = Buffer.from(await aSegRes.arrayBuffer());
    assert.equal(isMpegTsBuffer(aSegBuf), true, `[${label}] ${expectedOriginalCode} audio segment failed MPEG-TS check`);

    // 4. If subtitle tracks exist, verify proxied subtitle returns valid WebVTT with HH:MM:SS.mmm timestamps
    let subtitleVerified = 'none';
    if (Array.isArray(wData.subtitleTracks) && wData.subtitleTracks.length > 0) {
      const subRes = await fetch(wData.subtitleTracks[0].url);
      assert.equal(subRes.status, 200, `[${label}] subtitle proxy returned ${subRes.status}`);
      assert.match(subRes.headers.get('content-type') || '', /text\/vtt/i);
      const subText = await subRes.text();
      assert.ok(subText.startsWith('WEBVTT'), `[${label}] proxied subtitle missing WEBVTT header`);
      assert.match(subText, /\d{2}:\d{2}(?::\d{2})?\.\d{3}\s*-->\s*\d{2}:\d{2}(?::\d{2})?\.\d{3}/, `[${label}] proxied subtitle invalid WebVTT cue timestamps`);
      subtitleVerified = `${wData.subtitleTracks.map((s) => `${s.name}(${s.language})`).join(', ')} (${subText.length}B VTT OK)`;
    }

    return {
      server: wData.server,
      selectedAudio: `${wData.selectedAudioName} (${wData.selectedAudio}/${wData.selectedAudioCode})`,
      audioMode: wData.audioMode,
      allTracks: wData.audioTracks.map((t) => `${t.name}(${t.language}/${t.originalLanguageCode})`),
      subtitles: subtitleVerified,
      videoSegBytes: vSegBuf.length,
      audioSegBytes: aSegBuf.length,
    };
  }

  const TARGET_EPISODES = [
    { provider: 'animesalt', title: 'Naruto Ep 1', malId: 20, ep: 1 },
    { provider: 'animesalt', title: 'One Piece Ep 1', malId: 21, ep: 1 },
    { provider: 'animesalt', title: 'Solo Leveling S1E1', malId: 52299, ep: 1 },
    { provider: 'hindianime', title: 'Naruto Ep 1', malId: 20, ep: 1 },
    { provider: 'hindianime', title: 'One Piece Ep 1', malId: 21, ep: 1 },
    { provider: 'hindianime', title: 'Solo Leveling S1E1', malId: 52299, ep: 1 },
  ];

  for (const target of TARGET_EPISODES) {
    it(`LIVE ${target.provider} — ${target.title}: /servers + Hindi Dub + Japanese Sub + English + real MPEG-TS & VTT`, async () => {
      // 1. Check /api/servers (dub & sub)
      const dubSrvRes = await fetch(`${baseUrl}/api/servers?malId=${target.malId}&ep=${target.ep}&type=dub&source=${target.provider}`);
      assert.equal(dubSrvRes.status, 200);
      const dubSrv = await dubSrvRes.json();
      const fpDub = dubSrv.servers.find((s) => s.name === 'FirePlayer (Multi-Audio)');
      assert.ok(fpDub && fpDub.multiAudio === true, `${target.provider} ${target.title} missing FirePlayer dub`);
      assert.ok(Array.isArray(fpDub.languages) && fpDub.languages.includes('hi') && fpDub.languages.includes('ja'));

      const subSrvRes = await fetch(`${baseUrl}/api/servers?malId=${target.malId}&ep=${target.ep}&type=sub&source=${target.provider}`);
      assert.equal(subSrvRes.status, 200);
      const subSrv = await subSrvRes.json();
      assert.ok(subSrv.servers.some((s) => s.name === 'FirePlayer (Multi-Audio)'), `${target.provider} ${target.title} missing FirePlayer sub`);

      // 2. Default DUB (NO ?audio=) MUST select & stream real Hindi audio!
      const hinReport = await verifyAudioTrackPlayback(
        `${target.provider} ${target.title} [DUB->Hindi]`,
        `${baseUrl}/api/watch/${target.provider}/mal-${target.malId}/${target.ep}/dub`,
        'hi',
        'hin'
      );

      // 3. Default SUB (NO ?audio=) MUST select & stream real Japanese audio (+ real VTT if present)!
      const jpnReport = await verifyAudioTrackPlayback(
        `${target.provider} ${target.title} [SUB->Japanese]`,
        `${baseUrl}/api/watch/${target.provider}/mal-${target.malId}/${target.ep}/sub`,
        'ja',
        'jpn'
      );

      // 4. Explicit English (?audio=eng) MUST select & stream real English audio!
      const engReport = await verifyAudioTrackPlayback(
        `${target.provider} ${target.title} [audio=eng]`,
        `${baseUrl}/api/watch/${target.provider}/mal-${target.malId}/${target.ep}/dub?audio=eng`,
        'en',
        'eng'
      );

      console.log(`[LIVE 6-EP OK] ${target.provider} ${target.title}:`, {
        tracks: hinReport.allTracks,
        subtitles: jpnReport.subtitles,
        dubSelected: hinReport.selectedAudio,
        dubAudioBytes: hinReport.audioSegBytes,
        subSelected: jpnReport.selectedAudio,
        subMode: jpnReport.audioMode,
        subAudioBytes: jpnReport.audioSegBytes,
        engAudioBytes: engReport.audioSegBytes,
      });
    });
  }

  it('LIVE Unavailable Language Fallback & Existing Providers Smoke Check', async () => {
    // Request unavailable language (Korean) on AnimeSalt Naruto Ep 1
    const unavailRes = await fetch(`${baseUrl}/api/watch/animesalt/mal-20/1/dub?audio=kor`);
    assert.equal(unavailRes.status, 200);
    const unavail = await unavailRes.json();
    assert.equal(unavail.requestedAudio, 'ko');
    assert.equal(unavail.requestedAudioUnavailable, true);
    assert.equal(unavail.audioFallback, true);
    assert.equal(unavail.selectedAudio, 'hi');
    assert.match(unavail.audioWarning || '', /Korean.*unavailable.*Hindi/i);
    console.log('[LIVE UNAVAILABLE FALLBACK OK]', {
      requestedAudio: unavail.requestedAudio,
      selectedAudio: unavail.selectedAudio,
      audioWarning: unavail.audioWarning,
    });

    const checks = [
      ['health', `${baseUrl}/api/health`],
      ['search', `${baseUrl}/api/search?q=naruto`],
      ['anikoto-servers', `${baseUrl}/api/servers?malId=20&ep=1&type=sub&source=anikoto`],
      ['animeheaven-servers', `${baseUrl}/api/servers?malId=20&ep=1&type=sub&source=animeheaven`],
      ['desidub-servers', `${baseUrl}/api/servers?malId=16498&ep=1&type=dub&source=desidub`],
      ['megaplay-watch', `${baseUrl}/api/watch/megaplay/mal-20899/1/sub`],
      ['zokoanime-servers', `${baseUrl}/api/providers/zokoanime/servers?malId=20&ep=1`],
      ['zokoanime-watch', `${baseUrl}/api/providers/zokoanime/watch?serverId=20::1::sub`],
    ];

    const summary = {};
    for (const [name, url] of checks) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
        const body = await r.json().catch(() => ({}));
        summary[name] = {
          status: r.status,
          ok: r.ok,
          detail: body.error || body.playbackMode || (Array.isArray(body.servers) ? `${body.servers.length} servers` : body.status || `count=${body.count}`),
        };
      } catch (err) {
        summary[name] = { status: 'ERR', ok: false, detail: err.message };
      }
    }
    console.log('[LIVE REGRESSION SUMMARY]', JSON.stringify(summary, null, 2));
    assert.equal(summary.health.status, 200);
    assert.equal(summary.search.status, 200);
    assert.equal(summary['zokoanime-servers'].status, 200);
  });
});
