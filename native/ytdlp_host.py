#!/usr/bin/env python3
"""
Native messaging host: eklentiden gelen URL'yi yt-dlp'ye devreder ve ilerlemeyi
geri yollar.

Protokol (Chrome native messaging): stdin/stdout üzerinden, her mesajın önünde
4 baytlık little-endian uzunluk + UTF-8 JSON gövde.

Her gelen mesajda ayrıca {"lang": "tr"|"en"} bulunur; host yalnızca kendi
açtığı klasör penceresinin başlığı için kullanır. Eklentiye giden hatalar
metin değil `errKey` + `errVars` olarak gider, çeviriyi i18n.js yapar.

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
from urllib.parse import urlparse

if sys.platform == "win32":
    # stdin/stdout'ta CRLF çevirisi olursa protokol bozulur.
    import msvcrt

    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

_send_lock = threading.Lock()
_current = None  # çalışan yt-dlp süreci
_canceled = False  # kullanıcı mı durdurdu, yoksa gerçekten hata mı verdi

# --- dil -------------------------------------------------------------------
# Eklentiye giden hatalar BURADA çevrilmiyor: anahtar olarak gidiyor ve
# popup'ta i18n.js çözüyor. Böylece çeviriler tek yerde duruyor.
#
# Tek istisna klasör penceresinin başlığı: onu işletim sistemine veren biziz,
# eklentinin çevirmesine fırsat yok. O yüzden burada küçük bir tablo var ve
# eklenti her mesajda seçili dili gönderiyor.

LANG = "tr"

UI = {
    "tr": {"pick_title": "Dosyalarin inecegi klasoru sec"},
    "en": {"pick_title": "Choose the folder for downloads"},
}


def ui(key):
    return UI.get(LANG, UI["tr"]).get(key) or UI["tr"][key]


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

def configure_macos_path():
    """Finder-launched Chrome does not inherit the interactive shell PATH."""
    if sys.platform != "darwin":
        return
    paths = os.environ.get("PATH", "").split(os.pathsep)
    paths += ["/opt/homebrew/bin", "/usr/local/bin",
              os.path.expanduser("~/.local/bin"),
              os.path.expanduser("~/.deno/bin"),
              os.path.expanduser("~/.bun/bin")]
    os.environ["PATH"] = os.pathsep.join(dict.fromkeys(p for p in paths if p))


configure_macos_path()


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

    if sys.platform != "win32" or not os.environ.get("LOCALAPPDATA"):
        return None
    base = os.path.join(os.environ["LOCALAPPDATA"], "Microsoft", "WinGet", "Packages")
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
            title=ui("pick_title"),
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
    # Değerler betiğe GÖMÜLMÜYOR: içinde tek tırnak olan bir yol betiği bozar
    # ya da komut enjekte ederdi. Ortam değişkeniyle veri olarak geçiyoruz.
    script = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$d.Description = $env:PT_TITLE;"
        "$d.SelectedPath = $env:PT_INITIAL;"
        "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
    )
    env = os.environ.copy()
    env["PT_TITLE"] = ui("pick_title")
    env["PT_INITIAL"] = initial or os.path.expanduser("~")
    out = subprocess.run(
        ["powershell", "-NoProfile", "-STA", "-Command", script],
        capture_output=True, text=True, creationflags=CREATE_NO_WINDOW, timeout=300,
        env=env
    )
    return out.stdout.strip()


def _ask_dir_macos(initial):
    """Run the native picker in a separate process; Cocoa/Tk needs a main thread.

    Arguments are data, never interpolated into AppleScript source.
    """
    initial = os.path.abspath(os.path.expanduser(initial or "~"))
    if not os.path.isdir(initial):
        initial = os.path.expanduser("~")
    script = '''on run argv
    try
        tell application "System Events"
            activate
            set chosen to choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))
        end tell
        return POSIX path of chosen
    on error number -128
        return ""
    end try
end run'''
    result = subprocess.run(
        ["/usr/bin/osascript", "-e", script, ui("pick_title"), initial],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=300,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "macOS folder picker failed")
    return result.stdout.rstrip("\n")


def pick_dir(msg):
    initial = msg.get("path") or ""
    path = ""
    err_key, err_vars = "", {}
    try:
        path = _ask_dir_macos(initial) if sys.platform == "darwin" else _ask_dir_tk(initial)
    except Exception as e:
        if sys.platform == "win32":
            try:
                path = _ask_dir_powershell(initial)
            except Exception as e2:
                err_key, err_vars = "host.pickdirFailed", {"err": str(e2)}
        else:
            err_key, err_vars = "host.pickdirFailed", {"err": str(e)}

    if path and not err_key:
        path, err_key, err_vars = check_dir(path)
    send({"type": "dir", "path": path, "errKey": err_key, "errVars": err_vars})


def check_dir(path):
    """
    Yolu normalleştirir ve kullanılabilir mi bakar. Klasörü BURADA açmıyoruz:
    yanlış yazılmış bir yol yüzünden diske çöp klasör açılmasın. Gerçekten
    gerektiğinde (indirme anında) zaten os.makedirs çalışıyor.

    -> (path, errKey, errVars) — hata metni değil anahtar dönüyor; çeviri
    eklenti tarafında (i18n.js) yapılıyor.
    """
    p = (path or "").strip()
    if not p:
        return "", "", {}

    try:
        p = os.path.abspath(os.path.expanduser(os.path.normpath(p)))
    except Exception as e:
        return "", "host.pathUnreadable", {"err": str(e)}

    if os.path.isdir(p):
        return p, "", {}
    if os.path.exists(p):
        return "", "host.notADir", {"path": p}
    if os.path.isdir(os.path.dirname(p)):
        return p, "", {}   # üst klasör var; indirme sırasında oluşturulacak
    return "", "host.noSuchDir", {"path": p}


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
    # Silmedeki frenlerin aynısı: iki uç da mutlak ve izin verilen köklerin
    # (kayıt klasörü / İndirilenler) altında olmak zorunda. Yoksa host, eklenti
    # adına diskteki herhangi bir dosyayı herhangi bir yere taşıyabilirdi.
    roots = [r for r in (msg.get("roots") or []) if r]
    if not (os.path.isabs(src) and os.path.isabs(dst)
            and roots and _under(src, roots) and _under(dst, roots)):
        send({"type": "moved", "ok": False,
              "error": f"{os.path.basename(src)}: izin verilen klasörlerin dışında."})
        return
    if os.path.islink(src) or not os.path.isfile(src):
        send({"type": "moved", "ok": False,
              "error": f"{os.path.basename(src)}: düz dosya değil."})
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


# --- silme -----------------------------------------------------------------
# Host'un GERİ ALINAMAZ tek eylemi. Taşıma yanlış giderse dosya durur, indirme
# yanlış giderse tekrar indirilir — silme öyle değil. O yüzden burada üç ayrı
# fren var ve hiçbiri "kolaylık olsun" diye gevşetilmemeli.


def _under(path, roots):
    """`path`, roots'tan birinin ALTINDA mı? Kökün kendisi kabul edilmiyor."""
    p = os.path.normcase(os.path.abspath(os.path.normpath(path)))
    for r in roots:
        if not r:
            continue
        rr = os.path.normcase(os.path.abspath(os.path.normpath(r)))
        if p.startswith(rr + os.sep):
            return True
    return False


def delete_files(msg):
    """
    Verilen mutlak yolları siler ve tek bir toplu cevap döner.

    Neden eklenti kendi silemiyor: `chrome.downloads.removeFile` yalnızca
    Chrome'un kaydettiği yerdeki dosyayı siler. Köprüyle İndirilenler dışına
    taşınmış dosyalarda o kayıt artık yanlış yeri gösteriyor, dolayısıyla
    silmeyi de yerel süreç yapmak zorunda.
    """
    roots = [r for r in (msg.get("roots") or []) if r]
    done, failed = [], []

    for raw in (msg.get("paths") or []):
        path = os.path.normpath(raw or "")
        try:
            if not path or not os.path.isabs(path):
                raise ValueError("notabs")

            # 1. Fren: kayıt klasörünün (ya da İndirilenler'in) altı olmak
            # zorunda. Yol bizim kendi defterimizden gelse bile dışarı çıkan
            # hiçbir şeye dokunmuyoruz — kalan tek koruma bu.
            if not roots or not _under(path, roots):
                raise ValueError("outside")

            # Dosya zaten yok: kullanıcının istediği sonuç bu, hata değil.
            # Bu kontrol `notfile`'dan ÖNCE gelmek zorunda — sonra gelseydi
            # elle silinmiş bir dosya partiyi kırmızıya boyardı.
            if not os.path.exists(path) and not os.path.islink(path):
                done.append(raw)
                continue

            # 2. Fren: klasör değil, düz dosya. `islink` ayrıca kontrol ediliyor
            # çünkü bir klasöre işaret eden sembolik bağ `isfile` testini
            # geçebilir ve silmek klasörü silmek anlamına gelirdi.
            if os.path.islink(path) or not os.path.isfile(path):
                raise ValueError("notfile")

            os.remove(path)
            done.append(raw)
        except ValueError as e:
            # 3. Fren: gerekçe koda çevriliyor, cümleye değil — çeviri tablosu
            # eklentide tek yerde duruyor.
            failed.append({"path": raw, "code": str(e)})
        except Exception as e:
            failed.append({"path": raw, "code": "oserr", "error": str(e)})

    send({"type": "deleted", "ok": not failed, "done": done, "failed": failed})


def _http_url(value):
    """Yalnızca http(s) ve host'u olan adresler. `-` ile başlayan bir değer
    yt-dlp'de seçenek (ör. --exec) olarak yorumlanırdı; `file://` de yerel
    dosya okuturdu."""
    if not isinstance(value, str):
        return False
    try:
        u = urlparse(value)
    except ValueError:
        return False
    return u.scheme in ("http", "https") and bool(u.netloc)


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
    url = msg.get("url")
    if not _http_url(url):
        send({"type": "done", "ok": False, "code": -1,
              "error": "Geçersiz adres (yalnızca http/https)."})
        return

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

    # Izgaradan seçilen bir manifest (.mpd/.m3u8) çıplak CDN adresi oluyor;
    # sunucuların çoğu onu referer'sız reddediyor. Sayfa adresini geçiyoruz.
    # Site sayfasından başlatılan normal indirmelerde bu alan boş geliyor,
    # yt-dlp kendi çıkarıcısı neyi gerekiyorsa onu yapıyor.
    referer = msg.get("referer") or ""
    if not _http_url(referer):
        referer = ""
    if referer:
        args += ["--referer", referer]

    if ffmpeg_path:
        args += ["--ffmpeg-location", os.path.dirname(ffmpeg_path)]

    runtime = find_js_runtime()
    if runtime:
        args += ["--js-runtimes", runtime]
    else:
        send({"type": "log", "lineKey": "probe.noJs"})

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
            # "--": sonrası seçenek değil, yalnızca adres.
            cmd + ["--", url],
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
            send({"type": "log", "lineKey": "host.cookieRetry"})

    send({"type": "done", "ok": False, "code": code, "outdir": outdir})


# --- ana döngü -------------------------------------------------------------

def main():
    global _canceled, LANG

    while True:
        try:
            msg = read_message()
        except Exception as e:
            send({"type": "done", "ok": False, "code": -1, "error": str(e)})
            return
        if msg is None:
            return

        # Eklenti seçili dili her mesajda gönderiyor; host'un kalıcı bir
        # ayarı yok, kullanıcı dili değiştirdiğinde bir sonraki mesajla gelir.
        if msg.get("lang"):
            LANG = msg["lang"]

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
            path, err_key, err_vars = check_dir(msg.get("path") or "")
            send({"type": "dir", "path": path, "errKey": err_key, "errVars": err_vars})

        elif action == "move":
            # Ayrı thread: başka diske taşıma kopyalama demek, sürebilir. Ana
            # döngü bu sırada yt-dlp'nin iptal mesajını okuyabilmeli.
            threading.Thread(target=move_file, args=(msg,), daemon=False).start()

        elif action == "delete":
            # Ayrı thread: ağ sürücüsündeki ya da kilitli bir dosya sırayı
            # bekletebilir; ana döngü bu sırada iptal mesajını okuyabilmeli.
            threading.Thread(target=delete_files, args=(msg,), daemon=False).start()

        elif action == "cancel":
            if _current and _current.poll() is None:
                _canceled = True
                _current.kill()
                send({"type": "log", "lineKey": "host.canceling"})
            else:
                # Bu süreçte çalışan indirme yok (ör. köprü yeniden bağlandı).
                send({"type": "done", "ok": False, "code": -2, "canceled": True,
                      "errKey": "host.noRunning"})


if __name__ == "__main__":
    main()
