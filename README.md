# PageTrawl

> Trawl the open page for images and videos, filter them, download in bulk.
> Chrome extension (Manifest V3, no build step) with a local yt-dlp bridge for
> streaming sites. Documentation below is in Turkish.

Açık sekmedeki fotoğraf ve videoları tarayıp listeleyen, filtreleyip toplu indiren
kişisel kullanımlık bir Chrome eklentisi (Manifest V3, saf JS — build adımı yok).

## Kurulum

1. Chrome'da `chrome://extensions` adresini aç
2. Sağ üstten **Geliştirici modu**'nu (Developer mode) aç
3. **Paketlenmemiş öğe yükle** (Load unpacked) → bu klasörü seç
4. Araç çubuğunda ikon çıkar; sabitlemek için puzzle simgesine tıklayıp raptiyele

Kodu değiştirdikten sonra `chrome://extensions` sayfasındaki yenile (⟳) düğmesine
basman yeterli. `popup.js`/`popup.css` değişikliklerinde popup'ı kapatıp açmak da gerekir.

## Kullanım

- **İkona tıkla** → sayfa taranır, bulunan medya ızgarada listelenir
- Popup açık kaldığı sürece liste **canlı**: sayfayı kaydırıp yeni fotoğraf/video
  yükledikçe kartlar kendiliğinden sona ekleniyor (bir an yeşil çerçeveyle
  belirirler). Sekmede başka bir sayfaya/videoya geçersen liste sıfırlanıp
  yeniden kuruluyor — popup'ı kapatıp açman gerekmiyor
- Kartlara tıklayarak seç, `Tümünü seç` / `Tersle` ile toplu seç
- **Aynı videonun farklı kaliteleri tek kartta toplanıyor** (`clip_360p.mp4`,
  `clip_720p.mp4`, `clip_1080p.mp4` → bir kart). Kartta en iyi kalite duruyor;
  sağ alttaki ok listeyi açıyor, oradan istediğin kaliteyi seçebiliyorsun.
  Kart gövdesine tıklamak en iyi kaliteyi seçer, `Tümünü seç` de kart başına
  tek dosya alır — aynı videoyu üç kez indirmiş olmuyorsun
- Üstteki filtreler: tür (resim/video), URL araması, minimum genişlik
- **Kaydıraç** kart boyutunu ayarlar (2–7 sütun arası); seçimin kaydedilir
- Izgara kademeli çiziliyor: ilk 50 kart, aşağı indikçe 50'şer devamı
- Seçimler ve "indirildi" işaretleri sekme bazında hatırlanır, popup kapansa bile
- **Seçilenleri indir** → kuyruğa girer, ayarlardaki eşzamanlılık limitine göre akar
- Alt barda ilerleme çubuğu: `İndiriliyor… 12/49`, bitince yeşil `49 dosya indi`
  (hata varsa kırmızı). Popup kapalıysa aynı sayı **eklenti ikonunda rozet** olarak
  görünür — kuyruk arka planda işlemeye devam eder
- Herhangi bir resme/videoya **sağ tıkla** → "Bu medyayı indir" (tek dosya, hızlı yol)

Dosyalar `İndirilenler/{site-adı}/{dosya-adı}.{uzantı}` şeklinde kaydedilir.

### Kayıt klasörü

⚙ → **Gözat…** ile fotoğrafların da videoların da ineceği **tek** klasörü
seçiyorsun. Klasör **İndirilenler'in dışında olabilir** (Masaüstü, D:\ , ne
istersen). Yolu kutuya elle yazıp/yapıştırıp Enter'a da basabilirsin; **Sıfırla**
varsayılana döndürür.

Kutu boşken varsayılan davranış: fotoğraflar `İndirilenler\{site-adı}\`,
videolar `İndirilenler\yt-dlp\`.

#### Bu neden bu kadar dolambaçlı

Chrome eklentileri `chrome.downloads` ile **İndirilenler klasörünün dışına
yazamaz** — mutlak yol ve `../` kabul edilmiyor, bu tarayıcının sabit kuralı.
yt-dlp köprüsü ise dosyayı kendi yazdığı için bu kurala tabi değil. Tek bir ayar
olsun diye köprüyü ikisi için de kullanıyoruz:

| İş | Kim yapıyor |
|---|---|
| Klasörü seçtiren pencere | Köprü (`pickdir` → tkinter, yedeği PowerShell `FolderBrowserDialog`) |
| Yazılan yolu doğrulama | Köprü (`checkdir`) |
| Videoyu yazma | Köprü (`-P outdir`) |
| Fotoğrafı indirme | Chrome (`chrome.downloads`) |
| Fotoğrafı İndirilenler dışına taşıma | Köprü (`move`) |

Yani hedef İndirilenler'in **altındaysa** fotoğraf doğrudan oraya iner (köprüye
hiç ihtiyaç yok). **Dışındaysa** fotoğraf önce `İndirilenler\pagetrawl-gecici\`
altına iner, indirme biter bitmez köprü onu asıl yerine taşır ve boşalan ara
klasörü siler. Köprü kurulu değilse dosyalar o ara klasörde kalır ve ayar
panelinde kırmızı uyarı çıkar — sessizce kaybolmazlar.

Detaylar:

- **Klasör penceresi açılınca popup kapanır.** Chrome popup'ı odağı kaybedince
  kapatır, engellenemiyor. Sonuç `chrome.storage.session`'a yazılıyor; eklentiyi
  tekrar açtığında ayar paneli kendiliğinden açılıp "Kayıt klasörü güncellendi."
  diyor. Pencere açıkken worker ölmesin diye `dirPending` süresince keepAlive
  çalışıyor — yoksa dakikalarca beklenen seçim sessizce kaybolurdu.
- **Doğrulama klasör oluşturmaz.** `checkdir` yalnızca bakar (klasör var mı, yoksa
  üst klasörü var mı); asıl `makedirs` indirme/taşıma anında oluyor. Yanlış
  yazılmış bir yol yüzünden diske çöp klasör açılmasın diye.
- **Taşımada üzerine yazılmaz**: hedefte aynı ad varsa `ad (1).jpg` açılır. Dosya
  bir an kilitli kalabildiği için (Chrome/antivirüs) taşıma 4 kez deneniyor.
- **"Her dosyada nereye kaydedileceğini sor" açıkken taşıma yapılmaz** — yeri
  zaten sen seçiyorsun.
- İlerleme sayacı Chrome'un indirmesini baz alır; taşıma ondan hemen sonra, ayrı
  gerçekleşir. Yani "49 dosya indi" yazdıktan bir an sonra dosyalar yerine oturur.
- İndirilenler kökünü tamamen değiştirmek istersen: `chrome://settings/downloads`.

İndirilenler'in mutlak yolunu veren bir API yok; ayar paneli ilk açıldığında
sessiz bir sonda indirmesi yapılıp yol öğreniliyor ve saklanıyor (klasörün
İndirilenler altında olup olmadığına da bununla karar veriliyor). Sonda `data:`
URL'den iniyor — eskiden eklentinin kendi `chrome-extension://` kaynağı
kullanılıyordu, Chrome onu `downloads` API'siyle indirtmiyor ve `NETWORK_FAILED`
veriyordu.

Sonda `saveAs: false` ile iniyor. Bu açıkça yazılmazsa Chrome'un kendi
"her dosyada nereye kaydedileceğini sor" ayarı devreye giriyor ve sonda için
**`download.txt` adında bir Kaydet penceresi** açılıyordu (data: URL'de Chrome
bizim ad önerimizi de yutuyor).

## yt-dlp köprüsü (YouTube, Instagram, TikTok, X…)

Akış siteleri videoyu tek dosya olarak vermez: parçalı DASH/HLS akışı + şifreli
imza kullanırlar. Bunu eklenti içinde çözmeye çalışmak yt-dlp'yi baştan yazmak
olurdu ve siteler her değiştiğinde kırılırdı. Bunun yerine eklenti, Chrome'un
**Native Messaging** köprüsüyle bilgisayardaki yt-dlp'yi çağırıyor.

### Kurulum

```powershell
# 1. Eklentiyi yükle, chrome://extensions'tan kimliğini (ID) kopyala
# 2. Bu klasörde:
.\setup-native.ps1 -ExtensionId <32-harflik-kimlik>
# 3. chrome://extensions'ta eklentiyi yenile (⟳)
```

Script; launcher `.bat`'ini, host manifest'ini ve registry anahtarını
(`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.bozgu.ytdlp`) yazar.
Yönetici yetkisi gerekmez. Kaldırmak için `.\setup-native.ps1 -Uninstall`.

### Bağımlılıklar

| Araç | Gerekli mi | Not |
|---|---|---|
| yt-dlp | **Şart** | `pip install -U yt-dlp`. Eskiyince YouTube kırılır, ayda bir güncelle. |
| JS motoru (node/deno/bun) | **YouTube için şart** | yt-dlp motorsuz çıkarmayı kullanımdan kaldırdı. Node varsa host onu otomatik seçer (`--js-runtimes node`). |
| ffmpeg | Önerilir | Olmadan video+ses birleştirilemez → YouTube'da ~720p tavan, "sadece ses" mp3 yerine ham m4a. `winget install Gyan.FFmpeg` |

Host bu üçünü her çağrıda kendisi arar; ffmpeg PATH'te yoksa winget kurulum
ağacını da tarar ve bulduğunu `--ffmpeg-location` ile yt-dlp'ye verir. Bu, Chrome
PATH güncellenmeden önce açıldığında ffmpeg'in "terminalde var, eklentide yok"
görünmesini önlüyor.

**Çerezler varsayılan olarak kapalı.** Chrome 127+ çerez veritabanını App-Bound
Encryption ile şifreliyor; yt-dlp bunu Windows'ta çözemiyor
(`Failed to decrypt with DPAPI`). Her indirmede önce denemek sadece gecikme
üretiyordu. Girişli içerik gerekiyorsa yt-dlp'yi elle `--cookies` ile
(tarayıcıdan dışa aktarılmış bir cookies.txt ile) çalıştırman gerekir.

### Kullanım

Desteklenen bir sitedeyken eklentiyi aç; ızgaranın üstünde videonun **kapak
görseli, başlığı ve kanal adı** ile birlikte indirme barı çıkar. Kalite seç,
İndir'e bas — ilerleme çubuğu canlı akar. Dosyalar ⚙ → **kayıt klasörüne**,
seçilmemişse `İndirilenler\yt-dlp\` altına iner.

Durum satırında yt-dlp'nin ham çıktısı değil tek bir sade cümle var
(`İndiriliyor… %13`, `İndirildi`); ham satır ve hedef klasör fare ipucunda.

Başlık, kanal ve süre YouTube'da **oEmbed** uç noktasından
(`youtube.com/oembed`) + `<video>.duration`'dan alınır. Sayfanın kendi `og:` ve
microformat etiketleri SPA gezinmesinde bir önceki videoda takılı kalıyor, yani
başlığı da kanalı da yanlış gösteriyordu; kapak zaten URL'deki video kimliğinden
türetildiği için doğru görünüyor, kafa karıştıran da buydu. Diğer sitelerde `og:`
etiketleri kullanılmaya devam ediyor. Bar, yalnızca indirmeyi engelleyecek bir eksik varsa
(yt-dlp veya JS motoru yok) uyarı satırı gösterir.

Köprünün "kurulu mu" cevabı (`probe`) ayrı bir mesaj tipiyle geliyor, indirme
durumunun içinde değil. Aynı nesnede taşındığı sürümde alan durum nesnesine
yapışıp kalıyor, popup da canlı gelen her ilerleme mesajını probe cevabı sanıp
çubuğu güncellemiyordu — çubuk ancak popup kapatılıp açılınca ilerliyordu.

Köprü, girişli içerik için Chrome çerezlerini kullanır (`--cookies-from-browser
chrome`), yani özel Instagram hesapları ve yaş sınırlı YouTube videoları çalışır.
Çerez okuma başarısız olursa çerezsiz tekrar dener.

> Bu araç kişisel kullanım için. YouTube ve Instagram'ın kullanım şartları
> içerik indirmeyi yasaklar; DRM korumalı servisler (Netflix vb.) zaten
> kapsam dışı ve teknik olarak da çözülemez.

## Dosyalar

| Dosya | İş |
|---|---|
| `manifest.json` | İzinler ve giriş noktaları |
| `background.js` | Service worker: indirme kuyruğu, sağ tık menüleri, ağ dinleyicisi |
| `scanner.js` | Sayfaya enjekte edilen DOM tarayıcısı |
| `popup.html/css/js` | Izgara arayüzü, filtreler, seçim |
| `icons/` | Eklenti simgesi (16/32/48/128) + üreten `make-icon.py` (Pillow) |
| `native/ytdlp_host.py` | Native messaging host: yt-dlp'yi çağırır, klasör penceresini açar, dosya taşır |
| `setup-native.ps1` | Köprü kurulumu (bat + host manifest + registry) |

## Nasıl çalışıyor

- İndirme için `chrome.downloads.download()` kullanılıyor — Chrome'un kendi indirme
  motoru. Bu sayede **profildeki çerezler otomatik gönderiliyor** (giriş yapılmış
  siteler çalışır), CORS'a takılmıyor, duraklat/devam et bedava geliyor.
- Kuyruk `chrome.storage.session`'da tutuluyor. MV3'te service worker boşta ölür;
  RAM'deki kuyruk kaybolurdu. `downloads.onChanged` eventi worker'ı uyandırıp
  bir sonraki dosyayı başlatıyor, yani kuyruk kendi kendine akıyor.
- Tarayıcı `<img>`, `srcset` (en büyük varyantı seçer), `<picture><source>`,
  CSS `background-image`, `<video>` + `<source>` + poster, lazy-load
  (`data-src` / `data-original`), ve medyaya giden `<a href>` bağlantılarını
  topluyor. `allFrames: true` ile iframe'ler de taranıyor.
- `webRequest.onResponseStarted` ile ağ trafiği de dinleniyor; DOM'da hiç
  görünmeyen (JS ile çekilen) medya "ağ" etiketiyle listeye ekleniyor.
  MV3'te webRequest'in gözlemci tarafı hâlâ çalışıyor, sadece engelleyici
  (blocking) kısmı kaldırıldı. Yakalananlar `net:{tabId}` altında birikiyor;
  popup açıksa arka plan ayrıca `netAdded` mesajıyla anında haber veriyor.
- Canlı liste iki kaynaktan besleniyor: yukarıdaki `netAdded` mesajı ve popup'ın
  1,2 sn'de bir yaptığı yoklama. Her yoklamada tüm DOM'u taramak pahalı olurdu
  (özellikle `getComputedStyle` döngüsü), o yüzden `scanner.js` sayfaya bir
  `MutationObserver` kurup "değişti mi" bayrağı tutuyor; bayrak temizse tarayıcı
  anında `{unchanged:true}` dönüyor. Bayrak, `executeScript`'in izole dünyasında
  yaşadığı için çağrılar arasında kalıcı. Sekiz turda bir bayrağa bakılmadan tam
  tarama yapılıyor (stil kaynaklı arka planlar gibi gözlemcinin kaçırdıkları için).
- Yeni gelenler listenin **sonuna** ekleniyor, liste yeniden sıralanmıyor:
  kaydırma konumu, seçim ve çizili kartlar yerinde kalsın diye. Liste 3000 öğede
  duruyor (sonsuz kaydırmada popup'ın kilitlenmemesi için).
- İlerleme sayacı da `storage.session`'da ve tek promise zincirinden geçiyor;
  `_pump` ile `onChanged` aynı anda yazarsa oku-değiştir-yaz araları kaybolurdu.
  Yalnızca eklentinin başlattığı indirmeler sayılıyor (id'leri kayıtlı), yoksa
  kullanıcının kendi indirdiği dosyalar sayaca karışırdı.
- İndirilenler dışına taşınacak dosyalarda "hangi indirme nereye gidecek" eşlemesi
  de `storage.session`'da (`moves`) ve aynı şekilde tek zincirden geçiyor: worker
  indirme bitmeden ölebilir, taşıma bilgisi RAM'de durursa kaybolurdu.
- yt-dlp çalışırken (ve klasör penceresi açıkken) worker 20 sn'de bir
  `runtime.getPlatformInfo()` çağırıyor.
  Çağrı sonucu kullanılmıyor; tek işi boşta kalma sayacını sıfırlamak. Worker
  ölürse native port kapanır, host'un stdin'i EOF alır ve ana döngüsü biter —
  indirme host tarafında tamamlanır ama ilerleme gelmez, iptal de iş görmez.

## Bilinen sınırlar

- **`blob:` videolar ızgaradan indirilemez** — bunlar için üstteki yt-dlp barını
  kullan. `<video>` etiketinde gördüğün `blob:` URL, sayfanın belleğinde yaşayan
  bir referanstır; eklenti bağlamından erişilemez. Popup bu tür videoları sayıp
  uyarı gösteriyor.
- **DRM'li içerik (Widevine)** şifreli geldiği için teknik olarak da çözülemez.
- **Önizleme çıkmayabilir.** Hotlink koruması olan siteler eklenti bağlamından gelen
  istekleri reddeder; küçük resim yerine uzantı etiketi görürsün. Dosyanın kendisi
  yine de inebilir, çünkü indirme `chrome.downloads` üzerinden ve çerezlerle gider.
- **`chrome://`, Web Store ve PDF görüntüleyici sayfaları taranamaz** — Chrome
  eklenti enjeksiyonuna kapatır.
- **8000'den fazla element olan sayfalarda CSS arka plan taraması atlanır**
  (`getComputedStyle` çok yavaşlar). `scanner.js` içinde bu eşiği değiştirebilirsin.

## Sonraki adımlar (isteğe bağlı)

- Referer başlığı ekleme: hotlink korumalı siteler için `declarativeNetRequest`
  `modifyHeaders` kuralı (MV3'te `webRequest` blocking yerine bunu kullanacaksın)
- Sonsuz kaydırmalı galerilerde sayfayı otomatik aşağı kaydırma (tarama artık
  canlı; eksik olan tek şey kaydırmayı kullanıcı yerine yapmak)
- yt-dlp barına oynatma listesi desteği (`--no-playlist` bayrağını kaldırmak)

## Kapsam ve sorumluluk

Bu araç **kişisel kullanım** için yazıldı. YouTube, Instagram gibi servislerin
kullanım şartları içerik indirmeyi yasaklar; neyi indirdiğinden ve telif
durumundan kullanan sorumludur. DRM korumalı içerik (Widevine) kapsam dışı —
şifreli geldiği için teknik olarak da çözülemez, aracın böyle bir yeteneği yok.

## Lisans

MIT — bkz. [LICENSE](LICENSE).
