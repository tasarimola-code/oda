#!/usr/bin/env bash
# ODA dedicated server installer for Ubuntu 22.04/24.04 (x86_64). Run as root from the folder that
# contains this script, oda-server.cjs, package.json, livekit.yaml.template and the two .service files.
#
#   bash install.sh <PUBLIC_IP> ["Topluluk adı"]
#
# Re-running upgrades the ODA server bundle and keeps data, keys and certificates.
# Installs only under /opt/oda, /etc/oda, /var/lib/oda and two systemd units; the system Node.js
# and other services are not touched.
set -euo pipefail

PUBLIC_IP="${1:?kullanım: bash install.sh <PUBLIC_IP> [\"Topluluk adı\"]}"
NAME="${2:-ODA Topluluğu}"
NODE_VERSION=22.23.3
NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
LIVEKIT_VERSION=1.13.7
LIVEKIT_SHA256=6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2
ODA_PORT=47823
PREFIX=/opt/oda
DATA=/var/lib/oda
ETC=/etc/oda
SRC="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" = 0 ] || { echo "root olarak çalıştırın" >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "yalnızca x86_64 destekleniyor" >&2; exit 1; }
for f in oda-server.cjs package.json livekit.yaml.template oda-server.service oda-livekit.service; do
  [ -f "$SRC/$f" ] || { echo "eksik dosya: $f" >&2; exit 1; }
done

id oda >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin oda
install -d -m 755 "$PREFIX" "$PREFIX/app"
install -d -m 700 -o oda -g oda "$DATA"
install -d -m 750 -o root -g oda "$ETC"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Private Node.js runtime for the ODA server.
if [ "$("$PREFIX/node/bin/node" -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  echo "Node.js $NODE_VERSION indiriliyor…"
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum -c -
  rm -rf "$PREFIX/node" && mkdir -p "$PREFIX/node"
  tar -xJf "$tmp/node.tar.xz" -C "$PREFIX/node" --strip-components=1
fi

# LiveKit media server.
if ! "$PREFIX/livekit/livekit-server" --version 2>/dev/null | grep -q "$LIVEKIT_VERSION"; then
  echo "LiveKit $LIVEKIT_VERSION indiriliyor…"
  curl -fsSL -o "$tmp/livekit.tar.gz" "https://github.com/livekit/livekit/releases/download/v$LIVEKIT_VERSION/livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz"
  echo "$LIVEKIT_SHA256  $tmp/livekit.tar.gz" | sha256sum -c -
  mkdir -p "$PREFIX/livekit"
  tar -xzf "$tmp/livekit.tar.gz" -C "$PREFIX/livekit" livekit-server
  chmod 755 "$PREFIX/livekit/livekit-server"
fi

# ODA server bundle and its only native dependency.
install -m 644 "$SRC/oda-server.cjs" "$PREFIX/app/oda-server.cjs"
install -m 644 "$SRC/package.json" "$PREFIX/app/package.json"
(cd "$PREFIX/app" && PATH="$PREFIX/node/bin:$PATH" npm install --omit=dev --no-audit --no-fund --loglevel=error)

# Media server keys: generated once, readable by the oda user only.
if [ ! -f "$ETC/livekit.yaml" ]; then
  KEY="API$(openssl rand -hex 6)"
  SECRET="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-48)"
  # When the public IP sits on a local interface, media binds only to it, not to docker/VPN bridges.
  if ip -o -4 addr show | grep -q " inet $PUBLIC_IP/"; then
    IPS="  ips:\n    includes:\n      - $PUBLIC_IP/32"
  else
    IPS=""
  fi
  sed -e "s/__NODE_IP__/$PUBLIC_IP/" -e "s/__KEY__/$KEY/" -e "s/__SECRET__/$SECRET/" -e "s|^__IPS__$|$IPS|" "$SRC/livekit.yaml.template" | sed '/^$/d' > "$ETC/livekit.yaml"
fi
chown root:oda "$ETC/livekit.yaml"
chmod 640 "$ETC/livekit.yaml"
read -r KEY SECRET < <(awk '/^keys:/ {getline; gsub(/[: ]+/, " "); sub(/^ /, ""); print; exit}' "$ETC/livekit.yaml")

cat > /usr/local/bin/oda-server <<EOF
#!/bin/sh
exec runuser -u oda -- env ODA_DATA=$DATA $PREFIX/node/bin/node $PREFIX/app/oda-server.cjs "\$@"
EOF
chmod 755 /usr/local/bin/oda-server

FRESH=0
if [ ! -f "$DATA/server.json" ]; then
  # ODA_OPEN=0 makes the server invite-only; by default anyone with the app can create an account and rooms.
  OPEN_FLAG=""
  [ "${ODA_OPEN:-1}" = 1 ] && OPEN_FLAG="--open"
  oda-server init --name "$NAME" --public "$PUBLIC_IP" --port "$ODA_PORT" --livekit-key "$KEY" --livekit-secret "$SECRET" $OPEN_FLAG
  FRESH=1
fi

# Larger UDP socket buffers, as recommended by LiveKit for many simultaneous audio streams.
cat > /etc/sysctl.d/60-oda-livekit.conf <<EOF
net.core.rmem_max=5000000
net.core.wmem_max=5000000
EOF
sysctl -q -p /etc/sysctl.d/60-oda-livekit.conf

install -m 644 "$SRC/oda-livekit.service" /etc/systemd/system/oda-livekit.service
install -m 644 "$SRC/oda-server.service" /etc/systemd/system/oda-server.service
systemctl daemon-reload
systemctl enable oda-livekit.service oda-server.service
systemctl restart oda-livekit.service oda-server.service

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow "$ODA_PORT/tcp" comment 'ODA server' >/dev/null
  ufw allow 7881/tcp comment 'ODA media TCP' >/dev/null
  ufw allow 7882/udp comment 'ODA media UDP' >/dev/null
fi

sleep 2
systemctl --no-pager --lines=0 status oda-livekit.service oda-server.service || true
oda-server status
if [ "$FRESH" = 1 ]; then
  echo
  oda-server invite --admin
  echo "Bu yönetici davetini ODA uygulamasındaki \"Davet kodu\" alanına yapıştırın (24 saat, tek kullanımlık)."
  echo "Yönetici hesabı isteğe bağlıdır; açık kayıtta kullanıcılar kendi odalarını davetsiz açabilir."
fi
