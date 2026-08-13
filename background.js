// ---------------------------------------------------------------------------
// Service worker: indirme kuyruğu + sağ tık menüleri + ağ trafiğinden medya
// yakalama. MV3'te bu worker boşta ~30 sn sonra ölür; bu yüzden kalıcı hiçbir
// şeyi RAM'de tutmuyoruz, kuyruk chrome.storage.session'da duruyor.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  maxConcurrent: 4,
  template: '{host}/{name}.{ext}',
  folder: '',      // TEK kayıt klasörü: mutlak yol. Boşsa İndirilenler.
  saveAs: false    // her dosyada Kaydet penceresini aç
};

// Seçilen klasör İndirilenler dışındaysa Chrome oraya yazamaz; dosya önce
// İndirilenler'in altındaki bu ara klasöre iniyor, sonra köprü taşıyor.
const STAGE_DIR = 'medya-indirici-gecici';

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|m4v|ogv|m3u8|mpd)(\?|#|$)/i;

// --- ayarlar ---------------------------------------------------------------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

/** Kısmi yazma — diğer anahtarları ezmeden. */
async function saveSettings(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...(settings || {}), ...patch } });
}

// --- dosya adı üretimi -----------------------------------------------------

/** Windows/macOS/Linux'ta yasak olan karakterleri temizler. */
function sanitize(s) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'dosya';
}

function guessKind(url) {
  return VIDEO_EXT.test(url) ? 'video' : 'image';
}

/**
 * Şablondan göreli dosya yolu üretir. chrome.downloads mutlak yol veya ".."
 * kabul etmez; her şey Downloads klasörünün altına göreli olmak zorunda.
 */
function buildFilename(rawUrl, pageHost, template, kind) {
  let name = '';
  let ext = '';

  if (rawUrl.startsWith('data:')) {
    const mime = rawUrl.slice(5, rawUrl.indexOf(';') > 0 ? rawUrl.indexOf(';') : rawUrl.indexOf(','));
    name = 'inline-' + Date.now().toString(36);
    ext = (mime.split('/')[1] || '').replace(/[^a-z0-9]/gi, '');
  } else {
    try {
      const u = new URL(rawUrl);
      const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      const dot = last.lastIndexOf('.');
      if (dot > 0) {
        name = last.slice(0, dot);
        ext = last.slice(dot + 1);
      } else {
        name = last || u.hostname;
      }
    } catch {
      name = 'dosya';
    }
  }

  // Uzantı yoksa ya da "uzantı" gibi durmuyorsa (ör. query kalıntısı) tahmin et.
  if (!ext || ext.length > 5 || !/^[a-z0-9]+$/i.test(ext)) {
    ext = kind === 'video' ? 'mp4' : 'jpg';
  }
  if (!name) name = 'dosya';

  return template
    .replace(/{host}/g, sanitize(pageHost))
    .replace(/{name}/g, sanitize(name))
    .replace(/{ext}/g, sanitize(ext))
    .replace(/{date}/g, new Date().toISOString().slice(0, 10))
    .replace(/\/+/g, '/')
    .replace(/^\//, '');
}

// --- kuyruk ----------------------------------------------------------------

async function getQueue() {
  const { queue } = await chrome.storage.session.get('queue');
  return queue || [];
}

async function setQueue(queue) {
  await chrome.storage.session.set({ queue });
}

// --- ilerleme sayacı -------------------------------------------------------
// "İndi mi inmedi mi" sorusunun cevabı. Service worker ölüp dirildiği için
// sayaç RAM'de değil session storage'da; rozet ve popup çubuğu bunu okuyor.
//
// ids: bizim başlattığımız indirmelerin kimlikleri. Chrome'un kendi (kullanıcı
// elle başlattığı) indirmeleri de aynı onChanged olayını tetikliyor; onları
// kendi sayacımıza katmamak için hangileri bizim, kayıt altında tutuyoruz.

const EMPTY_PROG = { total: 0, done: 0, failed: 0, ids: {} };

async function getProg() {
  const { prog } = await chrome.storage.session.get('prog');
  return { ...EMPTY_PROG, ...(prog || {}) };
}

// Sayaç iki yerden değişiyor (_pump yeni indirme başlatırken, onChanged biterken).
// Hepsini tek zincire diziyoruz, yoksa oku-değiştir-yaz araları kaybolur.
let progChain = Promise.resolve();
function updateProg(mutate) {
  progChain = progChain
    .then(async () => {
      const prog = await getProg();
      mutate(prog);
      await chrome.storage.session.set({ prog });
      await paintProg(prog);
    })
    .catch((e) => console.error('[prog]', e));
  return progChain;
}

async function paintProg(prog) {
  const left = prog.total - prog.done - prog.failed;

  // Rozet: popup kapalıyken tek geri bildirim.
  if (left > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    await chrome.action.setBadgeText({ text: String(left) });
  } else if (prog.failed) {
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    await chrome.action.setBadgeText({ text: String(prog.failed) });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }

  // Popup açıksa canlı güncelle; kapalıysa alıcı yok, hatayı yut.
  chrome.runtime.sendMessage({ type: 'dlStatus', prog }).catch(() => {});
}

/** items: [{url, kind}] */
async function enqueue(items, pageHost) {
  const { template, saveAs } = await getSettings();
  const plan = await folderPlan();
  // Hedef İndirilenler dışındaysa Chrome oraya yazamaz: ara klasöre indirip
  // köprüye taşıtıyoruz. "Her dosyada sor" açıkken yeri kullanıcı seçtiği için
  // taşımaya karışmıyoruz.
  const staged = plan.outside && !saveAs;
  const prefix = staged ? STAGE_DIR + '/' : plan.rel ? plan.rel + '/' : '';

  const jobs = items
    .filter((it) => it && it.url)
    .map((it) => {
      const rel = buildFilename(it.url, pageHost, template, it.kind || guessKind(it.url));
      return {
        url: it.url,
        filename: prefix + rel,
        move: staged ? joinAbs(plan.abs, rel) : ''
      };
    });

  const queue = await getQueue();
  await setQueue(queue.concat(jobs));

  await updateProg((p) => {
    // Önceki parti bittiyse sayaç sıfırdan başlasın; bitmediyse üstüne eklensin.
    if (p.done + p.failed >= p.total) Object.assign(p, { total: 0, done: 0, failed: 0 });
    p.total += jobs.length;
  });

  await pump();
  return jobs.length;
}

// pump() birden çok yerden tetikleniyor; aynı anda iki kez çalışıp aynı işi
// iki kere indirmemesi için tek bir promise zincirine diziyoruz.
let chain = Promise.resolve();
function pump() {
  chain = chain.then(_pump, _pump).catch((e) => console.error('[pump]', e));
  return chain;
}

async function _pump() {
  const queue = await getQueue();
  if (!queue.length) return;

  const { maxConcurrent, saveAs } = await getSettings();
  // Chrome'un kendi indirmelerini de sayıyoruz; başka bir indirme sürerken
  // sunucuyu daha da yormanın anlamı yok.
  const active = (await chrome.downloads.search({ state: 'in_progress' })).length;
  let slots = Math.max(0, maxConcurrent - active);

  while (slots > 0 && queue.length) {
    const job = queue.shift();
    slots--;
    try {
      const id = await chrome.downloads.download({
        url: job.url,
        filename: job.filename,
        conflictAction: 'uniquify',
        saveAs: !!saveAs
      });
      await updateProg((p) => { p.ids[id] = 1; });
      if (job.move) await rememberMove(id, job.move);
    } catch (e) {
      // Geçersiz dosya adı, ölü URL vs. Kuyruğu tıkamasın, atla.
      console.warn('[indirilemedi]', job.url, e.message);
      await updateProg((p) => { p.failed++; });
    }
  }

  await setQueue(queue);
}

// Bir indirme bitince/koptuğunda sayacı ilerlet ve sıradakini başlat. Bu event
// aynı zamanda uyuyan service worker'ı uyandırdığı için kuyruk kendi kendine akar.
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const state = delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;

  updateProg((p) => {
    if (!p.ids[delta.id]) return;   // bizim değil (kullanıcının kendi indirmesi)
    delete p.ids[delta.id];
    if (state === 'complete') p.done++;
    else p.failed++;
  });

  // Ara klasöre inen dosyayı asıl yerine köprü taşıyor.
  if (state === 'complete') finishMove(delta.id);
  else takeMove(delta.id);

  pump();
});

// --- sağ tık menüleri ------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'dl-src',
      title: 'Bu medyayı indir',
      contexts: ['image', 'video', 'audio']
    });
    chrome.contextMenus.create({
      id: 'dl-link',
      title: 'Bağlantıyı indir',
      contexts: ['link']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.srcUrl || info.linkUrl;
  if (!url) return;

  if (url.startsWith('blob:')) {
    console.warn('blob: URL indirilemez —', url);
    return;
  }

  let host = 'indirilenler';
  try {
    if (tab?.url) host = new URL(tab.url).hostname;
  } catch {}

  await enqueue([{ url, kind: info.mediaType === 'video' ? 'video' : guessKind(url) }], host);
});

// --- ağdan medya yakalama --------------------------------------------------
// Sayfa DOM'unda görünmeyen (JS ile fetch edilen, lazy yüklenen) medyayı
// yakalar. MV3'te webRequest'in *gözlemci* tarafı hâlâ çalışıyor; sadece
// engelleyici (blocking) kısmı kaldırıldı.

const NET_CAP = 200;
const netBuffer = new Map(); // tabId -> [item]
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const entries = [...netBuffer.entries()];
    netBuffer.clear();
    for (const [tabId, items] of entries) {
      const key = 'net:' + tabId;
      const stored = (await chrome.storage.session.get(key))[key] || [];
      const seen = new Set(stored.map((i) => i.url));
      const added = [];
      for (const it of items) {
        if (!seen.has(it.url)) {
          seen.add(it.url);
          stored.push(it);
          added.push(it);
        }
      }
      await chrome.storage.session.set({ [key]: stored.slice(-NET_CAP) });

      // Popup açıksa listeye anında eklesin; kapalıysa alıcı yok, hatayı yut.
      if (added.length) {
        chrome.runtime.sendMessage({ type: 'netAdded', tabId, items: added }).catch(() => {});
      }
    }
  }, 600);
}

chrome.webRequest.onResponseStarted.addListener(
  (d) => {
    if (d.tabId < 0 || !/^https?:/.test(d.url)) return;

    const headers = d.responseHeaders || [];
    const get = (n) => headers.find((h) => h.name.toLowerCase() === n)?.value || '';
    const ct = get('content-type').toLowerCase();
    const size = parseInt(get('content-length'), 10) || 0;

    const isVideo = ct.startsWith('video/') || VIDEO_EXT.test(d.url);
    const isImage = ct.startsWith('image/');
    if (!isVideo && !isImage) return;

    // 20 KB altındaki resimler neredeyse her zaman ikon/spacer/tracking pikseli.
    if (isImage && size && size < 20000) return;

    const list = netBuffer.get(d.tabId) || [];
    list.push({ url: d.url, kind: isVideo ? 'video' : 'image', size, net: true });
    netBuffer.set(d.tabId, list);
    scheduleFlush();
  },
  { urls: ['<all_urls>'], types: ['media', 'image', 'xmlhttprequest', 'other'] },
  ['responseHeaders']
);

async function clearNet(tabId) {
  netBuffer.delete(tabId);
  // Popup'ın seçim/indirildi hafızası da o sayfaya aitti; yeni sayfada geçersiz.
  await chrome.storage.session.remove(['net:' + tabId, 'sel:' + tabId, 'done:' + tabId]);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) clearNet(tabId); // yeni sayfaya geçildi, listeyi sıfırla
});
chrome.tabs.onRemoved.addListener(clearNet);

// --- İndirilenler klasörünün yeri ------------------------------------------
// Mutlak yolu veren bir API yok, ama iki şey için lazım: ayarda gerçek yolu
// göstermek ve seçilen klasörün İndirilenler altında olup olmadığına karar
// vermek. Küçük bir sonda dosyası bir kez sessizce indirilip yolu okunuyor.

const PROBE_NAME = 'medya-indirici-klasor-secimi.txt';

// Sonda dosyasının kaynağı. `chrome-extension://` URL'si NETWORK_FAILED veriyor
// (Chrome kendi eklenti kaynaklarını downloads API'siyle indirtmiyor), o yüzden
// birinci tercih data: URL. Bir Chrome sürümü onu da kısıtlarsa web erişimine
// açık probe.txt'ye düşüyoruz.
const PROBE_URLS = [
  'data:text/plain;charset=utf-8,medya-indirici%20klasor%20sondasi',
  chrome.runtime.getURL('probe.txt')
];

const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function waitDownload(id) {
  return new Promise((resolve) => {
    const off = () => {
      chrome.downloads.onChanged.removeListener(onChange);
      clearTimeout(timer);
    };
    const onChange = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') {
        off();
        resolve({ ok: true });
      } else if (d.state.current === 'interrupted') {
        off();
        resolve({ ok: false, error: d.error?.current || 'INTERRUPTED' });
      }
    };
    // Sonda küçücük ama disk/antivirüs takılabilir; cömert bir üst sınır.
    const timer = setTimeout(() => { off(); resolve({ ok: false, error: 'TIMEOUT' }); }, 60000);
    chrome.downloads.onChanged.addListener(onChange);
  });
}

async function probeOnce(url) {
  let id;
  try {
    id = await chrome.downloads.download({
      url,
      filename: PROBE_NAME,
      conflictAction: 'overwrite',
      // saveAs BELİRTİLMEZSE Chrome'un kendi "her dosyada nereye kaydedileceğini
      // sor" ayarı geçerli olur: sonda için Kaydet penceresi açılır ve data:
      // URL'de Chrome bizim ad önerimizi de yutup "download.txt" gösterir.
      // Sonda sessiz olmak zorunda, o yüzden açıkça kapatıyoruz.
      saveAs: false
    });
  } catch (e) {
    return { ok: false, error: e.message, path: '' };
  }

  const res = await waitDownload(id);
  let path = '';
  if (res.ok) {
    const [item] = await chrome.downloads.search({ id });
    path = item?.filename || '';
  }
  // Sonda dosyasını diskten ve indirme geçmişinden temizle.
  try { await chrome.downloads.removeFile(id); } catch {}
  try { await chrome.downloads.erase({ id }); } catch {}

  return { ...res, path };
}

async function probeDownload() {
  let last = { ok: false, error: '?', path: '' };
  for (const url of PROBE_URLS) {
    last = await probeOnce(url);
    if (last.ok) break;
  }
  return last;
}

/**
 * İndirilenler klasörünün mutlak yolu. Ayarlarda gerçek yolu gösterebilmek
 * için lazım ve API bunu vermiyor; sessiz bir sonda indirmesiyle öğrenip
 * kalıcı olarak saklıyoruz (bir kez, ilk ihtiyaçta).
 */
async function getDownloadsRoot() {
  const { downloadsRoot } = await chrome.storage.local.get('downloadsRoot');
  if (downloadsRoot) return downloadsRoot;

  const res = await probeDownload();
  if (!res.ok || !res.path) return '';

  const root = dirOf(res.path);
  await chrome.storage.local.set({ downloadsRoot: root });
  return root;
}

const isAbs = (p) => /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\') || p.startsWith('/');

/** Yolları birleştirir; ayırıcıyı kökten alıyor (Windows: \). */
function joinAbs(base, rel) {
  const sep = base.includes('\\') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sep + rel.replace(/[\\/]+/g, sep);
}

/** abs, root'un altında mı: '' = tam kök, 'alt/klasör' = altında, null = dışarıda. */
function relUnder(root, abs) {
  if (!root || !abs) return null;
  if (norm(abs) === norm(root)) return '';
  if (!norm(abs).startsWith(norm(root) + '/')) return null;
  return abs.slice(root.length + 1).replace(/\\/g, '/');
}

/**
 * Tek kayıt klasörü ayarının indirme tarafındaki karşılığı:
 *   abs     : dosyaların gideceği mutlak klasör
 *   rel     : İndirilenler'e göreli hâli ('' = kök, dışarıdaysa boş)
 *   outside : true ise chrome.downloads oraya yazamaz → köprü taşıyacak
 *   set     : kullanıcı bir klasör seçmiş mi
 */
async function folderPlan() {
  const { folder } = await getSettings();
  const root = await getDownloadsRoot();

  let abs = (folder || '').trim();
  // 1.11'e kadar ayar İndirilenler'e göreliydi ("fotolar"); eski kurulumlar
  // güncellenince ayarını kaybetmesin diye burada mutlak yola çeviriyoruz.
  if (abs && !isAbs(abs)) abs = root ? joinAbs(root, abs) : '';
  if (!abs) return { root, abs: root, rel: '', outside: false, set: false };

  const rel = relUnder(root, abs);
  return { root, abs, rel: rel || '', outside: rel === null, set: true };
}

/**
 * yt-dlp'nin yazacağı MUTLAK klasör. Köprü dosyayı kendisi yazdığı için
 * "her şey İndirilenler altında" kuralına tabi değil. Ayar boşsa eski davranış
 * sürüyor: İndirilenler\yt-dlp. Yol öğrenilemezse boş dönüyoruz, host kendi
 * varsayılanına düşüyor.
 */
async function ytOutdir() {
  try {
    const plan = await folderPlan();
    if (plan.set) return plan.abs;
    return plan.root ? joinAbs(plan.root, 'yt-dlp') : '';
  } catch {
    return '';
  }
}

/** Ayar panelinde gösterilecek not; popup kapalıysa bir dahaki açılışta çıkar. */
async function noteFolder(text, bad = false) {
  await chrome.storage.session.set({ folderMsg: text });
  chrome.runtime.sendMessage({ type: 'folder', note: text, bad }).catch(() => {});
}

// --- İndirilenler dışına taşıma --------------------------------------------
// Chrome dosyayı ara klasöre indirdi; hangi indirmenin nereye taşınacağını
// session'da tutuyoruz, çünkü worker arada ölebilir.

let moveChain = Promise.resolve();
/** Oku-değiştir-yaz araları kaybolmasın diye taşıma defterine sırayla giriliyor. */
function queueMoves(fn) {
  const run = moveChain.then(fn, fn);
  moveChain = run.catch(() => {});
  return run;
}

function rememberMove(id, to) {
  return queueMoves(async () => {
    const { moves } = await chrome.storage.session.get('moves');
    await chrome.storage.session.set({ moves: { ...(moves || {}), [id]: to } });
  });
}

function takeMove(id) {
  return queueMoves(async () => {
    const { moves } = await chrome.storage.session.get('moves');
    const m = moves || {};
    const to = m[id] || '';
    if (to) {
      delete m[id];
      await chrome.storage.session.set({ moves: m });
    }
    return to;
  });
}

async function finishMove(id) {
  const to = await takeMove(id);
  if (!to) return;

  const [item] = await chrome.downloads.search({ id });
  if (!item?.filename) return;

  const root = await getDownloadsRoot();
  movesInFlight++;
  syncKeepAlive();   // taşıma sürerken worker ölmesin
  const ok = nativeSend({
    action: 'move',
    from: item.filename,
    to,
    prune: root ? joinAbs(root, STAGE_DIR) : ''   // boşalan ara klasörü sil
  });
  if (!ok) {
    movesInFlight--;
    syncKeepAlive();
    await noteFolder(
      'Köprü çalışmadığı için dosyalar taşınamadı; İndirilenler\\' + STAGE_DIR +
      ' altında duruyorlar.',
      true
    );
  }
}

// --- yt-dlp köprüsü (native messaging) -------------------------------------
// Akış siteleri (YouTube, Instagram reels…) videoyu tek dosya olarak vermez;
// parçalı DASH/HLS akışı + şifreli imza kullanırlar. Bunu eklentide çözmeye
// çalışmak yt-dlp'yi yeniden yazmak olurdu, üstelik siteler her değiştiğinde
// kırılırdı. Bunun yerine yerel yt-dlp'yi çağırıyoruz.

const NATIVE_HOST = 'com.bozgu.ytdlp';
let nativePort = null;

// MV3 service worker'ı ~30 sn boşta kalınca öldürüyor. yt-dlp bir YouTube
// videosunda ilk çıktısını vermeden önce rahat 30 sn geçirebiliyor (imza
// çözümü, format listesi) — bu sürede worker ölürse native port kapanır,
// host'un stdin'i EOF alır ve ana döngüsü biter. İndirme host tarafında
// tamamlanır (thread daemon değil) ama artık ilerleme gelmez ve iptal mesajı
// gidecek yer bulamaz. Tam olarak "dosya indi, bar Başlatılıyor'da kaldı".
//
// Çözüm: indirme sürerken düzenli aralıkla bir eklenti API'si çağırmak.
// Her çağrı boşta kalma sayacını sıfırlıyor, worker ayakta kalıyor.
let keepAliveTimer = null;
let ytRunning = false;    // bu port üzerinden sürmekte olan bir indirme var mı
let dirPending = false;   // klasör seçme penceresi açık (kullanıcı dakikalarca bakabilir)
let movesInFlight = 0;    // köprüye verilip cevabı beklenen taşıma sayısı

/** Worker'ı yalnızca gerçekten bekleyen bir iş varken ayakta tutuyoruz. */
function syncKeepAlive() {
  keepAlive(ytRunning || dirPending || movesInFlight > 0);
}

function keepAlive(on) {
  if (on) {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  } else {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/** Popup açıksa canlı bildir; kapalıysa durumu storage'a yaz ki açılışta okusun. */
async function pushStatus(patch) {
  const { ytStatus } = await chrome.storage.session.get('ytStatus');
  const next = { ...(ytStatus || {}), ...patch, at: Date.now() };
  await chrome.storage.session.set({ ytStatus: next });
  chrome.runtime.sendMessage({ type: 'ytStatus', status: next }).catch(() => {});
}

function nativeConnect() {
  if (nativePort) return nativePort;

  nativePort = chrome.runtime.connectNative(NATIVE_HOST);

  nativePort.onMessage.addListener((m) => {
    if (m.type === 'probe') {
      // Probe'u indirme durumuna KARIŞTIRMIYORUZ. Eskiden `pushStatus({probe})`
      // deniyordu; alan durum nesnesine yapışıp kalıyor, popup da her canlı
      // ilerleme mesajını "bu bir probe cevabı" sanıp çubuğu güncellemiyordu.
      // Saklamıyoruz: popup her açılışta yeniden soruyor, eski cevap yanıltıcı olur.
      chrome.runtime.sendMessage({ type: 'ytProbe', probe: m }).catch(() => {});
    } else if (m.type === 'dir') {
      // Klasör seçme penceresi kapandı. Popup büyük ihtimalle kapanmıştır
      // (pencere odağı aldı), o yüzden sonucu burada kaydediyoruz; popup açıksa
      // mesajı da alır, kapalıysa bir dahaki açılışta ayarda görür.
      dirPending = false;
      syncKeepAlive();

      (async () => {
        if (m.path) await saveSettings({ folder: m.path });
        if (m.path || m.error) {
          await chrome.storage.session.set({
            folderMsg: m.error || 'Kayıt klasörü güncellendi.'
          });
        }
        chrome.runtime
          .sendMessage({
            type: 'folder',
            path: m.path || '',
            error: m.error || '',
            canceled: !m.path && !m.error
          })
          .catch(() => {});
      })();
    } else if (m.type === 'moved') {
      movesInFlight = Math.max(0, movesInFlight - 1);
      syncKeepAlive();
      // Taşıma başarısızsa dosya ara klasörde kaldı — sessizce yutmuyoruz.
      if (!m.ok) noteFolder('Dosya taşınamadı: ' + (m.error || '?'), true);
    } else if (m.type === 'progress') {
      pushStatus({ running: true, percent: m.percent, line: m.line, error: null });
    } else if (m.type === 'log') {
      pushStatus({ running: true, line: m.line });
    } else if (m.type === 'done') {
      ytRunning = false;
      syncKeepAlive();

      if (m.ok) {
        // Popup "İndirildi" yazıyor; klasör yolu satırı şişirmesin diye ayrı
        // alanda gidiyor ve orada yalnızca fare ipucu olarak görünüyor.
        pushStatus({ running: false, percent: 100, line: '', dir: m.outdir, error: null });
      } else if (m.canceled) {
        // İptal hata değil: kırmızı satır yerine sade bir bilgi.
        pushStatus({
          running: false,
          percent: 0,
          line: m.error || 'İndirme iptal edildi.',
          error: null
        });
      } else {
        pushStatus({
          running: false,
          percent: undefined,
          line: '',
          dir: m.outdir || '',
          error: m.error || `İndirme başarısız oldu (kod ${m.code}).`
        });
      }
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || '';
    const wasRunning = ytRunning;
    const lostMoves = movesInFlight;

    nativePort = null;
    ytRunning = false;
    dirPending = false;
    movesInFlight = 0;
    keepAlive(false);

    // Cevabı gelmeyen taşımalar: dosyalar ara klasörde kaldı, söyle.
    if (lostMoves) {
      noteFolder(
        'Köprü bağlantısı koptuğu için ' + lostMoves + ' dosya taşınamadı; ' +
        'İndirilenler\\' + STAGE_DIR + ' altındalar.' + (err ? ' (' + err + ')' : ''),
        true
      );
    }

    if (err && !wasRunning) {
      pushStatus({
        running: false,
        error:
          'Köprü kurulu değil. Klasörde `.\\setup-native.ps1 -ExtensionId ' +
          chrome.runtime.id +
          '` komutunu çalıştır. (' + err + ')'
      });
    } else if (wasRunning) {
      // Eskiden burası sessizce geçiliyordu; bar sonsuza kadar "çalışıyor"
      // durumunda kalıyordu. Kopuş normal (hatasız) da olsa haber ver.
      pushStatus({
        running: false,
        error:
          'Köprü bağlantısı koptu. İndirme arka planda tamamlanmış olabilir — ' +
          'kayıt klasörüne bak.' + (err ? ' (' + err + ')' : '')
      });
    }
  });

  return nativePort;
}

function nativeSend(payload) {
  try {
    nativeConnect().postMessage(payload);
    return true;
  } catch (e) {
    pushStatus({ running: false, error: e.message });
    return false;
  }
}

// --- popup ile mesajlaşma --------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ytdlp') {
    if (msg.action === 'download') {
      ytRunning = true;
      keepAlive(true);
      pushStatus({ running: true, percent: 0, line: 'Başlatılıyor…', dir: '', error: null });

      // Klasörü çözmek ilk seferde sonda indirmesi gerektirebiliyor (mutlak yol
      // öğrenme), o yüzden asenkron: yanıtı beklemeden veriyoruz.
      ytOutdir().then((outdir) =>
        nativeSend({ action: 'download', url: msg.url, mode: msg.mode, outdir })
      );
      sendResponse({ ok: true });
      return true;
    }

    // İptal ancak indirmeyi başlatan bağlantı hâlâ ayaktaysa iş görür. Port
    // kopmuşsa nativeSend yeni bir host süreci açar, onun çalışan işi yoktur ve
    // düğme sessizce hiçbir şey yapmış gibi görünür — onun yerine durumu söyle.
    if (msg.action === 'cancel' && !nativePort) {
      ytRunning = false;
      syncKeepAlive();
      pushStatus({
        running: false,
        error: 'Bağlantı kopmuş olduğu için iptal edilemedi; indirme arka planda sürüyor olabilir.'
      });
      sendResponse({ ok: false });
      return true;
    }

    sendResponse({ ok: nativeSend({ action: msg.action, url: msg.url, mode: msg.mode }) });
    return true;
  }

  // Klasör seçimini köprü yapıyor: gerçek klasör penceresi açıyor ve
  // İndirilenler kısıtı olmadan her yeri seçebiliyor. Sonuç 'dir' mesajıyla
  // asenkron dönüyor.
  if (msg.type === 'pickFolder') {
    // Pencere dakikalarca açık kalabilir; worker ölürse host'un cevabı gidecek
    // yer bulamaz ve seçim sessizce kaybolurdu.
    dirPending = true;
    syncKeepAlive();
    folderPlan().then((p) => nativeSend({ action: 'pickdir', path: p.set ? p.abs : p.root }));
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'setFolder') {
    if (msg.path) {
      nativeSend({ action: 'checkdir', path: msg.path });   // köprü doğrulayıp kaydettirir
    } else {
      saveSettings({ folder: '' }).then(() =>
        chrome.runtime.sendMessage({ type: 'folder', path: '', error: '' }).catch(() => {})
      );
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'getYtStatus') {
    chrome.storage.session.get('ytStatus').then((r) => sendResponse(r.ytStatus || {}));
    return true;
  }

  if (msg.type === 'download') {
    enqueue(msg.items, msg.host)
      .then((n) => sendResponse({ ok: true, count: n }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async yanıt
  }

  if (msg.type === 'getFolderInfo') {
    (async () => {
      const plan = await folderPlan();   // ilk çağrıda sessiz sonda indirir
      const { folderMsg } = await chrome.storage.session.get('folderMsg');
      await chrome.storage.session.remove('folderMsg');   // bir kez gösterilir
      sendResponse({
        root: plan.root,
        abs: plan.abs,
        set: plan.set,
        outside: plan.outside,
        ytAbs: await ytOutdir(),
        stage: STAGE_DIR,
        folderMsg: folderMsg || ''
      });
    })().catch((e) => sendResponse({ root: '', abs: '', error: e.message }));
    return true;
  }

  if (msg.type === 'getProg') {
    getProg().then((prog) => {
      sendResponse(prog);
      // Kullanıcı sonucu popup'ta gördü; rozet artık iş bitmiş bir partiyi
      // (özellikle kırmızı hata sayısını) süresiz taşımasın.
      if (prog.done + prog.failed >= prog.total) chrome.action.setBadgeText({ text: '' });
    });
    return true;
  }

  if (msg.type === 'getNet') {
    const key = 'net:' + msg.tabId;
    chrome.storage.session.get(key).then((r) => sendResponse(r[key] || []));
    return true;
  }
});
