# ODA — Kullanım Kılavuzu

ODA, arkadaş grupları için sesli sohbet ve mesajlaşma uygulamasıdır. Topluluk her zaman bir **ODA sunucusunda** (VPS) çalışır; uygulama yalnızca o sunucuya bağlanır. Kimsenin bilgisayarı host olmaz, kimsenin port açması veya ağ ayarı yapması gerekmez. Sunucuyu yönetecekseniz: [SUNUCU-KURULUMU.md](SUNUCU-KURULUMU.md).

## 1. Kurulum

1. `ODA-Setup-x64.exe` dosyasını çalıştırın. Kurulum internet bağlantısı gerektirmez.
2. Uygulama kod imzalı değildir; Windows SmartScreen "Windows kişisel bilgisayarınızı korudu" uyarısı gösterebilir. Dosyayı güvendiğiniz birinden aldıysanız **Ek bilgi → Yine de çalıştır** seçin. İsterseniz dosyanın SHA-256 değerini size verilen değerle karşılaştırın:
   ```powershell
   Get-FileHash .\ODA-Setup-x64.exe -Algorithm SHA256
   ```
3. Kurulum türü:
   - **Sadece benim için** (varsayılan): yönetici izni gerekmez, `%LOCALAPPDATA%\Programs\ODA` altına kurulur.
   - **Tüm kullanıcılar**: yönetici izni ister, `Program Files\ODA` altına kurulur.
4. Masaüstü ve Başlat menüsü kısayolları oluşturulur. ODA Windows açılışında **kendiliğinden başlamaz** (Ayarlar'dan açılabilir).

ODA yalnızca dışarıya (sunucuya) bağlanır; bilgisayarınızda gelen bağlantı dinlemez. Bu yüzden Windows Güvenlik Duvarı izin sormaz ve modemde port açmak gerekmez.

## 2. Sunucuya katılma

1. Sunucu yöneticisinden bir davet kodu isteyin (`ODA1-` ile başlar).
2. ODA'yı açın. **Görünen adın** alanı Windows kullanıcı adınızla dolu gelir; isterseniz değiştirin (2–32 karakter).
3. Kodu **Davet kodu** alanına yapıştırın. Kod geçerliyse ODA **hemen bağlanır**; ayrıca düğmeye basmanız gerekmez. Kod eksik veya bozuksa alanın altında "Davet kodu okunamadı" yazar.
4. Bağlanırken sunucunun adı, adresi ve **parmak izi** gösterilir. İsterseniz parmak izini yöneticinin verdiği değerle karşılaştırın.

ODA sunucuyu hatırlar ve sonraki açılışlarda kendiliğinden bağlanır. Davet kodu yalnızca ilk katılımda gerekir; sonrasında kimliğiniz bu bilgisayardaki cihaz anahtarıyla doğrulanır.

Birden çok sunucuya katılabilirsiniz: Ana Sayfa → **Sunucuların** kartındaki **Davet koduyla katıl** yeni bir sunucu ekler; listeden sunucu değiştirilir, sunucunun adresi değiştiyse **Adresi düzenle**, artık kullanmıyorsanız **Kaydı sil** seçilir.

Davet kodu ODA sunucusuna ait değilse (örneğin eski sürümlerde birinin kendi bilgisayarında açtığı bir oda) ODA bağlanmayı reddeder ve davet harcanmaz.

## 3. Bağlantı

- Mesajlar ve oturum, sunucuya parmak izi sabitlenmiş TLS bağlantısıyla (`47823/TCP`) gider.
- Ses, sunucudaki ses dağıtıcısından (LiveKit SFU) geçer: önce `7882/UDP`, o kapalıysa `7881/TCP`.
- Oda ekranındaki **Bağlantı** etiketi ses bağlantısı gerçekten kurulduğunda **Sunucu üzerinden** yazar; kurulamadıysa **Başarısız** yazar.
- Bağlantı koparsa üstte bir şerit çıkar ve ODA kendiliğinden yeniden bağlanır; sohbet geçmişi sunucuda durduğu için kaybolmaz.

## 4. Sesli oda

- **Odaya katıl**: sesli sohbete girer. Oda doluysa düğme "Oda dolu" olur. Oda sınırı varsayılan 25, en çok 50 kişidir.
- **Mikrofon**: sesini aç/kapat. Kapalı mikrofon diğer herkeste simge olarak görünür.
- **Kulaklık**: gelen sesi ve mikrofonu birlikte kapatır.
- Mikrofon ve kulaklık düğmelerinin yanındaki oklar aygıt seçimini açar.
- Konuşan kişinin kartında altın rengi halka belirir.
- Bir katılımcının kartındaki menüden **kişiye özel ses düzeyi** ve **benim için sessize al** ayarlanır; yönetici buradan kişiyi sunucudan çıkarabilir.
- **Odadan Ayrıl**: sesli sohbetten çıkar; yazışma devam eder.

ODA ses kaydı yapmaz; kayıt düğmesi yoktur.

### Sık karşılaşılan ses sorunları

| Belirti | Ne yapmalı |
|---|---|
| "Mikrofon izni verilmedi" | Windows Ayarları → Gizlilik → Mikrofon → "Masaüstü uygulamalarının mikrofona erişmesine izin ver"i açın, sonra **Tekrar dene**. Mikrofonsuz da dinleyebilirsiniz. |
| "Mikrofon bulunamadı" | Mikrofon takın veya Ayarlar → Ses'ten başka giriş aygıtı seçin. |
| Kulaklık çıkarıldı | ODA varsayılan aygıta geçer ve bildirir. |
| "Ses sunucusuna bağlanılamadı" veya kartta "sesi sunucuya ulaşmadı" | Bulunduğunuz ağ `7882/UDP` ve `7881/TCP`'yi engelliyor olabilir (bazı iş/okul ağları). Başka bir ağda (ör. telefon hotspot) deneyin; sorun sürerse sunucu yöneticisine haber verin. |
| Yankı | Kulaklık kullanın; Ayarlar → Ses'te yankı engellemenin açık olduğundan emin olun. |

## 5. Mesajlaşma

- Sağdaki panel seçili odanın sohbetidir. **Enter** gönderir, **Shift+Enter** yeni satır ekler.
- Özel mesaj (DM) için karşı tarafla **arkadaş** olmalısınız: Arkadaşlar → Kişi ekle → **Arkadaş ekle**; karşı taraf Bekleyen sekmesinden **Kabul et**'e basar.
- Mesaj durumları: gönderiliyor → gönderildi; sunucuya ulaşılamıyorsa **teslim edilemedi** (yeniden gönder / sil).
- Sohbet başlığındaki büyüteçle mesajlarda arama yapılır. Eski mesajlar yukarı kaydırınca yüklenir.
- Bağlantılar yalnızca `http/https` ise tıklanabilir ve açılmadan önce onay istenir.
- Mesajlar **ODA sunucusunda** saklanır ve uçtan uca şifreli değildir: bağlantı şifrelidir, ancak sunucu mesajları okuyabilir.
- Ses de uçtan uca şifreli değildir: aktarım şifrelidir, ancak sunucudaki ses dağıtıcısı sesi çözerek diğerlerine iletir. Ayarlar → Gizlilik bunu açıkça gösterir.

## 6. Arkadaşlar ve engelleme

- Kişi arama yalnızca bağlı olduğunuz sunucunun topluluğunda yapılır; dünya genelinde kullanıcı araması yoktur.
- **Engelle**: arkadaşlığı kaldırır, özel mesajları kapatır, kişinin oda mesajlarını size göstermez ve sesini sizin için kapatır.
- Görünen ad kimlik kanıtı değildir; kimlik, cihazınıza özel anahtarla doğrulanır.

## 7. Yönetici

Sunucunun ilk yöneticisi, sunucu kurulurken üretilen **yönetici davetiyle** katılan kişidir (bkz. [SUNUCU-KURULUMU.md](SUNUCU-KURULUMU.md)). Tüm yetki kontrolleri sunucuda yapılır.

- **Davet oluştur**: geçerlilik (en çok 90 gün), kullanım sayısı (en çok 1000) ve isteğe bağlı özel oda erişimi. Varsayılan 7 gün ve 50 kullanımdır; bir kod bütün arkadaş grubuna yeter. Kod yalnızca bir kez gösterilir.
- Ana Sayfa → Davetler: etkin davetleri görür, **İptal et** ile geçersiz kılar.
- Oda oluştur (herkese açık / özel, 2–50 kişi), yeniden adlandır, sil; özel odaya üye ekle/çıkar.
- Topluluk üyeleri: **Çıkar** (oturum kapanır, yeni davetle dönebilir), **Yasakla** (tüm cihazları iptal edilir), **Yasağı kaldır**.

## 8. Ayarlar

- **Ses**: giriş/çıkış aygıtı, seviye göstergesi, mikrofon testi (kendi sesinizi duyarsınız), yankı engelleme, gürültü azaltma, otomatik kazanç, genel çıkış sesi, odalara mikrofon kapalı katılma.
- **Bildirimler**: yeni mesaj bildirimi ve sesi.
- **Profil**: görünen ad ve avatar rengi (bağlı olduğunuz sunucuya özel).
- **Uygulama**: Windows açılışında başlat (varsayılan kapalı), tepsiye küçültülmüş başla, kapatınca tepsiye küçült. Tepsi menüsünde **ODA'yı göster** ve **Çıkış** vardır.
- **Yedekleme**: bkz. bölüm 9.
- **Gizlilik**: verilerin nerede saklandığı ve neyin şifrelendiği.
- **Hakkında ve tanılama**: sürüm, veri klasörü, anahtar koruması durumu, **Günlük klasörünü aç**.

## 9. Yedekleme ve geri yükleme

Mesajlar ve hesaplar sunucuda durur; bilgisayarınızda yalnızca cihaz anahtarlarınız ve ayarlarınız vardır. Bilgisayar değiştirirken veya Windows'u yeniden kurarken yedek alırsanız aynı hesapla yeni davet istemeden devam edersiniz.

- Ayarlar → Yedekleme → en az 8 karakterlik bir **yedek parolası** girin → **Yedeği dışa aktar**. `.odabak` dosyası katıldığınız sunucuların cihaz anahtarlarını ve ayarları içerir; parolanızla AES-256-GCM ile şifrelenir. **Parolayı kaybederseniz yedek açılamaz.**
- **Yedekten geri yükle**: yedekteki sunucu kayıtlarını ve ayarları bu bilgisayara ekler. Eski sürümlerin yedeklerindeki yerel oda veritabanı yok sayılır.
- Yedeğiniz yoksa sorun değil: yöneticiden yeni bir davet isteyip yeniden katılırsınız.

## 10. Kaldırma, güncelleme, yeniden kurma

- Windows Ayarları → Uygulamalar → ODA → **Kaldır**. Kaldırıcı, kullanıcı verilerinin (`%APPDATA%\ODA`) de silinip silinmeyeceğini sorar. Varsayılan **Hayır**'dır: veriler korunur ve ODA yeniden kurulduğunda kaldığınız yerden devam eder. **Evet** derseniz cihaz anahtarlarınız silinir ve sunucuya tekrar girmek için yeni davet gerekir.
- Yeni sürümü kurmak (güncelleme) veya yeniden kurmak verilerinize dokunmaz.

## 11. Veriler nerede?

| Veri | Konum |
|---|---|
| Katıldığınız sunucular ve cihaz anahtarları | `%APPDATA%\ODA\client.json` (anahtarlar Windows veri korumasıyla şifreli) |
| Ayarlar | `%APPDATA%\ODA\settings.json` |
| Günlükler | `%APPDATA%\ODA\logs\` — parola, davet sırrı, mesaj metni veya ses verisi yazılmaz |
| Mesajlar, hesaplar, odalar | Sunucuda (`/var/lib/oda`); bkz. [SUNUCU-KURULUMU.md](SUNUCU-KURULUMU.md) |

Eski bir ODA sürümünde kendi bilgisayarınızda oda açtıysanız `%APPDATA%\ODA\host` klasörü diskte kalır; yeni sürüm onu kullanmaz ve silmez.

## 12. Klavye

- **Tab / Shift+Tab**: odak gezintisi; tüm düğmelerin odak çerçevesi vardır.
- **Esc**: açık menü veya pencereyi kapatır.
- **Ctrl+B**: sol paneli gizle/göster. **Ctrl+J**: sohbet panelini gizle/göster.
- **Enter / Shift+Enter**: mesaj gönder / yeni satır.
