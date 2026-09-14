const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../stream/plan.js');
const base = 'https://media.example/path/master.m3u8?token=one';
test('HLS master chooses cap and matching default audio group', () => {
  const plan = p.hls('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="audio.m3u8?x=1,2"\n#EXT-X-STREAM-INF:BANDWIDTH=9000,RESOLUTION=1920x1080,AUDIO="a"\nhi.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000,RESOLUTION=1280x720,AUDIO="a"\nlo.m3u8', base, '720');
  assert.equal(plan.video, 'https://media.example/path/lo.m3u8');
  assert.equal(plan.audio, 'https://media.example/path/audio.m3u8?x=1,2');
});
test('fMP4 map and explicit/implicit byte ranges are retained', () => {
  const plan = p.hls('#EXTM3U\n#EXT-X-MAP:URI="all.mp4",BYTERANGE="20@0"\n#EXT-X-BYTERANGE:10@20\nall.mp4\n#EXT-X-BYTERANGE:10\nall.mp4\n#EXT-X-ENDLIST', base);
  assert.deepEqual(plan.segments.map(s => s.range), [{start:0,end:19},{start:20,end:29},{start:30,end:39}]);
});
test('implicit ranges cannot silently cross resources', () => {
  assert.throws(() => p.hls('#EXTM3U\n#EXT-X-BYTERANGE:10@20\na.ts\n#EXT-X-BYTERANGE:10\nb.ts\n#EXT-X-ENDLIST', base), /unsupported/);
});
test('reject encrypted, live, discontinuous, empty and unsafe inputs', () => {
  for (const [text, error] of [
    ['#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\na.ts\n#EXT-X-ENDLIST', /encrypted/],
    ['#EXTM3U\na.ts', /live/],
    ['#EXTM3U\n#EXT-X-DISCONTINUITY\na.ts\n#EXT-X-ENDLIST', /unsupported/],
    ['#EXTM3U\n#EXT-X-ENDLIST', /unsupported/],
    ['#EXTM3U\nfile:///etc/passwd\n#EXT-X-ENDLIST', /unsupported/],
  ]) assert.throws(() => p.hls(text, base), error);
});
test('segment count is bounded', () => {
  assert.throws(() => p.hls('#EXTM3U\n' + 's.ts\n'.repeat(10001) + '#EXT-X-ENDLIST', base), /limit/);
});
