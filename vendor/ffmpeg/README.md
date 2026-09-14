# Bundled video engine

Unmodified UMD assets from `@ffmpeg/core` **0.12.10** (single-thread WebAssembly).
Downloaded from https://registry.npmjs.org/@ffmpeg/core/-/core-0.12.10.tgz.
They ship with PageTrawl; there are **no runtime CDN or executable downloads**.

| File | SHA-256 |
| --- | --- |
| ffmpeg-core.js | b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21 |
| ffmpeg-core.wasm | 9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7 |

The npm package declares **GPL-2.0-or-later**, not PageTrawl's MIT license.
See [COPYING.GPLv2](COPYING.GPLv2). FFmpeg and the codec libraries retain their
respective copyright notices and licenses. The wasm engine is approximately
32 MB and executes in a disposable dedicated worker.

Upstream source/build recipes: https://github.com/ffmpegwasm/ffmpeg.wasm
(package release `@ffmpeg/core@0.12.10`). The upstream Dockerfile records FFmpeg
and codec-library source dependencies. FFmpeg source:
https://github.com/FFmpeg/FFmpeg/tree/n5.1.4.

Restore and verify the exact bundled assets with `python3 tools/vendor-ffmpeg.py`.
Do not describe the vendored GPL engine as MIT when distributing a package.
