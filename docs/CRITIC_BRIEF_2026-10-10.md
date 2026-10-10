# Бриф независимому критику (Codex) — Second Opinion, правки по аудиту 09–10.10.2026

**Роль.** Ты независимый критик. Твоя задача — найти ошибки, слабые места и риски в сделанной работе, а не подтвердить её. Исходи из презумпции, что ошибки есть. Всё, что ты утверждаешь, должно быть проверяемо: файл:строка, команда, число.

**Репозиторий.** `/Users/zv/ТафсТендер/second-opinion`, ветка `e2-blocks-page`. Продукт — «второе мнение» по облигациям РФ на данных MOEX ISS; принцип «детерминированные факты»: все числа считает движок (`packages/engine`), LLM (`apps/web`) чисел не пишет.

**Что ревьюим.** Пять коммитов поверх `fb0712c`:
- `0ee38c1` — аудит (`docs/AUDIT_2026-10-09.md`), план (`docs/AUDIT_PLAN_2026-10-09.md`), аудит-харнес (`packages/engine/src/audit/`, `apps/web/audit/`, фикстуры `packages/engine/audit-fixtures/`);
- `0164e2a` WP-B — дата расчётов SETTLEDATE как начало отсчёта потоков, todayIso по МСК, валютный НКД;
- `fad3e36` WP-C — цепочка пар «доходность ↔ цена» ISS, 0 = «не рассчитано», выбор пары по показанной цене;
- `04d5ca9` WP-F — горизонт «колл»: подписи, комиссии/налог и контроль к одному горизонту;
- `43d3642` WP-D — гейт расхождения `controlFailPp`: производное от своего расчёта гасится, биржа главная, сигнал пользователю/модели/валидатору.

Команды: `git log --oneline fb0712c..HEAD`, `git diff fb0712c..HEAD -- packages/engine/src apps/web/lib tools/validate/src packages/engine/golden/expected`.

**Как проверять (минимум).**
1. `npm run -s selftest` (должен быть OK), `npm run -s -w @so/engine audit` и `npm run -s -w @so/web audit` (exit 1 — норма: часть проверок RED до будущих WP; смотри таблицу), `npm run -s -w @so/engine typecheck`, `npm run -s -w @so/web typecheck`.
2. Независимый пересчёт: по сырым таблицам ISS в `packages/engine/golden/snapshots/<case>/` и `packages/engine/audit-fixtures/<name>/` (securities №1: SETTLEDATE, ACCRUEDINT, FACEVALUE, COUPONVALUE; bondization: купоны/амортизации; marketdata_yields: EFFECTIVEYIELDWAPRICE, WAPRICE, YIELDDATETYPE) пересчитай IRR сам (python/любой язык) и сравни с `report.yield.own_control_pct`, `main_pct`, `k_grid`, `fees_tax`, `price.accruedint`. Сборка офлайн: `cd packages/engine && npx tsx -e 'import("./src/build.ts").then(async m=>console.log(JSON.stringify(await m.build("RU000A10ASE2",{}, {fromSnapshotDir:"golden/snapshots/rolf", todayIso:"2026-10-08"}),null,1)))'` (аналогично для фикстур: query/todayIso в `audit-fixtures/<name>/meta.json`).
3. Харнес как объект критики: проверки в `packages/engine/src/audit/checks/wp-{b,c,d,f}.ts` сейчас GREEN. Вопрос: они утверждают **правильное** поведение или подогнаны под реализацию? Есть ли тавтологии (продукт сверяется с продуктом), слабые допуски, пропущенные классы бумаг?
4. Эталоны: `packages/engine/golden/expected/*.json` перезаписывались в WP-B/C/D. В сообщениях коммитов перечислены ожидаемые изменения полей. Проверь, что перезаписано ровно это, и что ни одно изменение не «благословило» дефект.

**На что смотреть особенно.**
- Конвенции ISS: дата расчётов T+1 (пятница → понедельник), НКД на SETTLEDATE, купон между сегодня и датой расчётов, FACEVALUEONSETTLEDATE vs FACEVALUE, 0 как «не рассчитано», отрицательные доходности, YIELDDATETYPE=OFFER/MATDATE, BUYBACKDATE vs CALLOPTIONDATE.
- Краевые случаи: бумага без SETTLEDATE, оферта в дату расчётов или раньше (t ≤ 0), флоатер с коллом, валютная бумага, цена от пользователя, перпет/структурная.
- Гейт (WP-D): ложные срабатывания/несрабатывания на границе 5 п.п., поведение при `useMoex=false`, согласованность отчёта после гейта (страница ≡ движок ≡ дайджест ≡ валидатор), что осталось производным от своего расчёта в опубликованном отчёте (period_income при коротком колле — известно).
- Регрессии: что могло измениться для бумаг, которых нет ни в golden, ни в фикстурах (возьми 3–5 случайных ISIN с TQCB через живой ISS, если сеть есть: `cd packages/engine && npx tsx src/cli.ts <ISIN>`).
- Риски выкатки на прод (`deploy/heidi/`): что сломается у пользователя сайта и чата после этих правок.

**Ограничения.** Не менять файлы репозитория (кроме создания своего отчёта). Не запускать `golden:write`. Не вызывать `https://mkt-second-opinion.ru/api/chat` (платный бюджет). Не читать `.env`.

**Формат ответа.** Файл `docs/CRITIC_REPORT_2026-10-10.md`: (1) резюме — принять / принять с правками / отклонить, одним абзацем; (2) находки по убыванию серьёзности: blocker / major / minor — каждая с файл:строка, что не так, как воспроизвести (команда/число), предложение; (3) что проверил и что оказалось корректным (с числами); (4) чего не смог проверить и почему. Без общих слов — только проверяемые утверждения.
