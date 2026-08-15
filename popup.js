// ---------------------------------------------------------------------------
// Popup: sayfayı tarat, sonuçları ızgarada göster, seçilenleri service
// worker'daki kuyruğa yolla.
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

// Yan panelde miyiz?
//
// Chrome'un açılır penceresi başka yere tıklandığı anda kapanıyor ve bunu
// engelleyen bir API yok. Yan panel bu kurala tabi değil: tarayıcıya kenetli
// duruyor, sayfayla çalışırken açık kalıyor, kullanıcı kapatana kadar gitmiyor.
//
// Aynı `popup.html` iki kapta birden çalışıyor; fark yalnızca hedef sekmenin
// nasıl bulunduğu ve yerleşim.
const IN_PANEL = new URLSearchParams(location.search).has('panel');
document.documentElement.classList.toggle('panel', IN_PANEL);

const grid = $('#grid');
const notice = $('#notice');

let all = [];                    // taranan tüm medya
let selected = new Set();        // seçili URL'ler
let done = new Set();            // bu oturumda kuyruğa alınmış URL'ler
let kindFilter = 'all';
let tab = null;

// Popup her kapanışta tamamen yok olur. Seçimi ve "indirdim" işaretini sekme
// bazında session storage'da tutuyoruz ki tekrar açınca kaldığın yerden devam et.
const keySel = () => 'sel:' + tab.id;
const keyDone = () => 'done:' + tab.id;

/** settings nesnesine kısmi yazma — diğer anahtarları ezmeden. */
async function saveSetting(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...(settings || {}), ...patch } });
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.session.set({
      [keySel()]: [...selected],
      [keyDone()]: [...done]
    });
  }, 150);
}

// --- yardımcılar -----------------------------------------------------------

const area = (m) => (m.w || 0) * (m.h || 0);

function shortName(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
  } catch {
    return url.slice(0, 40);
  }
}

function humanSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function ext(url) {
  const m = url.match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i);
  return m ? m[1].toLowerCase() : '';
}

// --- kalite varyantları ----------------------------------------------------
// Aynı video sitelerde çoğu zaman birkaç ayrı URL: .../video_360p.mp4,
// .../video_720p.mp4… Izgarada üç ayrı kart oluyor ve liste şişiyordu.
// URL'den kalite damgasını çıkarınca geriye kalan aynıysa aynı videodur:
// en iyi kaliteyi kart yapıp diğerlerini onun altına topluyoruz.

/** Kelimeyle yazılmış kaliteler -> yaklaşık yükseklik (sıralama için). */
const QWORD = { '4k': 2160, uhd: 2160, fhd: 1080, hd: 720, hq: 720, sd: 480, mq: 480, lq: 360 };

// "1080" gibi çıplak sayıyı yalnızca gerçekten bir video yüksekliğiyse kalite
// sayıyoruz; yoksa "clip-2024.mp4" ile "clip-2019.mp4" aynı video sanılırdı.
const HEIGHTS = /^(144|240|360|480|540|576|720|1080|1440|2160|4320)$/;

const Q_PARAM = /^(quality|res|resolution|vq|bitrate|br|itag|height|size)$/i;

// İmza / son kullanma parametreleri: dosyayı DEĞİL, erişim iznini tarif
// ediyorlar. CDN aynı videoyu her istekte yeni bir imzayla verdiği için bunlar
// kimliğin parçası sayılırsa tek video birden çok kez listeye giriyor.
//
// Liste bilerek dar: burada yanlış yapmak iki AYRI videoyu aynı sanmak demek ve
// biri listeden kaybolur — fazladan bir karttan daha kötü. Bu yüzden yalnızca
// adı açıkça imza/süre bildiren parametreler ve iyi bilinen CDN önekleri var;
// `t`, `e`, `id` gibi kısa ve çift anlamlı olanlar KASTEN dışarıda.
const SIG_PARAM =
  /^(?:x-amz-|_nc_|__)|^(?:token|signature|sig|sign|hmac|policy|key-pair-id|expires|expire|expiry|exp|ttl|nonce|auth|authkey|access_key|verify|validfrom|validto|cachebust|cb|rnd)$/i;

/** Adresin imzasız kimliği: yalnızca token'ı değişen iki adres aynı dosyadır. */
function bareKey(url) {
  try {
    const u = new URL(url);
    const rest = [];
    for (const [k, v] of u.searchParams) if (!SIG_PARAM.test(k)) rest.push(k + '=' + v);
    return u.host + u.pathname + '?' + rest.sort().join('&');
  } catch {
    return url;
  }
}

/**
 * URL'nin kalite damgası çıkarılmış hâli. -> {key, tag} | null
 * `key` aynı olan iki video aynı videodur; `tag` kartta gösterilen kalite.
 */
function variantKey(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  let tag = '';
  const path = u.pathname
    // _720p. / /1080P/ / -480p
    .replace(/([_\-./])(\d{3,4})p(?=[_\-./]|$)/i, (s, sep, n) => ((tag = n + 'p'), sep))
    // 1920x1080
    .replace(/([_\-./])\d{3,4}x(\d{3,4})(?=[_\-./]|$)/i, (s, sep, h) => ((tag = tag || h + 'p'), sep))
    // _hd / -sd / /uhd/
    .replace(/([_\-./])(4k|uhd|fhd|hd|hq|sd|mq|lq)(?=[_\-./]|$)/i,
      (s, sep, w) => ((tag = tag || w.toLowerCase()), sep))
    // video-720.mp4
    .replace(/([_\-.])(\d{3,4})(?=\.[a-z0-9]{2,4}$)/i,
      (s, sep, n) => (HEIGHTS.test(n) ? ((tag = tag || n + 'p'), sep) : s));

  // Kalan sorgu parametreleri anahtarın parçası; kalite belirtenler ayıklanıyor.
  // İmza parametreleri de düşüyor: aynı videonun iki farklı token'lı adresi
  // yoksa iki ayrı kart olurdu.
  const rest = [];
  for (const [k, v] of u.searchParams) {
    if (Q_PARAM.test(k)) {
      if (!tag && /^\d{3,4}$/.test(v) && HEIGHTS.test(v)) tag = v + 'p';
      continue;
    }
    if (SIG_PARAM.test(k)) continue;
    rest.push(k + '=' + v);
  }

  // Damga çıkınca geriye anlamlı bir ad kalmıyorsa (".../720p/1.mp4" gibi)
  // gruplamak riskli: farklı videoları aynı sanabiliriz.
  if (path.replace(/[^a-z0-9]/gi, '').length < 3) return null;

  return { key: u.host + path + '?' + rest.sort().join('&'), tag };
}

/** Sıralama için kaba kalite puanı: gerçek yükseklik > damga > 0. */
function qRank(m) {
  if (m.h) return m.h;
  const t = m._qtag || '';
  return parseInt(t, 10) || QWORD[t] || 0;
}

/** Varyant satırında görünen etiket. */
function qLabel(m) {
  if (m.w && m.h) return `${m.w}×${m.h}`;
  if (m._qtag) return /^\d/.test(m._qtag) ? m._qtag : m._qtag.toUpperCase();
  return ext(m.url) || shortName(m.url);
}

/**
 * Bir medyanın hangi karta ait olduğu. İki kaynak var:
 *
 * 1. `grp` — tarayıcı aynı `<video>` etiketinin altındaki kaynakları böyle
 *    işaretliyor. Bu **kesin** bilgi: DOM aynı video olduklarını söylüyor,
 *    URL'de kalite damgası olup olmaması hiç önemli değil. İmzalı/hash'li CDN
 *    adreslerinde (`…/a3f9c1.mp4?token=…`) elimizdeki tek dayanak bu.
 * 2. `variantKey` — damgayı URL'den çıkarma tahmini. Damga yoksa `null`.
 */
function groupKey(m) {
  if (m.grp) return { key: 'grp:' + m.grp, tag: variantKey(m.url)?.tag || '', sure: true };
  const k = variantKey(m.url);
  return k && { key: k.key, tag: k.tag, sure: false };
}

// Anahtar -> grup. Canlı gelen bir varyant yeni kart açmak yerine mevcut
// kartın altına düşsün diye çizimler arasında saklanıyor.
let groupIndex = new Map();

/** Gruptaki en iyi kaliteyi karta çıkarır, kalanı `_vars` olarak altına asılır. */
function settle(g) {
  g.items.sort((a, b) => qRank(b) - qRank(a) || (b.size || 0) - (a.size || 0));
  for (const m of g.items) m._vars = null;
  g.primary = g.items[0];
  // `sure`: grup aynı <video> etiketinden geliyor, yani aynı video olduğu
  // KESİN — damga aramaya gerek yok. Değilse eski kural sürüyor: hiçbirinde
  // kalite damgası yoksa bunlar varyant değil, adaş dosyalardır.
  g.primary._vars =
    g.items.length > 1 && (g.sure || g.items.some((m) => m._qtag)) ? g.items : null;
  return g.primary;
}

/** Listeyi kartlara indirger: varyantlar tek kartta toplanır. */
function groupVariants(list) {
  groupIndex = new Map();
  const slots = [];

  for (const m of list) {
    m._vars = null;
    m._qtag = '';
    const k = m.kind === 'video' ? groupKey(m) : null;
    if (!k) {
      slots.push(m);
      continue;
    }
    m._qtag = k.tag;

    const g = groupIndex.get(k.key);
    if (g) {
      g.items.push(m);
      if (k.sure) g.sure = true;
    } else {
      const ng = { items: [m], primary: m, sure: !!k.sure };
      groupIndex.set(k.key, ng);
      slots.push(ng);   // kartın yeri: gruptan İLK göreni belirliyor
    }
  }

  return slots.map((s) => (s.items ? settle(s) : s));
}

// --- tarama ----------------------------------------------------------------

// URL -> medya. Havuzu popup açık kaldığı sürece büyütüyoruz; `all` bunun
// gösterim sırasına dizilmiş hâli (ilk tarama boyuta göre sıralı, sonradan
// gelenler sona ekleniyor ki liste gözünün önünde yerinden oynamasın).
const byUrl = new Map();
let blobSeen = 0;

// Parçalı akış (DASH/HLS) işaretleri. Böyle bir sayfada listede görünen
// dosyalar TEK BAŞINA işe yaramıyor: `.mpd`/`.m3u8` sadece bir liste dosyası,
// yanlarındaki mp4'ler de ayrı GÖRÜNTÜ ve SES parçaları. Bunları "aynı videonun
// kaliteleri" diye tek kartta toplamak yanlış olurdu — kullanıcı birini seçip
// sessiz bir video ya da görüntüsüz bir ses indirirdi.
const MANIFEST_EXT = /\.(m3u8|mpd)(\?|#|$)/i;
let manifestSeen = false;
let capped = false;
let bgTruncated = false;   // CSS arka plan taraması süre bütçesine takıldı

// Sonsuz kaydırılan bir sayfada popup saatlerce açık kalabilir; liste sınırsız
// büyürse popup kilitlenir. Üst sınıra gelince yeni gelenleri almayı bırakıyoruz.
const MAX_ITEMS = 3000;

// İmzasız kimlik -> havuzdaki kayıt. Aynı dosyanın yalnızca token'ı değişmiş
// hâli ikinci bir kart açmasın diye. `byUrl` yine tam adresle anahtarlı:
// indirirken ELİMİZDEKİ adresi kullanmak zorundayız, imzasız hâli çalışmaz.
const byKey = new Map();

/** Yeni bilgiyi eskisine katar — ama `url`'e dokunmadan. */
function enrich(prev, it) {
  const url = prev.url;
  if (area(it) > area(prev)) Object.assign(prev, it);
  if (!prev.size && it.size) prev.size = it.size;
  if (!prev.grp && it.grp) prev.grp = it.grp;
  prev.url = url;   // indirilecek adres ilk gördüğümüz (imzası taze) olan
}

/** Havuza katar; sadece gerçekten yeni olanları döndürür. */
function absorb(items) {
  const fresh = [];
  for (const it of items || []) {
    if (!it || !it.url) continue;

    const prev = byUrl.get(it.url);
    if (prev) {
      // Aynı URL birden çok yerden geldiyse en zengin bilgiyi tut.
      enrich(prev, it);
      continue;
    }

    // Adres yeni ama dosya yeni olmayabilir: yalnızca imza/son kullanma
    // parametreleri değişmişse bu aynı dosyanın tazelenmiş adresi.
    const key = bareKey(it.url);
    const twin = byKey.get(key);
    if (twin) {
      enrich(twin, it);
      continue;
    }

    if (byUrl.size >= MAX_ITEMS) {
      capped = true;
      continue;
    }
    if (MANIFEST_EXT.test(it.url)) manifestSeen = true;
    byUrl.set(it.url, it);
    byKey.set(key, it);
    fresh.push(it);
  }
  return fresh;
}

function showNotice() {
  const msgs = [];
  // Bu, blob uyarısından ÖNCE geliyor: kullanıcının gördüğü asıl kafa
  // karışıklığı "tek video ama üç satır" ve cevabı bu cümlede.
  if (manifestSeen) {
    msgs.push(t('notice.dash'));
  }
  if (blobSeen) {
    msgs.push(t('notice.blob', { n: blobSeen }));
  }
  if (capped) {
    msgs.push(t('notice.capped', { max: MAX_ITEMS }));
  }
  if (bgTruncated) {
    msgs.push(t('notice.bgTruncated'));
  }
  notice.textContent = msgs.join(' ');
  notice.classList.toggle('hidden', !msgs.length);
}

let scanning = false;
let scanError = '';   // sayfa taranamadıysa hata metni — dil değişince tazelenir

/** "Bu sayfa taranamıyor" ekranı; dil değişiminde de aynı yerden çiziliyor. */
function drawScanError() {
  grid.innerHTML =
    `<div class="empty">${t('grid.unscannable')}<br><span class="small">${scanError}</span></div>`;
}

/**
 * Sayfayı tarar ve yenileri listeye katar.
 * full=true: gözlemci bayrağına bakma, her şeyi baştan topla (ilk açılış,
 * gezinme sonrası ve arada bir emniyet turu).
 */
async function refresh(full = false) {
  if (scanning) return;
  scanning = true;

  try {
    let frames = [];
    try {
      frames = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: collectMedia,
        args: [full]
      });
    } catch (e) {
      // Gezinme sırasında araya girmiş olabiliriz; ilk taramada değilsek sus.
      if (full && !byUrl.size) {
        scanError = e.message;
        drawScanError();
      }
      return;
    }
    scanError = '';

    const found = [];
    let blobs = 0;
    for (const f of frames) {
      const r = f.result;
      if (!r || r.unchanged) continue;   // o çerçevede değişen bir şey yok
      found.push(...r.items);
      blobs += r.unsupported.length;
      // Arka plan taraması süre bütçesine takıldıysa liste eksik; sustuğumuzda
      // kullanıcı neyin kaçtığını bilemez.
      if (r.bgTruncated) bgTruncated = true;
    }
    // Bu turda taranmayan çerçeveler sayıyı düşük gösterebilir; en yükseği tut.
    blobSeen = Math.max(blobSeen, blobs);

    // Ağdan yakalananlar (DOM'da hiç görünmeyenler burada çıkar). Sonradan
    // gelenleri arka plan 'netAdded' ile anında yolluyor; burada sadece
    // popup açılmadan önce birikmiş olanları alıyoruz.
    if (full) {
      found.push(...((await chrome.runtime.sendMessage({ type: 'getNet', tabId: tab.id })) || []));
    }

    const fresh = absorb(found);
    showNotice();

    // Parçalı akış ilk kez şimdi fark edilmiş olabilir: `initYt` açılışta
    // çalıştı ama o an henüz hiçbir şey taranmamıştı. Bar kapalıysa aç.
    if (streamHere() && $('#ytbar').classList.contains('hidden')) await initYt();

    if (full && !all.length) {
      // İlk çizim: video önce, sonra büyükten küçüğe.
      all = [...byUrl.values()].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1;
        return area(b) - area(a);
      });
      render();
    } else {
      ingest(fresh);
    }
  } finally {
    scanning = false;
  }
}

// --- canlı takip -----------------------------------------------------------
// Popup eskiden yalnızca açılışta bir kez tarıyordu; sayfaya sonradan gelen
// (sonsuz kaydırma, lazy yükleme, SPA gezinmesi) hiçbir şey listeye düşmüyor,
// görmek için popup'ı kapatıp açmak gerekiyordu. Artık açık kaldığı sürece
// düzenli yokluyoruz. Tur ucuz: sayfada değişiklik yoksa tarayıcı fonksiyonu
// anında "unchanged" dönüyor.

const LIVE_MS = 1200;
const FORCE_EVERY = 8;   // ~10 sn'de bir gözlemciye güvenmeden tam tarama

let liveTimer = null;
let ticks = 0;

function startLive() {
  if (liveTimer) return;
  liveTimer = setInterval(tick, LIVE_MS);
}

async function tick() {
  if (scanning) return;

  let cur = null;
  try {
    cur = await chrome.tabs.get(tab.id);
  } catch {
    clearInterval(liveTimer);   // sekme kapandı
    liveTimer = null;
    // Panelde sekme kapanınca bir sonraki sekme değişimi bizi toparlayacak;
    // o ana kadar boş ızgarayla bakakalmasın diye sebebini yazıyoruz.
    if (IN_PANEL) {
      scanError = t('pin.gone');
      drawScanError();
    }
    return;                     // gezmeyi worker kendi kapatıyor (tabs.onRemoved)
  }

  // Sayfa değiştiyse (adres çubuğundan ya da SPA gezinmesiyle) liste artık
  // başka bir sayfaya ait; sıfırdan kur.
  if (cur.url !== tab.url) {
    // ...ama gezme sürerken adres değişimi çoğu zaman GEZİNME DEĞİL. Slayt
    // gösterileri ve lightbox'lar her görsel için pushState yapıyor
    // (/album/1 → /album/2). Bunu gezinme sayarsak her adımda liste silinir,
    // üstelik gezmenin kendisi de iptal edilir: kullanıcı sağa gezmeyi
    // başlatır, tek kart görür ve hiçbir şey birikmez.
    // Aynı site içinde kalıyorsak "aynı galeride ilerledik" sayıyoruz.
    if (sweeping() && sameHost(cur.url, tab.url)) {
      const wasTitle = tab.title;
      tab = cur;
      if (cur.title !== wasTitle) await initYt();
    } else {
      await navigated(cur);
      return;
    }
  }
  // SPA'larda başlık adresten biraz sonra oturuyor; video kartı eski videonun
  // adında kalmasın diye başlık değişince kartı tazeliyoruz.
  if (cur.title !== tab.title) {
    tab.title = cur.title;
    await initYt();
  }

  const force = ++ticks % FORCE_EVERY === 0;

  // Video kartını da arada bir tazele: reklam bittiğinde süre, geç yüklenen
  // sayfalarda kanal adı ancak o zaman doğruya oturuyor.
  if (force && !$('#ytbar').classList.contains('hidden')) {
    await syncYtMeta(tab.url, siteName(tab.url));
  }

  await refresh(force);
}

/**
 * İki adres aynı siteye mi ait? Gezme sırasında adres değişiminin "galeride
 * bir sonraki görsel" mi yoksa gerçek bir gezinme mi olduğunu ayırıyor.
 * Site değişmişse liste artık geçersiz, sıfırlamak doğru.
 */
function sameHost(a, b) {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/** tabSwitch: panelde başka sekmeye geçildi — sayfa gezinmesi değil. */
async function navigated(cur, tabSwitch = false) {
  tab = cur;
  ticks = 0;

  // Buraya gelmişsek gezme ya çalışmıyor ya da başka bir siteye geçilmiş
  // (aynı site içi adres değişimi yukarıda gezinme sayılmıyor). Gezmeyi worker
  // durduruyor; biz yalnızca haber veriyoruz ki geri sarma da onun tarafında
  // kalsın — burada durdurmak, kullanıcıyı ARTIK BAŞKA OLAN sayfada eski
  // konuma koymaya çalışmak olurdu.
  if (sweeping() && !tabSwitch) {
    chrome.runtime
      .sendMessage({ type: 'sweep', action: 'stop', restore: false })
      .then(refreshSweep);
  } else if (tabSwitch) {
    paintSweep();   // gezme başka sekmede sürüyor olabilir; düğmeleri ona göre çiz
  }

  byUrl.clear();
  byKey.clear();   // ikizi olan kayıtların defteri de o sayfaya aitti
  blobSeen = 0;
  manifestSeen = false;
  capped = false;
  all = [];
  listCache = [];
  drawn = 0;
  // Arka plan yeni sayfada sekmenin seçim hafızasını da siliyor.
  selected.clear();
  done.clear();

  grid.innerHTML = '';
  notice.textContent = '';
  notice.classList.add('hidden');
  updateCounts();

  await refresh(true);
  await initYt();
  // Sekme kapanınca canlı takip durmuştu; panelde başka sekmeye geçilince
  // yeniden ayağa kalkması gerekiyor (startLive zaten çift kurulumu engelliyor).
  startLive();
}

// --- render ----------------------------------------------------------------

function matches(m) {
  const q = $('#search').value.trim().toLowerCase();
  const minW = parseInt($('#minWidth').value, 10) || 0;

  // "Ağ" türe göre değil KAYNAĞA göre süzüyor: ağdan yakalanan medya hem resim
  // hem video olabilir. Bu yüzden tür karşılaştırmasının dışında duruyor.
  if (kindFilter === 'net') {
    if (!m.net) return false;
  } else if (kindFilter !== 'all' && m.kind !== kindFilter) return false;
  if (q && !m.url.toLowerCase().includes(q)) return false;
  // Boyutu bilinmeyenleri (w=0) elemeye çalışmıyoruz; çoğu lazy-load
  // görselinde boyut okunamıyor ve süzgeç onları haksız yere silerdi.
  if (minW && m.w && m.w < minW) return false;
  return true;
}

/** Filtreden geçenler — aynı videonun kaliteleri tek karta indirgenmiş hâlde. */
function visible() {
  return groupVariants(all.filter(matches));
}

function buildCard(m) {
  const card = document.createElement('div');
  // Gruplu kartta seçim varyantlardan herhangi biri olabilir.
  const anySel = (m._vars || [m]).some((v) => selected.has(v.url));
  card.className = 'card' + (anySel ? ' sel' : '') + (done.has(m.url) ? ' done' : '');
  card.dataset.url = m.url;
  card.title = m.url;

  // Video için poster yok; uzantıyı gösteren sade bir döşeme koyuyoruz.
  if (m.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.loading = 'lazy';
    img.src = m.url;
    img.onerror = () => {
      // Hotlink koruması olan siteler eklenti bağlamından gelen isteği
      // reddedebilir; önizleme çıkmasa da dosya indirilebilir olabilir.
      const ph = document.createElement('div');
      ph.className = 'ph';
      ph.textContent = ext(m.url) || t('tag.image');
      img.replaceWith(ph);
    };
    card.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'ph video';
    ph.textContent = '▶ ' + (ext(m.url) || t('tag.video'));
    card.appendChild(ph);
  }

  const tag = document.createElement('span');
  tag.className = 'tag';
  // Manifest kartını ayırt etmek şart: bu kart tıklandığında chrome.downloads
  // değil yt-dlp çalışıyor, ve tek gerçekten işe yarayan seçenek o.
  if (MANIFEST_EXT.test(m.url)) {
    tag.textContent = t('tag.manifest');
    tag.classList.add('stream');
    tag.title = t('tag.manifestTitle');
  } else {
    tag.textContent =
      m.net ? t('tag.net') : m.kind === 'video' ? t('tag.video') : ext(m.url) || t('tag.image');
  }
  card.appendChild(tag);

  const tick = document.createElement('span');
  tick.className = 'tick';
  card.appendChild(tick);

  if (done.has(m.url)) {
    const badge = document.createElement('span');
    badge.className = 'done-badge';
    badge.textContent = t('badge.done');
    card.appendChild(badge);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const dims = m.w && m.h ? `${m.w}×${m.h}` : '';
  const label = document.createElement('span');
  label.className = 'mtext';
  label.textContent = [dims, humanSize(m.size)].filter(Boolean).join(' · ') || shortName(m.url);
  meta.appendChild(label);

  // Aynı videonun başka kaliteleri varsa: sağ altta açılır ok, altında liste.
  if (m._vars) {
    label.textContent += ' · ' + t('card.qualities', { n: m._vars.length });
    meta.appendChild(buildChevron(m._vars.length));
  }
  card.appendChild(meta);

  if (m._vars) card.appendChild(buildVariants(m));

  return card;
}

function buildChevron(n) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chev';
  btn.title = t('chev.title', { n });
  // Metin oku (⌄) yazı tipine göre kayıyor; çizgi olarak koyuyoruz.
  btn.innerHTML =
    '<svg viewBox="0 0 12 8" aria-hidden="true"><path d="M1.5 1.5 6 6l4.5-4.5" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round"/></svg>';
  return btn;
}

/** Kartın altındaki kalite listesi. İlk satır kartın kendisi (en iyi kalite). */
function buildVariants(m) {
  const box = document.createElement('div');
  box.className = 'vars';

  for (const v of m._vars) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'var' + (selected.has(v.url) ? ' on' : '') + (done.has(v.url) ? ' done' : '');
    row.dataset.url = v.url;
    row.title = v.url;

    const name = document.createElement('span');
    name.className = 'vname';
    name.textContent = qLabel(v) + (v === m ? ' · ' + t('var.best') : '');

    const size = document.createElement('span');
    size.className = 'vsize';
    size.textContent = humanSize(v.size) || ext(v.url);

    row.append(name, size);
    box.appendChild(row);
  }

  return box;
}

/** Karttaki (varyantlar dâhil) tüm URL'ler. */
function cardUrls(card) {
  const urls = new Set([card.dataset.url]);
  card.querySelectorAll('.var').forEach((r) => urls.add(r.dataset.url));
  return [...urls];
}

/** Seçim işaretlerini kart ve satırları arasında eşitler. */
function syncCardSel(card) {
  card.querySelectorAll('.var').forEach((r) => r.classList.toggle('on', selected.has(r.dataset.url)));
  card.classList.toggle('sel', cardUrls(card).some((u) => selected.has(u)));
}

// --- kademeli çizim --------------------------------------------------------
// Yüzlerce kartı bir anda DOM'a basmak popup'ı kilitliyor. Onun yerine
// PAGE kadar çiziyoruz, kullanıcı aşağı indikçe devamı ekleniyor.

const PAGE = 50;
let listCache = [];   // aktif filtreye uyan tüm medya
let drawn = 0;        // şu an DOM'da kaç kart var

/** keep=true: seçim/işaret değişimi — aynı kart sayısı ve kaydırma konumu korunur. */
function render(keep = false) {
  const scrollTop = grid.scrollTop;
  const target = keep ? Math.max(PAGE, drawn) : PAGE;

  listCache = visible();
  grid.innerHTML = '';
  drawn = 0;

  if (!listCache.length) {
    grid.innerHTML = `<div class="empty">${t('grid.noMatch')}</div>`;
    updateCounts();
    return;
  }

  appendBatch(target);
  grid.scrollTop = keep ? scrollTop : 0;
}

function appendBatch(n = PAGE, flash = false) {
  const slice = listCache.slice(drawn, drawn + n);
  if (!slice.length) return;

  const frag = document.createDocumentFragment();
  for (const m of slice) {
    const card = buildCard(m);
    if (flash) card.classList.add('fresh');   // canlı gelen kart bir an vurgulanır
    frag.appendChild(card);
  }
  grid.appendChild(frag);
  drawn += slice.length;

  topUp();
  updateCounts();
}

/**
 * Popup açıkken sayfaya düşen yeni medyayı listeye katar. Yeniden çizmiyoruz:
 * mevcut kartlar, seçim ve kaydırma konumu yerinde kalsın, yenileri sona
 * eklensin. Kullanıcı listenin sonuna kadar inmemişse zaten kademeli çizim
 * onları sırası gelince gösterecek.
 */
/**
 * Canlı gelen medya bilinen bir videonun başka kalitesi mi? Öyleyse o kartın
 * listesine katıp kartı yeniliyor ve `true` dönüyoruz — çağıran yeni kart açmaz.
 */
function joinGroup(m) {
  m._vars = null;
  m._qtag = '';
  if (m.kind !== 'video') return false;

  const k = groupKey(m);
  if (!k) return false;
  m._qtag = k.tag;

  const g = groupIndex.get(k.key);
  if (!g) {
    groupIndex.set(k.key, { items: [m], primary: m, sure: !!k.sure });
    return false;   // grubun ilk üyesi: normal kart olarak eklenecek
  }
  if (k.sure) g.sure = true;

  const was = g.primary;
  g.items.push(m);
  const now = settle(g);   // yeni gelen daha iyi kaliteyse kartın yüzü değişir

  if (was !== now) {
    const i = listCache.indexOf(was);
    if (i >= 0) listCache[i] = now;
  }
  redrawCard(was, now);
  return true;
}

/** Çizilmiş bir kartı yerinde yeniler; açık listesi açık kalır. */
function redrawCard(oldItem, item) {
  const el = grid.querySelector(`.card[data-url="${CSS.escape(oldItem.url)}"]`);
  if (!el) return;   // henüz çizilmemiş — sırası gelince güncel hâliyle çizilir

  const card = buildCard(item);
  if (el.classList.contains('open')) card.classList.add('open');
  el.replaceWith(card);
}

function ingest(fresh) {
  if (!fresh || !fresh.length) return;

  all.push(...fresh);
  const pass = [];
  for (const m of fresh) {
    if (!matches(m)) continue;
    // Bilinen bir videonun başka kalitesiyse yeni kart açmıyoruz: mevcut
    // kartın listesine giriyor, kart yerinde yenileniyor.
    if (!joinGroup(m)) pass.push(m);
  }
  if (!pass.length) {
    updateCounts();
    return;
  }

  const atEnd = drawn >= listCache.length;   // liste sonuna kadar çizilmişti
  listCache.push(...pass);

  const empty = grid.querySelector('.empty');
  if (empty) empty.remove();                 // "medya yok" yazısı kalksın

  if (atEnd) appendBatch(pass.length, true);
  else updateCounts();
}

/**
 * Kartlar ekranı doldurmuyorsa scrollbar çıkmaz, kullanıcı da devamını
 * tetikleyemez. Büyük kart boyutunda veya geniş pencerede olabiliyor.
 */
function topUp() {
  let guard = 0;
  while (drawn < listCache.length && grid.scrollHeight <= grid.clientHeight && guard++ < 20) {
    const more = listCache.slice(drawn, drawn + PAGE);
    const frag = document.createDocumentFragment();
    for (const m of more) frag.appendChild(buildCard(m));
    grid.appendChild(frag);
    drawn += more.length;
  }
}

grid.addEventListener('scroll', () => {
  if (drawn >= listCache.length) return;
  if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 400) appendBatch();
});

function updateCounts() {
  const imgs = all.filter((m) => m.kind === 'image').length;
  const vids = all.length - imgs;
  const total = listCache.length;
  const seen = drawn >= total ? `${total}` : `${drawn}/${total}`;
  $('#stats').textContent = t('stats', { seen, imgs, vids });
  $('#selCount').textContent = t('selCount', { n: selected.size });
  $('#download').disabled = selected.size === 0;
}

// --- olaylar ---------------------------------------------------------------

grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;

  // Ok: sadece listeyi açıp kapatır, seçime dokunmaz.
  if (e.target.closest('.chev')) {
    card.classList.toggle('open');
    return;
  }

  // Kalite satırı: yalnızca o kaliteyi seçer/bırakır.
  const row = e.target.closest('.var');
  if (row) {
    const u = row.dataset.url;
    if (selected.has(u)) selected.delete(u);
    else selected.add(u);
    syncCardSel(card);
    persist();
    updateCounts();
    return;
  }

  // Kartın gövdesi: seçili bir kalite varsa hepsini bırakır, yoksa en iyisini
  // seçer. Böylece "kart seçili görünüyor ama hangisi ineceği belirsiz" hâli
  // oluşmuyor.
  const urls = cardUrls(card);
  if (urls.some((u) => selected.has(u))) urls.forEach((u) => selected.delete(u));
  else selected.add(card.dataset.url);

  syncCardSel(card);
  persist();
  updateCounts();
});

$('#kindFilter').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  kindFilter = chip.dataset.kind;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
  saveSetting({ kindFilter });   // popup kapanınca "Tümü"ye dönmesin
  render();
});

// Doğrudan `render` bağlamıyoruz: dinleyici Event nesnesini ilk argüman olarak
// geçirir ve render(keep) onu truthy sayıp listeyi başa sarmazdı.
$('#search').addEventListener('input', () => render());   // arama kalıcı değil, bilinçli
$('#minWidth').addEventListener('input', () => render());
$('#minWidth').addEventListener('change', (e) =>
  saveSetting({ minWidth: parseInt(e.target.value, 10) || 0 }));

// Not: bunlar visible() üzerinde çalışıyor, çizilmiş kartlar üzerinde değil —
// yani "Tümünü seç" henüz aşağıda görünmeyen kartları da kapsıyor.
$('#selAll').addEventListener('click', () => {
  visible().forEach((m) => selected.add(m.url));
  persist();
  render(true);
});

$('#selNone').addEventListener('click', () => {
  selected.clear();
  persist();
  render(true);
});

$('#selInvert').addEventListener('click', () => {
  visible().forEach((m) => (selected.has(m.url) ? selected.delete(m.url) : selected.add(m.url)));
  persist();
  render(true);
});

// --- kart boyutu -----------------------------------------------------------

/** Izgara genişliği sabit (780 - 24 padding); kaç sütun sığdığını gösteriyoruz. */
function applyTileSize(px) {
  // Sadece genişlik; yükseklik CSS'te aspect-ratio ile genişlikten türüyor.
  document.documentElement.style.setProperty('--tile-w', px + 'px');

  // Izgaranın GERÇEK genişliğinden hesaplıyoruz: yan panelin genişliğini
  // kullanıcı sürükleyerek belirliyor, sabit bir sayı orada yanlış olurdu.
  // Ölçüm alınamazsa (ilk çizimden önce) açılır pencerenin ölçüsüne düşüyoruz.
  const w = grid.clientWidth - 24 || 756;
  const cols = Math.max(1, Math.floor((w + 8) / (px + 8)));
  $('#sizeLabel').textContent = t('size.cols', { n: cols });
}

// Panel yeniden boyutlandırılınca sütun sayısı da değişiyor; etiket yalan
// söylemesin. Açılır pencerede bu olay hiç tetiklenmiyor, zararı yok.
window.addEventListener('resize', () => {
  applyTileSize(+$('#size').value);
  topUp();   // panel genişleyince boşluk kalırsa devamını çek
});

$('#size').addEventListener('input', (e) => {
  applyTileSize(+e.target.value);
  topUp();          // kartlar büyüyünce boşluk kalırsa devamını çek
  updateCounts();
});

$('#size').addEventListener('change', (e) => saveSetting({ tileSize: +e.target.value }));

// --- sayfayı gez -----------------------------------------------------------
// Gezmenin kendisi SERVICE WORKER'da çalışıyor (bkz. background.js): popup
// kapansa da sürüyor, bulduklarını `swept:<tabId>` altında biriktiriyor ve
// açık olduğumuzda `sweptAdded` ile anında yolluyor.
//
// Buradaki kod yalnızca kumanda: başlat/durdur mesajı at, gelen durumu çiz.
// v1.20'ye kadar döngü buradaydı ve popup kapanınca gezme de biterdi.

let sweepState = null;   // worker'dan gelen son durum

const sweepMode = () => sweepState?.mode || 'down';

// Gezme bir SEKMEYE ait. Panelde başka sekmeye bakarken "Durdur" göstermek,
// baktığın sayfada bir şey dönüyormuş gibi yapardı.
const sweeping = () => !!sweepState?.running && (!tab || sweepState.tabId === tab.id);

/** İki düğmenin yüzü tek yerden çiziliyor: dil değişince de buradan tazeleniyor. */
function paintSweep() {
  // Çalışan düğme "Durdur"a dönüyor, öteki kapanıyor: aynı anda iki gezme
  // birbirinin durma koşulunu bozardı.
  for (const [sel, mode, label, tip] of [
    ['#sweep', 'down', 'sweep.start', 'sweep.title'],
    ['#sweepRight', 'right', 'sweep.right', 'sweep.rightTitle']
  ]) {
    const btn = $(sel);
    const mine = sweeping() && sweepMode() === mode;
    btn.textContent = mine ? t('sweep.stop') : t(label);
    btn.classList.toggle('on', mine);
    btn.disabled = sweeping() && !mine;
    btn.title = t(tip);
  }

  // Durum satırı: çalışırken "geziliyor… +12", bitince sebebi.
  // Metni değil ANAHTARI saklıyoruz ki dil değişince yeni dilde kurulabilsin.
  const info = $('#sweepInfo');
  if (!sweepState) {
    info.textContent = '';
    return;
  }
  const key = sweeping() ? 'sweep.running' : sweepState.reason || 'sweep.stopped';
  info.textContent = t(key, { n: sweepState.found || 0 });
}

async function refreshSweep() {
  sweepState = await chrome.runtime.sendMessage({ type: 'sweep', action: 'status' });
  paintSweep();
}

async function toggleSweep(mode) {
  if (sweeping()) {
    await chrome.runtime.sendMessage({ type: 'sweep', action: 'stop' });
  } else {
    await chrome.runtime.sendMessage({ type: 'sweep', action: 'start', tabId: tab.id, mode });
  }
  await refreshSweep();
}

$('#sweep').addEventListener('click', () => toggleSweep('down'));
$('#sweepRight').addEventListener('click', () => toggleSweep('right'));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'sweepStatus') {
    sweepState = msg.sweep;
    paintSweep();
  }
  // Worker'ın gezerken bulduğu medya. Popup'ın kendi taraması bunu kaçırabilir:
  // slayt değişince kirli bayrağını worker'ın taraması temizlemiş olur ve
  // bizimki `unchanged` döner. Buradan gelmesi o yüzden şart, tamamlayıcı değil.
  if (msg.type === 'sweptAdded' && tab && msg.tabId === tab.id) ingest(absorb(msg.items));
});
// --- ayarlar ekranı --------------------------------------------------------
// Popup'ın üstüne sağdan kayan tam ekran katman. Klasör yolunu ancak ekran
// açılırken soruyoruz: mutlak yol henüz bilinmiyorsa arka plan sessiz bir sonda
// indirmesi yapıyor, bunu her popup açılışında yaptırmak gereksiz sürpriz olur.

function openSettings() {
  closeHistory();   // iki katman üst üste açılmasın
  $('#settingsView').classList.add('open');
  showFolder();
}

function closeSettings() {
  $('#settingsView').classList.remove('open');
  $('#saved').textContent = '';
}

$('#gear').addEventListener('click', () => {
  if ($('#settingsView').classList.contains('open')) closeSettings();
  else openSettings();
});

$('#settingsBack').addEventListener('click', closeSettings);

// Ekran açıkken Esc geri döndürsün; kullanıcı popup'ı kapatmak zorunda kalmasın.
// Aksi hâlde Esc popup'ın tamamını kapatır ve kullanıcı ızgaraya dönemez.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.view.open');
  if (!open) return;
  e.preventDefault();
  if (open.id === 'settingsView') closeSettings();
  else closeHistory();
});

// --- kayıt klasörü ---------------------------------------------------------

// Fotoğraf ve videolar için TEK klasör. Kutuda tam yol duruyor; İndirilenler'in
// mutlak yolunu API vermediği için arka plan onu bir kez sonda indirmesiyle
// öğreniyor, biz hazır değeri istiyoruz.
async function showFolder() {
  const info = await chrome.runtime.sendMessage({ type: 'getFolderInfo' });
  const box = $('#folder');
  box.value = info?.set ? info.abs : '';
  box.placeholder = info?.root || t('folder.rootPh');

  // Bir önceki "Gözat" denemesinin sonucu varsa onu göster: klasör penceresi
  // popup'ı kapattığı için o an gösterilememişti.
  setFolderNote(info?.folderMsg || defaultNote(info), !!info?.folderMsg && !info?.set);
}

function defaultNote(info) {
  if (!info?.set) return t('folder.note.unset');
  if (!info.outside) return t('folder.note.inside');
  return t('folder.note.outside', { stage: info.stage || 'pagetrawl-gecici' });
}

function setFolderNote(text, bad = false) {
  $('#folderNote').textContent = text;
  $('#folderNote').classList.toggle('err', bad);
}

// Klasörü seçtiren pencereyi köprü açıyor: Chrome'un kendi Kaydet penceresi
// yalnızca İndirilenler altını kabul ediyordu, köprününki her yeri seçebiliyor.
// Pencere odağı alınca Chrome popup'ı kapatıyor — engellenemiyor, o yüzden
// önce uyarıyoruz; sonuç storage'a yazılıp bir dahaki açılışta gösteriliyor.
$('#browse').addEventListener('click', () => {
  setFolderNote(t('folder.opening'));
  chrome.runtime.sendMessage({ type: 'pickFolder' });
});

$('#folderReset').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'setFolder', path: '' });
});

// Elle yazılan/yapıştırılan yol: köprü sadece doğruluyor, klasörü indirme
// anında açıyor — yanlış yazılmış bir yol diske çöp klasör bırakmasın.
$('#folder').addEventListener('change', (e) => {
  const path = e.target.value.trim();
  setFolderNote(path ? t('folder.checking') : '');
  chrome.runtime.sendMessage({ type: 'setFolder', path });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'folder') return;

  if (msg.note) setFolderNote(msg.note, !!msg.bad);          // ör. taşıma hatası
  else if (msg.error) setFolderNote(msg.error, true);
  else if (msg.canceled) setFolderNote(t('folder.canceled'));
  else if (msg.path) { $('#folder').value = msg.path; showFolder(); }
  else { $('#folder').value = ''; showFolder(); }
});

$('#saveSettings').addEventListener('click', async () => {
  await saveSetting({
    maxConcurrent: Math.min(10, Math.max(1, +$('#maxConcurrent').value || 4)),
    template: $('#template').value.trim() || '{host}/{name}.{ext}',
    saveAs: $('#saveAs').checked
  });

  const note = $('#saved');
  note.textContent = t('opt.saved');
  setTimeout(() => (note.textContent = ''), 1600);
});

// --- indirme geçmişi -------------------------------------------------------
// Chrome'un kendi indirme listesi dosyayı ve kaynak URL'sini biliyor ama onu
// BULDUĞUMUZ SAYFAYI bilmiyor. Bir galeriden 40 fotoğraf indirdikten bir hafta
// sonra "bunlar neredendi" sorusunun tarayıcıda cevabı yok; burada var.
//
// Kayıtlar sayfaya göre gruplu: aynı sayfadan inen 40 dosya tek başlığın
// altında duruyor, yoksa liste aynı adresi 40 kez tekrarlardı.

let histCache = [];        // arama ve dil değişiminde yeniden çizmek için ham liste
let histSel = new Set();   // silmek üzere seçilen indirme kimlikleri

function histTime(ms) {
  return new Date(ms).toLocaleString(getLang() === 'tr' ? 'tr-TR' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Bir kaydın aramada taranan alanları: dosya adı, sayfa ve kaynak URL. */
function histHay(e) {
  return [e.name, e.url, e.page?.title, e.page?.url].filter(Boolean).join(' ').toLowerCase();
}

/** Sayfaya göre gruplar; grupların sırası ilk (yani en yeni) kaydın sırası. */
function histGroups(list) {
  const index = new Map();
  const out = [];
  for (const e of list) {
    const key = e.page?.url || e.page?.host || '';
    let g = index.get(key);
    if (!g) {
      g = { page: e.page, items: [] };
      index.set(key, g);
      out.push(g);
    }
    g.items.push(e);
  }
  return out;
}

function renderHistory() {
  const body = $('#histBody');
  const q = $('#histSearch').value.trim().toLowerCase();
  const list = q ? histCache.filter((e) => histHay(e).includes(q)) : histCache;

  $('#histCount').textContent = t('hist.count', { n: list.length });
  body.innerHTML = '';

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = histCache.length ? t('hist.noMatch') : t('hist.empty');
    body.appendChild(empty);
    paintHistFoot();
    return;
  }

  const frag = document.createDocumentFragment();

  for (const g of histGroups(list)) {
    const box = document.createElement('div');
    box.className = 'hist-group';

    const headRow = document.createElement('div');
    headRow.className = 'hist-row head';

    // Grup kutusu: o sayfadan inen her şeyi tek hamlede seçiyor. Zaten silinmiş
    // kayıtlar sayılmıyor, yoksa kutu hiç "dolu" görünmezdi.
    const live = g.items.filter((e) => e.state !== 'deleted');
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.className = 'hist-pick-all';
    all.title = t('hist.selectAll');
    all.disabled = !live.length;
    all.checked = live.length > 0 && live.every((e) => histSel.has(e.id));
    headRow.appendChild(all);

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'hist-page';
    // Sayfa adresi yoksa (eski kayıt, ya da adresi okunamayan sekme) açacak
    // bir yer de yok; düğme tıklanmaz oluyor.
    head.disabled = !g.page?.url;
    if (g.page?.url) {
      head.dataset.url = g.page.url;
      head.title = g.page.url + '\n' + t('hist.openPage');
    }

    const ptitle = document.createElement('span');
    ptitle.className = 'hist-ptitle';
    ptitle.textContent = g.page?.title || g.page?.host || t('hist.unknownPage');

    const phost = document.createElement('span');
    phost.className = 'hist-phost';
    phost.textContent = g.page?.host || '';

    const pn = document.createElement('span');
    pn.className = 'hist-pn';
    pn.textContent = t('hist.files', { n: g.items.length });

    head.append(ptitle, phost, pn);
    headRow.appendChild(head);
    box.appendChild(headRow);

    for (const e of g.items) {
      const gone = e.state === 'deleted';

      const line = document.createElement('div');
      line.className = 'hist-row' + (gone ? ' gone' : '');

      const pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.className = 'hist-pick';
      pick.dataset.id = String(e.id);
      pick.disabled = gone;                    // silineni tekrar silmeye gerek yok
      pick.checked = histSel.has(e.id);
      line.appendChild(pick);

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'hist-file';
      row.dataset.id = String(e.id);
      if (e.move) row.dataset.move = e.move;
      if (gone) row.dataset.gone = '1';
      // Taşınmış dosyada "klasörde göster" yok (Chrome'un kaydı ara klasörü
      // gösteriyor), o yüzden ipucu da onu vaat etmiyor.
      row.title =
        e.url + '\n' + (e.move || e.name) + (e.move || gone ? '' : '\n' + t('hist.reveal'));

      const name = document.createElement('span');
      name.className = 'hist-name';
      name.textContent = e.name;

      const state = document.createElement('span');
      state.className = 'hist-state ' + (e.state || 'running');
      state.textContent = gone
        ? t('hist.deleted')
        : e.state === 'done'
          ? t('hist.ok')
          : e.state === 'failed'
            ? t('hist.failed')
            : t('hist.pending');

      const when = document.createElement('span');
      when.className = 'hist-when';
      when.textContent = histTime(e.at);

      row.append(name, state, when);
      line.appendChild(row);
      box.appendChild(line);
    }

    frag.appendChild(box);
  }

  body.appendChild(frag);
  paintHistFoot();
}

/** Silme düğmesi ve seçim sayacı; dil değişiminde de buradan tazeleniyor. */
function paintHistFoot() {
  const n = histSel.size;
  $('#histDelete').disabled = n === 0;
  $('#histDelete').textContent = n ? `${t('del.button')} (${n})` : t('del.button');
}

async function openHistory() {
  closeSettings();
  histCache = (await chrome.runtime.sendMessage({ type: 'getHistory' })) || [];
  // Seçim ekranla birlikte açılıp kapanıyor: bir önceki açılıştan kalan seçimle
  // "sil"e basmak, kullanıcının görmediği dosyaları silmek olurdu.
  histSel.clear();
  hideConfirm();
  $('#histNote').textContent = '';
  renderHistory();
  $('#historyView').classList.add('open');
}

function closeHistory() {
  $('#historyView').classList.remove('open');
  hideConfirm();
}

// --- indirilen dosyaları silme ---------------------------------------------
// Geri alınamaz olduğu için iki adım: önce onay barı, sonra silme. Tarayıcının
// confirm()'ü popup'ta güvenilmez — engellenebiliyor ve popup'ı kapatabiliyor.

function hideConfirm() {
  $('#histConfirm').classList.add('hidden');
  $('#histFoot').classList.remove('hidden');
}

$('#histBody').addEventListener('change', (e) => {
  const box = e.target;

  if (box.classList.contains('hist-pick')) {
    const id = +box.dataset.id;
    if (box.checked) histSel.add(id);
    else histSel.delete(id);
    // Grup kutusu artık "hepsi seçili" olmayabilir; satırları yeniden çizmeden
    // sadece başlıkları eşitliyoruz.
    syncGroupBoxes();
    paintHistFoot();
    return;
  }

  if (box.classList.contains('hist-pick-all')) {
    const group = box.closest('.hist-group');
    group.querySelectorAll('.hist-pick:not(:disabled)').forEach((p) => {
      p.checked = box.checked;
      if (box.checked) histSel.add(+p.dataset.id);
      else histSel.delete(+p.dataset.id);
    });
    paintHistFoot();
  }
});

/** Grup kutusu, altındaki tüm satırlar seçiliyse dolu görünmeli. */
function syncGroupBoxes() {
  $('#histBody')
    .querySelectorAll('.hist-group')
    .forEach((group) => {
      const picks = [...group.querySelectorAll('.hist-pick:not(:disabled)')];
      const box = group.querySelector('.hist-pick-all');
      if (box) box.checked = picks.length > 0 && picks.every((p) => p.checked);
    });
}

$('#histDelete').addEventListener('click', () => {
  if (!histSel.size) return;
  $('#histConfirmText').textContent = t('del.confirm', { n: histSel.size });
  $('#histFoot').classList.add('hidden');
  $('#histConfirm').classList.remove('hidden');
});

$('#histNo').addEventListener('click', hideConfirm);

$('#histYes').addEventListener('click', async () => {
  const ids = [...histSel];
  $('#histYes').disabled = true;
  $('#histConfirmText').textContent = t('del.working');

  const res = await chrome.runtime.sendMessage({ type: 'deleteFiles', ids });

  $('#histYes').disabled = false;
  hideConfirm();
  histSel.clear();

  // Silinen kayıtlar artık `deleted`; listeyi worker'dan tazeleyip çiziyoruz.
  histCache = (await chrome.runtime.sendMessage({ type: 'getHistory' })) || [];
  renderHistory();

  const failed = res?.failed || [];
  const gone = res?.gone || 0;
  $('#histNote').textContent = !gone
    ? t('del.none')
    : failed.length
      ? t('del.partial', { n: gone, f: failed.length })
      : t('del.done', { n: gone });

  // Neden silinemediğini söylemek şart: kullanıcı aksi hâlde dosyanın gittiğini
  // sanır. İlk gerekçe yeterli, hepsini sıralamak satırı okunmaz yapardı.
  if (failed.length) $('#histNote').textContent += ' — ' + delError(failed[0].code);
  $('#histNote').classList.toggle('warn', failed.length > 0);
});

/**
 * Köprünün gerekçe kodunu çevrilmiş cümleye çevirir.
 * Anahtarı `'del.err.' + code` diye kurmak cazip ama tehlikeli: tanımadığımız
 * bir kod gelse `t()` anahtarın kendisini döndürür ve kullanıcı arayüzde ham
 * `del.err.xxx` görür. Bilinmeyen her şey genel hataya düşüyor.
 */
function delError(code) {
  switch (code) {
    case 'outside':
      return t('del.err.outside');
    case 'notfile':
      return t('del.err.notfile');
    case 'notabs':
      return t('del.err.notabs');
    case 'nobridge':
      return t('del.err.nobridge');
    default:
      return t('del.err.oserr');
  }
}

// Yan panelde aç. `sidePanel.open()` kullanıcı hareketi istiyor, o yüzden
// worker'a uğramadan doğrudan buradan çağrılıyor — mesaj turu hareketi
// kaybettirebiliyor. Ardından açılır pencereyi kapatıyoruz: ikisi aynı anda
// durursa iki canlı tarayıcı aynı sekmeyi yarıştırır ve biri ötekinin kirli
// bayrağını yer — gezmede yaşadığımız sorunun aynısı.
$('#pin').addEventListener('click', async () => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.warn('[panel]', e.message);
    return;   // açılamadıysa popup'ı kapatmıyoruz, kullanıcı ortada kalmasın
  }
  window.close();
});

$('#histBtn').addEventListener('click', () => {
  if ($('#historyView').classList.contains('open')) closeHistory();
  else openHistory();
});

$('#histBack').addEventListener('click', closeHistory);
$('#histSearch').addEventListener('input', renderHistory);

$('#histBody').addEventListener('click', (e) => {
  const page = e.target.closest('.hist-page');
  if (page?.dataset.url) {
    chrome.tabs.create({ url: page.dataset.url });
    return;
  }

  const row = e.target.closest('.hist-file');
  if (!row || row.dataset.gone) return;   // silinmiş dosyada gösterilecek bir şey yok

  // Ara klasöre inip köprüyle taşınan dosyalarda Chrome'un kaydı ARTIK YANLIŞ
  // yeri gösteriyor: `show` boşalmış (çoğu zaman silinmiş) ara klasörü açardı.
  // Onun yerine gerçek yolu yazıyoruz.
  if (row.dataset.move) {
    $('#histNote').textContent = t('hist.movedTo', { path: row.dataset.move });
    return;
  }

  try {
    chrome.downloads.show(+row.dataset.id);
  } catch {
    // Kullanıcı Chrome'un indirme geçmişini temizlemişse kayıt yok; sessiz geç.
  }
});

$('#histClear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearHistory' });
  histCache = [];
  histSel.clear();          // kaydı kalmayan kimlikleri seçili tutmanın anlamı yok
  hideConfirm();
  renderHistory();
  $('#histNote').textContent = t('hist.cleared');
  $('#histNote').classList.remove('warn');
});

// --- toplu indirme ilerlemesi ----------------------------------------------
// Kuyruk service worker'da işliyor; popup kapansa da sürüyor. Bu yüzden durumu
// açılışta bir kez soruyoruz, sonrası canlı mesajla geliyor.

// Dil değişince aynı durumu yeni dilde yeniden çizebilmek için son gelen
// değerleri saklıyoruz; aksi hâlde açık bir ilerleme çubuğu eski dilde kalırdı.
let lastProg = null;

function renderDl(p) {
  lastProg = p;
  const box = $('#dlProg');
  if (!p || !p.total) {
    box.classList.add('hidden');
    return;
  }

  const fin = p.done + p.failed;
  const running = fin < p.total;
  const fill = $('#dlFill');

  fill.style.width = Math.round((fin / p.total) * 100) + '%';
  fill.classList.toggle('ok', !running && !p.failed);
  fill.classList.toggle('err', !running && !!p.failed);

  $('#dlText').textContent = running
    ? t('dl.running', { fin, total: p.total })
    : p.failed
      ? t('dl.mixed', { done: p.done, failed: p.failed })
      : t('dl.done', { done: p.done });

  box.classList.remove('hidden');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'dlStatus') renderDl(msg.prog);
  // Ağdan yeni medya yakalandı (DOM'da görünmeyen fetch/lazy içerik).
  if (msg.type === 'netAdded' && tab && msg.tabId === tab.id) ingest(absorb(msg.items));
});

$('#download').addEventListener('click', async () => {
  const picked = all.filter((m) => selected.has(m.url));
  if (!picked.length) return;

  // Manifestler (.mpd/.m3u8) chrome.downloads'a gitmemeli: inen şey birkaç
  // kilobaytlık bir XML/metin listesi olurdu, video değil. Onları yt-dlp'ye
  // yolluyoruz — parçaları o indirip birleştiriyor.
  const manifests = picked.filter((m) => MANIFEST_EXT.test(m.url));
  const items = picked
    .filter((m) => !MANIFEST_EXT.test(m.url))
    .map((m) => ({ url: m.url, kind: m.kind }));

  if (manifests.length) {
    const res = await chrome.runtime.sendMessage({
      type: 'ytdlp',
      action: 'queue',
      urls: manifests.map((m) => m.url),
      mode: $('#ytMode').value,
      // Çıplak CDN adresleri çoğu zaman referer'sız reddediliyor.
      referer: tab.url || ''
    });
    manifests.forEach((m) => done.add(m.url));
    if (!items.length) {
      selected.clear();
      persist();
      render(true);
      const btn = $('#download');
      btn.textContent = t('btn.queuedYt', { n: res?.count || manifests.length });
      setTimeout(() => (btn.textContent = t('footer.download')), 2400);
      return;
    }
  }

  let host = 'indirilenler';
  try {
    host = new URL(tab.url).hostname;
  } catch {}

  const btn = $('#download');
  btn.disabled = true;
  btn.textContent = t('btn.queueing');

  const res = await chrome.runtime.sendMessage({
    type: 'download',
    items,
    host,
    title: tab.title || '',   // şablondaki {title} için
    pageUrl: tab.url || ''    // geçmişte "hangi sayfadan" için
  });

  if (res?.ok) {
    // Kuyruğa gidenleri "indirildi" olarak işaretle ve seçimi bırak; popup
    // kapanmıyor, böylece kaldığın yerden devam edip geri kalanları seçebilirsin.
    items.forEach((it) => done.add(it.url));
    selected.clear();
    persist();
    render(true);
    btn.textContent = t('btn.queued', { n: res.count });
    setTimeout(() => (btn.textContent = t('footer.download')), 1600);
  } else {
    btn.textContent = t('btn.error', { msg: res?.error || t('err.unknown') });
  }
});

// --- yt-dlp köprüsü --------------------------------------------------------

// Bu sitelerde video parçalı akış (DASH/HLS) olarak gelir; ızgaradaki toplu
// indirici işe yaramaz, yt-dlp gerekir.
const STREAM_SITES = [
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'YouTube'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)twitter\.com$|(^|\.)x\.com$/, 'X'],
  [/(^|\.)facebook\.com$/, 'Facebook'],
  [/(^|\.)vimeo\.com$/, 'Vimeo'],
  [/(^|\.)twitch\.tv$/, 'Twitch'],
  [/(^|\.)reddit\.com$/, 'Reddit'],
  [/(^|\.)dailymotion\.com$/, 'Dailymotion']
];

function siteName(url) {
  try {
    const h = new URL(url).hostname;
    for (const [re, name] of STREAM_SITES) if (re.test(h)) return name;
  } catch {}
  return null;
}

let ytBusy = false;   // ekranda sürmekte olan bir yt-dlp indirmesi var mı

/**
 * Durum satırı yalnızca söyleyecek bir şey varken görünüyor: indirme sürüyorsa
 * ya da hata çıktıysa. Boştayken kart sadece video bilgisini gösteriyor.
 *
 * Satırda yt-dlp'nin ham çıktısı ("[download] 13.2% of 368MiB at …", "[youtube]
 * Extracting URL…") DEĞİL, tek bir sade cümle duruyor; ham satır yalnızca fare
 * ipucunda. Yüzdeyi zaten çubuk gösteriyor.
 */
let lastYtStatus = null;

function renderYtStatus(s) {
  if (!s) return;
  lastYtStatus = s;

  // Service worker indirme sırasında öldüyse durum "çalışıyor" hâlinde donar ve
  // İndir düğmesi sonsuza kadar kapalı kalırdı. Zaman damgası eskimişse
  // çalışmıyor kabul ediyoruz.
  const stale = s.running && s.at && Date.now() - s.at > 90000;
  const running = !!s.running && !stale;

  let text;
  if (stale) text = t('yt.stale');
  else if (s.error) text = s.error;
  else if (running) text = s.percent ? t('yt.downloadingPct', { pct: Math.round(s.percent) }) : t('yt.downloading');
  else if (s.percent === 100) text = t('yt.downloaded');
  else text = s.line || '';   // iptal gibi tek seferlik bilgiler

  // Kuyrukta bekleyen varsa söyle: beş akış seçip birinin ilerlediğini görmek,
  // ötekilerin unutulduğu izlenimi verirdi.
  if (running && s.left > 0) text += ' · ' + t('yt.left', { n: s.left });

  ytBusy = running;
  $('#ytBarFill').style.width = (s.percent || 0) + '%';
  $('#ytLine').textContent = text;
  $('#ytLine').title = s.dir || s.line || '';   // ayrıntı isteyen üstüne gelsin
  $('#ytLine').classList.toggle('err', !!s.error || !!stale);
  $('#ytStatus').classList.toggle('hidden', !text && !running);
  $('#ytCancel').classList.toggle('hidden', !running);
  $('#ytGo').disabled = running;
}

/** Sayfadan çalıştırılır: video başlığı/kapağı için sayfanın kendi meta'ları. */
function collectVideoMeta() {
  const meta = (sel, attr = 'content') => document.querySelector(sel)?.getAttribute(attr) || '';
  const txt = (sel) => document.querySelector(sel)?.textContent?.trim() || '';

  // YouTube'da og:/microformat etiketleri SPA gezinmesinde eski videoda takılı
  // kalabiliyor. Aşağıdaki ikisi o an ekranda olanı veriyor: oynatıcının süresi
  // ve kanal bağlantısının metni.
  const v = document.querySelector('video');
  const adShowing = !!document.querySelector('.html5-video-player.ad-showing');

  const abs = (u) => {
    try {
      return u ? new URL(u, document.baseURI).href : '';
    } catch {
      return '';
    }
  };

  // JSON-LD'de kapak genelde VideoObject.thumbnailUrl altında. Yapı siteden
  // siteye değiştiği için ağacı geziyoruz; derinlik sınırı olmadan devasa bir
  // JSON'da takılabilirdik.
  const fromLd = () => {
    const dig = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 6) return '';
      const tn = o.thumbnailUrl || o.thumbnail?.contentUrl || o.thumbnail?.url;
      if (typeof tn === 'string') return tn;
      if (Array.isArray(tn) && typeof tn[0] === 'string') return tn[0];
      for (const v of Object.values(o)) {
        const r = dig(v, depth + 1);
        if (r) return r;
      }
      return '';
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const r = dig(JSON.parse(s.textContent), 0);
        if (r) return r;
      } catch {
        // Bozuk JSON-LD yaygın; sessizce sonrakine geçiyoruz.
      }
    }
    return '';
  };

  return {
    title: meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') || document.title,
    // Tek bir kaynağa güvenmiyoruz: YouTube dışındaki sitelerin bir kısmında
    // og:image ya hiç yok ya da CDN'i eklenti bağlamından gelen isteği
    // reddediyor. Sırayla denenmek üzere aday listesi döndürüyoruz.
    //
    // `poster` başta: sayfanın oynatıcısı onu ZATEN yüklemiş oluyor, yani hem
    // kesinlikle bu videoya ait hem de kesinlikle çizilebilir.
    thumbs: [
      abs(v?.getAttribute('poster')),
      abs(meta('meta[property="og:image"]')),
      abs(meta('meta[name="twitter:image"]')),
      abs(meta('meta[property="og:image:secure_url"]')),
      abs(fromLd()),
      abs(meta('link[rel="image_src"]', 'href'))
    ].filter((u, i, a) => u && a.indexOf(u) === i),
    author:
      meta('link[itemprop="name"]') ||
      meta('meta[itemprop="author"]') ||
      meta('meta[name="author"]'),
    duration: meta('meta[itemprop="duration"]'),
    domAuthor: txt('#owner #channel-name a, ytd-channel-name a'),
    // Reklam oynarken süre reklamın süresidir; canlı yayında Infinity gelir.
    playerDur: v && isFinite(v.duration) && !adShowing ? Math.round(v.duration) : 0
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** saniye -> 4:13 / 1:02:07 */
function fmtClock(total) {
  const s = Math.max(0, Math.round(total || 0));
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const mi = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(mi)}:${pad2(s % 60)}` : `${mi}:${pad2(s % 60)}`;
}

/** ISO 8601 süre (PT4M13S) -> 4:13 */
function fmtDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return '';
  return fmtClock(+(m[1] || 0) * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0));
}

// YouTube'un oEmbed uçnoktası: başlığı ve kanalı doğrudan video kimliğinden
// veriyor, yani sayfanın DOM'undan bağımsız. Sayfadaki og:/microformat
// etiketleri SPA gezinmesinde bir önceki videoda takılı kalabildiği için
// (kartta yanlış başlık/kanal/süre görünüyordu) YouTube'da tek doğru kaynak bu.
const oembedCache = new Map();

async function ytOEmbed(id) {
  if (oembedCache.has(id)) return oembedCache.get(id);
  try {
    const r = await fetch(
      'https://www.youtube.com/oembed?format=json&url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + id),
      { credentials: 'omit' }
    );
    if (!r.ok) return null;   // özel/yaş kısıtlı video: sayfadan okunanla yetin
    const j = await r.json();
    const out = { title: j.title || '', author: j.author_name || '' };
    oembedCache.set(id, out);
    return out;
  } catch {
    return null;
  }
}

function youtubeId(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)youtu\.be$/.test(u.hostname)) return u.pathname.slice(1).split('/')[0];
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/(shorts|embed|live)\/([^/?#]+)/);
    return m ? m[2] : '';
  } catch {
    return '';
  }
}

/** Sayfa başlığındaki site kuyruğu ("… - YouTube") kartta gereksiz gürültü. */
function trimTitle(t, site) {
  return String(t || '')
    .replace(new RegExp(`\\s*[-–|]\\s*${site}\\s*$`, 'i'), '')
    .replace(/^\(\d+\)\s*/, '')   // sekme başlığındaki bildirim sayacı
    .trim();
}

let probed = false;

// Gezinmede yeniden çağrılıyor (YouTube'da sonraki videoya geçmek gibi):
// başlık, kapak ve site bilgisi her seferinde sıfırdan kuruluyor.
/** Bilinen bir akış sitesi değilse başlık olarak alan adını kullanıyoruz. */
function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Sayfada parçalı akış var mı? Manifest dosyası ya da `blob:` video, ikisi de
 * "bu videoyu ızgaradan indiremezsin" demek — tek çıkış yolu yt-dlp.
 */
const streamHere = () => manifestSeen || blobSeen > 0;

async function initYt() {
  const forUrl = tab?.url || '';
  const known = siteName(forUrl);

  // Bar eskiden YALNIZCA STREAM_SITES listesindeki sitelerde çıkıyordu. Oysa
  // DASH/HLS her sitede olabiliyor ve o sayfalarda kullanıcı üç işe yaramaz
  // kart görüp indirebileceğini sanıyordu. Parçalı akış tespit edildiyse bar
  // artık listeye bakmadan açılıyor: yt-dlp zaten site listesiyle sınırlı değil.
  const site = known || (streamHere() ? hostLabel(forUrl) : null);
  if (!site) {
    $('#ytbar').classList.add('hidden');
    return;
  }

  $('#ytbar').classList.remove('hidden');
  $('#ytTitle').textContent = trimTitle(tab.title, site) || t('yt.videoOf', { site });
  $('#ytSub').textContent = site;

  renderYtStatus(await chrome.runtime.sendMessage({ type: 'getYtStatus' }));

  // Köprü ayakta mı, ffmpeg var mı — arka planda sor. Sonucu yalnızca bir
  // eksik varsa gösteriyoruz; her şey yolundaysa kullanıcıyı ilgilendirmiyor.
  if (!probed) {
    probed = true;
    chrome.runtime.sendMessage({ type: 'ytdlp', action: 'probe' });
  }

  // YouTube'da kapağı URL'den türetiyoruz: SPA gezinmesinde og:image eski
  // videoda kalabiliyor, id ise her zaman doğru.
  const id = youtubeId(forUrl);
  if (id) setThumb(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
  else setThumb([]);   // adaylar aşağıda syncYtMeta'dan gelecek

  await syncYtMeta(forUrl, site);
}

/**
 * Başlık, kanal ve süre. Ayrı bir fonksiyon çünkü kart açıldıktan sonra da
 * çağrılıyor: reklam bitip gerçek süre oturduğunda ya da sayfa metası geç
 * güncellendiğinde kart kendini toparlasın.
 */
async function syncYtMeta(forUrl, site) {
  let info = null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectVideoMeta
    });
    info = res?.result;
  } catch {
    return;   // erişilemeyen sayfa: sekme başlığıyla yetiniyoruz
  }
  // Meta gelene kadar kullanıcı başka videoya geçmiş olabilir; geç kalan
  // cevap yeni videonun kartını bozmasın.
  if (!info || tab.url !== forUrl) return;

  const id = youtubeId(forUrl);
  let title = trimTitle(info.title, site);
  let author = info.author;
  let dur = fmtDuration(info.duration);

  if (id) {
    // YouTube: sayfanın etiketleri eski videoda kalabiliyor. Sekme başlığı ve
    // oynatıcının süresi güncel; başlık/kanal için kesin kaynak oEmbed.
    title = trimTitle(tab.title, site) || title;
    author = info.domAuthor || '';
    dur = fmtClock(info.playerDur);

    const oe = await ytOEmbed(id);
    if (tab.url !== forUrl) return;
    if (oe?.title) title = oe.title;
    if (oe?.author) author = oe.author;
  }

  if (title) $('#ytTitle').textContent = title;
  // YouTube'da kapak kimlikten türetiliyor (yukarıda); ötekilerde sayfadan
  // toplanan adaylar sırayla deneniyor.
  if (!id) setThumb(info.thumbs);
  $('#ytSub').textContent = [author, dur].filter(Boolean).join(' · ') || site;
}

let thumbTried = '';   // en son denenen aday listesi (titremeyi önlemek için)

/**
 * Kapağı sırayla dener. Tek bir adres yerine liste alıyor çünkü YouTube dışında
 * ilk aday sık sık çizilemiyor: ya meta etiketi yok ya da CDN eklenti
 * bağlamından gelen isteği reddediyor. Hepsi düşerse `src` kalkıyor ve CSS'teki
 * gri ▶ döşemesi görünüyor — kırık resim ikonu değil.
 */
function setThumb(list) {
  const cands = (Array.isArray(list) ? list : [list]).filter(Boolean);
  const key = cands.join('|');
  if (key === thumbTried) return;   // aynı liste: yeniden yükleyip titretme
  thumbTried = key;

  const img = $('#ytThumb');
  if (!cands.length) {
    img.onerror = null;
    img.removeAttribute('src');
    return;
  }

  let i = 0;
  img.onerror = () => {
    if (++i < cands.length) img.src = cands[i];
    else img.removeAttribute('src');
  };
  img.src = cands[0];
}

/** Köprü eksiklerini bildirir. Sadece indirmeyi engelleyecek/kısıtlayacak olanları. */
function renderProbe(p) {
  if (!p || ytBusy) return;   // sürmekte olan indirmenin satırını ezmesin
  let warn = '';
  if (!p.ytdlp) warn = t('probe.noYtdlp');
  else if (!p.js) warn = t('probe.noJs');
  if (!warn) return;

  $('#ytLine').textContent = warn;
  $('#ytLine').classList.add('err');
  $('#ytStatus').classList.remove('hidden');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ytStatus') renderYtStatus(msg.status);
  if (msg.type === 'ytProbe') renderProbe(msg.probe);
});

$('#ytGo').addEventListener('click', () => {
  renderYtStatus({ running: true, percent: 0, line: t('yt.starting') });
  chrome.runtime.sendMessage({
    type: 'ytdlp',
    action: 'download',
    url: tab.url,
    mode: $('#ytMode').value
  });
});

$('#ytCancel').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'ytdlp', action: 'cancel' });
});

// --- dil -------------------------------------------------------------------
// Sabit metinler HTML'den (data-i18n), geri kalan her şey yeniden çizilerek
// tazeleniyor. Kart etiketleri, sayaçlar ve açık durum satırı kartların içinde
// duruyor; sadece applyStaticI18n çağırmak onları eski dilde bırakırdı.

function applyLang(lang) {
  setLang(lang);

  document
    .querySelectorAll('#langs .flag')
    .forEach((b) => b.classList.toggle('on', b.dataset.lang === getLang()));

  applyStaticI18n();
  applyTileSize(+$('#size').value);   // "n sütun"
  paintSweep();                       // düğme metni + son gezme sonucu

  if (scanError) drawScanError();
  else render(true);                 // kart etiketleri + sayaçlar

  showNotice();
  renderDl(lastProg);
  if (lastYtStatus) renderYtStatus(lastYtStatus);
  if ($('#settingsView').classList.contains('open')) showFolder();   // klasör notu da çeviriyle üretiliyor
  // Geçmiş listesinin tamamı JS'in ürettiği metin (durum etiketleri, "n dosya",
  // tarih biçimi); applyStaticI18n bunların hiçbirini göremez.
  if ($('#historyView').classList.contains('open')) renderHistory();
  if (tab) initYt();                 // video kartındaki yedek başlık
}

$('#langs').addEventListener('click', (e) => {
  const btn = e.target.closest('.flag');
  if (!btn || btn.dataset.lang === getLang()) return;
  applyLang(btn.dataset.lang);
  saveSetting({ lang: getLang() });
});

// --- başlat ----------------------------------------------------------------

(async () => {
  const { settings } = await chrome.storage.local.get('settings');

  // Dil her şeyden önce: aşağıdaki ilk çizimler zaten doğru dilde olsun,
  // arayüz bir an Türkçe görünüp sonra İngilizceye atlamasın.
  setLang(settings?.lang || DEFAULT_LANG);
  document
    .querySelectorAll('#langs .flag')
    .forEach((b) => b.classList.toggle('on', b.dataset.lang === getLang()));
  applyStaticI18n();

  $('#maxConcurrent').value = settings?.maxConcurrent ?? 4;
  $('#template').value = settings?.template ?? '{host}/{name}.{ext}';
  $('#saveAs').checked = !!settings?.saveAs;

  // Eski sürümden 100 gibi çok küçük bir değer kalmış olabilir; alt sınıra çek.
  const tile = Math.min(340, Math.max(140, settings?.tileSize ?? 200));
  $('#size').value = tile;
  applyTileSize(tile);   // ızgarayı doldurmadan önce, tek seferde doğru boyutta çizilsin

  // Filtreleri scan()'den ÖNCE geri yükle; ilk render zaten doğru filtreyle çizilsin.
  kindFilter = settings?.kindFilter ?? 'all';
  document
    .querySelectorAll('#kindFilter .chip')
    .forEach((c) => c.classList.toggle('active', c.dataset.kind === kindFilter));
  $('#minWidth').value = settings?.minWidth ?? 0;

  renderDl(await chrome.runtime.sendMessage({ type: 'getProg' }));

  // Önceki "Gözat" denemesi bir sonuç bıraktıysa (klasör penceresi popup'ı
  // kapattığı için gösterilememişti) ayarlar ekranını kendiliğinden aç.
  const { folderMsg } = await chrome.storage.session.get('folderMsg');
  if (folderMsg) openSettings();

  // Yan panel de açılır pencere de "o pencerenin aktif sekmesi"ne bakıyor.
  // Panel bir sekme değil, penceresine kenetli bir kap; bu sorgu ona da doğru
  // cevabı veriyor.
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Panel açık kalıp kullanıcı sekme değiştirdiğinde bakılan sayfa da değişmeli
  // — kenetli olduğu pencereyi izliyor. Açılır pencerede böyle bir şey olamaz,
  // o zaten sekme değişince kapanmış oluyor.
  if (IN_PANEL) {
    $('#pin').classList.add('hidden');   // zaten paneldeyiz
    chrome.tabs.onActivated.addListener(async ({ tabId }) => {
      if (!tab || tabId === tab.id) return;
      try {
        // Sekme DEĞİŞTİRME, sekmenin gezinmesi değil: süren bir gezme varsa
        // durdurmuyoruz. Gezme bir sekmeye ait ve arka planda sürüyor;
        // kullanıcının başka sekmeye bakması onu iptal etmemeli.
        await navigated(await chrome.tabs.get(tabId), true);
      } catch {
        // Sekme o arada kapanmış olabilir; bir sonraki değişimde toparlanır.
      }
    });
  }

  // Önceki seçimleri geri yükle (popup kapanıp açılmış olabilir).
  const saved = await chrome.storage.session.get([keySel(), keyDone()]);
  selected = new Set(saved[keySel()] || []);
  done = new Set(saved[keyDone()] || []);

  // Gezme worker'da sürüyor olabilir: popup kapalıyken başlatılmış olabileceği
  // gibi, bu açılıştan önce bitmiş de olabilir. Düğmeleri ona göre çiziyoruz.
  await refreshSweep();

  await refresh(true);
  await initYt();
  startLive();
})();
