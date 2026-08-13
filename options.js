// ---------------------------------------------------------------------------
// Seçenekler sayfası. Ayarlar eskiden popup'ın içindeydi; klasör penceresi
// odağı alınca Chrome popup'ı kapatıyor ve kullanıcı seçiminin sonucunu
// göremiyordu. Bu sayfa bir sekmede açıldığı için odak kaybında kapanmıyor —
// köprünün 'folder' mesajı canlı olarak buraya düşüyor.
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

async function saveSetting(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...(settings || {}), ...patch } });
}

// --- kayıt klasörü ---------------------------------------------------------

async function showFolder() {
  const info = await chrome.runtime.sendMessage({ type: 'getFolderInfo' });
  const box = $('#folder');
  box.value = info?.set ? info.abs : '';
  box.placeholder = info?.root || t('folder.rootPh');
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

$('#browse').addEventListener('click', () => {
  // Popup'taki uyarının aksine burada "sayfa kapanacak" demiyoruz: kapanmıyor.
  setFolderNote(t('folder.checking'));
  chrome.runtime.sendMessage({ type: 'pickFolder' });
});

$('#folderReset').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'setFolder', path: '' });
});

$('#folder').addEventListener('change', (e) => {
  const path = e.target.value.trim();
  setFolderNote(path ? t('folder.checking') : '');
  chrome.runtime.sendMessage({ type: 'setFolder', path });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'folder') return;

  if (msg.note) setFolderNote(msg.note, !!msg.bad);
  else if (msg.error) setFolderNote(msg.error, true);
  else if (msg.canceled) setFolderNote(t('folder.canceled'));
  else { showFolder(); }
});

// --- kaydet ----------------------------------------------------------------

$('#save').addEventListener('click', async () => {
  await saveSetting({
    maxConcurrent: Math.min(10, Math.max(1, +$('#maxConcurrent').value || 4)),
    template: $('#template').value.trim() || '{host}/{name}.{ext}',
    saveAs: $('#saveAs').checked
  });

  const note = $('#saved');
  note.textContent = t('opt.saved');
  setTimeout(() => (note.textContent = ''), 1600);
});

// --- başlat ----------------------------------------------------------------

(async () => {
  const { settings } = await chrome.storage.local.get('settings');

  setLang(settings?.lang || DEFAULT_LANG);
  applyStaticI18n();

  $('#maxConcurrent').value = settings?.maxConcurrent ?? 4;
  $('#template').value = settings?.template ?? '{host}/{name}.{ext}';
  $('#saveAs').checked = !!settings?.saveAs;

  showFolder();
})();

// Dil popup'tan değiştirilebiliyor; bu sayfa açıkken de takip etsin.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = changes.settings.newValue?.lang || DEFAULT_LANG;
  if (next === getLang()) return;
  setLang(next);
  applyStaticI18n();
  showFolder();   // klasör notu da çeviriyle üretiliyor
});
