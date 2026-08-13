// ---------------------------------------------------------------------------
// Popup: sayfayı tarat, sonuçları ızgarada göster, seçilenleri service
// worker'daki kuyruğa yolla.
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

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
  const rest = [];
  for (const [k, v] of u.searchParams) {
    if (Q_PARAM.test(k)) {
      if (!tag && /^\d{3,4}$/.test(v) && HEIGHTS.test(v)) tag = v + 'p';
      continue;
    }
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

// Anahtar -> grup. Canlı gelen bir varyant yeni kart açmak yerine mevcut
// kartın altına düşsün diye çizimler arasında saklanıyor.
let groupIndex = new Map();

/** Gruptaki en iyi kaliteyi karta çıkarır, kalanı `_vars` olarak altına asılır. */
function settle(g) {
  g.items.sort((a, b) => qRank(b) - qRank(a) || (b.size || 0) - (a.size || 0));
  for (const m of g.items) m._vars = null;
  // Hiçbirinde kalite damgası yoksa bunlar varyant değil, adaş dosyalardır.
  g.primary = g.items[0];
  g.primary._vars = g.items.length > 1 && g.items.some((m) => m._qtag) ? g.items : null;
  return g.primary;
}

/** Listeyi kartlara indirger: varyantlar tek kartta toplanır. */
function groupVariants(list) {
  groupIndex = new Map();
  const slots = [];

  for (const m of list) {
    m._vars = null;
    m._qtag = '';
    const k = m.kind === 'video' ? variantKey(m.url) : null;
    if (!k) {
      slots.push(m);
      continue;
    }
    m._qtag = k.tag;

    const g = groupIndex.get(k.key);
    if (g) {
      g.items.push(m);
    } else {
      const ng = { items: [m], primary: m };
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
let capped = false;

// Sonsuz kaydırılan bir sayfada popup saatlerce açık kalabilir; liste sınırsız
// büyürse popup kilitlenir. Üst sınıra gelince yeni gelenleri almayı bırakıyoruz.
const MAX_ITEMS = 3000;

/** Havuza katar; sadece gerçekten yeni olanları döndürür. */
function absorb(items) {
  const fresh = [];
  for (const it of items || []) {
    if (!it || !it.url) continue;
    const prev = byUrl.get(it.url);
    if (prev) {
      // Aynı URL birden çok yerden geldiyse en zengin bilgiyi tut.
      if (area(it) > area(prev)) Object.assign(prev, it);
      if (!prev.size && it.size) prev.size = it.size;
    } else if (byUrl.size >= MAX_ITEMS) {
      capped = true;
    } else {
      byUrl.set(it.url, it);
      fresh.push(it);
    }
  }
  return fresh;
}

function showNotice() {
  const msgs = [];
  if (blobSeen) {
    msgs.push(`${blobSeen} adet blob: video atlandı — bunlar parçalı akış (HLS/DASH) ve eklentiden indirilemez.`);
  }
  if (capped) {
    msgs.push(`Liste ${MAX_ITEMS} öğede doldu; yeni gelenler eklenmiyor. Seçtiklerini indirip popup'ı yeniden aç.`);
  }
  notice.textContent = msgs.join(' ');
  notice.classList.toggle('hidden', !msgs.length);
}

let scanning = false;

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
        grid.innerHTML = `<div class="empty">Bu sayfa taranamıyor.<br><span class="small">${e.message}</span></div>`;
      }
      return;
    }

    const found = [];
    let blobs = 0;
    for (const f of frames) {
      const r = f.result;
      if (!r || r.unchanged) continue;   // o çerçevede değişen bir şey yok
      found.push(...r.items);
      blobs += r.unsupported.length;
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
    return;
  }

  // Sayfa değiştiyse (adres çubuğundan ya da SPA gezinmesiyle) liste artık
  // başka bir sayfaya ait; sıfırdan kur.
  if (cur.url !== tab.url) {
    await navigated(cur);
    return;
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

async function navigated(cur) {
  tab = cur;
  ticks = 0;

  byUrl.clear();
  blobSeen = 0;
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
}

// --- render ----------------------------------------------------------------

function matches(m) {
  const q = $('#search').value.trim().toLowerCase();
  const minW = parseInt($('#minWidth').value, 10) || 0;

  if (kindFilter !== 'all' && m.kind !== kindFilter) return false;
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
      ph.textContent = ext(m.url) || 'resim';
      img.replaceWith(ph);
    };
    card.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'ph video';
    ph.textContent = '▶ ' + (ext(m.url) || 'video');
    card.appendChild(ph);
  }

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = m.net ? 'ağ' : m.kind === 'video' ? 'video' : ext(m.url) || 'resim';
  card.appendChild(tag);

  const tick = document.createElement('span');
  tick.className = 'tick';
  card.appendChild(tick);

  if (done.has(m.url)) {
    const badge = document.createElement('span');
    badge.className = 'done-badge';
    badge.textContent = 'indirildi';
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
    label.textContent += ` · ${m._vars.length} kalite`;
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
  btn.title = `${n} kalite — aç/kapat`;
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
    name.textContent = qLabel(v) + (v === m ? ' · en iyi' : '');

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
    grid.innerHTML = '<div class="empty">Bu filtrelerle eşleşen medya yok.</div>';
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

  const k = variantKey(m.url);
  if (!k) return false;
  m._qtag = k.tag;

  const g = groupIndex.get(k.key);
  if (!g) {
    groupIndex.set(k.key, { items: [m], primary: m });
    return false;   // grubun ilk üyesi: normal kart olarak eklenecek
  }

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
  $('#stats').textContent = `${seen} gösteriliyor · ${imgs} resim, ${vids} video`;
  $('#selCount').textContent = `${selected.size} seçili`;
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
  const cols = Math.max(1, Math.floor((756 + 8) / (px + 8)));
  $('#sizeLabel').textContent = cols + ' sütun';
}

$('#size').addEventListener('input', (e) => {
  applyTileSize(+e.target.value);
  topUp();          // kartlar büyüyünce boşluk kalırsa devamını çek
  updateCounts();
});

$('#size').addEventListener('change', (e) => saveSetting({ tileSize: +e.target.value }));

// Klasör yolunu panel açılırken soruyoruz: mutlak yol henüz bilinmiyorsa arka
// plan sessiz bir sonda indirmesi yapıyor, bunu her popup açılışında değil
// yalnızca ayarlara bakıldığında yaptırmak daha az sürpriz.
$('#gear').addEventListener('click', () => {
  const panel = $('#settings');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) showFolder();
});

// --- kayıt klasörü ---------------------------------------------------------

// Fotoğraf ve videolar için TEK klasör. Kutuda tam yol duruyor; İndirilenler'in
// mutlak yolunu API vermediği için arka plan onu bir kez sonda indirmesiyle
// öğreniyor, biz hazır değeri istiyoruz.
async function showFolder() {
  const info = await chrome.runtime.sendMessage({ type: 'getFolderInfo' });
  const box = $('#folder');
  box.value = info?.set ? info.abs : '';
  box.placeholder = info?.root || 'İndirilenler klasörü';

  // Bir önceki "Gözat" denemesinin sonucu varsa onu göster: klasör penceresi
  // popup'ı kapattığı için o an gösterilememişti.
  setFolderNote(info?.folderMsg || defaultNote(info), !!info?.folderMsg && !info?.set);
}

function defaultNote(info) {
  if (!info?.set) return 'Fotoğraflar İndirilenler köküne, videolar İndirilenler\\yt-dlp altına iner.';
  if (!info.outside) return 'Fotoğraflar ve videolar buraya iner.';
  return (
    'Fotoğraflar ve videolar buraya iner. Burası İndirilenler dışında olduğu için ' +
    'fotoğrafları köprü taşıyor — köprü kurulu değilse İndirilenler\\' +
    (info.stage || 'pagetrawl-gecici') + ' altında kalırlar.'
  );
}

function setFolderNote(text, bad = false) {
  $('#folderNote').textContent = text;
  $('#folderNote').classList.toggle('err', bad);
}

// Klasörü seçtiren pencereyi köprü açıyor: Chrome'un kendi Kaydet penceresi
// yalnızca İndirilenler altını kabul ediyordu, köprününki her yeri seçebiliyor.
$('#browse').addEventListener('click', () => {
  setFolderNote('Klasör penceresi açılıyor… Popup kapanacak, bu normal — seçtiğin klasör kaydedilir.');
  chrome.runtime.sendMessage({ type: 'pickFolder' });
});

$('#folderReset').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'setFolder', path: '' });
});

// Elle yazılan/yapıştırılan yol: köprü sadece doğruluyor, klasörü indirme
// anında açıyor — yanlış yazılmış bir yol diske çöp klasör bırakmasın.
$('#folder').addEventListener('change', (e) => {
  const path = e.target.value.trim();
  setFolderNote(path ? 'Klasör doğrulanıyor…' : '');
  chrome.runtime.sendMessage({ type: 'setFolder', path });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'folder') return;

  if (msg.note) setFolderNote(msg.note, !!msg.bad);          // ör. taşıma hatası
  else if (msg.error) setFolderNote(msg.error, true);
  else if (msg.canceled) setFolderNote('İptal edildi.');
  else if (msg.path) { $('#folder').value = msg.path; showFolder(); }
  else { $('#folder').value = ''; showFolder(); }
});

$('#saveAs').addEventListener('change', (e) => saveSetting({ saveAs: e.target.checked }));

$('#saveSettings').addEventListener('click', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({
    settings: {
      ...(settings || {}),   // tileSize, folder vs. ezilmesin
      maxConcurrent: Math.max(1, Math.min(10, parseInt($('#maxConcurrent').value, 10) || 4))
    }
  });
  $('#settings').classList.add('hidden');
});

// --- toplu indirme ilerlemesi ----------------------------------------------
// Kuyruk service worker'da işliyor; popup kapansa da sürüyor. Bu yüzden durumu
// açılışta bir kez soruyoruz, sonrası canlı mesajla geliyor.

function renderDl(p) {
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
    ? `İndiriliyor… ${fin}/${p.total}`
    : p.failed
      ? `${p.done} indi · ${p.failed} başarısız`
      : `${p.done} dosya indi`;

  box.classList.remove('hidden');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'dlStatus') renderDl(msg.prog);
  // Ağdan yeni medya yakalandı (DOM'da görünmeyen fetch/lazy içerik).
  if (msg.type === 'netAdded' && tab && msg.tabId === tab.id) ingest(absorb(msg.items));
});

$('#download').addEventListener('click', async () => {
  const items = all.filter((m) => selected.has(m.url)).map((m) => ({ url: m.url, kind: m.kind }));
  if (!items.length) return;

  let host = 'indirilenler';
  try {
    host = new URL(tab.url).hostname;
  } catch {}

  const btn = $('#download');
  btn.disabled = true;
  btn.textContent = 'Kuyruğa alınıyor…';

  const res = await chrome.runtime.sendMessage({ type: 'download', items, host });

  if (res?.ok) {
    // Kuyruğa gidenleri "indirildi" olarak işaretle ve seçimi bırak; popup
    // kapanmıyor, böylece kaldığın yerden devam edip geri kalanları seçebilirsin.
    items.forEach((it) => done.add(it.url));
    selected.clear();
    persist();
    render(true);
    btn.textContent = `${res.count} dosya kuyrukta`;
    setTimeout(() => (btn.textContent = 'Seçilenleri indir'), 1600);
  } else {
    btn.textContent = 'Hata: ' + (res?.error || 'bilinmiyor');
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
function renderYtStatus(s) {
  if (!s) return;

  // Service worker indirme sırasında öldüyse durum "çalışıyor" hâlinde donar ve
  // İndir düğmesi sonsuza kadar kapalı kalırdı. Zaman damgası eskimişse
  // çalışmıyor kabul ediyoruz.
  const stale = s.running && s.at && Date.now() - s.at > 90000;
  const running = !!s.running && !stale;

  let text;
  if (stale) text = 'Durum kayboldu (köprü bağlantısı koptu). Dosya inmiş olabilir — kayıt klasörüne bak.';
  else if (s.error) text = s.error;
  else if (running) text = s.percent ? `İndiriliyor… %${Math.round(s.percent)}` : 'İndiriliyor…';
  else if (s.percent === 100) text = 'İndirildi';
  else text = s.line || '';   // iptal gibi tek seferlik bilgiler

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

  return {
    title: meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') || document.title,
    thumb: meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]'),
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
async function initYt() {
  const forUrl = tab?.url || '';
  const site = siteName(forUrl);
  if (!site) {
    $('#ytbar').classList.add('hidden');
    return;
  }

  $('#ytbar').classList.remove('hidden');
  $('#ytTitle').textContent = trimTitle(tab.title, site) || site + ' videosu';
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
  else $('#ytThumb').removeAttribute('src');   // og:image aşağıda gelirse konur

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
  if (!id && info.thumb) setThumb(info.thumb);
  $('#ytSub').textContent = [author, dur].filter(Boolean).join(' · ') || site;
}

function setThumb(src) {
  const img = $('#ytThumb');
  if (img.getAttribute('src') === src) return;   // aynı kapak: yeniden yükleyip titretme
  img.onerror = () => img.removeAttribute('src');   // kutu boş görünsün, kırık ikon değil
  img.src = src;
}

/** Köprü eksiklerini bildirir. Sadece indirmeyi engelleyecek/kısıtlayacak olanları. */
function renderProbe(p) {
  if (!p || ytBusy) return;   // sürmekte olan indirmenin satırını ezmesin
  let warn = '';
  if (!p.ytdlp) warn = 'yt-dlp bulunamadı — kurulum gerekiyor.';
  else if (!p.js) warn = 'JS motoru yok (deno/node/bun) — YouTube başarısız olabilir.';
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
  renderYtStatus({ running: true, percent: 0, line: 'Başlatılıyor…' });
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

// --- başlat ----------------------------------------------------------------

(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (settings) {
    $('#maxConcurrent').value = settings.maxConcurrent ?? 4;
    $('#saveAs').checked = !!settings.saveAs;
  }

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

  // Önceki "Gözat" denemesi bir sonuç bıraktıysa (popup o an kapandığı için
  // gösterilememişti) ayar panelini kendiliğinden aç ve sonucu göster.
  const { folderMsg } = await chrome.storage.session.get('folderMsg');
  if (folderMsg) {
    $('#settings').classList.remove('hidden');
    showFolder();
  }

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Önceki seçimleri geri yükle (popup kapanıp açılmış olabilir).
  const saved = await chrome.storage.session.get([keySel(), keyDone()]);
  selected = new Set(saved[keySel()] || []);
  done = new Set(saved[keyDone()] || []);

  await refresh(true);
  await initYt();
  startLive();
})();
