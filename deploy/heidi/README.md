# Тестовый стенд на heidi — https://40-160-87-140.sslip.io (позже mkt-second-opinion.ru)

Сервер: AlmaLinux 10, 4 vCPU / 7,6 GiB, пользователь `ez`, алиас `ssh heidi`. Схема: Caddy (HTTPS, сертификат Let's Encrypt
сам) → `next start` на 127.0.0.1:3000 под systemd. Пока домен на чужом DNS, стенд живёт на имени через sslip.io
(публичный DNS, `40-160-87-140.sslip.io` → `40.160.87.140`, сертификат настоящий) и по запасному `http://40.160.87.140`. Код попадает на сервер `git push` в bare-репозиторий `~/git/second-opinion.git`,
без GitHub-ключей на сервере.

Telegram-бот (план WP-TG, `docs/PLAN_telegram_bot_2026-10-14.md`) — второй сервис `second-opinion-bot` на той же машине,
см. раздел [«Telegram-бот»](#telegram-бот). Входящих портов ему не нужно, Caddy не меняется.

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
`deploy.sh` после этого работает через `bash -s`: управление сервисами разрешено без пароля (sudoers: `restart|start|stop|status`
для `second-opinion` и `second-opinion-bot`, больше ничего).

`.env` на сервере — тот же набор, что на Mac (ANTHROPIC_API_KEY, LLM_PROVIDER=anthropic, TYPESAFE_API_KEY, MOCK_LLM=0),
плюс лимиты и, когда включается бот, `SO_BOT_KEY`. Ключи вводятся руками в nano, в чат и в репозиторий не попадают.
Сейчас на проде `SO_DAILY_BUDGET_USD=0` (без лимита) и `SO_MESSAGE_LIMIT=1000000` (решение 10.10).

Переезд на домен: когда A-записи `mkt-second-opinion.ru` и `www` укажут на IP сервера, на сервере один раз
`DOMAINS="mkt-second-opinion.ru www.mkt-second-opinion.ru 40-160-87-140.sslip.io" bash setup.sh` — Caddyfile перепишется,
сертификат появится за минуту, старая ссылка продолжит работать.

## Каждое обновление

```
deploy/heidi/release.sh
```

`release.sh` пушит текущую ветку в `main` на heidi и запускает там `deploy.sh`. Порядок `deploy.sh` (план WP-TG §7):

1. стоп бота, если его юнит есть (`npm ci` меняет `node_modules` под живым процессом);
2. checkout; короткий sha коммита → `/opt/second-opinion/VERSION`;
3. `npm ci`;
4. `next build`;
5. перезапуск сайта, проверка `is-active`;
6. локальный `/api/health` сразу после рестарта: `version` должен совпасть с VERSION. Не совпал — на порту 3000 старый
   процесс (не заменённый рестартом или «осиротевший»), выкатка останавливается с кодом 1;
7. бот — только если есть юнит, `apps/bot/.env` и в нём не `SO_TG=0`: `install -d -m 700 apps/bot/.state`, старт, затем до 70 с
   ожидание свежего heartbeat и строк журнала этого запуска `getMe ok version=<sha>` и `polling version=<sha>`. Не дождались —
   журнал бота на экран и код 1 (сайт при этом уже работает).

Сборка ~1 мин. Предупреждения `deploy.sh`: права `apps/bot/.env` не 600; `SO_BOT_KEY` в `apps/web/.env` пуст или не равен ключу бота.

## Защита открытого стенда

- `SO_DAILY_BUDGET_USD` (по умолчанию 2, на проде сейчас 0 — без лимита): суммарный расход на модель и Jev за сутки по МСК;
  при исчерпании ассистент отвечает текстом без обращения к моделям, прямой путь (/check) работает. Бюджет общий для сайта
  и бота. Состояние — локальный `/api/health` → `budget`, файл `apps/web/.usage/budget.json`.
- Лимит реплик на сессию чата (`SO_MESSAGE_LIMIT`, по умолчанию 20; на проде сейчас 1000000).
- `robots.txt` запрещает индексацию, пока не задан `SO_PUBLIC=1`.

## Посмотреть

- Логи сайта: `ssh heidi journalctl -u second-opinion -f`
- Логи бота: `ssh heidi journalctl -u second-opinion-bot -f`
- Логи Caddy: `ssh heidi sudo tail -f /var/log/caddy/access.log`
- Расход: `ssh heidi 'cd /opt/second-opinion/apps/web && node ../../node_modules/.bin/tsx scripts/usage-report.ts'` (с разрезом по каналу `web`/`telegram`)
- Статус снаружи: `curl -s https://40-160-87-140.sslip.io/api/health` — только `{"ok":true}`
- Подробности (режим, модель, Jev, бюджет, версия кода): `ssh heidi curl -s http://127.0.0.1:3000/api/health`

## Telegram-бот

Бот — тонкий клиент того же `POST /api/chat`, что и браузер: решений, ключей LLM и Jev у него нет. Процесс
`second-opinion-bot.service` (`apps/bot`, `npm run start` → `tsx src/main.ts`) опрашивает Telegram (long polling, только
исходящий HTTPS к `api.telegram.org`) и шлёт ходы на `http://127.0.0.1:3000/api/chat` с ключом `SO_BOT_KEY`. Сайт и бот —
один бюджет и один журнал `usage.jsonl` (поле `channel`).

### Действия владельца (план §11, ≈ 1–1,5 ч без пилота)

1. **BotFather.** Два бота: тестовый (только для Mac) и прод. Для обоих: `/setjoingroups` → Disable; `/setcommands`:
   ```
   start - Начать
   new - Новая проверка
   help - Справка
   ```
   Токены в чат не присылать.
2. **Доступ heidi → Telegram** (до выкатки бота):
   `ssh heidi "curl -sS -o /dev/null -w '%{http_code}\n' https://api.telegram.org"` — ожидается 2xx или 3xx
   (`setup.sh` печатает то же самое). Нет ответа — бот работать не сможет; прокси только для клиента grammY — отдельное решение (§7).
3. **Секреты прод-бота** — на сервере, руками:
   ```
   ssh heidi nano /opt/second-opinion/apps/bot/.env
   ssh heidi chmod 600 /opt/second-opinion/apps/bot/.env
   ```
   Образец — `apps/bot/.env.example`. Нужны: `TG_BOT_TOKEN`, `TG_BOT_USERNAME` (без «@»), `SO_TG_SALT` и `SO_BOT_KEY`
   (оба — `openssl rand -base64 32`, разные), `SO_TG_ALLOW` (пусто — бот отвечает каждому только кодом доступа),
   по желанию `SO_TG_DAILY` (60), `SO_TG_CONCURRENCY` (4), `SO_SITE_URL` (кнопка «Открыть на сайте»; пусто — кнопки нет).
   **Тот же `SO_BOT_KEY`** — строкой `SO_BOT_KEY=…` в `apps/web/.env` (`ssh heidi nano /opt/second-opinion/apps/web/.env`);
   сайт читает `.env` только при старте, его перезапустит выкатка. Токена бота в `apps/web/.env` нет.
   `TG_API_ROOT` в прод-`.env` не пишется: это только для e2e, с `NODE_ENV=production` бот с ней не стартует.
   Тестовый токен — только в локальный `apps/bot/.env` на Mac.
4. **Root-шаг** (отдельное «катить»): `scp deploy/heidi/setup.sh heidi:setup.sh && ssh -t heidi bash setup.sh` — ставит юнит
   `second-opinion-bot` (включён, но не запущен), каталог `apps/bot/.state`, строку sudoers. Повторный запуск безопасен.
5. **Смоук на тестовом боте — на Mac, против MOCK**, со своим токеном (два опросчика одного токена получают 409, поэтому
   прод-токен на Mac не запускать):
   ```
   # терминал 1 — сайт в MOCK с ключом бота (тот же SO_BOT_KEY, что в apps/bot/.env на Mac)
   SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0 SO_BOT_KEY=<ключ> npm run web:dev
   # терминал 2 — бот: читает apps/bot/.env (тестовый токен, TG_BOT_USERNAME, SO_TG_SALT, SO_BOT_KEY, SO_TG_ALLOW="*")
   npm run -w @so/bot dev
   ```
   В журнале бота — `getMe ok version=dev` и `polling version=dev`. Чеклист в Telegram: 7 диалогов эталона
   (`apps/web/audit/fixtures/dialogs`), `/new`, 21-е сообщение одной сессии (лимит 20 — `SO_MESSAGE_LIMIT` не задавать),
   выбор выпуска кнопкой («Черкизово» → кнопка выпуска), deep-link
   `https://t.me/<username тестового бота>?start=qRU000A1038V6_p1500_s1000000_k30`, фото → «пока не разбираю».
6. **«Катить» и пилот.** После выкатки (`release.sh`) каждый участник пилота пишет боту — бот отвечает кодом доступа.
   Коды через запятую — в `SO_TG_ALLOW` в `apps/bot/.env`, затем `ssh heidi sudo systemctl restart second-opinion-bot`.
7. **Через неделю** — решение о публичном запуске (`SO_TG_ALLOW="*"`). До него на проде `SO_DAILY_BUDGET_USD > 0`.

### Эксплуатация

- Состояние: `ssh heidi systemctl status second-opinion-bot`. «active» ≠ «работает»: бот пишет heartbeat
  `/opt/second-opinion/apps/bot/.state/heartbeat` после каждого опроса Telegram (не реже раза в 50 с) и сам выходит с кодом 1,
  если отметке больше 120 с; systemd поднимает его через 5 с.
- Версия: строка журнала `getMe ok version=<sha>` равна `version` локального `/api/health`; бот при старте сверяет её с сайтом и
  при расхождении не запускается (`version mismatch`).
- Журнал (`journalctl -u second-opinion-bot`) — только служебные записи: событие, тип апдейта, время хода, статус. Текстов,
  chat_id, имён и токена в нём нет; код доступа (`pseudo`) — только в отказах `notAllowed` и `dailyLimit`.
- Остановка: на SIGTERM бот прекращает опрос, подтверждает offset и доделывает начатые ходы — не дольше 30 с
  (`KillMode=mixed`, `TimeoutStopSec=35` в юните).
- Лимиты бота (`apps/bot/.env`, после правки — `sudo systemctl restart second-opinion-bot`): `SO_TG_DAILY` — ходов в сутки
  по МСК на код доступа (60), `SO_TG_CONCURRENCY` — ходов одновременно на весь бот (4), `SO_TG_MAX_CHATS` — разговоров в
  памяти (300). Очередь — 2 сообщения на чат, лишнее — «ещё отвечаю».

### Выключатели

- `SO_TG=0` в `apps/bot/.env`, затем `ssh heidi sudo systemctl restart second-opinion-bot` — бот не опрашивает Telegram
  (heartbeat пишет). Выкатка при `SO_TG=0` бота не запускает.
- `ssh heidi sudo systemctl stop second-opinion-bot` — до следующей выкатки (она запускает бота снова, если есть `.env` и не `SO_TG=0`).
- Пустой `SO_BOT_KEY=` в `apps/web/.env`, затем `ssh heidi sudo systemctl restart second-opinion` — сайт отвечает 403 на все
  запросы бота (бот отвечает «не получилось»), сайт работает как обычно.

### Откат

- На версию с ботом: `release.sh` с нужной ветки — новый `deploy.sh` сам остановит и запустит бота.
- На версию до бота (до WP-TG): сначала `ssh heidi sudo systemctl stop second-opinion-bot` — иначе живой процесс продолжит
  ходить в старый сервер без проверки ключа; потом `release.sh`. Checkout удалит код бота, юнит дальше пропускается по
  `ConditionPathExists=` (и после перезагрузки тоже). Совсем отключить юнит — root-шаг: `sudo systemctl disable second-opinion-bot`.

### Секреты

- `apps/bot/.env` (chmod 600, владелец `ez`): `TG_BOT_TOKEN`, `TG_BOT_USERNAME`, `SO_TG_SALT`, `SO_BOT_KEY`, `SO_TG_ALLOW`,
  `SO_TG_DAILY`, `SO_TG_CONCURRENCY`, `SO_SITE_URL`. Читает его systemd (`EnvironmentFile=`). Смена `SO_TG_SALT` меняет все коды
  доступа — пилоту придётся прислать их заново.
- `apps/web/.env`: из бота — только `SO_BOT_KEY`. Ключей LLM и Jev у бота нет.
- Ключи генерируются на сервере или на Mac (`openssl rand -base64 32`) и вводятся руками; в чат, в git и в журналы не попадают.

### E2E без Telegram

`npm run e2e:bot -- --base http://127.0.0.1:<порт>` — настоящий процесс бота против фейкового Bot API и сайта в MOCK
(как поднять сайт — в шапке `tools/validate/src/e2e-bot.ts`). Сценарии: старт, `/start`, кнопки, отчёт по ISIN, `/new`,
deep-link, не-текст, лимит сессии, SIGTERM во время хода, приватность журнала.
