/* A separate worker permits immediate cancellation even during a synchronous mux. */
importScripts('../vendor/ffmpeg/ffmpeg-core.js');
let core;
const positions = new Map();
self.onmessage = async ({ data: { id, action, name, data, audioOnly, separateAudio } }) => {
  try {
    let result = true;
    if (action === 'load') {
      const coreURL = new URL('../vendor/ffmpeg/ffmpeg-core.js', self.location.href).href;
      const wasmURL = new URL('../vendor/ffmpeg/ffmpeg-core.wasm', self.location.href).href;
      core = await createFFmpegCore({ mainScriptUrlOrBlob: coreURL + '#' + btoa(JSON.stringify({ wasmURL })) });
      core.setLogger(() => {});
    } else if (action === 'append') {
      let file = positions.get(name);
      if (!file) { file = { stream: core.FS.open(name, 'w+'), offset: 0 }; positions.set(name, file); }
      core.FS.write(file.stream, data, 0, data.length, file.offset);
      file.offset += data.length;
    } else if (action === 'mux') {
      for (const { stream } of positions.values()) core.FS.close(stream);
      const args = ['-protocol_whitelist', 'file,pipe', '-i', 'track0'];
      if (separateAudio) args.push('-protocol_whitelist', 'file,pipe', '-i', 'track1');
      if (audioOnly) args.push('-map', separateAudio ? '1:a:0' : '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k');
      else {
        args.push('-map', '0:v:0', '-map', separateAudio ? '1:a:0' : '0:a:0?', '-c', 'copy', '-movflags', '+faststart');
      }
      const output = audioOnly ? 'output.mp3' : 'output.mp4';
      core.setTimeout(180000);
      const code = core.exec(...args, output);
      if (code !== 0) throw new Error('mux');
      result = core.FS.readFile(output);
      if (!result.length) throw new Error('mux');
    } else throw new Error('unsupported');
    self.postMessage({ id, result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (error) {
    self.postMessage({ id, error: action === 'load' ? 'engine' : 'mux' });
  }
};
