# ODA 0.1.0 — Test Raporu (yalnızca sunucu sürümü)

Tarih: 30.09.2026
- Test bilgisayarı: Windows 11 (10.0.26200) x64, tek bilgisayar, ev ağı (Wi-Fi). Node 22.22.0, Electron 44.4.5.
- Sunucu: VPS, Ubuntu 24.04, `5.199.136.47`. Node 22.23.3 (ODA'ya özel), LiveKit 1.13.7.

Bu sürümde bilgisayarda host / yerel ağ modu kaldırıldı. Masaüstü uygulaması yalnızca ODA sunucularına bağlanır; davet kodu yapıştırılınca katılım kendiliğinden başlar.

## Yükleyici

| | |
|---|---|
| Dosya | `out\ODA-Setup-x64.exe` |
| Boyut | 101.072.204 bayt |
| SHA-256 | `73AE92829B0CE39B7A2C645D5D2D7A75665D9F53C28CE4988D122233988E6B7D` |
| Tür | NSIS tam paket (çevrimdışı; `nsis-web` değil), Türkçe, kullanıcı başına varsayılan + tüm kullanıcılar seçeneği |
| İçerik | `app.asar` 1,6 MB; `better-sqlite3`, sunucu kodu veya başka yerel (`.node`) modül yok |
| İmza | **İmzasız** (`Get-AuthenticodeSignature` → `NotSigned`; `ODA.exe` de imzasız). SmartScreen uyarısı çıkabilir. |

## Otomatik testler (bu sürümle)

| Test | Komut | Sonuç |
|---|---|---|
| TypeScript tip kontrolü | `npm run typecheck` | Hatasız |
| Birim + entegrasyon | `npm test` | 47/47 (+1 uzak test, aşağıda) |
| Uçtan uca, yerel: LiveKit + `oda-server` bu PC'de, üç Electron istemcisi | `npm run test:e2e` | 36/36 |
| Gerçek VPS'e bağlanma denemesi | `ODA_REMOTE_CODE=… npx vitest run tests/remote.test.ts` | 1/1 |
| Paketli `ODA.exe` duman testi (yerel `oda-server` ile) | `node scripts/smoke-packaged.mjs` | 8/8 |

**Birim + entegrasyon kapsamı:**
- Sunucu protokolü, yetki, davet, oran sınırlama, arkadaşlık, DM, yedek şifreleme, migrasyon, bozuk veritabanı, ayar doğrulama.
- **Sunucu olmayan hosta katılmama:** `dedicated` bildirmeyen bir hosta davetle bağlanmaya çalışan istemci `NOT_SERVER` alır, kayıt göndermez; davetin kullanım sayısı 0 kalır ve aynı davet sonra normal şekilde kullanılabilir.
- Sunucu modu: ilk yönetici kurulumu, büyük odalar; LiveKit bilet içeriği (tek oda, yalnızca mikrofon, 10 dk); sahte, eksik, yanlış odaya ait veya odadan çıktıktan sonra kullanılan biletle ses sinyaline **403**; ayrılma/çıkarma/yasaklamada `RemoveParticipant`; `/twirp` yönetim API'sinin iletilmemesi; yerel köprünün yanlış parmak izinde bağlanmayı reddetmesi (502).

**Uçtan uca kapsamı (36 adım):**
- İlk açılışta yalnızca davet kodu formu var (Oda oluştur / yerel ağ seçeneği yok); görünen ad Windows kullanıcı adıyla dolu geliyor; bozuk kod hata gösteriyor ve bağlanmıyor.
- Yönetici davetini **yapıştırınca** düğmeye basmadan katılma; sunucu davet varsayılanları (50 kullanım / 7 gün); uygulamadan üye daveti; aynı davetle iki kişinin katılması.
- Oda mesajları iki yönde, satır sonu korunuyor; kullanıcı HTML'i metin olarak gösteriliyor.
- Üç kişinin sesli odaya "Sunucu üzerinden" bağlanması; her birinin diğer ikisinden gerçek ses alması (RTP bayt + enerji > 0); medya bağlantısında ICE/STUN sunucusu olmaması; medyanın doğrudan medya sunucusunun portuna (UDP) gitmesi.
- Uzak konuşma göstergesi; mikrofon kapalı durumu; LiveKit yeniden başlayınca sesin geri gelmesi; odadan ayrılma.
- Arkadaşlık isteği → kabul → DM ve okunmamış rozeti.
- Ana Sayfa'da sunucu listesi var, yerel host kartı yok; gizlilik metni (sunucuda saklama, uçtan uca şifreli olmayan ses).
- Sunucu durdurulunca "sunucuya ulaşılamıyor" şeridi; sunucu yeniden başlayınca kendiliğinden yeniden bağlanma; oda geçmişinin korunması.
- Sunucu günlüğünde bilet veya davet sırrı olmaması.

**Duman testi (paketli exe):** yerel bir `oda-server`'a davet yapıştırarak profil oluşturuldu; profilde yerel host verisi yok; paketli `ODA.exe` açılınca sunucuya kendiliğinden yeniden bağlandı (işlemin TCP bağlantısıyla doğrulandı); günlükte gizli bilgi yok; pencere açık.

## Gerçek sunucu (VPS)

- Sunucu, `hello` çerçevesinde `dedicated: true` bildiren yeni `oda-server.cjs` ile güncellendi (`install.sh` yeniden çalıştırıldı). Veriler, TLS anahtarı ve parmak izi (`71:6F:D5:77:…:65:B7`) korundu; `oda-server` ve `oda-livekit` servisleri çalışıyor.
- **Bu sürümün istemci koduyla uzak deneme:** sunucunun genel kimlik bilgilerinden (kimlik, adres, port, parmak izi) ve sahte bir sırdan oluşturulan bir kodla bağlanıldı. Sabitlenmiş TLS kontrolü geçti, sunucu kendini ODA sunucusu olarak tanıttı ve yeni cihaz anahtarına `DEVICE_UNKNOWN` ile giriş aşamasında yanıt verdi. Hiçbir davet kullanılmadı.
- **Önceki istemci sürümüyle yapılmış uzak testler (bu değişiklikten önce, aynı gün):** internet üzerinden üç istemcili SFU testi 18/18 (üç ayrı çalıştırma); kurulu `ODA.exe` bir üye davetiyle sunucuya katılıp sesli odaya girdi, "Bağlantı: Sunucu üzerinden"; LiveKit bağlantı türü `udp`. Ses yolu ve sunucu tarafı ses kodu bu değişiklikte değişmedi. Bu testler yeni istemciyle **tekrarlanmadı**, çünkü sunucuda henüz yönetici yok ve tek yönetici daveti size ayrıldı.
- Kurulumdaki doğrulamalar geçerliliğini koruyor: Node.js ve LiveKit indirmeleri SHA-256 ile doğrulandı; `47823/TCP` ve `7881/TCP` dışarıdan erişilebilir, LiveKit API'si (`7880`) yalnızca 127.0.0.1'de; sunucudaki mevcut servisler (nginx, Docker, veritabanları, sistem Node.js) değiştirilmedi.

## Gerçek kurulum döngüsü (bu sürümün EXE'siyle)

| Adım | Sonuç |
|---|---|
| Önceki sürümün üzerine sessiz kurulum `/S /currentuser` (güncelleme) | Çıkış 0, 25 sn; tek HKCU kaldırma kaydı; `settings.json` değişmedi. |
| Kurulu uygulamayı açma | Pencere 1 sn içinde açıldı; `ODA.exe` **hiçbir portu dinlemiyor**; `Run` anahtarında ODA yok; `%APPDATA%\ODA\host` oluşmadı. |
| Etkileşimli kaldırma → "Kullanıcı verileri de silinsin mi?" **Hayır** | Program, kısayollar ve kaldırma kaydı silindi; kullanıcı verisi (işaret dosyası) korundu. |
| Yeniden kurma ve açma | Çıkış 0; veri korunmuş; pencere açıldı, dinlenen port yok. |
| Etkileşimli kaldırma → **Evet** | Program, kısayollar, kaldırma kaydı ve `%APPDATA%\ODA` silindi; `Run` anahtarında ODA yok. |
| Son temiz kurulum ve açma | Çıkış 0; bilgisayarda ODA kurulu, ilk açılış ekranı (ad dolu, davet kodu alanı) görünüyor. |

Kaldırıcının sorusu artık "katıldığın sunucuların cihaz anahtarları, ayarlar ve günlükler" der; "tüm kullanıcılar" kurulumu artık güvenlik duvarı kuralı eklemez (eski sürümün kuralını siler).

Test sırasında yardımcı betiğin (`scripts/uninstall-interactive.ps1`) kaldırıcının arka planda veri silmesini beklemeden devam ettiği görüldü; betik düzeltildi (yalnızca kendi başlattığı kaldırıcıyı izliyor ve tüm kaldırıcı süreçleri bitene kadar bekliyor) ve üç kaldırma yolu yeniden denendi. Bu sorun sırasında bu bilgisayardaki `%APPDATA%\ODA` klasörü (ayarlar ve önbellek; kayıtlı sunucu yoktu) silindi ve geri yüklenemedi.

## Yapılmayan testler / bilinen sınırlar

- **Sunucuya farklı evlerden ve ağlardan gerçek kullanıcılarla bağlanılmadı.** Uzak testler internet üzerinden ama tek bir ev ağından (bu PC) yapıldı. Arkadaşlarınızın ilk bağlantısı gerçek çok ağlı testtir.
- Yeni istemciyle gerçek VPS'te sesli oda testi yapılmadı (yukarıdaki neden). İlk yönetici katıldıktan sonra `packaged-vps.mjs` ile üye daveti kullanılarak tekrarlanabilir.
- **Yalnızca 443 portuna izin veren ağlar** (bazı iş/okul ağları) denenmedi. TURN/443 aktarması olmadığı için bu ağlarda ses kurulamaz.
- Mobil hotspot / CGNAT arkasından bağlantı denenmedi. İstemci yalnızca giden bağlantı kurduğu için çalışması beklenir, ama doğrulanmadı.
- Gerçek kulaklık ve mikrofonla dinleme testi yapılmadı; ses akışı sahte mikrofon ve RTP istatistikleriyle doğrulandı.
- 15'ten fazla gerçek kişiyle oda testi yapılmadı. Sunucu tarafı sınırı 50; yük testi yok.
- "Tüm kullanıcılar" kurulumu ve Windows 10 üzerinde test yapılmadı.
