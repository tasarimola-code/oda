# ODA — Mimari kararlar ve ağ sınırları

Bu belge ODA'nın mimarisini, güvenlik modelini ve ürünün **dürüst sınırlarını** tanımlar.

## 1. Özet

ODA iki parçadan oluşur:

- **`oda-server`**: topluluğun kendi Linux sunucusunda (VPS) arayüzsüz çalışan sunucu. SQLite veritabanını tutar, TLS ile şifreli bir WebSocket hizmeti (signaling + mesaj) açar ve aynı makinedeki **LiveKit SFU**'ya ses biletleri verir.
- **`ODA.exe`**: Windows 10/11 Electron istemcisi. Yalnızca ODA sunucularına **dışarıya doğru** bağlanır; bilgisayarda gelen bağlantı dinlemez, veritabanı tutmaz, host olmaz.

ODA'nın işlettiği merkezi sunucu, bulut API'si veya hesap servisi **yoktur**. Sunucuyu topluluk kendisi kurar ve yönetir ([SUNUCU-KURULUMU.md](SUNUCU-KURULUMU.md)). Sunucu kapandığında o topluluğun odaları, mesaj teslimi ve signaling durur.

Önceki sürümlerdeki "bilgisayarda host" modu (WebRTC mesh, yerel ağ / port yönlendirme / STUN) kaldırıldı. Sunucu kodu (`src/main/host`) yalnızca `oda-server`'a derlenir; masaüstü paketinde `better-sqlite3` veya sunucu kodu yoktur.

## 2. Teknoloji

| Katman | Seçim | Gerekçe |
|---|---|---|
| İstemci kabuğu | Electron 44 (Chromium + Node 24) | WebRTC, `getUserMedia`, ses aygıtı seçimi (`setSinkId`) ve Node ağ yığını tek pakette; kullanıcıya ek çalışma zamanı kurdurmaz. |
| Dil | TypeScript (strict) | Sunucu, ana süreç, preload ve arayüz aynı tip sözleşmelerini (`src/shared`) paylaşır. |
| Arayüz | React 19 + Zustand, Vite ile paketlenir | Bileşen tabanlı, ölçeklenebilir UI. |
| Sunucu çalışma zamanı | Node 22 (`/opt/oda/node`, sistemdeki Node'dan bağımsız) | Sistem servislerine dokunmaz. |
| Veritabanı | SQLite (`better-sqlite3` 13), yalnızca sunucuda | Ayrı veritabanı sunucusu gerektirmez. |
| Taşıma | `https` + `ws` (WSS), `47823/TCP` | Signaling ve mesajlar TLS ile şifreli, parmak izi sabitlenmiş. |
| Ses | LiveKit 1.13.7 SFU + `livekit-client` | Herkes sesini bir kez yükler; NAT delme ve port yönlendirme gerekmez. |
| Kurulum | electron-builder NSIS **tam (offline)** paket, x64 | `nsis-web` kullanılmaz. |

## 3. Süreç ayrımı

```
┌──────────────── ODA.exe (istemci) ───────────────────┐        ┌────────────── VPS ───────────────┐
│ Ana süreç (Node)                                     │        │ oda-server (Node 22)             │
│  ├─ ClientConnection : sunucuya WSS (parmak izi      │  WSS   │  ├─ HostServer: yetki, davet,    │
│  │                     sabitleme, NOT_SERVER, yeniden├───────►│  │   mesaj, arkadaşlık, oran     │
│  │                     bağlanma)                     │ 47823  │  │   sınırlama, SQLite           │
│  ├─ SfuBridge : 127.0.0.1 köprü → /lk/rtc (sabitli)  ├───────►│  └─ /lk/rtc vekili (bilet doğr.) │
│  ├─ LocalProfile : cihaz anahtarları (safeStorage)   │        │           │ 127.0.0.1:7880       │
│  ├─ Tepsi, yedek/geri yükleme, günlük                │        │ LiveKit SFU ◄┘                   │
│  └─ IPC (dar, beyaz listeli)                         │  UDP/  │  medya: 7882/UDP, 7881/TCP       │
│ Preload (contextBridge, sandbox)                     │  TCP   │                                  │
│ Renderer (React, sandbox, sıkı CSP)                  ├───────►│                                  │
│  └─ livekit-client ses, aygıtlar, arayüz             │        │                                  │
└──────────────────────────────────────────────────────┘        └──────────────────────────────────┘
```

- Renderer internete doğrudan bağlanmaz. CSP `connect-src` yalnızca `ws://127.0.0.1:*` ve `http://127.0.0.1:*` adreslerine izin verir; bu, ana sürecin açtığı SFU köprüsü içindir (§5). Tüm signaling/mesaj trafiği IPC → ana süreç → WSS yolunu izler. Renderer bunun dışında yalnızca sunucuya giden WebRTC medya trafiği üretir.
- IPC yöntemleri ve sunucuya iletilen RPC yöntem adları beyaz listelidir.

## 4. Bağlantı

1. Davet kodu (`ODA1-…`) sunucunun kimliğini, adını, adreslerini, portunu, **TLS sertifika parmak izini** ve davet sırrını taşır.
2. İstemci adresleri dener; TLS el sıkışmasında sertifikanın SHA-256 parmak izini davetteki değerle karşılaştırır, eşleşmezse uygulama verisi göndermeden kapatır.
3. Sunucunun `hello` çerçevesi `dedicated: true` içermelidir. İçermiyorsa (ör. eski sürümlerde bir bilgisayarda açılmış host) istemci, **kayıt/giriş göndermeden** `NOT_SERVER` hatasıyla bağlantıyı keser; davet harcanmaz ve yeniden deneme yapılmaz.
4. Kayıt veya giriş (§6) başarılı olunca oturum açılır. Bağlantı koparsa istemci artan aralıklarla yeniden bağlanır.

Katılım arayüzünde görünen ad Windows kullanıcı adıyla önceden doldurulur; geçerli bir davet kodu yapıştırıldığında katılım kendiliğinden başlar.

## 5. Ses (SFU)

- **LiveKit** aynı sunucuda çalışır:
  - API/signaling portu (7880) yalnızca `127.0.0.1`'e bağlanır.
  - Medya portları `7882/UDP` ve `7881/TCP` (yedek) dışarı açıktır.
  - Medya yalnızca sunucunun genel IP'sine bağlanır (`rtc.ips.includes`), Docker/VPN köprülerine bağlanmaz.
- **Yetki (sunucuda):**
  - `voice.join` başarılı olunca sunucu, tek odaya ve yalnızca mikrofon yayınına izin veren, 10 dakikalık HS256 LiveKit bileti üretir.
  - İstemcinin LiveKit sinyali `wss://sunucu:47823/lk/rtc…` yoluyla oda-server'a gelir. Sunucu bileti (imza, `iss`, `exp`, kimlik, oda) doğrular. Kişi o anda gerçekten o ses odasındaysa ve durumu `active` ise isteği yerel LiveKit'e iletir, değilse 403 döner. `/twirp` yönetim API'si hiçbir zaman iletilmez.
  - Ayrılma, çıkarma ve yasaklamada sunucu `RemoveParticipant` çağırır.
- **Parmak izi sabitli köprü (istemcide):**
  - `livekit-client` renderer'da çalışır, ancak TLS parmak izi sabitlemesi yapamaz. Bu yüzden ana süreç `127.0.0.1` üzerinde rastgele port ve 32 karakterlik gizli bir yol ile küçük bir köprü açar.
  - Köprü her isteği sunucunun sertifika parmak izini doğruladıktan sonra iletir; uyuşmazsa tek bayt göndermez.
  - Global sertifika doğrulaması kapatılmaz. `Origin`/`Cookie` başlıkları iletilmez.
- **Medya:**
  - İstemci `iceServers: []` kullanır; üçüncü taraf STUN/TURN yoktur. Medya yalnızca sunucuya gider.
  - Chromium'un yerel IP'leri mDNS ile gizlemesi kapatılır (`WebRtcHideLocalIpsWithMdns`); yerel ICE adayları yalnızca kimliği doğrulanmış kullanıcının kendi sunucusuna gider.
  - Ses Opus + DTX + RED ile yayınlanır.
  - Konuşma göstergesi LiveKit'in `ActiveSpeakersChanged` olayından, yerel mikrofon seviyesi `AnalyserNode` RMS değerinden gelir.
  - Ses bağlantısı koparsa istemci yeni bilet alarak (`voice.join`) en fazla 4 kez yeniden bağlanır.
- Oda ekranındaki **Bağlantı** etiketi ölçüme dayanır: ses gerçekten kurulduğunda "Sunucu üzerinden", kurulamadıysa "Başarısız" yazar.
- **Gizlilik:** SFU sesi çözüp yeniden şifreleyerek iletir. Bu nedenle ses **uçtan uca şifreli değildir**; mesajlar da sunucuda saklanır. Gizlilik ekranı bunu açıkça yazar.

## 6. Kapasite

- **Oda başına en çok 50 katılımcı** (varsayılan 25). Her katılımcı tek bir akış yükler (~40 kbit/s) ve N−1 akış indirir; yükleme kişi sayısından bağımsızdır.
- Sınır sunucuda uygulanır; istemcinin gösterdiği sınır yalnızca bilgi amaçlıdır.

## 7. Kimlik, davet ve yetki

- **Cihaz anahtarı:** Her istemci, katıldığı her sunucu için ayrı bir Ed25519 anahtar çifti üretir (sunucular arası ilişkilendirmeyi önler). Özel anahtar Windows'ta `safeStorage` (DPAPI) ile şifreli saklanır.
- **Kayıt:** İstemci, davet kodundaki rastgele sırrı + görünen ad + açık anahtarı gönderir ve sunucunun verdiği tek seferlik `nonce`'u imzalar. Sunucu yalnızca davet sırrının SHA-256 özetini saklar.
- **Geri dönüş:** Aynı sunucuya tekrar bağlanırken yalnızca imzalı meydan okuma (challenge-response) kullanılır. Görünen ad kimlik kanıtı değildir; parola yoktur, dolayısıyla saklanacak parola da yoktur.
- **Davet:** 128 bit rastgele sır, süre (en çok 90 gün), kullanım sayısı (en çok 1000), isteğe bağlı özel oda erişimi, iptal edilebilir. İlk yönetici, sunucu komut satırından üretilen yönetici davetiyle katılır.
- **İptal:** Yönetici bir kullanıcıyı çıkarabilir (oturumu kapatılır), yasaklayabilir (tüm cihazlar iptal), cihaz iptal edebilir.
- **Roller:** `admin`: davet üret/iptal, oda oluştur/sil, özel odaya üye ekle/çıkar, kullanıcı çıkar/yasakla. `member`: izinli odalara katılma, kendi mesajları, arkadaşlık.
- Her ağ isteği sunucuda oturum + rol + üyelik + engel kontrolünden geçer. İstemci rozetlerine güvenilmez.

## 8. Taşıma güvenliği

- Sunucu kurulumda kendinden imzalı bir TLS sertifikası (EC P-256) üretir. Sertifikanın SHA-256 parmak izi **davet kodunun içindedir**.
- İstemci, sunucu sertifikasının parmak izini davetteki değerle karşılaştırır; eşleşmezse bağlantıyı uygulama verisi gönderilmeden kapatır. Sertifika doğrulaması global olarak kapatılmaz; yalnızca bu bağlantıya özel "sabitlenmiş parmak izi" doğrulaması yapılır. Açık metin (ws://) modu yoktur.
- WebRTC medyası DTLS-SRTP ile şifrelenir; LiveKit sinyali parmak izi sabitli köprüden geçtiği için DTLS parametreleri ortadaki adama karşı korunur.
- **Uçtan uca şifreleme iddia edilmez:** Mesajlar sunucuda açık metin olarak SQLite'ta durur; sunucuyu yöneten kişi mesajları okuyabilir, SFU sesi çözer. Bu, gizlilik ekranında açıkça yazılır.

## 9. Veri yerleşimi

| Veri | Yer |
|---|---|
| Topluluk veritabanı (kullanıcılar, cihazlar, davet özetleri, odalar, arkadaşlık, engeller, mesajlar, okundu durumu) | Sunucu: `/var/lib/oda/oda-host.db` |
| Sunucu TLS anahtarı | Sunucu: `/var/lib/oda/tls.json` (yalnızca `oda` kullanıcısı okuyabilir) |
| Otomatik veritabanı yedekleri | Sunucu: `/var/lib/oda/backups/` (saatlik, son 14) |
| İstemci profili (kayıtlı sunucular, cihaz anahtarları, son oturum) | `%APPDATA%\ODA\client.json` (özel anahtarlar DPAPI ile şifreli) |
| Ayarlar | `%APPDATA%\ODA\settings.json` |
| Günlükler | `%APPDATA%\ODA\logs\` ve `journalctl -u oda-server` (parola, davet sırrı, mesaj metni, ses verisi yazılmaz) |

Eski sürümlerin bilgisayarda oluşturduğu `%APPDATA%\ODA\host` klasörü okunmaz ve silinmez.

Program dosyaları varsayılan olarak kullanıcıya özel `%LOCALAPPDATA%\Programs\ODA` altına (yönetici izni gerekmez), kurulumda "tüm kullanıcılar" seçilirse `Program Files\ODA` altına kurulur. Güncelleme/yeniden kurulum `%APPDATA%\ODA`'ya dokunmaz. Kaldırmada kullanıcıya verileri silmek isteyip istemediği sorulur (varsayılan düğme ve sessiz kaldırma: koru). Güncelleme sırasında çalışan eski kaldırıcı bu soruyu sormaz.

Windows Güvenlik Duvarı: istemci gelen bağlantı dinlemediği için kural eklenmez. Eski sürümlerin "tüm kullanıcılar" kurulumunda eklediği `ODA` kuralı kurulumda ve kaldırmada silinir.

## 10. Veritabanı sağlığı (sunucu)

- Açılışta `PRAGMA quick_check`. Hata varsa `oda-server` başlamaz; yönetici otomatik yedekten geri yükler ([SUNUCU-KURULUMU.md](SUNUCU-KURULUMU.md)).
- WAL modu, `foreign_keys=ON`, tüm sorgular parametre bağlamalı.
- Şema sürümü `PRAGMA user_version` ile yönetilir; migrasyonlar `src/main/host/migrations.ts` içindedir.

## 11. İstemci yedeği

Yedek dosyası (`.odabak`): katılınan sunucuların cihaz anahtarları ve ayarlar; kullanıcının belirlediği yedek parolasından `scrypt` ile türetilen anahtarla **AES-256-GCM** ile şifrelenir. DPAPI makineye/kullanıcıya bağlı olduğu için yedekte anahtarlar DPAPI yerine yedek parolasıyla korunur. Eski sürümlerin yedeklerindeki host veritabanı geri yüklemede yok sayılır.

## 12. Electron sertleştirme ve paketleme

- `BrowserWindow`: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity` açık; geliştirici araçları yalnızca paketlenmemiş sürümde.
- Arayüz, ayrıcalıklı özel `oda://app` protokolünden yalnızca paket içindeki `dist/renderer` dosyalarıyla sunulur (yol aşımı korumalı). Uzak HTML/JS yüklenmez; gezinme ve yeni pencere açma engellenir.
- CSP: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ws://127.0.0.1:* http://127.0.0.1:*; object-src 'none'` (+ yazı tipi, resim ve medya için `'self'`).
- Mikrofon izni yalnızca uygulama kökeninden ve yalnızca ses için verilir; çıkış aygıtı seçimi (`speaker-selection`) dışındaki tüm izin istekleri reddedilir.
- Harici bağlantılar yalnızca `http/https` ise ve kullanıcı onaylarsa sistem tarayıcısında açılır. Kullanıcı metni hiçbir zaman HTML olarak işlenmez.
- Preload yalnızca beyaz listeli IPC kanallarını `contextBridge` ile açar; ana süreç her IPC çağrısında gönderen pencereyi ve kökeni doğrular.
- Electron fuse'ları: `RunAsNode`, `NODE_OPTIONS`, `--inspect` kapalı; asar bütünlük doğrulaması ve "yalnızca asar'dan yükle" açık.
- Kurulum paketi: electron-builder NSIS, tam/çevrimdışı (`nsis-web` değil), x64, Türkçe arayüz, kod imzasız. Pakette yerel (`.node`) modül yoktur.

## 13. Kapsam dışı

Bilgisayarda host / yerel ağ modu, dosya/resim gönderme, görüntülü görüşme, ekran paylaşımı, bot, ses kaydı, TURN/443 aktarması, uçtan uca şifreli mesaj veya ses, sunucular arası hesap birleştirme, kod imzalama.
