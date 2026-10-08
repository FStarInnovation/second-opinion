#!/usr/bin/env bash
# Выкатка на heidi: checkout из bare-репозитория → npm ci → next build → перезапуск сервиса → проверка.
# Запуск с Mac после push:  ssh heidi 'bash -s' < deploy/heidi/deploy.sh
# Или одной командой с Mac: deploy/heidi/release.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/second-opinion}"
REPO_DIR="${REPO_DIR:-$HOME/git/second-opinion.git}"
BRANCH="${BRANCH:-main}"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

say "Код: $BRANCH → $APP_DIR"
git --git-dir="$REPO_DIR" --work-tree="$APP_DIR" checkout -f "$BRANCH" 2>&1 | tail -1
git --git-dir="$REPO_DIR" log --oneline -1 "$BRANCH"

if [ ! -f "$APP_DIR/apps/web/.env" ]; then
  echo
  echo "Нет $APP_DIR/apps/web/.env — создайте его (ключи вводите сами):  ssh heidi nano $APP_DIR/apps/web/.env"
  echo "Образец: $APP_DIR/apps/web/.env.example. Без ключей сервис стартует в режиме MOCK."
fi

say "Зависимости"
cd "$APP_DIR"
npm ci --no-audit --no-fund 2>&1 | tail -2

say "Сборка"
npm run web:build 2>&1 | tail -12

say "Перезапуск"
sudo systemctl restart second-opinion
sleep 3
if ! systemctl is-active --quiet second-opinion; then
  echo "Сервис не поднялся. Последние строки журнала:"; journalctl -u second-opinion -n 30 --no-pager; exit 1
fi

say "Проверка"
curl -fsS http://127.0.0.1:3000/api/health && echo
echo "Статус: $(systemctl is-active second-opinion); журнал: journalctl -u second-opinion -f"
