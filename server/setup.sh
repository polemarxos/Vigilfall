#!/usr/bin/env bash
# Vigilfall Realm — one-time setup (and later updates) for an Ubuntu server, e.g. Oracle Cloud Always Free (Arm or x86).
#   curl -fsSL https://raw.githubusercontent.com/polemarxos/Vigilfall/main/server/setup.sh | sudo bash
# Without questions:  ... | sudo VF_DOMAIN=myrealm.duckdns.org VF_DUCKDNS_TOKEN=xxxx bash
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
echo "System: $PRETTY_NAME · $(uname -m) · $(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo) MB memory · $(nproc) CPU(s)"
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
ARCH=$(uname -m)
CHROME=""
PW_OVERRIDE=""
if [ "$ARCH" = "x86_64" ]; then
  # Google Chrome works on every 64-bit Ubuntu/Debian, also versions Playwright does not know yet
  if ! command -v google-chrome >/dev/null; then
    curl -fsSL -o /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get install -y /tmp/google-chrome.deb
    rm -f /tmp/google-chrome.deb
  fi
  CHROME=$(command -v google-chrome)
else
  if npx --yes playwright install-deps chromium && sudo -u vigilfall -H npx --yes playwright install chromium; then
    CHROME=""
  elif {
    # newer Ubuntu that Playwright does not list yet: use its Ubuntu 24.04 build and install the libraries by hand
    echo "Using Playwright's Ubuntu 24.04 browser on $PRETTY_NAME"
    for pkg in libnss3 libnspr4 libatk1.0-0t64 libatk1.0-0 libatk-bridge2.0-0t64 libatk-bridge2.0-0 libcups2t64 libcups2 libdrm2 libdbus-1-3 \
               libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libasound2 \
               libatspi2.0-0t64 libatspi2.0-0 libx11-xcb1 libxcb1 libxext6 libxshmfence1 libglib2.0-0t64 libglib2.0-0 fonts-liberation; do
      apt-get install -y "$pkg" >/dev/null 2>&1 || true
    done
    sudo -u vigilfall -H env PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-$( [ "$ARCH" = aarch64 ] && echo arm64 || echo x64 ) npx --yes playwright install chromium
  }; then
    CHROME=""
    PW_OVERRIDE="ubuntu24.04-$( [ "$ARCH" = aarch64 ] && echo arm64 || echo x64 )"
  else
    echo "Playwright's browser is not available for this system; using the distribution's Chromium."
    apt-get install -y chromium || apt-get install -y chromium-browser
    CHROME=$(command -v chromium || command -v chromium-browser || true)
    [ -n "$CHROME" ] || { echo "Could not install a browser. Please use Ubuntu 22.04 or 24.04."; exit 1; }
  fi
fi
echo "Browser: ${CHROME:-Playwright Chromium}"

# small servers: add swap so the world never runs out of memory
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 6000 ] && ! swapon --show | grep -q .; then
  say "Adding 4 GB swap (this server has ${MEM_MB} MB memory)"
  fallocate -l 4G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=4096
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Address of your Realm"
CUR=""; [ -f /etc/caddy/Caddyfile ] && CUR=$(grep -oE '^[a-z0-9.-]+\.[a-z]{2,}' /etc/caddy/Caddyfile | head -1 || true)
echo "Players need a name for your server so the game can use a secure connection (https/wss)."
echo "Free option: make a subdomain at https://www.duckdns.org (sign in, type a name, press 'add domain')."
DOMAIN=${VF_DOMAIN:-$(ask "Domain [${CUR:-myrealm.duckdns.org}]: " "$CUR")}
DOMAIN=$(echo "$DOMAIN" | sed -E 's#^https?://##; s#/.*##' | tr 'A-Z' 'a-z')
[ -n "$DOMAIN" ] || { echo "A domain is required."; exit 1; }
if [[ "$DOMAIN" == *.duckdns.org ]]; then
  TOKEN=${VF_DUCKDNS_TOKEN:-$(ask "DuckDNS token (top of the duckdns.org page; Enter to skip): " "")}
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
Environment=CHROME_PATH=$CHROME
Environment=PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=$PW_OVERRIDE
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
