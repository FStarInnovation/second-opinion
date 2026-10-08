# Тестовый стенд на heidi — mkt-second-opinion.ru

Сервер: AlmaLinux 10, 4 vCPU / 7,6 GiB, пользователь `ez`, алиас `ssh heidi`. Схема: Caddy (HTTPS, сертификат Let's Encrypt
сам) → `next start` на 127.0.0.1:3000 под systemd. Код попадает на сервер `git push` в bare-репозиторий `~/git/second-opinion.git`,
без GitHub-ключей на сервере.

## Первый запуск (один раз)

```
cd ~/ТафсТендер/second-opinion
scp deploy/heidi/setup.sh heidi:setup.sh
ssh -t heidi bash setup.sh
git remote add heidi ez@heidi:git/second-opinion.git
git push heidi e2-blocks-page:main
ssh heidi nano /opt/second-opinion/apps/web/.env
ssh heidi 'bash -s' < deploy/heidi/deploy.sh
```

`setup.sh` требует root один раз (пакеты, порты 80/443, firewall, systemd). Запускается с терминалом (`ssh -t`), потому что
sudo спрашивает пароль; через `bash -s` пароль ввести некуда. Если у `ez` нет sudo — тот, у кого есть root, выполняет на
сервере `APP_USER=ez bash setup.sh` (скрипт сам понимает, что он root). После этого root не нужен.
`deploy.sh` после этого работает через `bash -s`: перезапуск сервиса разрешён без пароля (sudoers).

`.env` на сервере — тот же набор, что на Mac (ANTHROPIC_API_KEY, LLM_PROVIDER=anthropic, TYPESAFE_API_KEY, MOCK_LLM=0),
плюс `SO_DAILY_BUDGET_USD=2`. Ключи вводятся руками в nano, в чат и в репозиторий не попадают.

DNS: A-запись `mkt-second-opinion.ru` и `www` → IP сервера. Пока записи нет, Caddy не выдаст сертификат и сайт по домену
не откроется (по `http://IP:80` тоже — Caddy ждёт имя хоста); проверить сервис можно с сервера: `curl localhost:3000/api/health`.

## Каждое обновление

```
deploy/heidi/release.sh
```

(push текущей ветки в `main` на heidi + checkout, `npm ci`, `next build`, перезапуск, `/api/health`). Сборка ~1 мин.

## Защита открытого стенда

- `SO_DAILY_BUDGET_USD` (по умолчанию 2): суммарный расход на Haiku и Jev за сутки по МСК; при исчерпании ассистент
  отвечает текстом без обращения к моделям, прямой путь (/check) работает. Состояние — `/api/health` → `budget`,
  файл `apps/web/.usage/budget.json`.
- Лимит 20 реплик на сессию чата (`SO_MESSAGE_LIMIT`).
- `robots.txt` запрещает индексацию, пока не задан `SO_PUBLIC=1`.

## Посмотреть

- Логи приложения: `ssh heidi journalctl -u second-opinion -f`
- Логи Caddy: `ssh heidi sudo tail -f /var/log/caddy/access.log`
- Расход: `ssh heidi 'cd /opt/second-opinion/apps/web && node ../../node_modules/.bin/tsx scripts/usage-report.ts'`
- Статус: `curl -s https://mkt-second-opinion.ru/api/health`
