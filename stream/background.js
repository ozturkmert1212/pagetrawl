/* Loaded after background.js: persistent, serialized browser-stream queue. */
let streamState = { queue: [], active: null };
let streamChain = Promise.resolve();
const offscreenURL = chrome.runtime.getURL('stream/offscreen.html');
const streamMessage = message => chrome.runtime.sendMessage({ target: 'stream-offscreen', ...message });
const streamPersist = () => chrome.storage.session.set({ browserStreams: streamState });
function streamSerial(fn) {
  const next = streamChain.then(fn);
  streamChain = next.catch(error => console.error('[browser stream]', error));
  return next;
}
async function streamEnsureDocument() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({ url: 'stream/offscreen.html', reasons: ['BLOBS', 'WORKERS'],
      justification: 'Download video segments, merge them locally and retain their download Blob until saved.' });
  }
}
async function streamStatus(patch) {
  await pushStatus({ engine: 'browser', left: streamState.queue.length, ...patch });
}
async function streamAdvance() {
  if (streamState.active || !streamState.queue.length) return;
  const job = streamState.queue.shift();
  streamState.active = { job, downloadId: null };
  await streamPersist();
  await streamStatus({ running: true, percent: 0, phase: 'loading', error: null, line: '', dir: '' });
  try {
    await streamEnsureDocument();
    const response = await streamMessage({ action: 'start', job });
    if (!response?.ok) throw new Error('engine');
  } catch (error) {
    await streamFinish('engine');
  }
}
async function streamFinish(code = '') {
  const active = streamState.active;
  if (!active) return;
  await streamMessage({ action: 'release', id: active.job.id }).catch(() => {});
  streamState.active = null;
  await streamPersist();
  const canceled = code === 'canceled';
  const key = code.startsWith('http:') ? 'http' : code;
  const known = ['unsupported', 'encrypted', 'live', 'limit', 'range', 'empty', 'engine', 'mux', 'save', 'interrupted', 'http'];
  await streamStatus({ running: false, phase: '', percent: code ? 0 : 100,
    error: code && !canceled ? t('stream.error.' + (known.includes(key) ? key : 'network')) : null,
    line: canceled ? t('wk.dlCanceled') : '' });
  if (!canceled) await streamAdvance();
  if (!streamState.active && await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}
async function streamRecover() {
  const stored = (await chrome.storage.session.get('browserStreams')).browserStreams;
  if (stored) streamState = stored;
  if (streamState.active) {
    const alive = await streamMessage({ action: 'status' }).catch(() => null);
    if (!alive || alive.job.id !== streamState.active.job.id) {
      // A browser restart cannot resume in-memory media. Never claim success.
      await streamFinish('interrupted');
    } else if (streamState.active.downloadId != null) {
      const [item] = await chrome.downloads.search({ id: streamState.active.downloadId });
      if (!item || item.state !== 'in_progress') await streamFinish(item?.state === 'complete' ? '' : 'interrupted');
    }
  }
  await streamAdvance();
}
const streamReady = streamSerial(streamRecover);
async function streamEnqueue(msg) {
  await streamReady;
  return streamSerial(async () => {
    if (ytRunning || (await getYtQueue()).length) return { ok: false, error: t('stream.nativeBusy') };
    const urls = [...new Set(msg.urls || [])];
    if (!urls.length || urls.length > 100 || streamState.queue.length + urls.length > 100) return { ok: false, error: t('stream.error.limit') };
    for (const address of urls) {
      const u = new URL(address);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Invalid stream URL');
    }
    const settings = await getSettings();
    const mode = ['best', '1080', '720', 'audio'].includes(msg.mode) ? msg.mode : 'best';
    for (const url of urls) streamState.queue.push({ id: crypto.randomUUID(), url, mode,
      title: String(msg.title || '').slice(0, 200), pageUrl: msg.pageUrl || '', saveAs: !!settings.saveAs });
    await streamPersist();
    await streamAdvance();
    return { ok: true, count: urls.length };
  });
}
async function streamSave(msg) {
  const active = streamState.active;
  if (!active || active.job.id !== msg.id || active.downloadId != null) return { ok: false, error: 'interrupted' };
  if (!msg.url.startsWith('blob:' + chrome.runtime.getURL('')) || !['mp4', 'mp3'].includes(msg.ext)) return { ok: false, error: 'save' };
  const name = (active.job.title || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'video';
  const filename = 'PageTrawl/' + name + '.' + msg.ext;
  try {
    const id = await chrome.downloads.download({ url: msg.url, filename, conflictAction: 'uniquify', saveAs: active.job.saveAs });
    active.downloadId = id;
    await streamPersist();
    await addHistory(id, { url: active.job.url, filename, kind: msg.ext === 'mp3' ? 'audio' : 'video',
      page: { url: active.job.pageUrl, title: active.job.title, host: new URL(active.job.url).hostname } });
    // Tiny Blob downloads can finish before the listener sees their ID.
    const [item] = await chrome.downloads.search({ id });
    if (item?.state === 'complete') { await markHistory(id, 'done'); await streamFinish(); }
    else if (!item || item.state === 'interrupted') { await markHistory(id, 'failed'); await streamFinish('interrupted'); }
    return { ok: true, id };
  } catch (error) { return { ok: false, error: 'save' }; }
}
chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current)) return;
  streamSerial(async () => {
    if (streamState.active?.downloadId === delta.id) await streamFinish(delta.state.current === 'complete' ? '' : 'interrupted');
  });
});
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === 'browserStream') {
    if (msg.action === 'queue') streamEnqueue(msg).then(reply, e => reply({ ok: false, error: e.message }));
    else if (msg.action === 'cancel') streamSerial(async () => {
      streamState.queue = [];
      const a = streamState.active;
      await streamPersist();
      if (a?.downloadId != null) await chrome.downloads.cancel(a.downloadId).catch(() => {});
      await streamFinish('canceled');
      return { ok: true };
    }).then(reply, e => reply({ ok: false, error: e.message }));
    else return;
    return true;
  }
  if (msg.target !== 'stream-background' || sender.url !== offscreenURL) return;
  streamSerial(async () => {
    if (streamState.active?.job.id !== msg.id) return { ok: false, error: 'interrupted' };
    if (msg.action === 'progress') await streamStatus({ running: true, percent: msg.percent, phase: msg.phase, error: null });
    else if (msg.action === 'save') return streamSave(msg);
    else if (msg.action === 'failed') await streamFinish(msg.code);
    return { ok: true };
  }).then(reply, e => reply({ ok: false, error: e.message }));
  return true;
});
