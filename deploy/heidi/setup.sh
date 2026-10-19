#!/usr/bin/env bash
# Разовая настройка сервера heidi (AlmaLinux 10) под Second opinion: сайт (second-opinion) и Telegram-бот (second-opinion-bot).
# Запуск с Mac (sudo спросит пароль — поэтому копируем файл и запускаем с терминалом, а не через bash -s):
#   scp deploy/heidi/setup.sh heidi:setup.sh && ssh -t heidi bash setup.sh
# Повторный запуск безопасен. Бота setup.sh не запускает: его запускает deploy.sh, когда есть apps/bot/.env (план WP-TG §7).
set -euo pipefail

# Можно запускать как ez с sudo — или напрямую под root (тогда sudo не нужен): APP_USER=ez bash setup.sh
if [ "$(id -u)" = 0 ]; then
  sudo() { if [ "${1:-}" = "-u" ]; then local u=$2; shift 2; runuser -u "$u" -- "$@"; else "$@"; fi; }
  APP_USER="${APP_USER:-ez}"
else
  APP_USER="${APP_USER:-$USER}"              # под кем работает сервис (ez)
  if ! sudo -n true 2>/dev/null; then
    echo "Нужны права root: у $USER нет sudo без пароля. Варианты: (а) ввести пароль sudo, когда спросит;"
    echo "(б) тот, у кого есть root, запускает:  APP_USER=$USER bash setup.sh"; echo
  fi
fi
APP_HOME=$(eval echo "~$APP_USER")
APP_DIR="${APP_DIR:-/opt/second-opinion}"  # рабочее дерево
REPO_DIR="${REPO_DIR:-$APP_HOME/git/second-opinion.git}"  # bare-репозиторий, в него пушим с Mac
# Имена сайта. Пока DNS mkt-second-opinion.ru не указывает сюда — временная ссылка через sslip.io
# (публичный DNS: 40-160-87-140.sslip.io → 40.160.87.140; Let's Encrypt выдаёт на него обычный сертификат).
# Когда домен переедет: DOMAINS="mkt-second-opinion.ru www.mkt-second-opinion.ru $SSLIP_HOST" bash setup.sh
PUBLIC_IP="${PUBLIC_IP:-$(curl -4 -fsS --max-time 10 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')}"
SSLIP_HOST="${PUBLIC_IP//./-}.sslip.io"
DOMAINS="${DOMAINS:-$SSLIP_HOST}"

say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

say "Пакеты: git, nano, Node.js, npm"
sudo dnf install -y git nano nodejs npm >/dev/null
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

say "Caddyfile → $DOMAINS (+ http://$PUBLIC_IP)"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
# Сгенерировано deploy/heidi/setup.sh. HTTPS-имена (сертификаты Caddy получает сам):
$DOMAINS {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
	log {
		output file /var/log/caddy/access.log
	}
}
# Запасной вход по IP без сертификата
http://$PUBLIC_IP {
	reverse_proxy 127.0.0.1:3000
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

say "Bare-репозиторий $REPO_DIR и рабочее дерево $APP_DIR (владелец $APP_USER)"
sudo -u "$APP_USER" mkdir -p "$(dirname "$REPO_DIR")"
[ -d "$REPO_DIR" ] || sudo -u "$APP_USER" git init --bare -q "$REPO_DIR"
# apps/bot/.state (heartbeat бота) — в .gitignore: checkout его не создаёт и не удаляет; без него юнит бота не стартует
sudo mkdir -p "$APP_DIR/apps/web/.usage" "$APP_DIR/apps/bot/.state" && sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo chmod 700 "$APP_DIR/apps/bot/.state"

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

# Telegram-бот (план WP-TG §3, §7): отдельный процесс, long polling (только исходящий HTTPS к api.telegram.org), ходы — в
# 127.0.0.1:3000. Без Requires=: рестарт сайта не убивает бота (бот переживает ECONNREFUSED повтором).
# ConditionPathExists: после отката на коммит без apps/bot или без apps/bot/.env юнит пропускается, а не крутится в Restart=always.
# ReadWritePaths= без «-»: при ProtectSystem=strict писать можно только в .state (heartbeat); нет каталога — ошибка видна сразу.
# KillMode=mixed: SIGTERM получает только npm, он передаёт его tsx, tsx — main.ts; бот доделывает ходы (≤ 30 с, TimeoutStopSec=35).
#   При KillMode=control-group (по умолчанию) main.ts получил бы SIGTERM дважды — от systemd и через npm → tsx, — и tsx на втором
#   завершил бы его сразу (exit 143), ход в полёте пропал бы. npm_config_script_shell=/bin/bash: скрипт start исполняет bash
#   (exec, без промежуточного sh, который сигнал не передаёт) — дерево npm → tsx → main.ts не зависит от того, чем является /bin/sh.
say "systemd-сервис second-opinion-bot (Telegram-бот; запускает deploy.sh)"
sudo tee /etc/systemd/system/second-opinion-bot.service >/dev/null <<UNIT
[Unit]
Description=Second opinion Telegram bot
After=network-online.target second-opinion.service
Wants=network-online.target second-opinion.service
ConditionPathExists=$APP_DIR/apps/bot/package.json
ConditionPathExists=$APP_DIR/apps/bot/.env

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/apps/bot
EnvironmentFile=$APP_DIR/apps/bot/.env
Environment=NODE_ENV=production
Environment=npm_config_script_shell=/bin/bash
Environment=npm_config_update_notifier=false
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=35
MemoryMax=512M
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=$APP_DIR/apps/bot/.state
# Логи: journalctl -u second-opinion-bot -f (только служебные записи: без текстов, chat_id и токена)
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable second-opinion-bot >/dev/null

say "sudo без пароля только на управление сервисами (для deploy.sh)"
SUDOERS_TMP=$(mktemp)
echo "$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart second-opinion, /usr/bin/systemctl start second-opinion, /usr/bin/systemctl stop second-opinion, /usr/bin/systemctl status second-opinion, /usr/bin/systemctl restart second-opinion-bot, /usr/bin/systemctl start second-opinion-bot, /usr/bin/systemctl stop second-opinion-bot, /usr/bin/systemctl status second-opinion-bot" > "$SUDOERS_TMP"
# проверка синтаксиса до установки: битый файл в sudoers.d ломает sudo целиком
sudo visudo -cqf "$SUDOERS_TMP"
sudo install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/second-opinion
rm -f "$SUDOERS_TMP"
sudo usermod -aG systemd-journal "$APP_USER" || true

say "Доступ к api.telegram.org (для бота)"
TG_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://api.telegram.org 2>/dev/null || true)
case "$TG_HTTP" in
  2??|3??) echo "api.telegram.org доступен (HTTP $TG_HTTP)" ;;
  *) echo "api.telegram.org НЕ доступен (HTTP ${TG_HTTP:-нет ответа}) — бот не сможет опрашивать Telegram; нужен прокси (план WP-TG §7)" ;;
esac

say "Готово. Дальше:"
cat <<EOF
1. На Mac добавить remote и запушить код:
     git remote add heidi $APP_USER@heidi:${REPO_DIR#"$APP_HOME/"}
     git push heidi e2-blocks-page:main
2. Создать $APP_DIR/apps/web/.env на сервере (ключи вводите сами):
     ssh heidi nano $APP_DIR/apps/web/.env
3. Собрать и запустить:
     ssh heidi 'bash -s' < deploy/heidi/deploy.sh
4. Ссылка для коллег (после шага 3): https://$SSLIP_HOST  (запасная: http://$PUBLIC_IP)
5. Когда DNS mkt-second-opinion.ru укажет на $PUBLIC_IP — на сервере:
     DOMAINS="mkt-second-opinion.ru www.mkt-second-opinion.ru $SSLIP_HOST" bash setup.sh
6. Telegram-бот (когда владелец решит включать; README, раздел «Telegram-бот»):
     ssh heidi nano $APP_DIR/apps/bot/.env && ssh heidi chmod 600 $APP_DIR/apps/bot/.env
     тот же SO_BOT_KEY — в $APP_DIR/apps/web/.env; затем deploy (шаг 3) запустит бота.
EOF
