/* Owns fetches, wasm worker and Blob URLs after the popup closes. */
const MAX_BYTES = 256 * 1024 * 1024;
let active = null;
let rpcId = 0;
const send = message => chrome.runtime.sendMessage({ target: 'stream-background', ...message });
function rpc(task, action, payload = {}) {
  task.controller.signal.throwIfAborted();
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    task.pending.set(id, { resolve, reject });
    task.worker.postMessage({ id, action, ...payload }, payload.data ? [payload.data.buffer] : []);
  });
}
function stop(task) {
  task.controller.abort();
  task.worker?.terminate();
  for (const { reject } of task.pending.values()) reject(new DOMException('Canceled', 'AbortError'));
  task.pending.clear();
  clearInterval(task.heartbeat);
  if (task.blob) URL.revokeObjectURL(task.blob);
}
async function resource(task, part, manifest = false) {
  const cap = manifest ? 2 * 1024 * 1024 : MAX_BYTES - task.bytes;
  for (let attempt = 0; ; attempt++) {
    task.controller.signal.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    task.controller.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 45000);
    try {
      const headers = part.range ? { Range: `bytes=${part.range.start}-${part.range.end}` } : {};
      const response = await fetch(StreamPlan.url(part.url), {
        credentials: 'include', headers, signal: controller.signal, cache: 'default'
      });
      if (!response.ok) throw new Error('http:' + response.status);
      if (part.range && (response.status !== 206 || !response.headers.get('Content-Range')?.startsWith(`bytes ${part.range.start}-${part.range.end}/`))) throw new Error('range');
      if (Number(response.headers.get('Content-Length') || 0) > cap) throw new Error('limit');
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > cap) { await reader.cancel(); throw new Error('limit'); }
        chunks.push(value);
      }
      if (!size) throw new Error('empty');
      if (part.range && size !== part.range.end - part.range.start + 1) throw new Error('range');
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (!manifest) task.bytes += size;
      return { bytes, url: response.url };
    } catch (error) {
      task.controller.signal.throwIfAborted();
      if (attempt >= 2 || /^(limit|range|empty|http:4)/.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
      controller.abort();
      task.controller.signal.removeEventListener('abort', cancel);
    }
  }
}
async function playlist(task, address, depth = 0) {
  if (depth > 3) throw new Error('unsupported');
  const r = await resource(task, { url: address }, true);
  const text = new TextDecoder().decode(r.bytes);
  if (text.trimStart().startsWith('#EXTM3U')) {
    const p = StreamPlan.hls(text, r.url, task.job.mode);
    if (p.type === 'media') return [{ kind: 'muxed', segments: p.segments }];
    if (task.job.mode === 'audio' && p.audio) return playlist(task, p.audio, depth + 1);
    const video = await playlist(task, p.video, depth + 1);
    if (video.length !== 1) throw new Error('unsupported');
    if (!p.audio) return video;
    const audio = await playlist(task, p.audio, depth + 1);
    if (audio.length !== 1) throw new Error('unsupported');
    return [{ ...video[0], kind: 'video' }, { ...audio[0], kind: 'audio' }];
  }
  return StreamPlan.dash(new DOMParser().parseFromString(text, 'application/xml'), r.url, task.job.mode);
}
async function run(task) {
  try {
    const tracks = await playlist(task, task.job.url);
    if (tracks.length === 1 && tracks[0].kind === 'audio' && task.job.mode !== 'audio') throw new Error('unsupported');
    task.worker = new Worker('mux-worker.js');
    task.worker.onmessage = ({ data }) => {
      const waiter = task.pending.get(data.id);
      if (!waiter) return;
      task.pending.delete(data.id);
      if (data.error) waiter.reject(new Error(data.error));
      else waiter.resolve(data.result);
    };
    task.worker.onerror = () => {
      for (const waiter of task.pending.values()) waiter.reject(new Error('engine'));
      task.pending.clear();
    };
    task.phase = 'loading';
    await rpc(task, 'load');
    task.phase = 'fetching';
    const total = tracks.reduce((sum, t) => sum + t.segments.length, 0);
    let completed = 0;
    for (let i = 0; i < tracks.length; i++) {
      for (const part of tracks[i].segments) {
        const { bytes } = await resource(task, part);
        await rpc(task, 'append', { name: 'track' + i, data: bytes });
        task.percent = 85 * ++completed / total;
        await send({ action: 'progress', id: task.job.id, percent: task.percent, phase: task.phase });
      }
    }
    task.phase = 'merging';
    await send({ action: 'progress', id: task.job.id, percent: 90, phase: task.phase });
    const output = await rpc(task, 'mux', { audioOnly: task.job.mode === 'audio', separateAudio: tracks.length === 2 });
    task.controller.signal.throwIfAborted();
    const audio = task.job.mode === 'audio';
    task.blob = URL.createObjectURL(new Blob([output], { type: audio ? 'audio/mpeg' : 'video/mp4' }));
    task.worker.terminate();
    task.worker = null;
    task.phase = 'saving';
    const saved = await send({ action: 'save', id: task.job.id, url: task.blob, ext: audio ? 'mp3' : 'mp4' });
    if (!saved?.ok) throw new Error(saved?.error || 'save');
    // Keep URL alive until chrome.downloads reports complete/interrupted.
  } catch (error) {
    if (active !== task) return;
    const canceled = task.controller.signal.aborted;
    stop(task);
    active = null;
    await send({ action: 'failed', id: task.job.id, code: canceled ? 'canceled' : error.message }).catch(() => {});
  }
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target !== 'stream-offscreen' || sender.id !== chrome.runtime.id) return;
  if (msg.action === 'status') {
    reply(active ? { job: active.job, phase: active.phase, percent: active.percent } : null);
  } else if (msg.action === 'start') {
    if (active) { reply({ ok: false, error: 'busy' }); return; }
    const task = { job: msg.job, bytes: 0, percent: 0, phase: 'loading', controller: new AbortController(), pending: new Map() };
    active = task;
    task.heartbeat = setInterval(() => send({ action: 'progress', id: task.job.id, phase: task.phase, percent: task.percent }).catch(() => {}), 20000);
    reply({ ok: true });
    run(task);
  } else if (['cancel', 'release'].includes(msg.action)) {
    if (active && active.job.id === msg.id) { stop(active); active = null; }
    reply({ ok: true });
  }
});
