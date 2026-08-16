// ---------------------------------------------------------------------------
// Arayüz dilleri. Chrome'un kendi chrome.i18n'i tarayıcı diline bakar ve
// çalışma anında değiştirilemez; burada kullanıcı bayrağa basarak seçiyor,
// o yüzden kendi tablomuzu tutuyoruz.
//
// Bu dosyayı popup `<script>` ile, service worker `importScripts()` ile
// yüklüyor — worker'ın ürettiği metinler (sağ tık menüsü, köprü hataları) de
// çevrilebilsin diye. Bu yüzden burada `document`'a koşulsuz dokunulmuyor.
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
    'chip.net': 'Ağ',
    'chip.netTitle':
      'Yalnızca ağ trafiğinden yakalananlar — sayfanın DOM\'unda hiç görünmeyen, ' +
      'JS ile çekilen medya. Resim de video da olabilir.',
    'search.ph': 'URL içinde ara…',
    'filter.minWidth': 'min genişlik',
    'gear.title': 'Ayarlar',
    'pin.title':
      'Yan panelde aç — başka yere tıklayınca kapanmaz, sen kapatana kadar açık kalır. ' +
      'Chrome açılır pencereyi odak kaybında kapatıyor ve bu engellenemiyor; ' +
      'yan panel o kurala tabi değil. Panel, baktığın sekmeyi izler.',
    'pin.gone': 'Bu sekme kapandı.',

    'sel.all': 'Tümünü seç',
    'sel.none': 'Temizle',
    'sel.invert': 'Tersle',
    'sweep.start': 'Sayfayı gez',
    'sweep.stop': 'Durdur',
    'sweep.title':
      'Sonsuz kaydırmalı sayfayı senin yerine aşağı kaydırır, yeni yüklenen medyayı listeye katar. ' +
      'Bittiğinde sayfa bulunduğun yere geri döner.',
    'sweep.right': 'Sağa gez',
    'sweep.rightTitle':
      'Sayfaya sağ ok tuşuna basılıyormuş gibi yapar — slayt gösterisi ve ' +
      'lightbox galerilerinde bir sonraki görsele geçirir. Yeni medya gelmeyi ' +
      'kesince kendiliğinden durur. Sayfa geri sarılmaz.',
    'sweep.running': 'geziliyor… +{n}',
    'sweep.end': 'Sayfa sonuna gelindi · +{n} yeni',
    'sweep.rightEnd': 'Yeni medya gelmiyor · +{n} yeni',
    'sweep.stopped': 'Durduruldu · +{n} yeni',
    'sweep.limit': 'Gezme sınırına gelindi · +{n} yeni',
    'sweep.blocked': 'Bu sayfa gezilemiyor.',
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
    'folder.checking': 'Klasör doğrulanıyor…',
    'folder.opening': 'Klasör penceresi açılıyor… Popup kapanacak, bu normal — seçtiğin klasör kaydedilir ve buraya döndüğünde görünür.',
    'settings.back': 'Geri',
    'opt.saved': 'Kaydedildi.',
    'settings.template': 'Dosya adı şablonu',
    'settings.templateHint':
      'Kullanılabilir alanlar: {host} site adı · {title} sayfa başlığı · {name} dosya adı · ' +
      '{ext} uzantı · {date} tarih (YYYY-AA-GG). Eğik çizgi alt klasör açar. ' +
      '{title} boşsa yerine site adı yazılır.',
    'folder.canceled': 'İptal edildi.',

    'hist.title': 'İndirme geçmişi',
    'hist.gear': 'İndirme geçmişi — hangi sayfadan ne indi',
    'hist.search.ph': 'Dosya, sayfa ya da URL ara…',
    'hist.empty': 'Henüz indirme yok.',
    'hist.noMatch': 'Aramayla eşleşen kayıt yok.',
    'hist.clear': 'Geçmişi temizle',
    'hist.cleared': 'Geçmiş temizlendi.',
    'hist.count': '{n} kayıt',
    'hist.files': '{n} dosya',
    'hist.ok': 'indi',
    'hist.failed': 'başarısız',
    'hist.pending': 'sürüyor',
    'hist.openPage': 'Sayfayı yeni sekmede aç',
    'hist.reveal': 'Dosyayı klasörde göster',
    'hist.movedTo': 'Köprü şuraya taşıdı: {path}',
    'hist.unknownPage': 'Bilinmeyen sayfa',
    'hist.selected': '{n} seçili',
    'hist.selectAll': 'Bu sayfadakilerin hepsini seç',
    'hist.deleted': 'silindi',

    'del.button': 'Seçilen dosyaları sil',
    'del.confirm': '{n} dosya diskten kalıcı olarak silinecek. Geri alınamaz.',
    'del.yes': 'Evet, sil',
    'del.no': 'Vazgeç',
    'del.working': 'Siliniyor…',
    'del.done': '{n} dosya silindi.',
    'del.partial': '{n} dosya silindi, {f} tanesi silinemedi.',
    'del.none': 'Hiçbir dosya silinemedi.',
    'del.err.outside':
      'kayıt klasörünün dışında — köprü oraya dokunmuyor, elle silmen gerekiyor',
    'del.err.notfile': 'dosya değil (klasör ya da bağlantı)',
    'del.err.notabs': 'geçersiz yol',
    'del.err.oserr': 'işletim sistemi izin vermedi',
    'del.err.nobridge': 'köprü yanıt vermedi — kayıt klasörü İndirilenler dışında olduğu için silmeyi o yapmalıydı',

    'grid.unscannable': 'Bu sayfa taranamıyor.',
    'grid.noMatch': 'Bu filtrelerle eşleşen medya yok.',
    'notice.dash':
      'Bu sayfadaki video parçalı akış (DASH/HLS). Listedeki .mpd/.m3u8 bir liste dosyası, ' +
      'yanındaki mp4\'ler de ayrı görüntü ve ses parçaları — biri tek başına indirilirse ' +
      'sessiz video ya da görüntüsüz ses olur. Tamamı için üstteki yt-dlp barını kullan.',
    'notice.drm':
      '{n} video DRM korumalı (Widevine) — şifreli geldiği için ne eklenti ne de ' +
      'yt-dlp indirebilir. Izgarada kilitli kart olarak duruyorlar.',
    'notice.blob': '{n} adet blob: video atlandı — bunlar parçalı akış (HLS/DASH) ve eklentiden indirilemez.',
    'notice.capped': "Liste {max} öğede doldu; yeni gelenler eklenmiyor. Seçtiklerini indirip popup'ı yeniden aç.",
    'notice.bgTruncated': 'Sayfa çok büyük olduğu için CSS arka plan görsellerinin bir kısmı taranamadı.',

    'tag.net': 'ağ',
    'tag.drm': 'DRM',
    'drm.locked': 'indirilemez',
    'drm.cardTitle':
      'Bu video DRM korumalı (Widevine): şifreli geldiği için ne eklenti ne de yt-dlp indirebilir.',
    'tag.manifest': 'akış',
    'tag.manifestTitle':
      'Parçalı akışın liste dosyası. Bunu seçip indirirsen yt-dlp çalışır ve ' +
      'görüntüyle sesi birleştirip tek dosya verir — bu sayfadaki videoyu almanın doğru yolu.',
    'tag.image': 'resim',
    'tag.video': 'video',
    'badge.done': 'indirildi',
    'card.qualities': '{n} kalite',
    'chev.title': '{n} kalite — aç/kapat',
    'var.best': 'en iyi',

    'footer.download': 'Seçilenleri indir',
    'btn.queueing': 'Kuyruğa alınıyor…',
    'btn.queued': '{n} dosya kuyrukta',
    'btn.queuedYt': '{n} akış yt-dlp kuyruğunda',
    'yt.left': 'sırada {n} tane daha',
    'btn.error': 'Hata: {msg}',
    'err.unknown': 'bilinmiyor',
    'dl.running': 'İndiriliyor… {fin}/{total}',
    'dl.mixed': '{done} indi · {failed} başarısız',
    'dl.done': '{done} dosya indi',

    // --- service worker + köprü (background.js, ytdlp_host.py) --------------
    'action.title': 'PageTrawl — sayfadaki medyayı indir',
    'menu.media': 'Bu medyayı indir',
    'menu.link': 'Bağlantıyı indir',
    'wk.folderUpdated': 'Kayıt klasörü güncellendi.',
    'wk.moveNoBridge': 'Köprü çalışmadığı için dosyalar taşınamadı; İndirilenler\\{stage} altında duruyorlar.',
    'wk.moveFailed': 'Dosya taşınamadı: {err}',
    'wk.movesLost': 'Köprü bağlantısı koptuğu için {n} dosya taşınamadı; İndirilenler\\{stage} altındalar.',
    'wk.dlCanceled': 'İndirme iptal edildi.',
    'wk.dlFailed': 'İndirme başarısız oldu (kod {code}).',
    'wk.bridgeMissing': 'Köprü kurulu değil. Klasörde `.\\setup-native.ps1 -ExtensionId {id}` komutunu çalıştır.',
    'wk.bridgeLost': 'Köprü bağlantısı koptu. İndirme arka planda tamamlanmış olabilir — kayıt klasörüne bak.',
    'wk.cancelNoPort': 'Bağlantı kopmuş olduğu için iptal edilemedi; indirme arka planda sürüyor olabilir.',
    'host.pickdirFailed': 'Klasör penceresi açılamadı: {err}',
    'host.pathUnreadable': 'Yol okunamadı: {err}',
    'host.notADir': 'Burası bir klasör değil: {path}',
    'host.noSuchDir': 'Böyle bir klasör yok: {path}',
    'host.cookieRetry': 'Çerezli deneme başarısız, çerezsiz deneniyor…',
    'host.canceling': 'İptal ediliyor…',
    'host.noRunning': 'İptal edilecek çalışan indirme bulunamadı.'
  },

  en: {
    'lang.tr': 'Turkish',
    'lang.en': 'English',

    'chip.all': 'All',
    'chip.image': 'Images',
    'chip.video': 'Video',
    'chip.net': 'Network',
    'chip.netTitle':
      'Only what was captured from network traffic — media fetched by JS that ' +
      'never appears in the page DOM. Can be images or video.',
    'search.ph': 'Search in URL…',
    'filter.minWidth': 'min width',
    'gear.title': 'Settings',
    'pin.title':
      'Open in the side panel — it does not close when you click elsewhere and stays ' +
      'until you close it. Chrome closes the action popup as soon as it loses focus and ' +
      'that cannot be prevented; the side panel is not subject to that rule. The panel ' +
      'follows whichever tab you are looking at.',
    'pin.gone': 'This tab has been closed.',

    'sel.all': 'Select all',
    'sel.none': 'Clear',
    'sel.invert': 'Invert',
    'sweep.start': 'Sweep page',
    'sweep.stop': 'Stop',
    'sweep.title':
      'Scrolls an infinite-scroll page down for you and adds newly loaded media to the list. ' +
      'When it finishes the page returns to where you were.',
    'sweep.right': 'Sweep right',
    'sweep.rightTitle':
      'Presses the right arrow key on the page for you — advances slideshows ' +
      'and lightbox galleries to the next image. Stops on its own once no new ' +
      'media arrives. The page is not rewound afterwards.',
    'sweep.running': 'sweeping… +{n}',
    'sweep.end': 'Reached the end of the page · +{n} new',
    'sweep.rightEnd': 'No new media arriving · +{n} new',
    'sweep.stopped': 'Stopped · +{n} new',
    'sweep.limit': 'Sweep limit reached · +{n} new',
    'sweep.blocked': "This page can't be swept.",
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
    'folder.checking': 'Validating folder…',
    'folder.opening': 'Opening the folder window… The popup will close, which is normal — your choice is saved and shown when you come back.',
    'settings.back': 'Back',
    'opt.saved': 'Saved.',
    'settings.template': 'Filename template',
    'settings.templateHint':
      'Available fields: {host} site name · {title} page title · {name} file name · ' +
      '{ext} extension · {date} date (YYYY-MM-DD). A slash creates a subfolder. ' +
      'If {title} is empty the site name is used instead.',
    'folder.canceled': 'Canceled.',

    'hist.title': 'Download history',
    'hist.gear': 'Download history — what came from which page',
    'hist.search.ph': 'Search file, page or URL…',
    'hist.empty': 'No downloads yet.',
    'hist.noMatch': 'No entries match your search.',
    'hist.clear': 'Clear history',
    'hist.cleared': 'History cleared.',
    'hist.count': '{n} entries',
    'hist.files': '{n} files',
    'hist.ok': 'done',
    'hist.failed': 'failed',
    'hist.pending': 'running',
    'hist.openPage': 'Open the page in a new tab',
    'hist.reveal': 'Show the file in its folder',
    'hist.movedTo': 'The bridge moved it to: {path}',
    'hist.unknownPage': 'Unknown page',
    'hist.selected': '{n} selected',
    'hist.selectAll': 'Select everything from this page',
    'hist.deleted': 'deleted',

    'del.button': 'Delete selected files',
    'del.confirm': '{n} file(s) will be permanently deleted from disk. This cannot be undone.',
    'del.yes': 'Yes, delete',
    'del.no': 'Cancel',
    'del.working': 'Deleting…',
    'del.done': '{n} file(s) deleted.',
    'del.partial': '{n} file(s) deleted, {f} could not be deleted.',
    'del.none': 'No files could be deleted.',
    'del.err.outside': 'outside the save folder — the bridge will not touch it, delete it manually',
    'del.err.notfile': 'not a file (a folder or a link)',
    'del.err.notabs': 'invalid path',
    'del.err.oserr': 'the operating system refused',
    'del.err.nobridge': 'the bridge did not respond — it had to do the deleting because the save folder is outside Downloads',

    'grid.unscannable': "This page can't be scanned.",
    'grid.noMatch': 'No media matches these filters.',
    'notice.dash':
      'The video on this page is a segmented stream (DASH/HLS). The .mpd/.m3u8 in the list is ' +
      'a playlist file and the mp4s next to it are separate video and audio tracks — downloading ' +
      'one on its own gives you a silent video or audio with no picture. Use the yt-dlp bar above ' +
      'to get the whole thing.',
    'notice.drm':
      '{n} video(s) are DRM-protected (Widevine) — they arrive encrypted, so neither the ' +
      'extension nor yt-dlp can download them. They appear in the grid as locked cards.',
    'notice.blob': "Skipped {n} blob: video(s) — these are segmented streams (HLS/DASH) and can't be downloaded from the extension.",
    'notice.capped': 'The list filled up at {max} items; new ones are no longer added. Download your selection and reopen the popup.',
    'notice.bgTruncated': 'The page is very large, so some CSS background images could not be scanned.',

    'tag.net': 'network',
    'tag.drm': 'DRM',
    'drm.locked': "can't be downloaded",
    'drm.cardTitle':
      'This video is DRM-protected (Widevine): it arrives encrypted, so neither the ' +
      'extension nor yt-dlp can download it.',
    'tag.manifest': 'stream',
    'tag.manifestTitle':
      'The playlist file of a segmented stream. Selecting and downloading this runs yt-dlp, ' +
      'which merges the video and audio into one file — the right way to get the video on this page.',
    'tag.image': 'image',
    'tag.video': 'video',
    'badge.done': 'downloaded',
    'card.qualities': '{n} qualities',
    'chev.title': '{n} qualities — expand/collapse',
    'var.best': 'best',

    'footer.download': 'Download selected',
    'btn.queueing': 'Queueing…',
    'btn.queued': '{n} files queued',
    'btn.queuedYt': '{n} stream(s) queued for yt-dlp',
    'yt.left': '{n} more queued',
    'btn.error': 'Error: {msg}',
    'err.unknown': 'unknown',
    'dl.running': 'Downloading… {fin}/{total}',
    'dl.mixed': '{done} downloaded · {failed} failed',
    'dl.done': '{done} files downloaded',

    // --- service worker + bridge (background.js, ytdlp_host.py) ------------
    'action.title': 'PageTrawl — download media from this page',
    'menu.media': 'Download this media',
    'menu.link': 'Download link',
    'wk.folderUpdated': 'Save folder updated.',
    'wk.moveNoBridge': "The bridge isn't running, so files couldn't be moved; they're sitting under Downloads\\{stage}.",
    'wk.moveFailed': "File couldn't be moved: {err}",
    'wk.movesLost': 'The bridge connection dropped, so {n} file(s) were not moved; they are under Downloads\\{stage}.',
    'wk.dlCanceled': 'Download canceled.',
    'wk.dlFailed': 'Download failed (code {code}).',
    'wk.bridgeMissing': 'The bridge is not installed. Run `.\\setup-native.ps1 -ExtensionId {id}` in the extension folder.',
    'wk.bridgeLost': 'The bridge connection dropped. The download may have finished in the background — check the save folder.',
    'wk.cancelNoPort': "Couldn't cancel because the connection dropped; the download may still be running in the background.",
    'host.pickdirFailed': "Couldn't open the folder window: {err}",
    'host.pathUnreadable': "Couldn't read the path: {err}",
    'host.notADir': 'Not a folder: {path}',
    'host.noSuchDir': 'No such folder: {path}',
    'host.cookieRetry': 'Cookie attempt failed, retrying without cookies…',
    'host.canceling': 'Canceling…',
    'host.noRunning': 'No running download to cancel.'
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
  // Service worker'da document yok; orada yalnızca metin üretmek için kullanılıyor.
  if (typeof document !== 'undefined') document.documentElement.lang = LANG;
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
