#!/bin/bash
# macOS Chrome native messaging registration (no sudo).
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Bu kurucu macOS içindir. Windows: setup-native.ps1' >&2
  exit 1
fi
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin"
if ! command -v python3 >/dev/null 2>&1; then
  echo 'Python 3 bulunamadı. Homebrew ile: brew install python yt-dlp ffmpeg deno' >&2
  exit 1
fi
exec python3 "$ROOT/native/setup_macos.py" "$@"
