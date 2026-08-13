#!/usr/bin/env python3
"""
Native messaging host: eklentiden gelen URL'yi yt-dlp'ye devreder ve ilerlemeyi
geri yollar.

Protokol (Chrome native messaging): stdin/stdout üzerinden, her mesajın önünde
4 baytlık little-endian uzunluk + UTF-8 JSON gövde.

Gelen mesajlar:
    {"action": "download", "url": ..., "mode": "best|1080|720|audio", "outdir": ...}
    {"action": "probe"}     -> yt-dlp / ffmpeg var mı, sürüm ne
    {"action": "cancel"}
    {"action": "pickdir", "path": ...}   -> klasör seçme penceresi aç
    {"action": "checkdir", "path": ...}  -> elle yazılan yolu doğrula
    {"action": "move", "from": ..., "to": ..., "prune": ...}  -> inen dosyayı taşı

Giden mesajlar:
    {"type": "probe",    "ytdlp": "...", "ffmpeg": bool}
    {"type": "progress", "percent": 42.0, "line": "..."}
    {"type": "log",      "line": "..."}
    {"type": "done",     "ok": true, "code": 0}
    {"type": "dir",      "path": "C:\\...", "error": ""}
    {"type": "moved",    "ok": true, "path": "C:\\..."}

Klasör işleri neden burada: Chrome'un downloads API'si İndirilenler dışına
yazamıyor ve mutlak yol kabul etmiyor. Köprü bu kurala tabi olmadığı için hem
klasör penceresini o açıyor (her yer seçilebiliyor) hem de İndirilenler dışına
düşen fotoğrafları ara klasörden asıl yerine o taşıyor.
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time

if sys.platform == "win32":
    # stdin/stdout'ta CRLF çevirisi olursa protokol bozulur.
    import msvcrt

    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

_send_lock = threading.Lock()
_current = None  # çalışan yt-dlp süreci
_canceled = False  # kullanıcı mı durdurdu, yoksa gerçekten hata mı verdi


# --- protokol --------------------------------------------------------------

def send(obj):
    data = json.dumps(obj).encode("utf-8")
    with _send_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None  # Chrome portu kapattı
    length = struct.unpack("<I", raw)[0]
    body = sys.stdin.buffer.read(length)
    if len(body) < length:
        return None
    return json.loads(body.decode("utf-8"))


# --- yardımcılar -----------------------------------------------------------

def find_ytdlp():
    return shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")


def find_ffmpeg():
    """
    PATH'e bakar, bulamazsa winget kurulum ağacını tarar.

    Bu ikinci adım şart: Chrome, ffmpeg PATH'e eklenmeden önce açıldıysa child
    süreçler eski PATH'i miras alır ve ffmpeg terminalde görünüp eklentiden
    görünmez. Tam yolu bulup yt-dlp'ye --ffmpeg-location ile veriyoruz.
    """
    p = shutil.which("ffmpeg")
    if p:
        return p

    base = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages")
    if os.path.isdir(base):
        for root, _dirs, files in os.walk(base):
            if "ffmpeg.exe" in files:
                return os.path.join(root, "ffmpeg.exe")
    return None


def find_js_runtime():
    """
    YouTube imzaları artık bir JS motoru olmadan çözülemiyor; yt-dlp motorsuz
    çıkarmayı kullanımdan kaldırdı ve formatların bir kısmı hiç görünmüyor.
    Varsayılan yalnızca deno, ama node/bun da destekleniyor — hangisi varsa onu
    açıkça bildiriyoruz.
    """
    for name in ("deno", "node", "bun"):
        if shutil.which(name):
            return name
    return None


def build_format(mode, ffmpeg):
    """
    ffmpeg yoksa video+ses birleştirilemez; o yüzden tek parça hâlinde gelen
    (progressive) formatlara düşüyoruz. YouTube'da bu pratikte 720p tavan demek.
    """
    if mode == "audio":
        return ["-f", "ba/b", "-x", "--audio-format", "mp3"] if ffmpeg else ["-f", "ba/b"]

    if not ffmpeg:
        return ["-f", "b[ext=mp4]/b"]

    caps = {"1080": 1080, "720": 720}
    if mode in caps:
        h = caps[mode]
        return ["-f", f"bv*[height<={h}]+ba/b[height<={h}]/b", "--merge-output-format", "mp4"]

    return ["-f", "bv*+ba/b", "--merge-output-format", "mp4"]


# --- klasör seçimi ---------------------------------------------------------

def _ask_dir_tk(initial):
    """Tkinter'ın klasör seçicisi. Tk nesnelerinin hepsi bu thread'e ait."""
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    # Pencere Chrome'un arkasında açılırsa kullanıcı kayıp bir dialog bekler.
    root.attributes("-topmost", True)
    try:
        return filedialog.askdirectory(
            title="Dosyaların ineceği klasörü seç",
            initialdir=initial or os.path.expanduser("~"),
            mustexist=False,
        )
    finally:
        # update() olmadan dialog kapansa da Tk penceresi ekranda asılı kalabiliyor.
        try:
            root.update()
        except Exception:
            pass
        root.destroy()


def _ask_dir_powershell(initial):
    """tkinter yoksa Windows'ta yedek: FolderBrowserDialog (STA şart)."""
    script = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$d.Description = 'Dosyalarin inecegi klasoru sec';"
        f"$d.SelectedPath = '{(initial or os.path.expanduser('~'))}';"
        "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
    )
    out = subprocess.run(
        ["powershell", "-NoProfile", "-STA", "-Command", script],
        capture_output=True, text=True, creationflags=CREATE_NO_WINDOW, timeout=300
    )
    return out.stdout.strip()


def pick_dir(msg):
    initial = msg.get("path") or ""
    path, error = "", ""
    try:
        path = _ask_dir_tk(initial)
    except Exception as e:
        if sys.platform == "win32":
            try:
                path = _ask_dir_powershell(initial)
            except Exception as e2:
                error = f"Klasör penceresi açılamadı: {e2}"
        else:
            error = f"Klasör penceresi açılamadı: {e}"

    if path and not error:
        path, error = check_dir(path)
    send({"type": "dir", "path": path, "error": error})


def check_dir(path):
    """
    Yolu normalleştirir ve kullanılabilir mi bakar. Klasörü BURADA açmıyoruz:
    yanlış yazılmış bir yol yüzünden diske çöp klasör açılmasın. Gerçekten
    gerektiğinde (indirme anında) zaten os.makedirs çalışıyor.  -> (path, error)
    """
    p = (path or "").strip()
    if not p:
        return "", ""

    try:
        p = os.path.abspath(os.path.expanduser(os.path.normpath(p)))
    except Exception as e:
        return "", f"Yol okunamadı: {e}"

    if os.path.isdir(p):
        return p, ""
    if os.path.exists(p):
        return "", "Burası bir klasör değil: " + p
    if os.path.isdir(os.path.dirname(p)):
        return p, ""   # üst klasör var; indirme sırasında oluşturulacak
    return "", "Böyle bir klasör yok: " + p


# --- taşıma ----------------------------------------------------------------

def _unique(path):
    """Hedefte aynı adlı dosya varsa "ad (1).jpg" diye açıyoruz — üzerine yazmak
    yok; Chrome'un uniquify davranışının aynısı."""
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    i = 1
    while os.path.exists(f"{stem} ({i}){ext}"):
        i += 1
    return f"{stem} ({i}){ext}"


def _prune(start, root):
    """Boşalan ara klasörleri siler. root'un dışına ASLA çıkmıyoruz: yanlış bir
    parametre yüzünden kullanıcının klasörlerini silmeyelim."""
    if not root:
        return
    root = os.path.normpath(root)
    cur = os.path.normpath(start)
    while cur.startswith(root) and len(cur) >= len(root):
        try:
            os.rmdir(cur)          # yalnızca boşsa siler
        except OSError:
            return
        parent = os.path.dirname(cur)
        if parent == cur:
            return
        cur = parent


def move_file(msg):
    src = os.path.normpath(msg.get("from") or "")
    dst = os.path.normpath(msg.get("to") or "")
    if not src or not dst:
        send({"type": "moved", "ok": False, "error": "Eksik yol."})
        return
    # Dosya "complete" olduktan sonra bile bir an Chrome ya da antivirüs
    # tarafından kilitli olabiliyor (WinError 32); birkaç kez deniyoruz.
    for attempt in range(4):
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            final = _unique(dst)
            shutil.move(src, final)
            _prune(os.path.dirname(src), msg.get("prune") or "")
            send({"type": "moved", "ok": True, "path": final})
            return
        except Exception as e:
            if attempt == 3:
                send({"type": "moved", "ok": False,
                      "error": f"{os.path.basename(src)}: {e}"})
                return
            time.sleep(0.5)


PERCENT_RE = re.compile(r"\[download\]\s+([\d.]+)%")


def pump_output(proc):
    for line in iter(proc.stdout.readline, ""):
        line = line.rstrip("\r\n")
        if not line:
            continue
        m = PERCENT_RE.search(line)
        if m:
            send({"type": "progress", "percent": float(m.group(1)), "line": line})
        else:
            send({"type": "log", "line": line[:400]})


def download(msg):
    global _current, _canceled

    _canceled = False
    ytdlp = find_ytdlp()
    if not ytdlp:
        send({"type": "done", "ok": False, "code": -1,
              "error": "yt-dlp bulunamadı (PATH'te değil)."})
        return

    ffmpeg_path = find_ffmpeg()
    ffmpeg = bool(ffmpeg_path)
    outdir = msg.get("outdir") or os.path.join(
        os.path.expanduser("~"), "Downloads", "yt-dlp"
    )
    os.makedirs(outdir, exist_ok=True)

    args = [
        ytdlp,
        "--newline",             # ilerleme satırlarını ayrı ayrı bas
        "--no-playlist",
        "--no-part",
        "--restrict-filenames",  # Windows'ta sorun çıkaran karakterleri ele
        "-P", outdir,
        "-o", "%(uploader)s - %(title)s [%(id)s].%(ext)s",
    ]
    args += build_format(msg.get("mode", "best"), ffmpeg)

    if ffmpeg_path:
        args += ["--ffmpeg-location", os.path.dirname(ffmpeg_path)]

    runtime = find_js_runtime()
    if runtime:
        args += ["--js-runtimes", runtime]
    else:
        send({"type": "log",
              "line": "JS motoru yok (deno/node/bun) -> YouTube indirmeleri başarısız olabilir."})

    # Çerezler VARSAYILAN OLARAK KAPALI. Chrome 127+ çerez veritabanını
    # App-Bound Encryption ile şifreliyor ve yt-dlp Windows'ta bunu çözemiyor
    # ("Failed to decrypt with DPAPI"). Her indirmede önce bunu denemek yalnızca
    # gecikme üretiyordu. Girişli içerik için kullanıcı açıkça isterse denenir.
    use_cookies = msg.get("cookies", False)
    attempts = [args + ["--cookies-from-browser", "chrome"], args] if use_cookies else [args]

    if not ffmpeg:
        send({"type": "log",
              "line": "ffmpeg yok -> tek parça format kullanılıyor (YouTube'da ~720p tavan)."})

    for i, cmd in enumerate(attempts):
        proc = subprocess.Popen(
            cmd + [msg["url"]],
            # stdin=DEVNULL ŞART: aksi hâlde yt-dlp host'un stdin'ini miras alır,
            # yani Chrome'un native messaging borusunu. Hem bloke olur hem de
            # protokol mesajlarımızı yiyebilir.
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=CREATE_NO_WINDOW,
        )
        _current = proc
        pump_output(proc)
        code = proc.wait()
        _current = None

        if code == 0:
            send({"type": "done", "ok": True, "code": 0, "outdir": outdir})
            return
        if _canceled:
            # Süreci biz öldürdük; bu bir hata değil, kullanıcının kararı.
            send({"type": "done", "ok": False, "code": code, "canceled": True,
                  "outdir": outdir})
            return
        if i < len(attempts) - 1:
            send({"type": "log", "line": "Çerezli deneme başarısız, çerezsiz deneniyor…"})

    send({"type": "done", "ok": False, "code": code, "outdir": outdir})


# --- ana döngü -------------------------------------------------------------

def main():
    global _canceled

    while True:
        try:
            msg = read_message()
        except Exception as e:
            send({"type": "done", "ok": False, "code": -1, "error": str(e)})
            return
        if msg is None:
            return

        action = msg.get("action")

        if action == "probe":
            ytdlp = find_ytdlp()
            version = ""
            if ytdlp:
                try:
                    version = subprocess.run(
                        [ytdlp, "--version"], capture_output=True, text=True,
                        creationflags=CREATE_NO_WINDOW, timeout=15
                    ).stdout.strip()
                except Exception:
                    version = "?"
            send({"type": "probe", "ytdlp": version, "ffmpeg": bool(find_ffmpeg()),
                  "js": find_js_runtime() or ""})

        elif action == "download":
            # Ayrı thread: indirme sürerken "cancel" mesajını okuyabilelim.
            # daemon=False bilinçli: Chrome portu kapatırsa (service worker ölür,
            # popup kapanır) ana döngü biter ama indirme tamamlanana kadar süreç
            # ayakta kalır. daemon=True olsaydı indirme yarıda kesilirdi.
            threading.Thread(target=download, args=(msg,), daemon=False).start()

        elif action == "pickdir":
            # Ayrı thread: pencere açıkken ana döngü mesaj okumaya devam etsin,
            # yoksa Chrome'un portu boyunca her şey donar.
            threading.Thread(target=pick_dir, args=(msg,), daemon=False).start()

        elif action == "checkdir":
            path, error = check_dir(msg.get("path") or "")
            send({"type": "dir", "path": path, "error": error})

        elif action == "move":
            # Ayrı thread: başka diske taşıma kopyalama demek, sürebilir. Ana
            # döngü bu sırada yt-dlp'nin iptal mesajını okuyabilmeli.
            threading.Thread(target=move_file, args=(msg,), daemon=False).start()

        elif action == "cancel":
            if _current and _current.poll() is None:
                _canceled = True
                _current.kill()
                send({"type": "log", "line": "İptal ediliyor…"})
            else:
                # Bu süreçte çalışan indirme yok (ör. köprü yeniden bağlandı).
                send({"type": "done", "ok": False, "code": -2, "canceled": True,
                      "error": "İptal edilecek çalışan indirme bulunamadı."})


if __name__ == "__main__":
    main()
