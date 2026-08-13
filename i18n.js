// ---------------------------------------------------------------------------
// Popup dilleri. Chrome'un kendi chrome.i18n'i tarayıcı diline bakar ve
// çalışma anında değiştirilemez; burada kullanıcı bayrağa basarak seçiyor,
// o yüzden kendi tablomuzu tutuyoruz.
//
// Anahtar yoksa Türkçeye düşülüyor: yeni bir metin eklenip çevirisi
// unutulursa arayüzde `key.adi` görünmesin.
// ---------------------------------------------------------------------------

const I18N = {
  tr: {
    'lang.tr': 'Türkçe',
    'lang.en': 'İngilizce',

    'chip.all': 'Tümü',
    'chip.image': 'Resim',
    'chip.video': 'Video',
    'search.ph': 'URL içinde ara…',
    'filter.minWidth': 'min genişlik',
    'gear.title': 'Ayarlar',

    'sel.all': 'Tümünü seç',
    'sel.none': 'Temizle',
    'sel.invert': 'Tersle',
    'size.title': 'Kart boyutu',
    'size.cols': '{n} sütun',
    'stats': '{seen} gösteriliyor · {imgs} resim, {vids} video',
    'selCount': '{n} seçili',

    'yt.videoOf': '{site} videosu',
    'yt.mode.best': 'En iyi kalite',
    'yt.mode.1080': "1080p'ye kadar",
    'yt.mode.720': "720p'ye kadar",
    'yt.mode.audio': 'Sadece ses (mp3)',
    'yt.go': 'İndir',
    'yt.cancel': 'İptal',
    'yt.starting': 'Başlatılıyor…',
    'yt.downloading': 'İndiriliyor…',
    'yt.downloadingPct': 'İndiriliyor… %{pct}',
    'yt.downloaded': 'İndirildi',
    'yt.stale': 'Durum kayboldu (köprü bağlantısı koptu). Dosya inmiş olabilir — kayıt klasörüne bak.',
    'probe.noYtdlp': 'yt-dlp bulunamadı — kurulum gerekiyor.',
    'probe.noJs': 'JS motoru yok (deno/node/bun) — YouTube başarısız olabilir.',

    'settings.concurrent': 'Aynı anda indirme',
    'settings.folder': 'Kayıt klasörü (fotoğraf ve video — istediğin yer olabilir)',
    'settings.browse': 'Gözat…',
    'settings.reset': 'Sıfırla',
    'settings.saveAs': 'Her dosyada nereye kaydedileceğini sor',
    'settings.save': 'Kaydet',
    'folder.ph': 'Yol okunuyor…',
    'folder.rootPh': 'İndirilenler klasörü',
    'folder.note.unset': 'Fotoğraflar İndirilenler köküne, videolar İndirilenler\\yt-dlp altına iner.',
    'folder.note.inside': 'Fotoğraflar ve videolar buraya iner.',
    'folder.note.outside':
      'Fotoğraflar ve videolar buraya iner. Burası İndirilenler dışında olduğu için ' +
      'fotoğrafları köprü taşıyor — köprü kurulu değilse İndirilenler\\{stage} altında kalırlar.',
    'folder.opening': 'Klasör penceresi açılıyor… Popup kapanacak, bu normal — seçtiğin klasör kaydedilir.',
    'folder.checking': 'Klasör doğrulanıyor…',
    'folder.canceled': 'İptal edildi.',

    'grid.unscannable': 'Bu sayfa taranamıyor.',
    'grid.noMatch': 'Bu filtrelerle eşleşen medya yok.',
    'notice.blob': '{n} adet blob: video atlandı — bunlar parçalı akış (HLS/DASH) ve eklentiden indirilemez.',
    'notice.capped': "Liste {max} öğede doldu; yeni gelenler eklenmiyor. Seçtiklerini indirip popup'ı yeniden aç.",

    'tag.net': 'ağ',
    'tag.image': 'resim',
    'tag.video': 'video',
    'badge.done': 'indirildi',
    'card.qualities': '{n} kalite',
    'chev.title': '{n} kalite — aç/kapat',
    'var.best': 'en iyi',

    'footer.download': 'Seçilenleri indir',
    'btn.queueing': 'Kuyruğa alınıyor…',
    'btn.queued': '{n} dosya kuyrukta',
    'btn.error': 'Hata: {msg}',
    'err.unknown': 'bilinmiyor',
    'dl.running': 'İndiriliyor… {fin}/{total}',
    'dl.mixed': '{done} indi · {failed} başarısız',
    'dl.done': '{done} dosya indi'
  },

  en: {
    'lang.tr': 'Turkish',
    'lang.en': 'English',

    'chip.all': 'All',
    'chip.image': 'Images',
    'chip.video': 'Video',
    'search.ph': 'Search in URL…',
    'filter.minWidth': 'min width',
    'gear.title': 'Settings',

    'sel.all': 'Select all',
    'sel.none': 'Clear',
    'sel.invert': 'Invert',
    'size.title': 'Card size',
    'size.cols': '{n} columns',
    'stats': '{seen} shown · {imgs} images, {vids} videos',
    'selCount': '{n} selected',

    'yt.videoOf': '{site} video',
    'yt.mode.best': 'Best quality',
    'yt.mode.1080': 'Up to 1080p',
    'yt.mode.720': 'Up to 720p',
    'yt.mode.audio': 'Audio only (mp3)',
    'yt.go': 'Download',
    'yt.cancel': 'Cancel',
    'yt.starting': 'Starting…',
    'yt.downloading': 'Downloading…',
    'yt.downloadingPct': 'Downloading… {pct}%',
    'yt.downloaded': 'Downloaded',
    'yt.stale': 'Status lost (the bridge connection dropped). The file may have downloaded — check the save folder.',
    'probe.noYtdlp': 'yt-dlp not found — it needs to be installed.',
    'probe.noJs': 'No JS runtime (deno/node/bun) — YouTube may fail.',

    'settings.concurrent': 'Concurrent downloads',
    'settings.folder': 'Save folder (images and videos — anywhere you like)',
    'settings.browse': 'Browse…',
    'settings.reset': 'Reset',
    'settings.saveAs': 'Ask where to save each file',
    'settings.save': 'Save',
    'folder.ph': 'Reading path…',
    'folder.rootPh': 'Downloads folder',
    'folder.note.unset': 'Images go to the Downloads root, videos to Downloads\\yt-dlp.',
    'folder.note.inside': 'Images and videos land here.',
    'folder.note.outside':
      'Images and videos land here. Since this is outside Downloads, images are moved ' +
      'by the bridge — without the bridge installed they stay under Downloads\\{stage}.',
    'folder.opening': 'Opening the folder window… The popup will close, which is normal — your choice is saved.',
    'folder.checking': 'Validating folder…',
    'folder.canceled': 'Canceled.',

    'grid.unscannable': "This page can't be scanned.",
    'grid.noMatch': 'No media matches these filters.',
    'notice.blob': "Skipped {n} blob: video(s) — these are segmented streams (HLS/DASH) and can't be downloaded from the extension.",
    'notice.capped': 'The list filled up at {max} items; new ones are no longer added. Download your selection and reopen the popup.',

    'tag.net': 'network',
    'tag.image': 'image',
    'tag.video': 'video',
    'badge.done': 'downloaded',
    'card.qualities': '{n} qualities',
    'chev.title': '{n} qualities — expand/collapse',
    'var.best': 'best',

    'footer.download': 'Download selected',
    'btn.queueing': 'Queueing…',
    'btn.queued': '{n} files queued',
    'btn.error': 'Error: {msg}',
    'err.unknown': 'unknown',
    'dl.running': 'Downloading… {fin}/{total}',
    'dl.mixed': '{done} downloaded · {failed} failed',
    'dl.done': '{done} files downloaded'
  }
};

const DEFAULT_LANG = 'tr';
let LANG = DEFAULT_LANG;

/** Seçili dil. */
function getLang() {
  return LANG;
}

function setLang(lang) {
  LANG = I18N[lang] ? lang : DEFAULT_LANG;
  document.documentElement.lang = LANG;
}

/** Çeviri + `{ad}` yer tutucularını doldurma. Anahtar yoksa Türkçeye düşer. */
function t(key, vars) {
  let s = I18N[LANG]?.[key] ?? I18N[DEFAULT_LANG][key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(v);
  }
  return s;
}

/**
 * HTML'deki sabit metinleri tazeler. Dil değişince yeniden çağrılıyor, o yüzden
 * metni doğrudan yazmak yerine her seferinde anahtardan üretiyoruz.
 */
function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
}
