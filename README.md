# ODA

**Tasarimola.com** tarafından ücretsiz ve açık kaynak olarak yayınlanan Windows 10/11 sesli sohbet ve mesajlaşma uygulaması.

> Bu Yazılım Tasarimola.com tarafından (Aşk) ile yapılmıştır.

Topluluk kendi ODA sunucunuzda (VPS, `oda-server`) çalışır; masaüstü uygulaması istemcidir. Ses aynı sunucudaki LiveKit SFU üzerinden gider; oda başına 50 kişiye kadar, port açmadan bağlanılır.

## İndir (Windows)

En son hazır yükleyiciyi [Releases](../../releases) sayfasından indirin: **`ODA-Setup-x64.exe`**.

```powershell
Get-FileHash .\ODA-Setup-x64.exe -Algorithm SHA256
```

Yükleyici kod imzalı değildir; Windows SmartScreen uyarı gösterebilir. Dosyayı bu sayfadan aldıysanız **Ek bilgi → Yine de çalıştır** seçebilirsiniz.

## Özellikler

- TLS WebSocket signaling + mesajlaşma, sunucuda SQLite
- Davet kodları, sertifika parmak izi sabitleme, Ed25519 cihaz anahtarları
- Kendi odanı kur / davetle katıl; arkadaş listesinden sese katıl
- Oda sohbeti, özel mesajlar, arkadaşlık, arama
- Türkçe arayüz, tepsi, yedekleme

## Belgeler

- [Kullanım kılavuzu](docs/KULLANIM-KILAVUZU.md)
- [Sunucu kurulumu](docs/SUNUCU-KURULUMU.md)
- [Mimari ve güvenlik](docs/ARCHITECTURE.md)
- [Test raporu](docs/TEST-RAPORU.md)

## Geliştirme

- Windows 10/11 x64
- Node.js 22+ ve npm

```powershell
npm ci
npm run build
npm start
npm test
npm run test:e2e
npm run dist:win          # out\ODA-Setup-x64.exe
```

## Lisans

[MIT](LICENSE) — Copyright © 2026 [Tasarimola.com](https://tasarimola.com)

Herkes kullanabilir, değiştirebilir ve dağıtabilir. Marka ve katkı için: **Tasarimola.com**.

## Bilinen sınırlar

- Bir ODA sunucusu gerekir; sunucu kapalıyken kimse bağlanamaz.
- TURN/443 aktarması yoktur. `7882/UDP` ve `7881/TCP` kapalı ağlarda ses kurulamayabilir.
- Mesajlar ve ses uçtan uca şifreli değildir; sunucu bunlara erişebilir (Gizlilik ekranında yazılır).
- Kod imzalama yoksa SmartScreen uyarısı çıkabilir.
