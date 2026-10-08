#!/usr/bin/env bash
# С Mac: запушить текущую ветку на heidi и выкатить. Запуск из корня репозитория:  deploy/heidi/release.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
BRANCH=$(git branch --show-current)
HOST="${HOST:-heidi}"

git remote get-url "$HOST" >/dev/null 2>&1 || git remote add "$HOST" "ez@$HOST:git/second-opinion.git"
printf '\033[1;34m== push %s → %s:main\033[0m\n' "$BRANCH" "$HOST"
git push "$HOST" "$BRANCH:main"
ssh "$HOST" 'bash -s' < deploy/heidi/deploy.sh
