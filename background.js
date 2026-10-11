// ---------------------------------------------------------------------------
// Service worker: indirme kuyruğu + sağ tık menüleri + ağ trafiğinden medya
// yakalama. MV3'te bu worker boşta ~30 sn sonra ölür; bu yüzden kalıcı hiçbir
// şeyi RAM'de tutmuyoruz, kuyruk chrome.storage.session'da duruyor.
// ---------------------------------------------------------------------------

// Popup'la ortak çeviri tablosu. Worker'ın da kendi metinleri var (sağ tık
// menüsü, köprü hataları) ve bunlar popup'a hazır metin olarak gidiyor.
importScripts('i18n.js');
// Tarayıcı fonksiyonu: gezme worker'da çalıştığı için taramayı da o yapıyor.
// scanner.js tek bir fonksiyon bildirimi, yan etkisi yok.
importScripts('scanner.js');

const DEFAULTS = {
  maxConcurrent: 4,
  template: '{host}/{name}.{ext}',
  folder: '',      // TEK kayıt klasörü: mutlak yol. Boşsa İndirilenler.
  saveAs: false,   // her dosyada Kaydet penceresini aç
  lang: DEFAULT_LANG
};

// --- dil -------------------------------------------------------------------
// Worker boşta ölüp dirildiği için dil RAM'de kalıcı değil: her uyanışta
// storage'dan okunuyor. Metin üreten yerler bu sözü bekliyor, yoksa worker'ın
// ilk mesajı seçili dil yüklenmeden Türkçe çıkardı.

let langReady = (async () => {
  const { settings } = await chrome.storage.local.get('settings');
  setLang(settings?.lang || DEFAULT_LANG);
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = changes.settings.newValue?.lang || DEFAULT_LANG;
  if (next === getLang()) return;

  setLang(next);
  // Menü başlıkları ve araç çubuğu ipucu Chrome'da kayıtlı; dil değişince
  // kendiliğinden güncellenmezler.
  buildMenus();
  chrome.action.setTitle({ title: t('action.title') });
});

// Seçilen klasör İndirilenler dışındaysa Chrome oraya yazamaz; dosya önce
// İndirilenler'in altındaki bu ara klasöre iniyor, sonra köprü taşıyor.
const STAGE_DIR = 'pagetrawl-gecici';

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
function buildFilename(rawUrl, pageHost, template, kind, pageTitle = '') {
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

  // {title}: sayfa başlığı. Boş olabilir (erişilemeyen sayfa, başlıksız sekme);
  // o zaman host'a düşüyoruz, yoksa şablonda boş bir klasör adı oluşur ve
  // "//" temizliği yüzünden dosya beklenmedik bir yere iner.
  const title = sanitize(pageTitle) ;

  return template
    .replace(/{host}/g, sanitize(pageHost))
    .replace(/{title}/g, title && title !== 'dosya' ? title : sanitize(pageHost))
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

// --- indirme geçmişi -------------------------------------------------------
// "Bu dosya hangi sayfadan indi" sorusunun cevabı. Chrome'un kendi indirme
// listesi dosyayı ve kaynak URL'sini biliyor ama ONU BULDUĞUMUZ SAYFAYI
// bilmiyor: bir galeriden 40 fotoğraf indirdikten sonra "bunlar neredendi"
// sorusunun tarayıcıda cevabı yok. Kaydı biz tutuyoruz.
//
// storage.session değil `local`: geçmişin tarayıcı kapanınca silinmesi
// anlamsız olurdu. Kuyruk ve sayaç oturumluk çünkü onlar "şu an akan iş";
// geçmiş ise arşiv.

const HISTORY_MAX = 500;

async function getHistory() {
  const { history } = await chrome.storage.local.get('history');
  return Array.isArray(history) ? history : [];
}

// Geçmiş de iki yerden yazılıyor: _pump kaydı açarken, onChanged sonucu
// işaretlerken. progChain/moveChain ile aynı gerekçe — araya giren yazmalar
// kaybolmasın.
let histChain = Promise.resolve();
function updateHistory(mutate) {
  histChain = histChain
    .then(async () => {
      const history = await getHistory();
      const next = mutate(history);
      await chrome.storage.local.set({ history: (next || history).slice(0, HISTORY_MAX) });
    })
    .catch((e) => console.error('[history]', e));
  return histChain;
}

/** İndirme başlarken kaydı açar; sonucu sonra `markHistory` yazıyor. */
function addHistory(id, job) {
  return updateHistory((history) => {
    history.unshift({
      id,
      url: job.url,
      // Chrome'a verdiğimiz göreli ad. Ara klasöre inen dosyalarda gerçek yer
      // `move`; kullanıcıya onu gösteriyoruz.
      name: job.filename,
      move: job.move || '',
      kind: job.kind || '',
      page: job.page || null,
      at: Date.now(),
      state: 'running'
    });
    return history;
  });
}

function markHistory(id, state) {
  return updateHistory((history) => {
    const e = history.find((h) => h.id === id);
    if (e) e.state = state;
    return history;
  });
}

// --- indirilen dosyaları silme ---------------------------------------------
// Geçmişten seçilen kayıtların dosyalarını DİSKTEN siler. İki ayrı yol var,
// çünkü dosyanın nerede olduğuna göre silebilecek olan değişiyor:
//
//   İndirilenler altında  → chrome.downloads.removeFile (Chrome kendi kaydından)
//   köprüyle dışarı taşınmış → köprü (Chrome'un kaydı artık yanlış yeri gösteriyor)
//
// Bu, eklentinin geri alınamaz tek işlemi. Onayı popup alıyor; buraya gelen
// çağrı "kullanıcı emin" demektir.

let deleteWaiter = null;   // köprüden 'deleted' cevabını bekleyen çözücü

/**
 * Silmeyi köprüye yaptırır. Tek mesajda toplu gidiyor: dosya başına ayrı mesaj
 * atsak cevapları eşleştirmek için protokole istek kimliği eklemek gerekirdi.
 */
function bridgeDelete(paths, roots) {
  return new Promise((resolve) => {
    if (deleteWaiter) return resolve(null);   // aynı anda tek parti

    const finish = (r) => {
      clearTimeout(timer);
      deleteWaiter = null;
      syncKeepAlive();
      resolve(r);
    };
    // Cevap hiç gelmezse (köprü öldü, kilitli dosyada takıldı) sonsuza kadar
    // beklemiyoruz; kullanıcı "silindi mi silinmedi mi" bilmeden kalmasın.
    const timer = setTimeout(() => finish(null), 30000);

    deleteWaiter = finish;
    syncKeepAlive();
    if (!nativeSend({ action: 'delete', paths, roots })) finish(null);
  });
}

/** ids: geçmiş kayıtlarının indirme kimlikleri. -> {gone, failed[]} */
async function deleteFiles(ids) {
  const wanted = (await getHistory()).filter(
    (h) => ids.includes(h.id) && h.state !== 'deleted'
  );

  const gone = [];
  const failed = [];

  for (const h of wanted.filter((x) => !x.move)) {
    try {
      await chrome.downloads.removeFile(h.id);
      gone.push(h.id);
    } catch (e) {
      // Chrome dosya zaten yoksa da hata veriyor. Kullanıcı açısından sonuç
      // aynı — dosya gitmiş — o yüzden bunu başarı sayıyoruz.
      const msg = e?.message || '';
      if (/already deleted|does not exist|missing/i.test(msg)) gone.push(h.id);
      else failed.push({ id: h.id, code: 'oserr', error: msg });
    }
  }

  const staged = wanted.filter((x) => x.move);
  if (staged.length) {
    const res = await bridgeDelete(staged.map((h) => h.move), await bridgeRoots());

    if (!res) {
      for (const h of staged) failed.push({ id: h.id, code: 'nobridge' });
    } else {
      const ok = new Set(res.done || []);
      for (const h of staged) {
        if (ok.has(h.move)) {
          gone.push(h.id);
          continue;
        }
        const f = (res.failed || []).find((x) => x.path === h.move);
        failed.push({ id: h.id, code: f?.code || 'oserr', error: f?.error || '' });
      }
    }
  }

  // Kayıt silinmiyor, `deleted` işaretleniyor: "bu dosya şu sayfadan inmişti ve
  // sonra sildim" bilgisi kaydın kendisinden daha değerli.
  if (gone.length) {
    const g = new Set(gone);
    await updateHistory((history) => {
      for (const h of history) if (g.has(h.id)) h.state = 'deleted';
      return history;
    });
  }

  return { gone: gone.length, failed };
}

/** items: [{url, kind}] */
async function enqueue(items, pageHost, pageTitle = '', pageUrl = '') {
  const { template, saveAs } = await getSettings();
  const plan = await folderPlan();
  // Hedef İndirilenler dışındaysa Chrome oraya yazamaz: ara klasöre indirip
  // köprüye taşıtıyoruz. "Her dosyada sor" açıkken yeri kullanıcı seçtiği için
  // taşımaya karışmıyoruz.
  const staged = plan.outside && !saveAs;
  const prefix = staged ? STAGE_DIR + '/' : plan.rel ? plan.rel + '/' : '';

  // Sayfa bilgisi işle birlikte kuyruğa giriyor: indirme başladığında (belki
  // dakikalar sonra, belki worker ölüp dirildikten sonra) hangi sayfadan
  // geldiğini başka türlü bilemezdik.
  const page = { url: pageUrl || '', title: pageTitle || '', host: pageHost || '' };

  const jobs = items
    .filter((it) => it && it.url)
    .map((it) => {
      const kind = it.kind || guessKind(it.url);
      const rel = buildFilename(it.url, pageHost, template, kind, pageTitle);
      return {
        url: it.url,
        filename: prefix + rel,
        move: staged ? joinAbs(plan.abs, rel) : '',
        kind,
        page
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
      await addHistory(id, job);
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

  // Geçmişte yalnızca bizim açtığımız kayıtlar var; kullanıcının kendi
  // indirmesinin kimliği hiçbir kayda denk gelmiyor ve sessizce düşüyor.
  markHistory(delta.id, state === 'complete' ? 'done' : 'failed');

  // Ara klasöre inen dosyayı asıl yerine köprü taşıyor.
  if (state === 'complete') finishMove(delta.id);
  else takeMove(delta.id);

  pump();
});

// --- sağ tık menüleri ------------------------------------------------------

/** Menüleri sıfırdan kurar. Dil değişiminde de çağrılıyor. */
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'dl-src',
      title: t('menu.media'),
      contexts: ['image', 'video', 'audio']
    });
    chrome.contextMenus.create({
      id: 'dl-link',
      title: t('menu.link'),
      contexts: ['link']
    });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await langReady;
  buildMenus();
  chrome.action.setTitle({ title: t('action.title') });
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

  await enqueue(
    [{ url, kind: info.mediaType === 'video' ? 'video' : guessKind(url) }],
    host,
    tab?.title || '',
    tab?.url || ''
  );
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

    const manifest = /(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|audio\/mpegurl)/i.test(ct);
    const isVideo = manifest || ct.startsWith('video/') || VIDEO_EXT.test(d.url);
    const isImage = ct.startsWith('image/');
    if (!isVideo && !isImage) return;

    // 20 KB altındaki resimler neredeyse her zaman ikon/spacer/tracking pikseli.
    if (isImage && size && size < 20000) return;

    const list = netBuffer.get(d.tabId) || [];
    list.push({ url: d.url, kind: isVideo ? 'video' : 'image', size, net: true, manifest });
    netBuffer.set(d.tabId, list);
    scheduleFlush();
  },
  { urls: ['<all_urls>'], types: ['media', 'image', 'xmlhttprequest', 'other'] },
  ['responseHeaders']
);

async function clearNet(tabId) {
  netBuffer.delete(tabId);
  // Popup'ın seçim/indirildi hafızası da o sayfaya aitti; yeni sayfada geçersiz.
  await chrome.storage.session.remove([
    'net:' + tabId,
    'sel:' + tabId,
    'done:' + tabId,
    'swept:' + tabId
  ]);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;

  // Gezilen sekmede adres değişimi GEZİNME DEĞİL: slayt gösterileri her görsel
  // için pushState yapıyor. Burada silmek, gezmenin bulduğu her şeyi anında yok
  // ediyordu — üstelik `netBuffer` 600 ms'lik debounce'unu doldurmadan
  // silindiği için ağdan yakalananlar popup'a hiç ulaşmıyordu. Kullanıcının
  // gördüğü belirti buydu: sağa gezerken liste boş kalıyor, ama popup'ı kapatıp
  // açınca aradakiler "ağ" etiketiyle beliriyordu.
  const s = await getSweep();
  if (s && s.running && s.tabId === tabId) return;

  clearNet(tabId);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Sekme kapandıysa gezecek bir şey de kalmadı.
  const s = await getSweep();
  if (s && s.tabId === tabId) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
    await setSweep(null);
  }
  clearNet(tabId);
});

// --- İndirilenler klasörünün yeri ------------------------------------------
// Mutlak yolu veren bir API yok, ama iki şey için lazım: ayarda gerçek yolu
// göstermek ve seçilen klasörün İndirilenler altında olup olmadığına karar
// vermek. Küçük bir sonda dosyası bir kez sessizce indirilip yolu okunuyor.

const PROBE_NAME = 'pagetrawl-klasor-secimi.txt';

// Sonda dosyasının kaynağı. `chrome-extension://` URL'si NETWORK_FAILED veriyor
// (Chrome kendi eklenti kaynaklarını downloads API'siyle indirtmiyor), o yüzden
// birinci tercih data: URL. Bir Chrome sürümü onu da kısıtlarsa web erişimine
// açık probe.txt'ye düşüyoruz.
const PROBE_URLS = [
  'data:text/plain;charset=utf-8,pagetrawl%20klasor%20sondasi',
  chrome.runtime.getURL('probe.txt')
];

const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
const norm = (p) => {
  const clean = p.replace(/\\/g, '/').replace(/\/+$/, '');
  // POSIX volumes can be case-sensitive; never fold distinct Mac paths.
  return /^[a-z]:/i.test(clean) || clean.startsWith('//') ? clean.toLowerCase() : clean;
};

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
 * Köprüye izin verdiğimiz sınır: kayıt klasörü ve İndirilenler. Host silme ve
 * taşımada bunun dışındaki hiçbir yola dokunmuyor.
 */
async function bridgeRoots() {
  const plan = await folderPlan();
  return [plan.abs, plan.root].filter(Boolean);
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

/**
 * Ayar panelinde gösterilecek not; popup kapalıysa bir dahaki açılışta çıkar.
 * Anahtarla çağrılıyor (metinle değil) ki dil worker'da çözülsün.
 */
async function noteFolder(key, vars = {}, bad = false, extra = '') {
  await langReady;
  // extra: teşhis için ham hata metni (çevrilmez, parantez içinde eklenir).
  const text = t(key, vars) + (extra ? ' (' + extra + ')' : '');
  await chrome.storage.session.set({ folderMsg: text });
  chrome.runtime.sendMessage({ type: 'folder', note: text, bad }).catch(() => {});
}

/**
 * Köprüden gelen hata metni. Host artık `errKey` gönderiyor; eski bir host
 * sürümü hâlâ ham `error` yolluyorsa o kullanılıyor.
 */
function hostText(m) {
  return m?.errKey ? t(m.errKey, m.errVars || {}) : m?.error || '';
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
  const roots = await bridgeRoots();
  movesInFlight++;
  syncKeepAlive();   // taşıma sürerken worker ölmesin
  const ok = nativeSend({
    action: 'move',
    from: item.filename,
    to,
    roots,
    prune: root ? joinAbs(root, STAGE_DIR) : ''   // boşalan ara klasörü sil
  });
  if (!ok) {
    movesInFlight--;
    syncKeepAlive();
    await noteFolder('wk.moveNoBridge', { stage: STAGE_DIR }, true);
  }
}

// --- yt-dlp köprüsü (native messaging) -------------------------------------
// Akış siteleri (YouTube, Instagram reels…) videoyu tek dosya olarak vermez;
// parçalı DASH/HLS akışı + şifreli imza kullanırlar. Bunu eklentide çözmeye
// çalışmak yt-dlp'yi yeniden yazmak olurdu, üstelik siteler her değiştiğinde
// kırılırdı. Bunun yerine yerel yt-dlp'yi çağırıyoruz.

const NATIVE_HOST = 'com.bozgu.ytdlp';
const YTDLP_PASSTHROUGH = ['probe', 'cancel'];   // popup'ın host'a doğrudan iletebildikleri
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
  keepAlive(ytRunning || dirPending || movesInFlight > 0 || !!deleteWaiter || sweepRunning);
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
  await langReady;
  const { ytStatus } = await chrome.storage.session.get('ytStatus');
  const next = { ...(ytStatus || {}), ...patch, at: Date.now() };
  await chrome.storage.session.set({ ytStatus: next });
  chrome.runtime.sendMessage({ type: 'ytStatus', status: next }).catch(() => {});
}

// --- yt-dlp kuyruğu --------------------------------------------------------
// Köprü aynı anda TEK indirme yapıyor (host'ta `_current` tek bir süreç). Bir
// sayfada beş ayrı DASH akışı olabildiği için sıralamayı eklenti tarafında
// yapıyoruz: biri bitince sıradaki gönderiliyor.
//
// Kuyruk `storage.session`'da, indirme kuyruğuyla aynı gerekçe: worker arada
// ölebilir ve RAM'deki liste kaybolurdu.

async function getYtQueue() {
  const { ytQueue } = await chrome.storage.session.get('ytQueue');
  return Array.isArray(ytQueue) ? ytQueue : [];
}

/** Tek bir indirmeyi başlatır. `left`: bu işten SONRA kuyrukta kalan sayı. */
function ytStart(job, left = 0) {
  ytRunning = true;
  keepAlive(true);
  langReady.then(() =>
    pushStatus({
      running: true,
      engine: 'native',
      phase: '',
      percent: 0,
      line: t('yt.starting'),
      dir: '',
      error: null,
      left
    })
  );

  // Klasörü çözmek ilk seferde sonda indirmesi gerektirebiliyor (mutlak yol
  // öğrenme), o yüzden asenkron: yanıtı beklemeden veriyoruz.
  ytOutdir().then((outdir) =>
    nativeSend({
      action: 'download',
      url: job.url,
      mode: job.mode,
      referer: job.referer || '',
      outdir
    })
  );
}

async function ytEnqueue(urls, mode, referer) {
  const jobs = urls.filter(Boolean).map((url) => ({ url, mode, referer }));
  if (!jobs.length) return 0;

  const q = (await getYtQueue()).concat(jobs);
  await chrome.storage.session.set({ ytQueue: q });

  // Boştaysak hemen başlıyoruz; değilse sıradaki `done` mesajında alınacak.
  if (!ytRunning) await ytNext();
  else await pushStatus({ left: q.length });
  return jobs.length;
}

/** Kuyruktan sıradakini alıp başlatır; kuyruk boşsa hiçbir şey yapmaz. */
async function ytNext() {
  const q = await getYtQueue();
  const job = q.shift();
  await chrome.storage.session.set({ ytQueue: q });
  if (!job) return false;
  ytStart(job, q.length);
  return true;
}

/** İptal kuyruğu da boşaltıyor: yoksa sıradaki hemen başlar ve şaşırtır. */
async function ytClearQueue() {
  await chrome.storage.session.remove('ytQueue');
}

function nativeConnect() {
  if (nativePort) return nativePort;

  nativePort = chrome.runtime.connectNative(NATIVE_HOST);

  // Dil yüklenmeden t() çağrılırsa metin Türkçe çıkar; mesajları o yüzden
  // langReady'den sonra işliyoruz.
  nativePort.onMessage.addListener(async (m) => {
    await langReady;

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
          await langReady;
          await chrome.storage.session.set({
            folderMsg: hostText(m) || t('wk.folderUpdated')
          });
        }
        chrome.runtime
          .sendMessage({
            type: 'folder',
            path: m.path || '',
            error: hostText(m),
            canceled: !m.path && !m.error && !m.errKey
          })
          .catch(() => {});
      })();
    } else if (m.type === 'moved') {
      movesInFlight = Math.max(0, movesInFlight - 1);
      syncKeepAlive();
      // Taşıma başarısızsa dosya ara klasörde kaldı — sessizce yutmuyoruz.
      if (!m.ok) noteFolder('wk.moveFailed', { err: hostText(m) || '?' }, true);
    } else if (m.type === 'deleted') {
      // Bekleyen yoksa bu geç kalmış bir cevap (zaman aşımından sonra geldi);
      // sessizce düşüyor, çünkü sonucu soracak kimse kalmadı.
      if (deleteWaiter) deleteWaiter(m);
    } else if (m.type === 'progress') {
      pushStatus({ running: true, percent: m.percent, line: m.line, error: null });
    } else if (m.type === 'log') {
      pushStatus({ running: true, line: m.lineKey ? t(m.lineKey, m.lineVars || {}) : m.line });
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
          line: hostText(m) || t('wk.dlCanceled'),
          error: null
        });
      } else {
        pushStatus({
          running: false,
          percent: undefined,
          line: '',
          dir: m.outdir || '',
          error: hostText(m) || t('wk.dlFailed', { code: m.code })
        });
      }

      // Kuyrukta bekleyen varsa sıradakine geç. İptalde geçmiyoruz: kullanıcı
      // "dur" dedi, beşincisini başlatmak onu şaşırtırdı — `ytClearQueue`
      // kuyruğu zaten boşaltmış oluyor.
      if (!m.canceled) ytNext();
    }
  });

  nativePort.onDisconnect.addListener(async () => {
    // lastError'ı hemen oku: await'ten sonra kaybolur.
    const err = chrome.runtime.lastError?.message || '';
    const wasRunning = ytRunning;
    const lostMoves = movesInFlight;

    nativePort = null;
    ytRunning = false;
    dirPending = false;
    movesInFlight = 0;
    // Bekleyen silme partisi varsa 30 sn'lik zaman aşımını beklemeden serbest
    // bırakıyoruz: cevap gelecek bir yer kalmadı, popup boşuna donmasın.
    if (deleteWaiter) deleteWaiter(null);
    keepAlive(false);

    await langReady;

    // Cevabı gelmeyen taşımalar: dosyalar ara klasörde kaldı, söyle.
    if (lostMoves) {
      noteFolder('wk.movesLost', { n: lostMoves, stage: STAGE_DIR }, true, err);
    }

    if (streamState.active) return;
    if (err && !wasRunning) {
      pushStatus({
        running: false,
        error: t('wk.bridgeMissing', { id: chrome.runtime.id }) + ' (' + err + ')'
      });
    } else if (wasRunning) {
      // Eskiden burası sessizce geçiliyordu; bar sonsuza kadar "çalışıyor"
      // durumunda kalıyordu. Kopuş normal (hatasız) da olsa haber ver.
      pushStatus({
        running: false,
        error: t('wk.bridgeLost') + (err ? ' (' + err + ')' : '')
      });
    }
  });

  return nativePort;
}

function nativeSend(payload) {
  try {
    // Host kendi metinlerini (klasör penceresi başlığı) seçili dilde üretsin.
    nativeConnect().postMessage({ ...payload, lang: getLang() });
    return true;
  } catch (e) {
    pushStatus({ running: false, error: e.message });
    return false;
  }
}

// --- sayfayı gez -----------------------------------------------------------
// Gezme SERVICE WORKER'da çalışıyor. v1.20'ye kadar döngü popup'taydı ve
// popup kapanınca gezme de biterdi; oysa sonsuz bir galeriyi gezmek dakikalar
// sürüyor ve kullanıcının o süre boyunca popup'ı açık tutması saçmaydı.
//
// Worker MV3'te boşta ölüyor, o yüzden gezme sürerken keepAlive açık —
// yt-dlp indirmesi ve klasör penceresiyle aynı mekanizma.
//
// Tarama da burada: popup kapalıyken kimse taramıyor olsaydı gezme boşuna
// kaydırırdı. Bulunanlar `swept:<tabId>` altında birikiyor, popup açıksa
// anında haber veriliyor.

function sweepStep(cmd) {
  // Sağa ok tuşuna basılmış gibi yapar. Kaydırmayla ilgisi olmadığı için
  // kap seçmeden, en başta dönüyor.
  if (cmd.mode === 'key') {
    // Odaktaki öğeye gönderiyoruz: lightbox'lar ve slayt gösterileri açılınca
    // odağı kendi kabına alıyor ve dinleyiciyi oraya kuruyor. Odak yoksa
    // body'den gönderilen olay zaten document ve window'a kadar kabarıyor.
    const el =
      document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : document.body;
    if (!el) return { blocked: true };

    const init = {
      key: 'ArrowRight',
      code: 'ArrowRight',
      keyCode: 39,
      which: 39,
      bubbles: true,
      cancelable: true,
      composed: true,   // shadow DOM'daki galerilere de ulaşsın
      view: window
    };

    for (const type of ['keydown', 'keyup']) {
      const ev = new KeyboardEvent(type, init);
      // keyCode/which standart KeyboardEventInit'te yok; Chrome kabul ediyor
      // ama garanti değil. Eski siteler hâlâ e.keyCode'a baktığı için
      // tutmadıysa elle tanımlıyoruz.
      if (ev.keyCode !== 39) {
        Object.defineProperty(ev, 'keyCode', { get: () => 39 });
        Object.defineProperty(ev, 'which', { get: () => 39 });
      }
      el.dispatchEvent(ev);
    }
    return { pressed: true };
  }

  const doc = document.scrollingElement || document.documentElement;

  // Çoğu sayfa pencereyi kaydırıyor ama bazı galeriler kendi kabını kaydırıyor;
  // o zaman window.scrollBy hiçbir şey yapmaz ve gezme ilk adımda "bitti" sanır.
  const pick = () => {
    if (doc && doc.scrollHeight > doc.clientHeight + 40) return doc;
    let best = null;
    let bestGain = 0;
    for (const el of document.querySelectorAll('div, main, section, ul, ol')) {
      const gain = el.scrollHeight - el.clientHeight;
      if (gain <= 40 || el.clientHeight < 200) continue;
      const ov = getComputedStyle(el).overflowY;
      if (ov !== 'auto' && ov !== 'scroll') continue;
      if (gain > bestGain) {
        best = el;
        bestGain = gain;
      }
    }
    return best || doc;
  };

  const el = pick();
  if (!el) return { blocked: true };

  const state = () => ({
    y: el.scrollTop,
    height: el.scrollHeight,
    atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 4
  });

  if (cmd.mode === 'probe') return state();

  if (cmd.mode === 'restore') {
    // `scrollTo` + 'instant': sayfanın CSS'inde `scroll-behavior: smooth`
    // varsa düz atama animasyona girer ve konum okuması yanlış çıkar.
    el.scrollTo({ top: cmd.to, behavior: 'instant' });
    return state();
  }

  const before = el.scrollTop;
  // Tam ekran boyu yerine biraz azı: lazy yükleyicilerin eşiği ekranın hemen
  // altında, örtüşme olmazsa aradaki görseller hiç tetiklenmeden geçilebiliyor.
  el.scrollTo({ top: before + Math.max(200, el.clientHeight * 0.85), behavior: 'instant' });

  const s = state();
  s.moved = s.y > before;
  return s;
}

const SWEEP_MS = 700;
const SWEEP_IDLE = 5;
const SWEEP_IDLE_RIGHT = 7;
const SWEEP_MAX = 400;
const SWEPT_CAP = 3000;

let sweepTimer = null;
let sweepRunning = false;   // keepAlive için RAM'deki ayna

async function getSweep() {
  const { sweep } = await chrome.storage.session.get('sweep');
  return sweep || null;
}

async function setSweep(s) {
  if (s) await chrome.storage.session.set({ sweep: s });
  else await chrome.storage.session.remove('sweep');
  sweepRunning = !!(s && s.running);
  syncKeepAlive();
  chrome.runtime.sendMessage({ type: 'sweepStatus', sweep: s || null }).catch(() => {});
}

/** Sayfaya enjekte edilen tarayıcıyı bir kez çalıştırır. */
async function scanTab(tabId, full) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: collectMedia,
    args: [full]
  });

  const items = [];
  for (const f of frames) {
    const r = f.result;
    if (!r || r.unchanged) continue;
    items.push(...(r.items || []));
  }
  return items;
}

/**
 * Gezme sırasında bulunanlar burada birikiyor. Popup kapalıyken bunları
 * tutacak başka bir yer yok: popup'ın `byUrl` havuzu onunla birlikte yok
 * oluyor, sayfanın DOM'u ise yalnızca O ANKİ slaydı gösteriyor.
 */
async function addSwept(tabId, items) {
  if (!items.length) return;
  const key = 'swept:' + tabId;
  const stored = (await chrome.storage.session.get(key))[key] || [];
  const seen = new Set(stored.map((i) => i.url));

  const added = [];
  for (const it of items) {
    if (!it || !it.url || seen.has(it.url)) continue;
    seen.add(it.url);
    stored.push(it);
    added.push(it);
  }
  if (!added.length) return;

  await chrome.storage.session.set({ [key]: stored.slice(-SWEPT_CAP) });
  // Popup açıksa anında görsün. Kapalıysa alıcı yok, hatayı yutuyoruz —
  // açılışta zaten depodan çekiyor.
  chrome.runtime.sendMessage({ type: 'sweptAdded', tabId, items: added }).catch(() => {});
}

async function sweepStart(tabId, mode) {
  const cur = await getSweep();
  if (cur && cur.running) return { ok: false };

  let probe = null;
  try {
    [{ result: probe }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: sweepStep,
      args: [{ mode: 'probe' }]
    });
  } catch {
    probe = null;
  }
  if (!probe || probe.blocked) {
    await setSweep({ running: false, tabId, mode, reason: 'sweep.blocked', found: 0 });
    return { ok: false };
  }

  // Gezmeye başlarken sayfada zaten duran medyayı da alalım; yoksa ilk slayt
  // yalnızca popup açıksa listeye girerdi.
  const base = (await chrome.storage.session.get('swept:' + tabId))['swept:' + tabId] || [];
  try {
    await addSwept(tabId, await scanTab(tabId, true));
  } catch {
    // Tarama başarısızsa gezmeyi yine de başlatıyoruz; adımlar deneyecek.
  }

  await setSweep({
    running: true,
    tabId,
    mode,
    steps: 0,
    idle: 0,
    home: probe.y || 0,
    height: probe.height || 0,
    base: base.length,
    found: 0,
    reason: '',
    at: Date.now()
  });

  sweepTimer = setTimeout(sweepTick, SWEEP_MS);
  return { ok: true };
}

async function sweepStop(reason, restore = true) {
  const s = await getSweep();
  clearTimeout(sweepTimer);
  sweepTimer = null;
  if (!s || !s.running) return;

  // Kullanıcıyı bıraktığı yere geri koy. Sağa gezmede yok: sayfayı biz
  // kaydırmadık, tuşa bastık — aynı sayıda sola basmak sayfanın o tuşa ne
  // yaptığını bildiğimizi varsaymak olurdu.
  // `restore=false`: sekme başka bir SİTEYE geçti. Eski konuma koymaya
  // çalışmak, artık bambaşka olan bir sayfayı rastgele kaydırmak demek.
  if (s.mode === 'down' && restore) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: s.tabId },
        func: sweepStep,
        args: [{ mode: 'restore', to: s.home }]
      });
    } catch {
      // Sekme kapandı ya da başka sayfaya gitti — geri koyacak yer yok.
    }
  }

  await setSweep({ ...s, running: false, reason: reason || 'sweep.stopped', at: Date.now() });
}

async function sweepTick() {
  const s = await getSweep();
  if (!s || !s.running) return;

  const right = s.mode === 'right';

  if (++s.steps > SWEEP_MAX) return sweepStop('sweep.limit');

  let r;
  try {
    [{ result: r }] = await chrome.scripting.executeScript({
      target: { tabId: s.tabId },
      func: sweepStep,
      args: [{ mode: right ? 'key' : 'step' }]
    });
  } catch {
    return sweepStop('sweep.blocked');   // sekme kapandı ya da gezindi
  }
  if (!r || r.blocked) return sweepStop('sweep.blocked');

  // Adım yeni içerik yüklettiyse görelim. Sağa gezmede tam tarama şart:
  // slayt değişince MutationObserver'ın kirli bayrağını popup'ın taraması da
  // temizlemiş olabiliyor ve `unchanged` dönerdi.
  let items = [];
  try {
    items = await scanTab(s.tabId, right);
  } catch {
    return sweepStop('sweep.blocked');
  }
  await addSwept(s.tabId, items);

  const key = 'swept:' + s.tabId;
  const total = ((await chrome.storage.session.get(key))[key] || []).length;
  const found = Math.max(0, total - s.base);

  let stuck;
  if (right) {
    // Sağa gezmede elimizdeki TEK gösterge bu: tuşa bastık, yeni bir şey
    // geldi mi? Slayt gösterisinin "sonu" diye bir kavram yok.
    stuck = found === s.found;
  } else {
    const ended = r.atBottom && r.height <= s.height && found === s.found;
    // Dipte değiliz ama kaydırma da tutmuyor: yanlış kap ya da kilitli sayfa.
    const stalled = !r.moved && !r.atBottom;
    stuck = ended || stalled;
    s.height = Math.max(s.height || 0, r.height || 0);
  }

  s.idle = stuck ? (s.idle || 0) + 1 : 0;
  s.found = found;
  s.at = Date.now();

  if (s.idle >= (right ? SWEEP_IDLE_RIGHT : SWEEP_IDLE)) {
    await setSweep(s);
    return sweepStop(right ? 'sweep.rightEnd' : 'sweep.end');
  }

  await setSweep(s);
  sweepTimer = setTimeout(sweepTick, SWEEP_MS);
}

// Worker gezme sırasında ölürse `sweep.running` sonsuza kadar true kalır ve
// düğme bir daha açılmaz. yt-dlp durumundaki 90 saniyelik eskime kontrolünün
// aynısı: zamanı geçmiş bir "çalışıyor" kaydı çalışmıyor sayılıyor.
const SWEEP_STALE_MS = 15000;

async function sweepAlive() {
  const s = await getSweep();
  if (!s || !s.running) return s;
  if (Date.now() - (s.at || 0) < SWEEP_STALE_MS) return s;

  const dead = { ...s, running: false, reason: 'sweep.stopped' };
  await setSweep(dead);
  return dead;
}

// --- popup ile mesajlaşma --------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ytdlp') {
    if (['download', 'queue'].includes(msg.action)) {
      streamReady.then(() => streamSerial(async () => {
        if (streamState.active || streamState.queue.length) return { ok: false, error: t('stream.browserBusy') };
        const urls = msg.action === 'queue' ? (msg.urls || []) : [msg.url];
        const count = await ytEnqueue(urls, msg.mode, msg.referer || '');
        return { ok: true, count };
      })).then(sendResponse, e => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    // İptal ancak indirmeyi başlatan bağlantı hâlâ ayaktaysa iş görür. Port
    // kopmuşsa nativeSend yeni bir host süreci açar, onun çalışan işi yoktur ve
    // düğme sessizce hiçbir şey yapmış gibi görünür — onun yerine durumu söyle.
    if (msg.action === 'cancel') {
      // Kuyruğu da boşaltıyoruz: "iptal" bu indirmeyi değil, işi durdurmak
      // demek. Yoksa sıradaki hemen başlar ve kullanıcı durduramadığını sanır.
      ytClearQueue();

      if (!nativePort) {
        ytRunning = false;
        syncKeepAlive();
        langReady.then(() => pushStatus({ running: false, left: 0, error: t('wk.cancelNoPort') }));
        sendResponse({ ok: false });
        return true;
      }
      pushStatus({ left: 0 });
    }

    // Buradan host'a yalnızca zararsız eylemler geçer. delete/move/download'ın
    // kendi fonksiyonları var; popup'tan gelen ham bir mesaj onları tetiklemesin.
    if (!YTDLP_PASSTHROUGH.includes(msg.action)) {
      sendResponse({ ok: false });
      return true;
    }
    sendResponse({ ok: nativeSend({ action: msg.action }) });
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
    enqueue(msg.items, msg.host, msg.title, msg.pageUrl)
      .then((n) => sendResponse({ ok: true, count: n }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async yanıt
  }

  if (msg.type === 'getHistory') {
    getHistory().then(sendResponse);
    return true;
  }

  if (msg.type === 'deleteFiles') {
    deleteFiles(msg.ids || [])
      .then(sendResponse)
      .catch((e) => sendResponse({ gone: 0, failed: [], error: e.message }));
    return true;
  }

  if (msg.type === 'clearHistory') {
    // Zincirden geçiyor: o sırada akan bir indirme kaydı araya yazıp
    // temizlenmiş listeyi diriltmesin.
    updateHistory(() => []).then(() => sendResponse({ ok: true }));
    return true;
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
    // Gezmenin bulduklarını da aynı yerden veriyoruz: popup açısından ikisi de
    // "ben açık değilken birikmiş medya".
    (async () => {
      const keys = ['net:' + msg.tabId, 'swept:' + msg.tabId];
      const r = await chrome.storage.session.get(keys);
      sendResponse([...(r[keys[0]] || []), ...(r[keys[1]] || [])]);
    })();
    return true;
  }

  if (msg.type === 'sweep') {
    (async () => {
      if (msg.action === 'start') sendResponse(await sweepStart(msg.tabId, msg.mode));
      else if (msg.action === 'stop') {
        await sweepStop('sweep.stopped', msg.restore !== false);
        sendResponse({ ok: true });
      } else {
        sendResponse(await sweepAlive());   // 'status'
      }
    })();
    return true;
  }
});

// Browser-only HLS/DASH engine; owns a separate serialized queue.
importScripts('stream/background.js');
