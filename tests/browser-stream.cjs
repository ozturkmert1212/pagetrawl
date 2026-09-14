/* Run with NODE_PATH pointing at playwright, or npm-installed playwright.
 * Generates its own synthetic media; no third-party videos or signed-in profile.
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagetrawl-stream-'));
const media = path.join(temp, 'media'); fs.mkdirSync(media);
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
function generate(args) { execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: media }); }
const source = ['-f','lavfi','-i','testsrc2=size=160x90:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','4','-c:v','libx264','-preset','ultrafast','-g','24','-c:a','aac'];
generate([...source, '-f','hls','-hls_time','1','-hls_playlist_type','vod','vod.m3u8']);
generate([...source, '-f','hls','-hls_time','1','-hls_playlist_type','vod','-hls_segment_type','fmp4','frag.m3u8']);
generate([...source, '-map','0:v:0','-an','-f','hls','-hls_time','1','-hls_playlist_type','vod','video.m3u8']);
generate(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','4','-c:a','aac','-f','hls','-hls_time','1','-hls_playlist_type','vod','audio.m3u8']);
generate([...source, '-f','hls','-hls_time','1','-hls_playlist_type','vod','-hls_flags','single_file','ranges.m3u8']);
generate([...source, '-f','dash','-seg_duration','1','manifest.mpd']);
fs.writeFileSync(path.join(media,'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=160x90\nvod.m3u8\n');
fs.writeFileSync(path.join(media,'separate.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=160x90,AUDIO="audio"\nvideo.m3u8\n');
fs.writeFileSync(path.join(media,'large.m3u8'), '#EXTM3U\n#EXTINF:4,\nlarge.ts\n#EXT-X-ENDLIST');
fs.writeFileSync(path.join(media,'encrypted.m3u8'), '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\nvod0.ts\n#EXT-X-ENDLIST');
fs.writeFileSync(path.join(media,'live.m3u8'), '#EXTM3U\n#EXTINF:1,\nvod0.ts');
fs.writeFileSync(path.join(media,'slow.m3u8'), '#EXTM3U\n#EXTINF:4,\nslow.ts\n#EXT-X-ENDLIST');
fs.writeFileSync(path.join(media,'failure.m3u8'), '#EXTM3U\n#EXTINF:4,\nmissing.ts\n#EXT-X-ENDLIST');
const requests = [];
const server = http.createServer((req,res) => {
  const pathname = new URL(req.url,'http://localhost').pathname;
  requests.push(pathname);
  if (pathname === '/large.ts') { res.writeHead(200, {'Content-Length': 300*1024*1024}); res.end(); return; }
  if (pathname === '/slow.ts') { setTimeout(() => { if (!res.destroyed) { res.writeHead(200); res.end(fs.readFileSync(path.join(media,'vod0.ts'))); } }, 8000); return; }
  const file = path.join(media, path.basename(pathname));
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const data = fs.readFileSync(file);
  res.setHeader('Content-Type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.mpd') ? 'application/dash+xml' : 'application/octet-stream');
  if (req.headers.range) {
    const [,a,b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
    res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}` }); res.end(data.subarray(+a,+b+1));
  } else { res.writeHead(200); res.end(data); }
});
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temp,'profile'), { channel: 'chromium', headless: true,
      acceptDownloads: true, downloadsPath: path.join(temp,'downloads'),
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
    let sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const errors = []; sw.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const id = new URL(sw.url()).host;
    let page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.addScriptTag({ url: `chrome-extension://${id}/stream/plan.js` });
    await page.evaluate(() => chrome.storage.local.set({ settings: { lang: 'en', saveAs: false } }));
    const enqueue = (names, mode='best', title='test') => page.evaluate(({base,names,mode,title}) => chrome.runtime.sendMessage({type:'browserStream',action:'queue',urls:names.map(n=>base+'/'+n),mode,title,pageUrl:base}), {base,names,mode,title});
    const status = () => page.evaluate(async () => (await chrome.storage.session.get('ytStatus')).ytStatus);
    async function waitDone() {
      for (let i=0;i<240;i++) {
        const s=await status();
        const state=await page.evaluate(async () => (await chrome.storage.session.get('browserStreams')).browserStreams);
        if (s && !s.running && !state.active && !state.queue.length) return s;
        await new Promise(r=>setTimeout(r,250));
      }
      throw new Error('Download timeout: '+JSON.stringify(await status()));
    }
    async function verify(name, mode='best') {
      assert.equal((await enqueue([name],mode,name)).ok,true);
      const done=await waitDone(); assert.equal(done.error,null,JSON.stringify(done)); assert.equal(done.percent,100);
      const last=await page.evaluate(async () => (await chrome.storage.local.get('history')).history[0]);
      assert.equal(last.state,'done');
      const item=await page.evaluate(id=>chrome.downloads.search({id}).then(r=>r[0]),last.id);
      const info=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',item.filename]));
      const kinds=info.streams.map(s=>s.codec_type);
      assert.ok(kinds.includes('audio')); if(mode!=='audio') assert.ok(kinds.includes('video'));
      assert.ok(Number(info.format.duration)>3.5 && Number(info.format.duration)<4.5);
      console.log('PASS real wasm download:',name,mode,kinds.join('+'));
    }
    // Native browser DOM parser exercises DASH inheritance and timeline expansion.
    const dash = await page.evaluate(() => {
      const parse=s=>StreamPlan.dash(new DOMParser().parseFromString(s,'application/xml'),'https://x.test/root/a.mpd','720');
      const result=parse('<MPD mediaPresentationDuration="PT4S"><BaseURL>media/</BaseURL><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" initialization="init-$RepresentationID$.mp4" media="$Number%03d$-$Time$.m4s"><SegmentTimeline><S t="0" d="1" r="-1"/></SegmentTimeline></SegmentTemplate><Representation id="v" bandwidth="100" height="720"/></AdaptationSet></Period></MPD>');
      const failures=[];
      for(const s of ['<MPD type="dynamic"><Period/></MPD>','<MPD><Period/><Period/></MPD>','<MPD><Period><ContentProtection/></Period></MPD>']) {try{parse(s)}catch(e){failures.push(e.message)}}
      return {result,failures};
    });
    assert.equal(dash.result[0].segments[4].url,'https://x.test/root/media/004-3.m4s');
    assert.deepEqual(dash.failures,['live','unsupported','encrypted']); console.log('PASS DASH templates, timeline and rejection tests');
    await verify('master.m3u8');
    await verify('frag.m3u8');
    await verify('manifest.mpd');
    await verify('separate.m3u8');
    await verify('ranges.m3u8');
    await verify('vod.m3u8','audio');
    for (const [name,word] of [['encrypted.m3u8','Encrypted'],['live.m3u8','Live'],['failure.m3u8','server'],['large.m3u8','limit']]) {
      await enqueue([name]); const s=await waitDone(); assert.ok(s.error.toLowerCase().includes(word.toLowerCase()),s.error); console.log('PASS failure:',name);
    }
    await enqueue(['slow.m3u8','vod.m3u8']);
    await new Promise(r=>setTimeout(r,750));
    assert.equal((await page.evaluate(()=>chrome.runtime.sendMessage({type:'browserStream',action:'cancel'}))).ok,true);
    const canceled=await waitDone(); assert.equal(canceled.percent,0); assert.equal(canceled.error,null); console.log('PASS cancel clears queue');
    await enqueue(['vod.m3u8','frag.m3u8']);
    assert.equal((await waitDone()).percent,100); console.log('PASS sequential queue');
    // Closing the popup must not own/cancel the download.
    await enqueue(['slow.m3u8']);
    await page.close();
    page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    const result = await waitDone();
    assert.equal(result.error,null,JSON.stringify(result));
    console.log('PASS download survives popup closure');
    // Stop only the service worker; offscreen still owns the bytes.
    const cdp = await context.newCDPSession(page);
    const versions = new Map();
    cdp.on('ServiceWorker.workerVersionUpdated', ({versions: updates}) => {
      for (const v of updates) versions.set(v.versionId, v);
    });
    await cdp.send('ServiceWorker.enable');
    await enqueue(['slow.m3u8']);
    await new Promise(r=>setTimeout(r,500));
    const version = [...versions.values()].find(v=>v.scriptURL===sw.url() && v.runningStatus==='running');
    assert.ok(version,'Service worker CDP version available');
    await cdp.send('ServiceWorker.stopWorker',{versionId:version.versionId});
    const recovered = await waitDone();
    assert.equal(recovered.error,null,JSON.stringify(recovered));
    assert.equal(recovered.percent,100);
    sw = context.serviceWorkers().find(w=>w.url().includes(id)) || await context.waitForEvent('serviceworker');
    console.log('PASS service worker restart recovers active offscreen job');
    await page.evaluate(() => { document.querySelector('#ytbar').classList.remove('hidden'); document.querySelector('#ytTitle').textContent='Synthetic test video'; });
    await page.screenshot({path:path.join(temp,'popup.png')});
    assert.equal(await sw.evaluate(()=>nativePort),null); console.log('PASS no native host was opened');
    assert.deepEqual(errors,[],JSON.stringify(errors));
    console.log('ALL PASS; artifacts:',temp);
  } finally { await context?.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1});
