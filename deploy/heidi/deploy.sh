#!/usr/bin/env bash
# Выкатка на heidi (план WP-TG §7): стоп бота → checkout и VERSION → npm ci → next build → перезапуск сайта → /api/health
# (version = VERSION) → старт Telegram-бота, если есть apps/bot/.env и SO_TG≠0 → ожидание свежего heartbeat и строки
# «getMe ok version=<sha>» в журнале бота.
# Запуск с Mac после push:  ssh heidi 'bash -s' < deploy/heidi/deploy.sh
# Или одной командой с Mac: deploy/heidi/release.sh
# Скрипт идёт от владельца $APP_DIR (ez); sudo без пароля — только systemctl restart|start|stop|status для двух сервисов
# (строка sudoers из setup.sh). Ничего секретного не печатает.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/second-opinion}"
REPO_DIR="${REPO_DIR:-$HOME/git/second-opinion.git}"
BRANCH="${BRANCH:-main}"
BOT_UNIT="${BOT_UNIT:-/etc/systemd/system/second-opinion-bot.service}"
BOT_ENV="$APP_DIR/apps/bot/.env"
WEB_ENV="$APP_DIR/apps/web/.env"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
# Значение переменной из env-файла, как его читает systemd (EnvironmentFile): последнее присваивание, без кавычек; нет — пусто
env_value() { [ -f "$1" ] || return 0; sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" | tail -n 1 | sed 's/[[:space:]]*$//' | tr -d "\"'\r"; }

# 1. Бот останавливается на время выкатки: npm ci меняет node_modules под живым процессом, а новый код бота ходит только
#    в сервер своей версии. Нет юнита (root-шаг setup.sh ещё не сделан) — бота нет, останавливать нечего.
if [ -f "$BOT_UNIT" ]; then
  say "Стоп бота на время выкатки"
  sudo systemctl stop second-opinion-bot
fi

# 2. Код и версия: короткий sha коммита — в $APP_DIR/VERSION до рестарта (сайт и бот читают его один раз при старте)
say "Код: $BRANCH → $APP_DIR"
git --git-dir="$REPO_DIR" --work-tree="$APP_DIR" checkout -f "$BRANCH" 2>&1 | tail -1
git --git-dir="$REPO_DIR" log --oneline -1 "$BRANCH"
SHA=$(git --git-dir="$REPO_DIR" rev-parse --short "$BRANCH")
printf '%s\n' "$SHA" > "$APP_DIR/VERSION"
echo "VERSION: $SHA"

if [ ! -f "$WEB_ENV" ]; then
  echo
  echo "Нет $WEB_ENV — создайте его (ключи вводите сами):  ssh heidi nano $WEB_ENV"
  echo "Образец: $APP_DIR/apps/web/.env.example. Без ключей сервис стартует в режиме MOCK."
fi

# 3–4. Зависимости и сборка
say "Зависимости"
cd "$APP_DIR"
npm ci --no-audit --no-fund 2>&1 | tail -2

say "Сборка"
npm run web:build 2>&1 | tail -12

# 5. Сайт
say "Перезапуск сайта"
sudo systemctl restart second-opinion
sleep 3
if ! systemctl is-active --quiet second-opinion; then
  echo "Сервис не поднялся. Последние строки журнала:"; journalctl -u second-opinion -n 30 --no-pager; exit 1
fi

# 6. Проверка: локальный /api/health отдаёт version запущенного процесса. В Next 16 модуль маршрута грузится при первом
#    запросе и тогда же читает VERSION, поэтому запрос — сразу после рестарта. Другая версия = отвечает процесс, запущенный до
#    записи VERSION (не заменённый рестартом или «осиротевший» на порту 3000).
say "Проверка сайта"
HEALTH=""
for _ in $(seq 1 30); do
  HEALTH=$(curl -fsS --max-time 30 http://127.0.0.1:3000/api/health 2>/dev/null) && break
  HEALTH=""
  sleep 1
done
if [ -z "$HEALTH" ]; then
  echo "Сайт не отвечает на /api/health 30 с. Последние строки журнала:"; journalctl -u second-opinion -n 30 --no-pager; exit 1
fi
echo "$HEALTH"
SERVER_VERSION=$(printf '%s' "$HEALTH" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
if [ "$SERVER_VERSION" != "$SHA" ]; then
  echo "Сайт отвечает version «${SERVER_VERSION:-нет поля}», а выкатывается $SHA: на порту 3000 процесс, запущенный до записи VERSION."
  echo "Кто слушает порт: ss -ltnp | grep ':3000 '; журнал: journalctl -u second-opinion -n 50 --no-pager"
  exit 1
fi
echo "Сайт: $(systemctl is-active second-opinion), version $SERVER_VERSION; журнал: journalctl -u second-opinion -f"

# 7. Telegram-бот: только если есть юнит (setup.sh), apps/bot/.env (секреты владельца) и бот не выключен (SO_TG=0)
say "Telegram-бот"
if [ ! -f "$BOT_UNIT" ]; then
  echo "Юнита second-opinion-bot нет — бот не запускается (сайт работает). Root-шаг владельца: README, раздел «Telegram-бот»."
elif [ ! -f "$BOT_ENV" ]; then
  echo "Нет $BOT_ENV — бот не запускается (сайт работает). Образец: $APP_DIR/apps/bot/.env.example; README, раздел «Telegram-бот»."
elif [ "$(env_value "$BOT_ENV" SO_TG)" = "0" ]; then
  echo "SO_TG=0 в $BOT_ENV — бот выключен и после выкатки не запускается (выключатель, README)."
else
  if [ "$(stat -c %a "$BOT_ENV")" != "600" ]; then warn "права $BOT_ENV — $(stat -c %a "$BOT_ENV"), нужно 600: chmod 600 $BOT_ENV"; fi
  if [ -z "$(env_value "$WEB_ENV" SO_BOT_KEY)" ]; then
    warn "SO_BOT_KEY в $WEB_ENV пуст — сервер отвечает 403 на все ходы бота (выключатель). Бот запустится, но отвечать не будет."
  elif [ "$(env_value "$WEB_ENV" SO_BOT_KEY)" != "$(env_value "$BOT_ENV" SO_BOT_KEY)" ]; then
    warn "SO_BOT_KEY в $WEB_ENV и $BOT_ENV различаются — сервер отвечает 403 на ходы бота. Нужен один и тот же ключ."
  fi
  # .state в .gitignore, checkout его не создаёт; без него юнит не стартует (ReadWritePaths= без «-»)
  install -d -m 700 "$APP_DIR/apps/bot/.state"
  T0=$(date +%s)
  sudo systemctl start second-opinion-bot
  # «active» ≠ «работает»: ждём свежий heartbeat (пишется после каждого getUpdates) и строки журнала этого запуска —
  # «getMe ok version=<sha>» (бот тот, токен верный) и «polling version=<sha>» (версия совпала с сайтом, опрос идёт)
  echo "Ожидание бота (до 70 с): heartbeat новее старта и «getMe ok version=$SHA» в журнале"
  HB="$APP_DIR/apps/bot/.state/heartbeat"
  BOT_OK=""
  for _ in $(seq 1 70); do
    LOG=$(journalctl -u second-opinion-bot --since "@$T0" -o cat --no-pager 2>/dev/null || true)
    if [ -f "$HB" ] && [ "$(stat -c %Y "$HB")" -ge "$T0" ] && grep -qF "getMe ok version=$SHA" <<<"$LOG" && grep -qF "polling version=$SHA" <<<"$LOG"; then
      BOT_OK=1
      break
    fi
    sleep 1
  done
  if [ -z "$BOT_OK" ]; then
    echo "Бот не подтвердил старт за 70 с (heartbeat, «getMe ok version=$SHA», «polling version=$SHA»). Сайт работает. Журнал бота:"
    journalctl -u second-opinion-bot --since "@$T0" -n 40 --no-pager || true
    exit 1
  fi
  echo "Бот: $(systemctl is-active second-opinion-bot), getMe ok version=$SHA, heartbeat свежий; журнал: journalctl -u second-opinion-bot -f"
fi

echo
echo "Готово: $SHA. Сайт — $(systemctl is-active second-opinion)."
