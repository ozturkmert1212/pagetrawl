#!/usr/bin/env python3
"""Restore pinned, hash-checked ffmpeg core assets (developer tool, not setup)."""
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

URL = 'https://registry.npmjs.org/@ffmpeg/core/-/core-0.12.10.tgz'
FILES = {
    'ffmpeg-core.js': 'b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21',
    'ffmpeg-core.wasm': '9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7',
}

def main():
    target = Path(__file__).resolve().parents[1] / 'vendor/ffmpeg'
    with urllib.request.urlopen(URL, timeout=60) as response:
        archive = response.read(50 * 1024 * 1024)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        verified = {}
        for name, expected in FILES.items():
            data = tar.extractfile('package/dist/umd/' + name).read()
            if hashlib.sha256(data).hexdigest() != expected:
                raise ValueError('Checksum mismatch: ' + name)
            verified[name] = data
    target.mkdir(parents=True, exist_ok=True)
    for name, data in verified.items():
        (target / name).write_bytes(data)
        print('Verified:', name)

if __name__ == '__main__':
    main()
