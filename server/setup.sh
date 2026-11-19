#!/usr/bin/env bash
# Vigilfall Realm — one-time setup (and later updates) for an Ubuntu server, e.g. Oracle Cloud Always Free (Arm or x86).
#   curl -fsSL https://raw.githubusercontent.com/polemarxos/Vigilfall/main/server/setup.sh | sudo bash
# Run it again any time to update the server code; your players and settings are kept.
set -euo pipefail

REPO="https://github.com/polemarxos/Vigilfall.git"
APP=/opt/vigilfall-realm
SRC=/opt/vigilfall-src
SVC=vigilfall-realm
ask() { local q="$1" d="${2:-}" a; if [ -r /dev/tty ]; then read -r -p "$q" a </dev/tty || true; fi; echo "${a:-$d}"; }
say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Run with sudo:  sudo bash setup.sh"; exit 1; }
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo "This script supports Ubuntu (recommended: Ubuntu 22.04 or 24.04). You have $PRETTY_NAME."; exit 1;; esac

say "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent cron

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  say "Caddy (web server with automatic HTTPS)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

say "Realm server code"
id vigilfall >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/vigilfall --shell /usr/sbin/nologin vigilfall
# fresh shallow copy of the repository every time (older git versions break on sparse clones)
rm -rf "$SRC"
git clone --depth 1 "$REPO" "$SRC"
[ -f "$SRC/server/realm.js" ] || { echo "Could not download the server code from $REPO"; exit 1; }
mkdir -p "$APP"
cp -r "$SRC/server/." "$APP/"
mkdir -p "$APP/data" "$APP/game"
chown -R vigilfall:vigilfall "$APP"
cd "$APP"
sudo -u vigilfall -H npm install --omit=dev --no-audit --no-fund
say "Headless browser for the world (this takes a few minutes the first time)"
npx --yes playwright install-deps chromium
sudo -u vigilfall -H npx --yes playwright install chromium

say "Address of your Realm"
CUR=""; [ -f /etc/caddy/Caddyfile ] && CUR=$(grep -oE '^[a-z0-9.-]+\.[a-z]{2,}' /etc/caddy/Caddyfile | head -1 || true)
echo "Players need a name for your server so the game can use a secure connection (https/wss)."
echo "Free option: make a subdomain at https://www.duckdns.org (sign in, type a name, press 'add domain')."
DOMAIN=$(ask "Domain [${CUR:-myrealm.duckdns.org}]: " "$CUR")
DOMAIN=$(echo "$DOMAIN" | sed -E 's#^https?://##; s#/.*##' | tr 'A-Z' 'a-z')
[ -n "$DOMAIN" ] || { echo "A domain is required."; exit 1; }
if [[ "$DOMAIN" == *.duckdns.org ]]; then
  TOKEN=$(ask "DuckDNS token (top of the duckdns.org page; Enter to skip): " "")
  if [ -n "$TOKEN" ]; then
    SUB=${DOMAIN%.duckdns.org}
    cat > /etc/cron.d/duckdns <<EOF
*/5 * * * * root curl -fsS "https://www.duckdns.org/update?domains=$SUB&token=$TOKEN&ip=" >/dev/null 2>&1
EOF
    curl -fsS "https://www.duckdns.org/update?domains=$SUB&token=$TOKEN&ip=" && echo " (DuckDNS updated)"
  fi
fi

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:8787
}
EOF

say "Firewall (ports 80 and 443)"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport $p -m state --state NEW -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport $p -m state --state NEW -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true

say "Service"
cat > /etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=Vigilfall Realm
After=network-online.target
Wants=network-online.target

[Service]
User=vigilfall
WorkingDirectory=$APP
ExecStart=/usr/bin/node $APP/realm.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable $SVC >/dev/null
systemctl restart $SVC
systemctl restart caddy

for i in $(seq 1 20); do [ -f "$APP/data/config.json" ] && break; sleep 1; done
PW=$(node -p "require('$APP/data/config.json').adminPassword" 2>/dev/null || echo "(see $APP/data/config.json)")
IP=$(curl -fsS https://api.ipify.org 2>/dev/null || echo "your server's public IP")

say "Done"
cat <<EOF
Realm address:   $DOMAIN
Admin password:  $PW
Admin page:      https://$DOMAIN/admin   (or the Vigilfall Admin app)

ONE MORE STEP in the Oracle Cloud console (only once):
  Networking > Virtual cloud networks > your VCN > Security Lists > Default Security List
  > Add Ingress Rules: Source CIDR 0.0.0.0/0, IP protocol TCP, destination port 80  — and again for 443.
Also make sure $DOMAIN points to $IP.

The world needs about a minute to start. Check it with:
  sudo systemctl status $SVC        sudo journalctl -u $SVC -f
In the game: main menu > ⚙ next to "Enter the Realm" > $DOMAIN
EOF
