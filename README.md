# PageTrawl

Trawl the open page for images and videos, filter them, download in bulk.
A personal-use Chrome extension (Manifest V3, plain JS — no build step), with a
local yt-dlp bridge for streaming sites.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder
4. The icon appears in the toolbar; pin it via the puzzle-piece menu

After changing code, hit the reload (⟳) button on `chrome://extensions`. For
`popup.js`/`popup.css` changes you also need to close and reopen the popup.

> **If you cloned the repo, this is not enough.** The steps above give you page
> scanning, the grid and bulk downloading — but streaming sites (YouTube,
> Instagram…) and saving outside the Downloads folder need the **yt-dlp bridge,
> installed separately**: its files are machine-specific and therefore not in the
> repo. See the "yt-dlp bridge" section below.

## Usage

- **Click the icon** → the page is scanned, media found is listed in a grid
- The list stays **live** while the popup is open: as you scroll and new
  images/videos load, cards append themselves (flashing a green border for a
  moment). Navigating the tab to another page/video resets and rebuilds the list
  — no need to close and reopen the popup
- Click cards to select; `Select all` / `Invert` for bulk selection
- **Different qualities of the same video collapse into one card**
  (`clip_360p.mp4`, `clip_720p.mp4`, `clip_1080p.mp4` → a single card). The card
  shows the best quality; the arrow at the bottom right opens the list so you can
  pick a specific one. Clicking the card body selects the best quality, and
  `Select all` takes one file per card — so you don't download the same video
  three times
- Filters at the top: type (image/video), URL search, minimum width
- The **slider** sets card size (2–7 columns); your choice is remembered
- The grid renders progressively: first 50 cards, then 50 more as you scroll
- Selections and "downloaded" marks are remembered per tab, even if the popup closes
- **Download selected** → enters the queue, flowing at the concurrency limit from
  settings
- Progress bar in the bottom bar: `Downloading… 12/49`, then a green
  `49 files downloaded` when finished (red if there were errors). If the popup is
  closed, the same number shows as a **badge on the extension icon** — the queue
  keeps working in the background
- **Right-click** any image or video → "Download this media" (single file, fast path)
- Two flags in the header switch the interface language between **Turkish and
  English**; the choice is remembered. Chrome's own `chrome.i18n` follows the
  browser language and can't be switched at runtime, so the strings live in
  `i18n.js` instead. The service worker loads the same file via `importScripts`,
  so context menus and bridge errors follow the choice too — the bridge itself
  sends message *keys* rather than sentences

Files are saved as `Downloads/{site-name}/{file-name}.{ext}`.

### Settings

⚙ slides a **full settings screen** over the popup — like opening a new tab,
except it stays inside the popup. Back arrow or Esc returns to the grid.

It holds the save folder, the concurrency limit, the filename template and the
"ask where to save" toggle. Language is switched from the popup's flags.

> The folder picker window still takes focus, and Chrome closes a popup the
> moment it loses focus, so the popup disappears while you pick. The result is
> written to `chrome.storage.session`: reopen the extension and the settings
> screen opens by itself showing what happened. Nothing is lost, you just don't
> see it instantly.

#### Filename template

Default `{host}/{name}.{ext}`. Fields:

| Field | Value |
|---|---|
| `{host}` | site name (`example.com`) |
| `{title}` | page title — falls back to `{host}` when the page has no usable title |
| `{name}` | the file's own name from the URL |
| `{ext}` | extension (guessed when the URL has none) |
| `{date}` | `YYYY-MM-DD` |

A slash creates a subfolder, so `{host}/{title}/{name}.{ext}` groups downloads
per page. Everything is sanitized: characters illegal on Windows/macOS/Linux
become `_`, and each field is capped at 100 characters.

### Save folder

⚙ → **Browse…** picks a **single** folder for both images and videos. It **may
live outside the Downloads folder** (Desktop, `D:\`, wherever). You can also type
or paste a path into the box and press Enter; **Reset** returns to the default.

With the box empty, the default is: images to `Downloads\{site-name}\`, videos to
`Downloads\yt-dlp\`.

#### Why this is so convoluted

Chrome extensions **cannot write outside the Downloads folder** through
`chrome.downloads` — absolute paths and `../` are rejected, and that is a fixed
browser rule. The yt-dlp bridge writes files itself, so it isn't bound by that
rule. To keep this a single setting, the bridge is used for both:

| Job | Who does it |
|---|---|
| The folder picker window | Bridge (`pickdir` → tkinter, falling back to PowerShell `FolderBrowserDialog`) |
| Validating a typed path | Bridge (`checkdir`) |
| Writing the video | Bridge (`-P outdir`) |
| Downloading the image | Chrome (`chrome.downloads`) |
| Moving the image outside Downloads | Bridge (`move`) |

So if the target is **under** Downloads, images land there directly (the bridge
isn't needed at all). If it is **outside**, an image first lands in
`Downloads\pagetrawl-gecici\`, and the moment the download finishes the bridge
moves it to its real destination and removes the empty staging folder. Without
the bridge installed, files stay in that staging folder and the settings panel
shows a red warning — they never disappear silently.

Details:

- **The popup closes when the folder window opens.** Chrome closes a popup that
  loses focus, and that can't be prevented. The result is written to
  `chrome.storage.session`; next time you open the extension the settings screen
  opens by itself and reports "Save folder updated." A keepAlive runs for the
  duration of `dirPending` so the worker doesn't die while the window is open —
  otherwise a selection you took minutes over would vanish silently.
- **Validation does not create folders.** `checkdir` only looks (does the folder
  exist, or if not, does its parent?); the actual `makedirs` happens at download
  or move time. This keeps a mistyped path from littering your disk.
- **Moves never overwrite**: if the name is taken at the destination, it becomes
  `name (1).jpg`. Since a file can stay locked for a moment (Chrome, antivirus),
  the move is retried 4 times.
- **No move happens while "Ask where to save each file" is on** — you're already
  choosing the location.
- The progress counter is based on Chrome's download; the move happens right
  after, separately. So files settle into place a moment after "49 files
  downloaded" appears.
- To change the Downloads root entirely: `chrome://settings/downloads`.

There is no API that returns the absolute path of the Downloads folder. The first
time the settings panel opens, a silent probe download runs to learn and store it
(this is also how the extension decides whether a folder sits under Downloads).
The probe comes from a `data:` URL — the extension's own `chrome-extension://`
resource used to be used, but Chrome refuses to download that through the
`downloads` API and returns `NETWORK_FAILED`.

The probe uses `saveAs: false`. Without stating that explicitly, Chrome's own
"ask where to save each file" setting takes over and the probe opened a Save
dialog **named `download.txt`** (with a `data:` URL Chrome also swallows our
filename suggestion).

## yt-dlp bridge (YouTube, Instagram, TikTok, X…)

Streaming sites don't serve video as a single file: they use segmented DASH/HLS
streams plus signed URLs. Solving that inside the extension would mean rewriting
yt-dlp, and it would break every time a site changed. Instead the extension calls
the yt-dlp on your machine through Chrome's **Native Messaging** bridge.

### Setup

```powershell
# 1. Load the extension, copy its ID from chrome://extensions
# 2. In this folder:
.\setup-native.ps1 -ExtensionId <32-char-id>
# 3. Reload the extension on chrome://extensions (⟳)
```

The script writes the launcher `.bat`, the host manifest and the registry key
(`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.bozgu.ytdlp`). No admin
rights needed. To remove: `.\setup-native.ps1 -Uninstall`.

The two files it generates (`native/ytdlp_host.bat`,
`native/com.bozgu.ytdlp.json`) are **not** in the repo — they're gitignored,
because they contain absolute machine-specific paths (where Python lives) and the
extension's local ID. Shipping them ready-made wouldn't help anyway: an unpacked
extension gets a different ID on every install, and the bridge silently fails to
connect under the wrong ID. That's why step one is copying the ID.

### Dependencies

| Tool | Required? | Note |
|---|---|---|
| yt-dlp | **Yes** | `pip install -U yt-dlp`. YouTube breaks as it ages — update monthly. |
| JS runtime (node/deno/bun) | **Yes, for YouTube** | yt-dlp deprecated runtime-less extraction. If Node is present the host selects it automatically (`--js-runtimes node`). |
| ffmpeg | Recommended | Without it video+audio can't be merged → ~720p ceiling on YouTube, and "audio only" gives raw m4a instead of mp3. `winget install Gyan.FFmpeg` |

The host looks all three up on every call; if ffmpeg isn't on PATH it also scans
the winget install tree and passes what it finds to yt-dlp via
`--ffmpeg-location`. This prevents ffmpeg from looking "present in the terminal,
missing in the extension" when Chrome was started before PATH was updated.

**Cookies are off by default.** Chrome 127+ encrypts its cookie database with
App-Bound Encryption, and yt-dlp can't decrypt that on Windows
(`Failed to decrypt with DPAPI`). Trying cookies first on every download only
added latency. If you need logged-in content, run yt-dlp manually with
`--cookies` (a cookies.txt exported from the browser).

### Usage

Open the extension on a supported site and a download bar appears above the grid,
with the video's **thumbnail, title and channel name**. Pick a quality, hit
Download — the progress bar streams live. Files go to the ⚙ **save folder**, or
to `Downloads\yt-dlp\` if none is set.

The status line shows a single plain sentence rather than yt-dlp's raw output
(`Downloading… 13%`, `Downloaded`); the raw line and the target folder live in the
tooltip.

On YouTube the title, channel and duration come from the **oEmbed** endpoint
(`youtube.com/oembed`) plus `<video>.duration`. The page's own `og:` and
microformat tags get stuck on the previous video during SPA navigation, so they
reported the wrong title and channel; the thumbnail always looked right because
it's derived from the video ID in the URL, which is exactly what made the bug
confusing. Other sites still use `og:` tags. The bar only shows a warning line
when something would actually block a download (no yt-dlp, no JS runtime).

The bridge's "are you installed?" answer (`probe`) arrives as its own message
type, not inside the download status. In the version where both rode in the same
object, the field stuck to the status object and the popup treated every live
progress message as a probe reply, so the bar never advanced — it only moved when
the popup was closed and reopened.

> This tool is for personal use. YouTube's and Instagram's terms of service
> prohibit downloading content; DRM-protected services (Netflix and the like) are
> out of scope and technically unsolvable anyway.

## Files

| File | Job |
|---|---|
| `manifest.json` | Permissions and entry points |
| `background.js` | Service worker: download queue, context menus, network listener |
| `scanner.js` | DOM scanner injected into the page |
| `popup.html/css/js` | Grid UI, filters, selection |
| `i18n.js` | Turkish/English strings + the `t()` helper; shared by the popup and the service worker |
| `icons/` | Extension icons (16/32/48/128) + `make-icon.py` that generates them (Pillow) |
| `native/ytdlp_host.py` | Native messaging host: calls yt-dlp, opens the folder window, moves files |
| `setup-native.ps1` | Bridge setup (bat + host manifest + registry) |

## How it works

- Downloads go through `chrome.downloads.download()` — Chrome's own download
  engine. That way **cookies from your profile are sent automatically** (so
  logged-in sites work), CORS isn't an issue, and pause/resume comes for free.
- The queue lives in `chrome.storage.session`. Under MV3 the service worker dies
  when idle, and an in-memory queue would be lost. The `downloads.onChanged`
  event wakes the worker and starts the next file, so the queue flows by itself.
- The scanner collects `<img>`, `srcset` (picking the largest variant),
  `<picture><source>`, CSS `background-image`, `<video>` + `<source>` + poster,
  lazy-load attributes (`data-src` / `data-original`), and `<a href>` links that
  point at media. `allFrames: true` means iframes are scanned too.
- Network traffic is watched via `webRequest.onResponseStarted`, so media that
  never appears in the DOM (fetched by JS) is added to the list tagged "network".
  Under MV3 the observational side of webRequest still works — only the blocking
  side was removed. Captures accumulate under `net:{tabId}`; if the popup is open,
  the background also announces them immediately with a `netAdded` message.
- The live list is fed from two sources: that `netAdded` message, and a poll the
  popup runs every 1.2 s. Scanning the whole DOM on every poll would be expensive
  (the `getComputedStyle` loop especially), so `scanner.js` installs a
  `MutationObserver` on the page and keeps a "did anything change" flag; if the
  flag is clean the scanner returns `{unchanged:true}` immediately. The flag
  survives between calls because it lives in `executeScript`'s isolated world.
  Every eighth round a full scan runs regardless of the flag, to catch what the
  observer misses (such as style-driven backgrounds).
- New items are appended to the **end** of the list and the list is never
  re-sorted, so scroll position, selection and already-rendered cards stay put.
  The list stops at 3000 items (so infinite scroll doesn't lock up the popup).
- The progress counter also lives in `storage.session` and passes through a single
  promise chain; if `_pump` and `onChanged` wrote at the same time,
  read-modify-write updates would be lost. Only downloads the extension started
  are counted (their IDs are recorded), otherwise the user's own downloads would
  pollute the counter.
- For files headed outside Downloads, the "which download goes where" mapping is
  in `storage.session` too (`moves`) and passes through the same single chain: the
  worker can die before a download finishes, and move information held in memory
  would be lost.
- While yt-dlp is running (and while the folder window is open) the worker calls
  `runtime.getPlatformInfo()` every 20 s. The result is unused; its only job is to
  reset the idle timer. If the worker dies, the native port closes, the host's
  stdin hits EOF and its main loop ends — the download completes on the host side,
  but no progress arrives and cancelling does nothing.

## Known limitations

- **`blob:` videos can't be downloaded from the grid** — use the yt-dlp bar above
  for those. The `blob:` URL you see in a `<video>` tag is a reference living in
  the page's memory; it isn't reachable from the extension's context. The popup
  counts such videos and shows a warning.
- **DRM-protected content (Widevine)** arrives encrypted and is technically
  unsolvable.
- **Thumbnails may not render.** Sites with hotlink protection reject requests
  coming from the extension context, so you see a file-extension label instead of
  a preview. The file itself can still download, because that goes through
  `chrome.downloads` with your cookies.
- **`chrome://`, the Web Store and the PDF viewer can't be scanned** — Chrome
  blocks extension injection there.
- **On very large pages some CSS background images may be missed.** The
  `getComputedStyle` sweep is split into chunks and run through
  `requestIdleCallback`, but a single scan round is capped at 3 seconds; if it
  runs out, the popup says so rather than staying silent about it.

## Next steps (optional)

- Referer header injection: a `declarativeNetRequest` `modifyHeaders` rule for
  hotlink-protected sites (MV3 requires this instead of blocking `webRequest`)
- Auto-scrolling infinite-scroll galleries (scanning is live now; the only missing
  piece is doing the scrolling for the user)
- Playlist support in the yt-dlp bar (dropping the `--no-playlist` flag)
- A download history view (which page did this come from)
- Firefox support — the `browser.*` APIs are largely the same, but the native
  messaging manifest location and registry differ

## Scope and responsibility

This tool was written for **personal use**. The terms of service of services like
YouTube and Instagram prohibit downloading content; what you download and its
copyright status are your responsibility. DRM-protected content (Widevine) is out
of scope — it arrives encrypted, is technically unsolvable, and the tool has no
such capability.

## License

MIT — see [LICENSE](LICENSE).
