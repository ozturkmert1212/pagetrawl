#!/usr/bin/env python3
"""Install the per-user Google Chrome bridge on macOS."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys

HOST = "com.bozgu.ytdlp"


def install(extension_id, home=None):
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        raise ValueError("Eklenti kimliği 32 karakter olmalı (yalnızca a-p).")
    home = Path.home() if home is None else Path(home)
    source = Path(__file__).resolve().with_name("ytdlp_host.py")
    target = home / "Library/Application Support/PageTrawl"
    manifests = home / "Library/Application Support/Google/Chrome/NativeMessagingHosts"
    target.mkdir(parents=True, exist_ok=True)
    manifests.mkdir(parents=True, exist_ok=True)
    launcher = target / "ytdlp_host.sh"
    # Keep the checkout as source of truth; reinstallation refreshes Python's path.
    launcher.write_text(
        "#!/bin/sh\nexport PYTHONIOENCODING=utf-8\nexec "
        + shlex.quote(os.path.abspath(sys.executable)) + " -u "
        + shlex.quote(str(source)) + "\n", encoding="utf-8")
    launcher.chmod(0o755)
    manifest = manifests / (HOST + ".json")
    manifest.write_text(json.dumps({
        "name": HOST, "description": "PageTrawl yt-dlp bridge",
        "path": str(launcher), "type": "stdio",
        "allowed_origins": ["chrome-extension://" + extension_id + "/"],
    }, indent=2) + "\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("extension_id", nargs="?", help="chrome://extensions → PageTrawl kimliği")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Bu kurucu yalnızca macOS içindir.")
    if args.uninstall:
        manifest = Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts" / (HOST + ".json")
        manifest.unlink(missing_ok=True)
        print("PageTrawl köprü kaydı kaldırıldı. İndirilen dosyalar korunur.")
        return
    if not args.extension_id:
        parser.error("Kullanım: bash setup-native.sh <chrome://extensions sayfasındaki kimlik>")
    try:
        manifest = install(args.extension_id)
    except ValueError as error:
        parser.error(str(error))
    from ytdlp_host import configure_macos_path
    configure_macos_path()
    for tool in ("yt-dlp", "ffmpeg", "deno"):
        print(tool + ": " + (shutil.which(tool) or "bulunamadı"))
    print("Eksik araçları Homebrew ile kur: brew install python yt-dlp ffmpeg deno")
    print("Kayıt: " + str(manifest))
    print("chrome://extensions sayfasında PageTrawl'ı yenile.")


if __name__ == "__main__":
    main()
