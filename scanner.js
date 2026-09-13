// ---------------------------------------------------------------------------
// Sayfa tarayıcısı. Bu fonksiyon chrome.scripting.executeScript ile sayfaya
// enjekte edilir, yani METNE ÇEVRİLİR: dışarıdaki hiçbir değişkene/fonksiyona
// erişemez. Tüm yardımcılar içeride tanımlı olmalı.
//
// Popup açık kaldığı sürece saniyede bir çağrılıyor (canlı liste). Her turda
// tüm DOM'u taramak — özellikle getComputedStyle döngüsü — pahalı olurdu; bu
// yüzden sayfaya bir MutationObserver kurup "değişti mi" bayrağı tutuyoruz.
// executeScript'in izole dünyası çağrılar arasında yaşadığı için bayrak orada
// kalıcı. force=true gelirse bayrağa bakmadan tarıyoruz.
// ---------------------------------------------------------------------------

async function collectMedia(force) {
  const W = window;
  if (!W.__mdInit) {
    W.__mdInit = true;          // kurulum bir kez; başarısız olsa da tekrarlanmasın
    W.__mdWatch = { dirty: true };
    W.__mdDrm = new WeakSet();  // `encrypted` olayı geçmiş <video>'lar
    try {
      new MutationObserver(() => { W.__mdWatch.dirty = true; }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'poster', 'href', 'style', 'data-src', 'data-srcset']
      });
      // Lazy görsellerde src baştan doğru olabilir; asıl boyut ancak yüklenince
      // okunuyor. load olayı bubble etmediği için yakalama fazında dinliyoruz.
      W.addEventListener('load', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO')) W.__mdWatch.dirty = true;
      }, true);
      // DRM (EME) tespitinin ilk sinyali: `encrypted`, şifreli içerik görüldüğü
      // anda medya elemanında ateşleniyor. `load` gibi bubble ETMEDİĞİ için yine
      // yakalama fazında dinliyoruz. Olay bir kez geçiyor, tarama ise saniyede
      // bir çalışıyor — o yüzden elemanı kalıcı bir sette tutuyoruz.
      W.addEventListener('encrypted', (e) => {
        if (e.target) W.__mdDrm.add(e.target);
        if (W.__mdWatch) W.__mdWatch.dirty = true;
      }, true);
    } catch {
      // Gözlemci kurulamadıysa (nadir) her turda tam tarama yapılsın.
      W.__mdWatch = null;
    }
  }

  if (!force && W.__mdWatch && !W.__mdWatch.dirty) return { unchanged: true };
  if (W.__mdWatch) W.__mdWatch.dirty = false;

  const items = [];
  const unsupported = [];
  const seen = new Set();
  let drmCount = 0;           // DRM (EME) korumalı <video> sayısı

  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?|heic)(\?|#|$)/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|m4v|ogv)(\?|#|$)/i;

  const abs = (u) => {
    if (!u) return null;
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return null;
    }
  };

  const add = (raw, kind, meta) => {
    const url = abs(raw);
    if (!url) return;

    if (url.startsWith('blob:')) {
      // blob: URL'leri yalnızca o sayfanın belleğinde yaşar; eklenti bağlamından
      // indirilemez. Kullanıcıya "yakalandı ama alınamıyor" diye göstereceğiz.
      // (DRM'li videolar buraya HİÇ gelmiyor — onları `addDrm` ayrı ele alıyor,
      // çünkü "yt-dlp'yi kullan" tavsiyesi onlar için yanlış olurdu.)
      if (!seen.has(url)) {
        seen.add(url);
        unsupported.push({ url, kind, reason: 'blob' });
      }
      return;
    }
    if (!/^https?:|^data:/.test(url)) return;
    if (url.startsWith('data:') && url.length < 2048) return; // ufak inline ikonlar
    if (seen.has(url)) return;

    seen.add(url);
    items.push(Object.assign({ url, kind }, meta || {}));
  };

  /** srcset içindeki en büyük varyantı seçer. */
  const fromSrcset = (ss) => {
    if (!ss) return null;
    let best = null;
    let bestScore = -1;
    for (const part of ss.split(',')) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      const d = bits[1] || '';
      let score = 0;
      if (d.endsWith('w')) score = parseInt(d, 10) || 0;
      else if (d.endsWith('x')) score = (parseFloat(d) || 1) * 1000;
      if (score > bestScore) {
        bestScore = score;
        best = bits[0];
      }
    }
    return best;
  };

  /**
   * Video DRM (EME) korumalı mı? İki sinyal birbirini tamamlıyor, ikisi de
   * KESİN — tahmin değil:
   *   - `mediaKeys`: oynatıcı anahtarları bağladıysa dolu kalıyor, yani her
   *     turda okunabilen kalıcı bir durum. Ama ancak setMediaKeys() bittikten
   *     SONRA doluyor; ondan önceki turlarda boş görünür.
   *   - `encrypted` olayı: şifreli içerik görüldüğü anda, anahtarlar daha
   *     bağlanmadan ateşleniyor. Biz dinleyiciyi kurmadan önce geçtiyse onu
   *     kaçırırız — o boşluğu da `mediaKeys` kapatıyor.
   * Tek başına hiçbiri yetmiyor; birlikte hem erken hem geç hâli yakalıyorlar.
   */
  const isDrm = (v) => {
    try {
      if (v.mediaKeys) return true;
    } catch {
      // EME desteklemeyen/kısıtlı bağlamda özellik erişilemeyebilir.
    }
    return !!(W.__mdDrm && W.__mdDrm.has(v));
  };

  /**
   * DRM'li videoyu ızgaraya KİLİTLİ bir kart olarak koyar.
   *
   * İndirilemeyecek bir şeyi listelemek ilk bakışta ters görünüyor, ama asıl
   * soru "bu sayfadaki video neden listede yok?" ve sessiz kalmak kullanıcıyı
   * kendi kurulumunu suçlamaya bırakıyor. Kart, sebebi söylediği için var.
   *
   * Eleman başına TEK kart: `<video>`nun öteki kaynakları ayrı kart olsaydı
   * kullanıcı için orada tek bir video varken listede üç satır görünürdü — v1.26
   * parçalı akışta öğrenilen ders. Onları `unsupported`'a da atmıyoruz, çünkü o
   * sayı "yt-dlp bunları alabilir" demek.
   */
  const addDrm = (v, src) => {
    // Kaynağı henüz bağlanmamış DRM videosu da olabiliyor; kartı yine de
    // göstermek istediğimiz için elemana sabit bir kimlik üretiyoruz. Kimliğin
    // tarama turları arasında DEĞİŞMEMESİ şart, yoksa kart her turda yeniden
    // çizilir — `grp`teki ile aynı gerekçe.
    const url = abs(src) || `drm:${location.href}#${drmCount}`;
    if (seen.has(url)) return;
    seen.add(url);
    items.push({
      url,
      kind: 'video',
      drm: true,
      // Kapak varsa kartın küçük resmi o olur; yoksa popup ▶ döşemesini koyuyor.
      poster: abs(v.poster) || '',
      w: v.videoWidth || 0,
      h: v.videoHeight || 0,
      dur: Math.round(v.duration) || 0
    });
  };

  // --- <img> ---------------------------------------------------------------
  for (const img of document.querySelectorAll('img')) {
    const lazy =
      img.dataset.src ||
      img.dataset.original ||
      img.dataset.lazySrc ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-srcset');

    const cand = fromSrcset(img.getAttribute('srcset')) || img.currentSrc || img.src || lazy;
    add(cand, 'image', {
      w: img.naturalWidth || img.width || 0,
      h: img.naturalHeight || img.height || 0,
      alt: (img.alt || '').slice(0, 80)
    });

    // Lazy-load'da currentSrc placeholder olabilir; data-src'yi de ayrıca ekle.
    if (lazy && lazy !== cand) add(lazy, 'image', { w: 0, h: 0 });
  }

  // --- <picture><source> ---------------------------------------------------
  for (const s of document.querySelectorAll('picture source')) {
    add(fromSrcset(s.getAttribute('srcset')) || s.getAttribute('src'), 'image', { w: 0, h: 0 });
  }

  // --- CSS background-image ------------------------------------------------
  // getComputedStyle her element için pahalı (her çağrı stil hesabı zorlar).
  // Eskiden 8000 elementten büyük sayfalarda bu tarama TAMAMEN atlanıyordu:
  // büyük galerilerde arka plan görselleri hiç listelenmiyordu ve kullanıcı
  // bunu göremiyordu bile. Artık iş parçalara bölünüp tarayıcının boş anlarında
  // (requestIdleCallback) yapılıyor — sayfa donmuyor, sınır da kalktı.
  const all = document.querySelectorAll('*');
  let bgTruncated = false;

  const scanBg = (from, to) => {
    for (let i = from; i < to; i++) {
      const bg = getComputedStyle(all[i]).backgroundImage;
      if (!bg || bg === 'none') continue;
      const matches = bg.match(/url\((['"]?)(.*?)\1\)/g);
      if (!matches) continue;
      for (const chunk of matches) {
        const u = chunk.slice(4, -1).replace(/^['"]|['"]$/g, '');
        add(u, 'image', { w: 0, h: 0, bg: true });
      }
    }
  };

  if (typeof requestIdleCallback === 'function') {
    const BUDGET_MS = 3000;   // tek tarama turunun üst sınırı
    const CHUNK = 250;
    const started = Date.now();
    let i = 0;

    while (i < all.length) {
      if (Date.now() - started > BUDGET_MS) {
        bgTruncated = true;
        break;
      }
      // timeout şart: meşgul bir sayfada boş an hiç gelmeyebilir ve tarama
      // sonsuza kadar beklerdi.
      const deadline = await new Promise((res) => requestIdleCallback(res, { timeout: 300 }));
      do {
        const end = Math.min(i + CHUNK, all.length);
        scanBg(i, end);
        i = end;
      } while (i < all.length && deadline.timeRemaining() > 4);
    }
  } else if (all.length < 8000) {
    // requestIdleCallback yoksa eski davranış: küçük sayfalarda tek seferde.
    scanBg(0, all.length);
  } else {
    bgTruncated = true;
  }

  // --- <video> -------------------------------------------------------------
  for (const v of document.querySelectorAll('video')) {
    // Bir <video>'nun currentSrc'si ve <source> çocukları TANIM GEREĞİ aynı
    // videonun farklı kodlamaları (mp4 + webm, ya da farklı çözünürlükler).
    // Bunu ortak bir `grp` ile işaretliyoruz: popup onları tek kartta
    // toplarken URL'den kalite damgası çıkarmaya çalışmak zorunda kalmıyor.
    // Damgasız CDN adreslerinde tek kesin bilgi bu.
    //
    // `grp` ilk bulunan adres: tarama turları arasında sabit kalsın, yoksa her
    // turda yeni bir grup açılır ve kart sürekli yeniden çizilirdi.
    const srcs = [v.currentSrc || v.src];
    for (const s of v.querySelectorAll('source')) srcs.push(s.src || s.getAttribute('src'));

    const grp = srcs.find((u) => u && !u.startsWith('blob:')) || '';

    // Sayım ELEMAN üzerinden: kullanıcıya söylediğimiz şey "1 video DRM
    // korumalı", kaç farklı blob adresi gördüğümüz değil.
    if (isDrm(v)) {
      drmCount++;
      addDrm(v, srcs[0]);
    } else {
      add(srcs[0], 'video', {
        w: v.videoWidth || 0,
        h: v.videoHeight || 0,
        dur: Math.round(v.duration) || 0,
        grp
      });
      for (let i = 1; i < srcs.length; i++) add(srcs[i], 'video', { w: 0, h: 0, grp });
    }

    if (v.poster) add(v.poster, 'image', { w: 0, h: 0, poster: true });
  }

  // --- medyaya giden <a> bağlantıları --------------------------------------
  // Galeri sitelerinde küçük resim, tam boy dosyaya link verir — asıl istediğin
  // genelde budur.
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (VIDEO_EXT.test(href)) add(href, 'video', { w: 0, h: 0, fromLink: true });
    else if (IMAGE_EXT.test(href)) add(href, 'image', { w: 0, h: 0, fromLink: true });
  }

  return {
    items,
    unsupported,
    drm: drmCount,
    bgTruncated,
    frameUrl: location.href,
    host: location.hostname
  };
}
