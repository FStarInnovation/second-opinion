# Second opinion · Атремус

Сервис «второго мнения» по инвестиционным продуктам российского рынка: пользователь вводит ссылку, ISIN или название бумаги — получает отчёт с реальной доходностью, ликвидностью, рисками и Product Truth Score на данных MOEX ISS.

Архитектура — «генеративная сборка, детерминированные факты»: все числа считает движок по закрытой постановке, страница собирается из типизированных блоков по контракту `bond_report@1`, LLM (ассистентный слой) видит только одобренные инструменты и не пишет ни одного числа.

## Документы (Claude Project «Tafs Tender»)

- Методика метрик и источники: `Second opinion · Облигации: постановка с исправлениями и методика метрик`
- Контракт и реестр блоков: `Second opinion · Генеративная сборка страницы бумаги`
- План реализации и инварианты: `Second opinion · План реализации сервиса`

## Структура

```
packages/engine   движок данных: ISS №1–№4 + поиск → метрики → bond_report@1
  src/contract.ts     zod-схема контракта + конверт BuildResult (отчёт / выбор выпуска / не нашли / ошибка)
  src/iss/client.ts   клиент ISS (прокси, снимки, классификация ошибок)
  src/iss/facts.ts    сырые таблицы → факты о бумаге
  src/recognize.ts    распознавание ввода (правила 2.3.0)
  src/metrics.ts      доходность, ликвидность, комиссии/налог, worst-case, 15 флагов (13 по постановке + структурная, бессрочная), Truth Score
  src/inputs.ts       ввод пользователя → зависимые поля + композиция panels (работает и в браузере)
  src/config.ts       веса, пороги, сетки методики
  src/format.ts       ru-RU форматирование (общее для движка и страницы)
  src/report.ts       сборка контракта
  src/cli.ts          tsx src/cli.ts "<запрос>" [--promised 26] [--pos 500000] [--k 0.3] …
  src/selftest.ts     без сети: юнит-проверки + golden + паритет «страница ≡ движок»
  src/golden-update.ts  пополевой дифф эталонов (--write — записать)
  golden/             снимки ISS (2026-10-08) + эталонные контракты, 11 кейсов
packages/blocks   React-блоки реестра (чистые компоненты от контракта, без assistant-ui)
  src/blocks.tsx      data_line, product, claim, yield, price_line, ask_price, liquidity, fees, worst, flags_score, plaque
  src/ReportView.tsx  раскладка по panels (сетка прототипа v3) — та же в чате Э3
  src/branches.tsx    «Уточните выпуск», «Не нашли», ошибка ввода
  src/app.tsx         шапка + состояние ввода (пересчёт — applyInputs движка)
  src/styles.css      стиль v3: Geist, #353d64, белые карточки
apps/static       Э2: SSG — страницы всех golden-кейсов, витрина блоков, манифест сборки
tools/validate    Playwright-валидатор: 13 условий падения на 1280 и 390 px + проверка ввода; --selfcheck
apps/web          Э3: Next.js — прямой путь без LLM (/, /check, /api/report) + ассистент (/chat, /api/chat); /api/health — провайдер и живость Jev (строка статуса под чатом)
  lib/engine.ts       build() + кэш 15 мин + офлайн-режим на golden (SO_OFFLINE=1)
  lib/tools.ts        одобренный реестр инструментов: resolve_security, build_bond_report, set_inputs, explain_term
  lib/digest.ts       что видит модель (~600 токенов), а не контракт целиком
  lib/jev.ts          Jev: маршрутизация реплик и разбор «обещали» (Decisions API) + правило-фоллбэк
  lib/gate.ts         уверенные реплики → инструмент без LLM, в тот же UI-поток
  lib/model.ts        OpenRouter: Haiku 5.5 + fallback GPT-6 Luna; MOCK_LLM — скриптовые сценарии
  lib/prompt.ts       системный промпт: числа только из инструментов, без ИИР
  components/         Thread на примитивах assistant-ui; tool UI → те же блоки @so/blocks
  jev/                размеченные фразы для проверки маршрутизатора (jev:check / scripts/jev-eval.ts)
```

## Запуск

```bash
npm install
npm run selftest        # движок офлайн: golden + паритет страница ≡ движок
npm run pages           # собрать apps/static/dist (страницы, витрина, manifest.json)
npm run validate        # валидатор по всем страницам; скриншоты — apps/static/dist/screens
npm run -w @so/validate selfcheck   # испортить страницы 12 способами — каждый должен быть пойман
npm run check           # всё сразу

# Э3 — сайт и ассистент
cp apps/web/.env.example apps/web/.env   # вписать OPENROUTER_API_KEY; без ключа — MOCK-режим
npm run web:dev                          # http://localhost:3000 — форма, /check, /chat
npm run e2e:chat                         # сценарии чата на запущенном сервере (SO_OFFLINE=1 MOCK_LLM=1)
cd apps/web && npx tsx --env-file=.env scripts/jev-eval.ts --jev   # маршрутизатор на 50 фразах, живой Jev
cd apps/web && npx tsx scripts/usage-report.ts                       # сколько потратили: журнал .usage/usage.jsonl

cd packages/engine
npx tsx src/cli.ts "РОЛЬФ 1Р07" --promised 26          # живой ISS
npx tsx src/cli.ts "RU000A1038V6" --out report.json     # контракт в файл
```

Движку и страницам ключей не требуется (ISS открытый). Ассистенту нужен ключ в `apps/web/.env` — только там, никогда в чате и файлах репозитория: `OPENROUTER_API_KEY` (Haiku 5.5 + fallback GPT-6 Luna, и Jev через Decisions API) или `ANTHROPIC_API_KEY` (Claude API напрямую, Haiku 5.5 без fallback); Jev отдельно — `TYPESAFE_API_KEY` (прямой API TypeSafe, приоритетный) либо тот же OpenRouter-ключ; без ключа Jev — маршрутизация по правилам. Ключ, попавший в чат или коммит, считается скомпрометированным — его сразу отзывают и выпускают новый.

## Тестовый стенд (heidi → https://40-160-87-140.sslip.io, позже mkt-second-opinion.ru)

Caddy (HTTPS сам) → `next start` под systemd, код — `git push heidi <ветка>:main` в bare-репозиторий на сервере.
Разовая настройка `deploy/heidi/setup.sh`, каждое обновление — `deploy/heidi/release.sh`. Стенд открытый: дневной лимит
расхода на модели `SO_DAILY_BUDGET_USD` (2 $/сутки по МСК, при исчерпании ассистент отвечает текстом, /check работает),
20 реплик на сессию, `robots.txt` закрыт до `SO_PUBLIC=1`. Подробно — `deploy/heidi/README.md`.

## Инварианты (нарушать нельзя)

1. Одна точка входа в движок: `build()` — и для прямой формы, и для инструментов ассистента.
2. LLM видит только одобренный реестр инструментов; числа — только из их result.
3. Единственный контракт `bond_report@1`: не хватает поля — расширяем контракт, не считаем в UI.
4. Одни и те же React-блоки на странице и в чате; правка блока → повторный прогон валидатора по всем golden-страницам.
