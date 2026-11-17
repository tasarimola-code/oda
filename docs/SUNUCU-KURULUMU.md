# ODA Sunucusu (VPS) — Kurulum ve Yönetim

ODA topluluğu her zaman bir ODA sunucusunda çalışır; masaüstü uygulaması yalnızca istemcidir. Sunucu sürekli açık olduğu için farklı evlerden ve ağlardan herkes, modemde port açmadan bağlanır. Ses, aynı sunucuda çalışan **LiveKit** ses dağıtıcısı (SFU) üzerinden gider (oda başına varsayılan 25, en çok 50 kişi).

Arkadaşlar yalnızca `ODA-Setup-x64.exe`'yi kurar ve sunucunun davet kodunu **Davet kodu** alanına yapıştırır; uygulama hemen bağlanır. Ek ayar, ayrı istemci veya hesap gerekmez. Uygulama, bağlandığı karşı taraf kendini ODA sunucusu olarak tanıtmazsa davet harcanmadan bağlantıyı reddeder.

## 1. Gereksinimler

- Ubuntu 22.04 veya 24.04, x86_64, root erişimi
- Sabit bir genel IPv4 adresi
- Açık olması gereken portlar (kurulum betiği `ufw` etkinse kuralları kendisi ekler; sağlayıcının panelinde ayrı bir güvenlik duvarı varsa orada da açın):

| Port | Ne için |
|---|---|
| `47823/TCP` | ODA bağlantısı: giriş, mesajlar, davetler, ses sinyali (TLS, sertifika parmak iziyle sabitlenir) |
| `7882/UDP` | Ses (tercih edilen yol) |
| `7881/TCP` | Ses için yedek yol (UDP engelliyse) |
| `7880/TCP` | LiveKit API — **yalnızca 127.0.0.1**, dışarı açılmaz. İstemciler LiveKit'e doğrudan değil ODA sunucusu üzerinden bağlanır. |

Kurulum yalnızca `/opt/oda`, `/etc/oda`, `/var/lib/oda`, `/usr/local/bin/oda-server`, `/etc/sysctl.d/60-oda-livekit.conf` ve iki systemd birimine dokunur. Sistemdeki Node.js, nginx, Docker, veritabanları gibi diğer servisler değiştirilmez; ODA kendi Node.js 22 kopyasını `/opt/oda/node` altına kurar.

## 2. Kurulum

Geliştirme bilgisayarında sunucu paketini derleyin:

```powershell
npm ci
npm run build            # dist\server\oda-server.cjs üretilir
```

`deploy\` klasöründeki dosyaları ve `dist\server\oda-server.cjs`'i sunucuda aynı klasöre kopyalayın:

```powershell
scp deploy\install.sh deploy\livekit.yaml.template deploy\oda-livekit.service deploy\oda-server.service deploy\package.json dist\server\oda-server.cjs root@SUNUCU_IP:/root/oda-deploy/
```

Sunucuda:

```bash
cd /root/oda-deploy
bash install.sh SUNUCU_IP "Topluluk Adı"
```

Betik şunları yapar:
- Node.js 22.23.3 ve LiveKit 1.13.7'yi indirir, SHA-256 özetlerini doğrular.
- `oda` sistem kullanıcısını oluşturur.
- LiveKit anahtarlarını üretir (`/etc/oda/livekit.yaml`, yalnızca root ve `oda` okuyabilir).
- Sunucunun TLS kimliğini ve veritabanını oluşturur.
- UDP tamponlarını büyütür, servisleri başlatır ve güvenlik duvarı kurallarını ekler.

Sonunda tek kullanımlık, 24 saat geçerli bir **yönetici daveti** yazdırır.

İlk iş, bu yönetici davetini kendi ODA uygulamanızda **Davet kodu** alanına yapıştırın. İlk katılan yönetici topluluğun sahibi olur ve "Genel" odası (25 kişilik) oluşur. Sonrasında üye davetlerini uygulamadaki **Davet oluştur** ile üretebilirsiniz (sunucuda varsayılan: 50 kullanım, 7 gün; en çok 1000 kullanım, 90 gün).

## 3. Komutlar

```bash
oda-server status                         # topluluk, adres, parmak izi, üye ve oda sayısı
oda-server invite --admin                 # yeni yönetici daveti (varsayılan 1 kullanım, 1 gün)
oda-server invite --uses 50 --days 7      # üye daveti (önce bir yönetici katılmış olmalı)
oda-server invites                        # davetler ve durumları
oda-server revoke <id>                    # daveti iptal et
oda-server rename --name "Yeni Ad"        # topluluk adını değiştir
oda-server backup /root/oda-yedek.db      # anlık veritabanı yedeği

systemctl status oda-server oda-livekit
systemctl restart oda-server oda-livekit
journalctl -u oda-server -f               # ODA günlüğü
journalctl -u oda-livekit -f              # ses sunucusu günlüğü
```

Sunucu ayrıca saatte bir otomatik yedek alır (son 14 yedek, `/var/lib/oda/backups/auto-<zaman>.db`).

Yedekten geri yüklemek (veritabanı bozulursa `oda-server` başlamaz ve `journalctl -u oda-server` bunu yazar):

```bash
systemctl stop oda-server
mkdir -p /root/oda-bozuk && mv /var/lib/oda/oda-host.db* /root/oda-bozuk/
cp /var/lib/oda/backups/auto-<zaman>.db /var/lib/oda/oda-host.db     # veya kendi aldığınız yedek
chown oda:oda /var/lib/oda/oda-host.db && chmod 600 /var/lib/oda/oda-host.db
systemctl start oda-server
```

`tls.json` değişmediği sürece parmak izi aynı kalır ve üyeler yeniden davet gerektirmeden bağlanır; yalnızca yedekten sonraki mesajlar kaybolur.

## 4. Dosyalar

| Yol | İçerik |
|---|---|
| `/var/lib/oda/oda-host.db` | Hesaplar, arkadaşlıklar, odalar, **mesajlar** (SQLite) |
| `/var/lib/oda/tls.json` | Sunucunun TLS kimlik anahtarı. Bunu kaybetmek parmak izini değiştirir; eski davetler ve kayıtlı cihazlar yeniden davet gerektirir. |
| `/var/lib/oda/server.json` | Ad, genel adres, port, LiveKit bağlantısı |
| `/var/lib/oda/backups/` | Otomatik yedekler |
| `/etc/oda/livekit.yaml` | LiveKit ayarı ve API anahtarı (gizli) |
| `/opt/oda/` | Node.js, LiveKit ve ODA sunucu paketi |

## 5. Güncelleme

Yeni `oda-server.cjs` ile aynı `install.sh` komutunu tekrar çalıştırın. Veriler, anahtarlar ve sertifika korunur; servisler yeniden başlatılır. Mevcut üyeler yeniden davet gerektirmez.

## 6. Sıfırlama ve kaldırma

Topluluğu tamamen sıfırlamak (tüm üyeler, mesajlar ve davetler silinir, parmak izi değişir):

```bash
systemctl stop oda-server
rm -rf /var/lib/oda
bash /root/oda-deploy/install.sh SUNUCU_IP "Topluluk Adı"   # yeni yönetici daveti yazdırır
```

Kaldırmak:

```bash
systemctl disable --now oda-server oda-livekit
rm -f /etc/systemd/system/oda-server.service /etc/systemd/system/oda-livekit.service /usr/local/bin/oda-server /etc/sysctl.d/60-oda-livekit.conf
systemctl daemon-reload
rm -rf /opt/oda /etc/oda /var/lib/oda
userdel oda
ufw delete allow 47823/tcp; ufw delete allow 7881/tcp; ufw delete allow 7882/udp
```

## 7. Güvenlik ve gizlilik

- **Her ağ isteği sunucuda kimlik ve yetki kontrolünden geçer.**
  - Ses odasına giriş için sunucu, yalnızca o odaya ve yalnızca mikrofon yayınına izin veren, 10 dakika geçerli bir LiveKit bileti üretir.
  - Ses sinyali sunucuya gelince bilet doğrulanır ve kişinin gerçekten o ses odasında, yasaklı olmadığı kontrol edilir. Sonra istek LiveKit'e iletilir.
  - Odadan çıkan, çıkarılan veya yasaklanan kişi LiveKit'ten de düşürülür.
- **Sertifika doğrulaması kapatılmaz.** Sunucunun sertifikası kendinden imzalıdır ve davet kodundaki SHA-256 parmak iziyle sabitlenir. Uygulama bu kontrolü ses bağlantısında da yapar: yerel köprü, parmak izi uyuşmayan sunucuya tek bayt göndermez.
- **Mesajlar** sunucuda SQLite'ta şifrelenmeden saklanır; sunucu yöneticisi okuyabilir.
- **Ses uçtan uca şifreli değildir.** Aktarım DTLS-SRTP ile şifrelidir, ancak SFU sesi çözerek diğer katılımcılara iletir. Sunucu teknik olarak sese erişebilir. ODA ses kaydı yapmaz. Uygulamanın Gizlilik ekranı bunu sunucuya bağlıyken açıkça gösterir.
- Ses bağlantısı üçüncü taraf STUN/TURN sunucusu kullanmaz; istemciler yalnızca sizin sunucunuzla konuşur. Masaüstü uygulaması bilgisayarda gelen bağlantı dinlemez.
- Günlüklere parola, davet sırrı, mesaj metni veya ses verisi yazılmaz. Davet kimlikleri günlükte `[gizli]` olarak görünür.
- **Sunucu erişimi:** root parolasını başkasıyla paylaştıysanız değiştirin (`passwd`). SSH anahtarıyla giriş kurun ve parola ile SSH girişini kapatın (`/etc/ssh/sshd_config` → `PasswordAuthentication no`, ardından `systemctl reload ssh`). Kapatmadan önce anahtarla girebildiğinizi ayrı bir oturumda doğrulayın.

## 8. Bilinen sınırlar

- **TURN/443 aktarması yoktur.** Yalnızca 443 portuna izin veren kurumsal veya okul ağlarında (`7882/UDP` ve `7881/TCP` kapalıysa) ses kurulamaz; mesajlaşma yine de çalışabilir.
- Sunucu tek makinedir: sunucu kapalıysa topluluğa erişilemez.
- Uzaktan test, sunucuya bu geliştirme bilgisayarından (tek ev ağı) yapıldı. Farklı evlerden gerçek kullanıcılarla test ayrıca yapılmalıdır. Ayrıntılar: [TEST-RAPORU.md](TEST-RAPORU.md).
