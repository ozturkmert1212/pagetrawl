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

function collectMedia(force) {
  const W = window;
  if (!W.__mdInit) {
    W.__mdInit = true;          // kurulum bir kez; başarısız olsa da tekrarlanmasın
    W.__mdWatch = { dirty: true };
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
  // getComputedStyle her element için pahalı; çok büyük sayfalarda atlıyoruz.
  const all = document.querySelectorAll('*');
  if (all.length < 8000) {
    for (const el of all) {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') continue;
      const matches = bg.match(/url\((['"]?)(.*?)\1\)/g);
      if (!matches) continue;
      for (const chunk of matches) {
        const u = chunk.slice(4, -1).replace(/^['"]|['"]$/g, '');
        add(u, 'image', { w: 0, h: 0, bg: true });
      }
    }
  }

  // --- <video> / <audio> ---------------------------------------------------
  for (const v of document.querySelectorAll('video')) {
    add(v.currentSrc || v.src, 'video', {
      w: v.videoWidth || 0,
      h: v.videoHeight || 0,
      dur: Math.round(v.duration) || 0
    });
    for (const s of v.querySelectorAll('source')) {
      add(s.src || s.getAttribute('src'), 'video', { w: 0, h: 0 });
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
    frameUrl: location.href,
    host: location.hostname
  };
}
