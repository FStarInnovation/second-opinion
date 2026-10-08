#!/usr/bin/env bash
# Разовая настройка сервера heidi (AlmaLinux 10) под Second opinion.
# Запуск с Mac:  ssh heidi 'bash -s' < deploy/heidi/setup.sh
# Нужен sudo без пароля или с паролем (спросит один раз). Повторный запуск безопасен.
set -euo pipefail

APP_USER="${APP_USER:-$USER}"              # под кем работает сервис (ez)
APP_DIR="${APP_DIR:-/opt/second-opinion}"  # рабочее дерево
REPO_DIR="${REPO_DIR:-$HOME/git/second-opinion.git}"  # bare-репозиторий, в него пушим с Mac
DOMAIN="${DOMAIN:-mkt-second-opinion.ru}"

say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

say "Пакеты: git, Node.js, npm"
sudo dnf install -y git nodejs npm >/dev/null
node -v; npm -v
NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node $NODE_MAJOR слишком старый — нужен 20+. Поставьте nodejs 22 из AppStream и запустите снова."; exit 1
fi

say "Caddy (HTTPS и обратный прокси)"
if ! command -v caddy >/dev/null; then
  if sudo dnf install -y 'dnf-command(copr)' >/dev/null 2>&1 && sudo dnf copr enable -y @caddy/caddy >/dev/null 2>&1 && sudo dnf install -y caddy >/dev/null 2>&1; then
    echo "caddy из COPR @caddy/caddy"
  else
    echo "COPR для EL10 недоступен — ставлю официальный бинарник"
    sudo dnf copr disable -y @caddy/caddy >/dev/null 2>&1 || true
    curl -fsSL -o /tmp/caddy "https://caddyserver.com/api/download?os=linux&arch=amd64"
    sudo install -m 0755 /tmp/caddy /usr/local/bin/caddy
    sudo groupadd --system caddy 2>/dev/null || true
    sudo useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin --comment "Caddy web server" caddy 2>/dev/null || true
    sudo mkdir -p /etc/caddy
    sudo tee /etc/systemd/system/caddy.service >/dev/null <<'UNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
  fi
fi
caddy version

say "Caddyfile → $DOMAIN"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DOMAIN, www.$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
	log {
		output file /var/log/caddy/access.log
	}
}
CADDY
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo systemctl daemon-reload
sudo systemctl enable --now caddy
sudo systemctl reload caddy || sudo systemctl restart caddy

say "SELinux и firewalld"
if command -v setsebool >/dev/null && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  sudo setsebool -P httpd_can_network_connect 1 || true
fi
if systemctl is-active --quiet firewalld; then
  sudo firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  sudo firewall-cmd --reload >/dev/null
  echo "80/443 открыты"
fi

say "Bare-репозиторий $REPO_DIR и рабочее дерево $APP_DIR"
mkdir -p "$(dirname "$REPO_DIR")"
[ -d "$REPO_DIR" ] || git init --bare -q "$REPO_DIR"
sudo mkdir -p "$APP_DIR" && sudo chown "$APP_USER:$APP_USER" "$APP_DIR"
mkdir -p "$APP_DIR/apps/web/.usage"

say "systemd-сервис second-opinion (next start на :3000)"
sudo tee /etc/systemd/system/second-opinion.service >/dev/null <<UNIT
[Unit]
Description=Second opinion (Next.js)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/apps/web
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=3
# Логи: journalctl -u second-opinion -f
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable second-opinion >/dev/null

say "sudo без пароля только на перезапуск сервиса (для deploy.sh)"
echo "$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart second-opinion, /usr/bin/systemctl start second-opinion, /usr/bin/systemctl stop second-opinion, /usr/bin/systemctl status second-opinion" | sudo tee /etc/sudoers.d/second-opinion >/dev/null
sudo chmod 0440 /etc/sudoers.d/second-opinion
sudo usermod -aG systemd-journal "$APP_USER" || true

say "Готово. Дальше:"
cat <<EOF
1. На Mac добавить remote и запушить код:
     git remote add heidi $APP_USER@heidi:$REPO_DIR
     git push heidi e2-blocks-page:main
2. Создать $APP_DIR/apps/web/.env на сервере (ключи вводите сами):
     ssh heidi nano $APP_DIR/apps/web/.env
3. Собрать и запустить:
     ssh heidi 'bash -s' < deploy/heidi/deploy.sh
4. DNS: A-запись $DOMAIN (и www) → $(curl -4 -fsS ifconfig.me 2>/dev/null || echo 'IP сервера'). Caddy получит сертификат сам.
EOF
