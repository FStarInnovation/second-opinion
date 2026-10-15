# План: Telegram-бот на том же движке решений (WP-TG)

**Дата:** 14.10.2026 · **Основание:** проектирование 14.10 (карта связности, три проекта, два судьи) — оба судьи выбрали проект «Один мозг, два клиента», плюс решения оркестратора (ниже они обязательны) · **База:** ветка `e2-blocks-page`, HEAD `d16c809` (по коду = прод `a1d695d`) · **Эталон паритета:** `apps/web/audit/fixtures/dialogs/*.json` — 7 диалогов, 15 реальных тел запросов браузера · **Харнес:** WP-TG, `apps/web/audit/checks/wp-tg.ts`; до правки ожидается 24 RED и 6 guard GREEN · **Исполнители:** Opus 5.5; на каждый пакет два независимых ревью · **Эталоны и фикстуры** меняет только оркестратор после разбора диффа · **Выкатка:** только по явному «катить». Root-шаг `setup.sh` одобряется отдельно.

Порядок работы проекта: отчёт → план (этот документ) → красный харнес → правка → 2 ревью → выкатка. Код бота и продукта на этапе плана не пишется.

## 1. Зачем

- Владельцу нужен Telegram-бот с той же логикой, что у чата на сайте. Движок решений при этом должен остаться один.
- Как сейчас:
  - числа и фразы отчёта считает `@so/engine`;
  - решения о диалоге принимают модули `apps/web/lib` в процессе `next start`: гейт, правила и Jev, промпт, модель, инструменты, бюджет, журнал.
- Если написать бота «рядом», появятся второй гейт и второй текст отчёта, и они разойдутся при первой же правке.
- Цель:
  - бот становится вторым клиентом того же `POST /api/chat` и шлёт те же тела, что браузер;
  - тексты отчёта берутся из одной view-model;
  - паритет закрепляется проверками до того, как написан код.

## 2. Инварианты

| | Инвариант | Чем доказывается |
|---|---|---|
| И1 | **Бот не принимает решений.** В `apps/bot` нет гейта, правил и Jev, промпта, модели, инструментов, `build` и `applyInputs`, нет ключей LLM и Jev | TG.1, TG.2, TG.22 |
| И2 | **Канал не влияет на гейт.** На одну и ту же реплику сервер отвечает одинаково при канале `web` и `telegram`. Канал читают только проверка ключа, тексты отказа и журнал | TG.3, TG.G3 |
| И3 | **Один текст отчёта.** Всё, что пользователь видит в блоках отчёта, приходит из `presentReport(r)`. React и Telegram только раскладывают этот текст. Проверяется в обе стороны: каждая строка VM видна на сайте и в Telegram, и весь видимый текст блоков чата и сообщений Telegram покрыт строками VM. Исключение — четыре замороженные подписи веб-контролов (§4.1) | TG.6, TG.6-tg, TG.7, TG.G5 |
| И4 | **Одна схема ввода.** `ReportInputsSchema` из `@so/engine/contract` проверяет ввод на `/check`, в `/api/report`, `/api/chat` (поле `inputs` и `set_inputs`), в `/chat?q=…` и в deep-link бота | TG.13, R.7-web |
| И5 | **Тела бота ≡ тела браузера.** На те же действия пользователя бот шлёт в `/api/chat` тела, которые совпадают с записанными телами assistant-ui после нормализации из §4.5 | TG.4, TG.5, TG.G2, TG.G4 |

## 3. Архитектура и границы

```
Telegram ⇄ getUpdates (long polling, только исходящий HTTPS)
  │
second-opinion-bot.service — apps/bot, grammY 1.46.0, tsx          ← нет решений, нет ключей LLM/Jev
  │  POST http://127.0.0.1:3000/api/chat   тело = как у браузера;
  │  заголовки: x-so-chat, x-so-channel: telegram, x-so-bot-key
  ▼
second-opinion.service — next start -H 127.0.0.1                  ← единственный экземпляр решений
  route.ts → channelOf → getSession → лимит/бюджет → runGate → streamText + инструменты → buildCached/applyInputs
  кэш отчётов (globalThis), бюджет, журнал — общие для сайта и бота (процесс один)
Браузер → Caddy → тот же next start (без изменений)
```

Решения:

1. **Бот — отдельный процесс, long polling.**
   - Входящий порт не нужен, Caddy не меняется.
   - Рестарт веба не теряет апдейты.
   - Код бота не попадает в бандл Next и в `next dev`. Иначе dev-машина перехватила бы апдейты прод-токена (409).
2. **grammY 1.46.0** — точный пин, версия опубликована 26.08.2026.
   - Нужен только как транспорт Bot API и только в `main.ts` и `telegram.ts`.
   - Плагины `runner` и `auto-retry` не берём. Обработчик апдейта лишь ставит ход в очередь и не блокирует опрос. 429 и откат HTML обрабатывает своя обёртка (TG.18).
3. **Ответ из SSE собирается функциями `ai@7.0.133`**: `parseJsonEventStream` + `uiMessageChunkSchema` + `readUIMessageStream`. Это тот же `processUIMessageStream`, что работает под assistant-ui в браузере. Свой разбор SSE запрещён.
4. **История — сырые `UIMessage`** в том виде, как их собрал `ai`. Рендер в историю не пишется. Причина: гейт решает по дословному тексту прошлого ответа (`gate.ts:171`, `jev.ts:167`, `jev.ts:389-395`).
5. **Канал передаётся в заголовке `x-so-channel`, а не в теле.** Тело остаётся побайтно браузерным, И5 действует без исключений.
6. **Шаблоны гейта не меняются.**
   - Фразы «смотрите блоки выше» и «в списке выше» верны и в Telegram: бот отправляет части ответа строго в порядке `parts`, а отчёт появляется правкой заглушки на её месте (TG.9).
   - Меняется только промпт: `prompt.ts:11` «доходность в блоке ниже», «Truth Score показан справа» → «в блоке «Доходность»», «в блоке Truth Score». Здесь порядок в Telegram другой, а «справа» неверно уже на мобильном сайте.
   - Поэтому фикстуры диалогов остаются валидными.
7. **`gate/jev/tools` не выносим в пакет и не делаем `runTurn`.**
   - Это дорого: пришлось бы мигрировать `wp-s` (`analyzeRoute`) и `mkWriter` во всех гейт-проверках.
   - При одном процессе решений это ничего не даёт.
   - Вернуться к вопросу стоит, если появится канал без HTTP или второй сервер.

| Где | Что | Чего там нет |
|---|---|---|
| `apps/web` | все решения; `lib/channel.ts` (ключ бота); тексты отказа по каналу; `channel` в журнале; `version` сборки (`SO_BUILD_SHA`) в локальном `/api/health` | кода Telegram, токена бота |
| `packages/present` (`@so/present`, новый; чистый TS без React, Node и `ai`) | протокол: имена инструментов, типы выходов, TTL, заголовки; вход: `initialOf`, `firstText`, `chatParams`, `pickMessage`, `SUGGESTIONS`, deep-link; тексты каналов; view-model отчёта и веток | решений диалога |
| `packages/engine/src/contract.ts` | `ReportInputsSchema` (перенос из `tools.ts:22-27`) | — |
| `packages/blocks` | раскладка VM в React; из `WEB` — только формы ввода, шапка `/check` и четыре подписи веб-контролов | собственных текстов ни в четырёх файлах блоков, ни в модулях, которые они импортируют (TG.7); текста блоков чата помимо VM (TG.6) |
| `apps/bot` | транспорт Telegram, очередь, история, сборка тела, рендер VM в HTML | гейта, Jev, промпта, модели, `build`/`applyInputs`, ключей LLM/Jev, кириллических литералов |

## 4. Интерфейсы

Харнес вызывает эти интерфейсы до того, как написан код. Если модуля нет, проверка RED с detail «нет модуля …», а не ERROR. Если сигнатура меняется, правится этот раздел и харнес, решение принимает оркестратор.

### 4.1 `@so/present` (`packages/present`)

`package.json`:
- `"name": "@so/present"`;
- exports `./protocol`, `./entry`, `./copy`, `./report` → `./src/<имя>.ts`;
- зависимости — `@so/engine` (contract, format, config) и `zod`.

В `apps/web/next.config.ts` в `transpilePackages` добавляется `"@so/present"`, там же — `env.SO_BUILD_SHA` (§4.3). В `apps/web/package.json` — зависимость `"@so/present": "0.1.0"`, как у `@so/blocks`.

```ts
// @so/present/protocol
export const TOOL_NAMES = ["resolve_security", "build_bond_report", "set_inputs", "explain_term"] as const; // из tools.ts
export type ToolName = (typeof TOOL_NAMES)[number];
export type ReportToolResult = { query: string; result: BuildResultT };
export type ExplainResult = { found: true; id: string; title: string; text: string } | { found: false; query: string; known: string[] };
export const SESSION_TTL_MS = 60 * 60_000;      // session.ts берёт отсюда (сейчас литерал session.ts:21)
export const BOT_TTL_MARGIN_MS = 5 * 60_000;    // история бота живёт SESSION_TTL_MS − запас
export type Channel = "web" | "telegram";
export const HDR = { chat: "x-so-chat", channel: "x-so-channel", botKey: "x-so-bot-key" } as const;
export const TG_SESSION_PREFIX = "tg_";

// @so/present/entry — перенос без изменения поведения
export type EntryParams = { q?: string; promised?: string; pos?: string; k?: string; price?: string; m?: string };
export type ChatInitial = { q: string; inputs: ReportInputs } | { text: string };
export function initialOf(p: EntryParams): ChatInitial | undefined;              // app/chat/page.tsx:29-43
export function firstText(i: ChatInitial): string;                               // components/ChatApp.tsx:14-15
export function chatParams(res: BuildResultT, query: string): EntryParams | null; // ядро chatHref, app/check/CheckClient.tsx:8-20
export function pickMessage(c: { isin?: string | null; secid: string }): string;  // `Проверь ${isin ?? secid}`, ToolUIs.tsx:23
export const SUGGESTIONS: readonly string[];                                     // Thread.tsx:9-14
export function encodeStartPayload(p: EntryParams): string | null;               // §4.6
export function decodeStartPayload(s: string): EntryParams | null;

// @so/present/copy — все тексты каналов; своих текстов в apps/bot нет
export const WAIT_REPORT: string;   // «Собираю отчёт по данным Мосбиржи…» (ToolUIs.tsx:29)
export const WAIT_TERM: string;     // «Ищу в глоссарии…» (ToolUIs.tsx:48)
export const DISCLAIMER: string;    // Thread.tsx:76
export function limitText(ch: Channel, limit: number): string;   // web — байт в байт route.ts:45; telegram — «… отправьте /new …»
export function budgetExhaustedText(ch: Channel): string;        // web — байт в байт budget.ts:63-65; telegram — «… работает на сайте …»
export const BOT: { start: string; help: string; privacy: string; newSession: string; sessionExpired: string; busy: string;
  onlyText: string; serviceRestarting: string; turnFailed: string; dailyLimit(n: number): string; notAllowed(code: string): string;
  fullReport: string; openOnSite: string };
export const WEB: Record<string, string>; // литералы React вне VM: формы ввода и шапка /check (вне видов чата), «Новая проверка»,
                                          // сообщения формы цены после отправки (ошибка ввода, «пересчёт недоступен»),
                                          // четыре подписи веб-контролов WEB_ONLY_CONTROLS (ниже) — и больше ничего (шаг 3)

// @so/present/report
export type Tone = "good" | "mid" | "bad" | "none";                // как ui.tsx:13-21
export interface SectionVM { id: PanelIdT; title: string; subtitle?: string; big?: string; tone?: Tone; lines: string[];
  bars?: { label: string; value: string }[]; items?: { title: string; text: string }[] }
export interface ReportVM { dataTime: string | null; kicker: string; name: string; isin: string | null;
  sections: SectionVM[]; plaque: { title: string; items: string[] } | null }
export function presentReport(r: BondReportT): ReportVM;          // секции — по раскладке ReportView, только из r.panels; опций нет
export type BranchVM =
  | { kind: "pick"; title: string; lines: string[]; options: { label: string; message: string; traded: boolean }[] }
  | { kind: "notfound" | "err"; title: string; lines: string[] };
export function presentBranch(res: Exclude<BuildResultT, { kind: "report" }>): BranchVM;
export function vmStrings(vm: ReportVM | BranchVM): string[];    // все видимые строки — для TG.6 и TG.6-tg
```

В VM переезжает всё, что сейчас дописывает React:
- заголовки карточек;
- «+X% за период до колла…» (`blocks.tsx:61-64`);
- крупное число комиссий с подписью (`blocks.tsx:152-158`);
- подписи баров;
- «N / 100», «Ни один из N red flags не сработал», «Ещё N — в полном отчёте» (`blocks.tsx:186-206`);
- метка ликвидности (`blocks.tsx:139`);
- тексты веток со склонением через `plural` из `format.ts` (`branches.tsx:13-14, 30-32, 71-93`);
- плашка полного отчёта;
- тон по `CONFIG` (из `ui.tsx`).

**VM покрывает весь видимый текст блоков чата.** Типы выше — минимальный состав. P2 добавляет поля, если без них какой-то текст блока остаётся вне VM. Примеры:
- в pick: подпись секции «Найденные выпуски», колонки «Выпуск и ISIN», «Рег. номер», «Торги», рег. номер, «торгуется» / «не торгуется», «Сначала торгуемые. Данные Мосбиржи.»;
- в плашке: заголовок, пункты и «Без входа базовый отчёт доступен только в этой сессии.»;
- в ветке «нет цены»: пояснение и подпись поля цены;
- в notfound: «Искали:» и пояснения.

Харнес читает VM только через `vmStrings`, поэтому новые поля сигнатуру не ломают. Обратная проверка TG.6 вычитает из текста SSR видов чата все строки VM. После вычета не должно остаться ни буквы, ни цифры. Виды чата — `ReportView`, `PickView`, `NotFoundView`, `ErrView` в режиме compact.

Единственное исключение — **подписи веб-контролов**, у которых в Telegram нет текстового аналога. Они могут прийти из `WEB`. Список заморожен в харнесе (`WEB_ONLY_CONTROLS`), менять его — решение оркестратора:

| Подпись | Где на сайте | Что вместо неё в Telegram |
|---|---|---|
| «Проверить» | кнопка строки pick | кнопка кандидата с подписью из VM |
| «Посчитать» | отправка формы цены | цену пишут репликой |
| «Загрузить документ продавца» | неактивная кнопка notfound | загрузки нет |
| «Войти и получить полный отчёт» | кнопка плашки | кнопка `BOT.fullReport` |

`ResultApp` (страница `/check`) обратной проверкой не покрыт: его шапка (`app.tsx`) и формы ввода живут в `WEB`. Прямая проверка (каждая строка VM есть в SSR) действует и для него.

**Подсказка «нет цены» в VM не входит.** Проп `askPriceUnavailableNote` (в чате — «Напишите цену предложения в чате — пересчитаю.», `ToolUIs.tsx:35`; на демо — `app.tsx:60`) и сообщения формы цены (`blocks.tsx:110-111`) — реакция веб-контрола «Посчитать»: они видны только после отправки формы, в SSR их нет.
- Если положить подсказку в VM, прямая часть TG.6 навсегда красная на ветке «нет цены» (cherk1p6 и живые фикстуры без цены).
- В Telegram формы нет: под вопросом из VM («По какой цене вам предлагают купить?…») цену пишут репликой, отдельной подсказки не нужно, и TG.6-tg её не допускает.
- Поэтому опции у `presentReport` нет. Текст подсказки чата остаётся пропом в `ToolUIs.tsx`, сообщения формы переезжают в `WEB`.

### 4.2 `@so/engine/contract`

- `export const ReportInputsSchema = z.object({ position_size, k_pct, promised_pct, offer_price_pct })` — границы как в `tools.ts:22-27`.
- `apps/web/lib/tools.ts`: `export const inputsSchema = ReportInputsSchema` — тот же объект.
- Потребители схемы:
  - `route.ts` — `body.inputs`, через `tools`;
  - `set_inputs`;
  - `initialOf` и deep-link;
  - `app/check/page.tsx` — поле за полем, невалидное игнорируется, как в `initialOf`;
  - `app/api/report/route.ts` — невалидное → `{kind:"err"}` 4xx (R.7-web).
- Не потребители: границы React-форм — цена в `AskPrice` (`blocks.tsx:110`: `n <= 0 || n > 300` при `min(1)` схемы) и поля `InputsPanel` (`blocks.tsx:281, 292, 305`: «обещали» `n > 0` при `min(0)`). Это ранняя подсказка в браузере, а не вход сервера: всё, что форма пропустила, проверяет схема на сервере (`/api/report`, `set_inputs`). В Telegram форм нет. Сведение этих границ к схеме меняет видимое поведение форм, поэтому оно вне объёма (§14).

### 4.3 Сервер (`apps/web`)

```ts
// apps/web/lib/channel.ts (новый)
export function channelOf(req: Request, sessionId: string): { ok: true; channel: Channel } | { ok: false; status: 403 };
```

**Правило channelOf.** Канал `telegram` ⇔ выполнены все три условия:
1. `sessionId` начинается с `tg_`;
2. заголовок `x-so-channel: telegram`;
3. `x-so-bot-key` совпал с `SO_BOT_KEY`.

Выполнено только одно или два условия → 403. Ни одного → `web`.

- Ключи сравниваются через `crypto.timingSafeEqual` над SHA-256 обеих строк.
- `SO_BOT_KEY` читается при каждом вызове. Если на сервере он пуст, все tg-запросы получают 403.

**`route.ts`.**
- До `getSession`, `userMessages` и `countMessage`:
  `const sid = body.id ?? req.headers.get("x-so-chat") ?? "anon"; const ch = channelOf(req, sid); if (!ch.ok) return new Response(null, { status: 403 });`
- Фолбэк `"anon"` сохраняется как есть. Для бота он недостижим: бот всегда шлёт `body.id` и `x-so-chat` (TG.4), а `"anon"` без `tg_` даёт канал `web`. Замена на 400 — правка веба, вынесена в §14.
- Во все `log({...})` добавляется `channel`.
- Тексты отказа: `limitText(ch.channel, MESSAGE_LIMIT)`, `budgetExhaustedText(ch.channel)`.
- Больше `channel` в сервере нигде не появляется (TG.G3).

**Версия сервера — sha сборки, а не файл на диске.**
- `next.config.ts` (правит P1 вместе с `transpilePackages`): `env: { SO_BUILD_SHA: <содержимое <repo>/VERSION на момент next build, иначе "dev"> }`. Next подставляет значение в бандл при сборке.
- `health/route.ts`: в локальный ответ добавляется `version: process.env.SO_BUILD_SHA ?? "dev"`. Нужен именно точечный доступ `process.env.SO_BUILD_SHA`: Next 16 подставляет ключи `env` из конфига в серверный бандл как `process.env.<KEY>` (`next/dist/build/define-env.js`, `getNextConfigEnv`), а доступ по индексу и деструктуризация остаются чтением окружения во время работы. Файл `VERSION` обработчик не читает ни при запросе, ни при загрузке модуля. Наружу по-прежнему только `{ok}`.
- `VERSION` описывает код на диске, `SO_BUILD_SHA` — сборку, которая реально работает. `deploy.sh` пишет `VERSION` при checkout, до сборки (§7). Если `web:build` упал (`set -e`), на диске уже новый sha, а в памяти — процесс Next со старой сборкой. Сверка «файл против файла» в этом случае совпала бы. Совпала бы и после перезагрузки heidi, если старая `.next` уцелела: Next поднимается с неё, а бот — с нового кода. Сверка «sha сборки против `VERSION`» даёт расхождение, и бот не стартует (§4.4).
- Почему `VERSION` не переносится после сборки: тогда при упавшей сборке на диске остался бы старый sha при новом коде бота, и сверка снова прошла бы.

**Остальные файлы:**
- `session.ts`: TTL берётся из `SESSION_TTL_MS`.
- `budget.ts`: `BUDGET_EXHAUSTED_TEXT = budgetExhaustedText("web")`.
- `prompt.ts:11` — нейтральные слова.
- `gate.ts:118` — «Главные red flags» из `truth_score.top3`.
- `jev.ts` — `parseInputs` возвращает usage вызова `jevKind`, маршрут его списывает (H.7).
- `scripts/usage-report.ts` — разрез по `channel`.

### 4.4 `apps/bot/src`

- `grammy` импортируют только `main.ts` и `telegram.ts`.
- `core.ts` не читает `process.env` и ходит в сеть только через внедрённые `fetch` и `TgClient`.

```ts
// config.ts
export interface BotConfig { webUrl: string; botKey: string; salt: string; allow: string; dailyTurns: number; concurrency: number;
  perChatPending: number; maxChats: number; turnTimeoutMs: number; siteUrl?: string }
export interface MainConfig extends BotConfig { token: string; username: string; stateDir: string; appDir: string; enabled: boolean }
export function loadConfig(env: Record<string, string | undefined>): MainConfig; // в тексте ошибок нет значения токена
// stateDir = env.STATE_DIRECTORY (его ставит systemd по StateDirectory=, §7), иначе <appDir>/apps/bot/.state (локально);
// appDir — корень репозитория (/opt/second-opinion), там лежит VERSION

// telegram.ts
export type InlineKeyboard = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
export interface TgSendOpts { html?: boolean; keyboard?: InlineKeyboard }
export interface TgClient {
  sendMessage(chatId: number, text: string, o?: TgSendOpts): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, o?: TgSendOpts): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action: "typing"): Promise<void>;
}
export interface TgApiError { error_code: number; description: string; parameters?: { retry_after?: number } } // форма GrammyError
export function withTelegramPolicy(raw: TgClient, d: { sleep(ms: number): Promise<void>; log(r: LogRec): void }): TgClient;
// 429 → пауза retry_after, не больше 3 раз; 400 «can't parse entities» → тот же текст без HTML (htmlToPlain)
export function grammyClient(api: import("grammy").Api): TgClient;

// core.ts
export type TgUpdate = { update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type: string } } } };
export interface CoreDeps { config: BotConfig; tg: TgClient; fetch: typeof fetch; now?: () => number;
  random?: (n: number) => Uint8Array; sleep?: (ms: number) => Promise<void>; log?: (r: LogRec) => void }
export interface BotCore {
  handleUpdate(u: TgUpdate): Promise<void>;  // промис завершается после хода (или отказа); main.ts вызывает без await
  idle(): Promise<void>;                     // все очереди пусты
  peek(chatId: number): { sessionId: string; messages: UIMessage[]; inputs?: ReportInputs } | undefined; // для харнеса
}
export function createCore(d: CoreDeps): BotCore;
```

**Что делает ядро:**
- `/start` — новый разговор, приветствие, уведомление о приватности, кнопки `sg:<i>`.
- `/start <payload>` — новый разговор с вводами ссылки и ход `firstText`.
- `/new` — новый разговор; `/help` — справка.
- callback `pk:<ISIN|SECID>` → реплика `pickMessage`; callback `sg:<i>` → `SUGGESTIONS[i]`.
- Чат не private → апдейт игнорируется.
- Не текст → `BOT.onlyText`, POST не уходит.

```ts
// request.ts
export interface Conv { pseudo: string; chatId: number; sessionId: string; messages: UIMessage[]; inputs?: ReportInputs; lastActive: number }
export function userMessage(text: string, id: string): UIMessage;  // {id, role:"user", parts:[{type:"text", text}], metadata:{custom:{}}}
export function toWire(m: UIMessage): unknown;                       // user: {role, parts, metadata, id}; assistant: {id, role, parts}
export function buildChatRequest(c: Conv, cfg: Pick<BotConfig, "webUrl" | "botKey">):
  { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } };
// body    = { tools: {}, ...(c.inputs !== undefined ? { inputs: c.inputs } : {}), id: c.sessionId,
//             messages: c.messages.map(toWire), trigger: "submit-message", metadata: {} }
// headers = { "content-type": "application/json", "x-so-chat": c.sessionId, "x-so-channel": "telegram", "x-so-bot-key": cfg.botKey }

// turn.ts
export type TurnOutcome = { ok: true; assistant: UIMessage }
  | { ok: false; reason: "refused" | "http" | "stream" | "timeout"; status?: number; partial?: UIMessage };
export function runTurn(c: Conv, cfg: BotConfig, d: { fetch: typeof fetch; sleep(ms: number): Promise<void>;
  onToolInput?(toolCallId: string, toolName: string): void }): Promise<TurnOutcome>;
// POST повторяется ТОЛЬКО если fetch отклонён с code ECONNREFUSED (или cause.code):
//   до 3 повторов с паузами 2/8/20 с, после этого реплика убирается из истории.
// HTTP-ошибка, обрыв потока, таймаут turnTimeoutMs (90 с), ECONNRESET и прочие сетевые ошибки, кроме ECONNREFUSED, — без повтора:
//   запрос мог дойти до сервера, а ход не идемпотентен (бюджет, session.result).
//   Реплика и частичный ответ остаются в истории, как у AbstractChat.

// render.ts — чистые функции
export type TgOp = { partIndex: number; toolCallId?: string; text: string; html: boolean; keyboard?: InlineKeyboard };
export function renderTurn(m: UIMessage, o?: { siteUrl?: string; cabinetHref?: string }): TgOp[];
//   порядок = порядок parts; step-start пропускается; explain found:false → ничего; текст ассистента → простой текст
export function renderReport(vm: ReportVM, o?: { siteUrl?: string; cabinetHref?: string; params?: EntryParams }): { html: string; keyboard?: InlineKeyboard };
export function renderBranch(vm: BranchVM): { html: string; keyboard?: InlineKeyboard }; // pick → кнопки pk:<ISIN ?? SECID>

// html.ts
export function escapeHtml(s: string): string;
export function htmlToPlain(h: string): string;
export function visibleLength(h: string): number;       // длина после разбора сущностей — как считает Telegram
export function splitHtml(h: string, max?: number): string[]; // по границам секций, тег не режется

// ids.ts
export function pseudonymOf(chatId: number, salt: string): string;   // base64url(HMAC-SHA256(salt, String(chatId))).slice(0, 12)
export function newSessionId(pseudo: string, random: (n: number) => Uint8Array): string; // `tg_${pseudo}_${base64url(random(6))}`

// queue.ts
export class ChatQueues { constructor(o: { concurrency: number; perChatPending: number });
  run(key: string, job: () => Promise<void>): Promise<"done" | "busy">; idle(): Promise<void>; inFlight(): number }

// limits.ts
export function isAllowed(pseudo: string, allow: string): boolean;   // "" — никто; "*" — все; иначе список псевдонимов через запятую
export class DailyLimit { constructor(perDay: number, now: () => number); take(pseudo: string): boolean } // сутки по МСК

// log.ts
export type LogRec = { ev: string; pseudo?: string; upd?: "message" | "callback" | "command" | "other"; ms?: number;
  status?: string; err?: string; version?: string };
export function makeLogger(sink: (line: string) => void, secrets: string[]): (r: LogRec) => void; // секреты и «bot<цифры>:…» вырезаются

// heartbeat.ts
export function makeHeartbeat(o: { file: string; staleMs: number; now(): number; exit(code: number): void;
  write(file: string): void; mtime(file: string): number | null }): { beat(): void; check(): void };

// version.ts
export function readVersion(appDir: string): string;                 // <appDir>/VERSION (sha кода на диске) или "dev"
export function checkServerVersion(f: typeof fetch, webUrl: string, mine: string): Promise<{ ok: boolean; server: string | null }>;
// server — поле version локального GET <webUrl>/api/health (sha сборки, §4.3); null — сервер недоступен или поля нет; ok ⇔ server === mine
```

**Запуск `main.ts`:**
1. `loadConfig(process.env)`; `mkdir -p stateDir` (под systemd каталог уже создан, локально — нет).
2. `const mine = readVersion(appDir)` — **один раз**, до `bot.start`. Дальше версия бота не перечитывается: бот работает с кодом, загруженным при старте.
3. `getMe`: username должен совпасть с `TG_BOT_USERNAME`, иначе `exit(78)`.
4. `checkServerVersion(fetch, webUrl, mine)`:
   - `server === null` (веб ещё не поднялся) → `exit(1)`, systemd повторит через 5 с;
   - `server !== mine` (сервер работает на другой сборке) → `exit(78)`.
   - Код 78 (EX_CONFIG) — ошибка конфигурации. Юнит с `RestartPreventExitStatus=78` (§7) не крутит рестарты, нужен человек.
5. В журнал: `getMe ok version=<mine>`. Затем `bot.start({ allowed_updates: ["message", "callback_query"] })`.
6. Heartbeat (`<stateDir>/heartbeat`) пишется после каждого `getUpdates` (transformer `bot.api.config.use`), watchdog проверяет его каждые 30 с.
7. По SIGTERM: `bot.stop()`, затем `core.idle()` — не дольше 30 с.

`apps/bot/package.json`:
- `"name": "@so/bot"`;
- точные версии: `grammy 1.46.0`, `ai 7.0.133`;
- `@so/present`, `@so/engine` (только `contract` и `format`), `zod`, `tsx`;
- `"start": "tsx src/main.ts"`.

### 4.5 Тело запроса и нормализация (эталон И5)

**Как устроено тело браузера** (запись 14.10):
- поля: `{ tools: {}, id, messages, trigger: "submit-message", metadata: {}, inputs? }`;
- заголовки: `content-type`, `x-so-chat`;
- сообщение пользователя: `{ role, parts: [{ type: "text", text }], metadata: { custom: {} }, id }`;
- сообщение ассистента: `{ id, role, parts }`. Части — как их собрал `ai`: `step-start`; `tool-*` с `state: "output-available"`; `text` с `state: "done"`.

Две особенности:
- Сервер ключует сессию по `body.id`. У браузера это `__LOCALID_…` от assistant-ui; при наличии `body.id` заголовок `x-so-chat` не используется.
- `inputs` уходит в **каждом** запросе разговора, начатого ссылкой с `q`, — даже пустым объектом (`ChatApp.tsx:44`).

**Нормализация N** — единственные допуски:
- `body.id`;
- значение `x-so-chat`;
- `messages[].id`;
- `toolCallId` — нумеруется по порядку появления;
- `built_at`;
- `diagnostics.snapshot_dir` — абсолютный путь машины записи.

Порядок ключей не важен, сравнивается канонический JSON. У бота сверх браузерных заголовков разрешены только `x-so-channel` и `x-so-bot-key`. Всё остальное сравнивается побайтно: `tools`, `metadata`, `metadata.custom`, `trigger`, `inputs`, `state`, `step-start`, текст.

### 4.6 Deep-link

Формат: `/start <payload>`, payload — не больше 64 символов из `[A-Za-z0-9_-]`.

- Обязательная часть: `q<ISIN|SECID>`, q — только `[A-Za-z0-9]{1,20}`.
- Необязательные части, все целые: `_p<обещали×100>`, `_s<сумма>`, `_k<комиссия×100>`, `_o<цена×100>`.
- Пример: `qRU000A1038V6_p1500_s1000000_k30` (32 символа) ≡ `/chat?q=RU000A1038V6&promised=15&pos=1000000&k=0.3`.
- Если значение нельзя представить целым после умножения на 100, `encode` возвращает `null`, и ссылка не строится.
- Декодер: `EntryParams` → `initialOf` (та же схема) → первая реплика `firstText` и `inputs` в теле каждого запроса.
- Текст с главной (`?m=…`) в deep-link не кодируется: в боте его просто пишут.

### 4.7 Отрисовка в Telegram

- Части ответа идут по порядку `parts`.
- Отчёт, ветка и термин — сообщения с `parse_mode: HTML`:
  - разрешены теги `b`, `i`, `code`, `a`;
  - `&`, `<`, `>` экранированы;
  - превью ссылок выключено.
- Текст ассистента — простой текст без `parse_mode`. Длиннее 4096 символов — делится по предложениям.
- Инструмент отчёта:
  - на `tool-input-available` уходит заглушка `WAIT_REPORT` — гейт пишет input до сборки (U.2);
  - после ответа заглушка правится в отчёт (`editMessageText`);
  - пока ход идёт, каждые 4 с отправляется `typing`.
- Отчёт:
  - шапка: `dataTime` курсивом, `kicker`, `<b>name</b> <code>ISIN</code>`;
  - секции VM;
  - кнопки «Полный отчёт — после входа» (`CABINET_HREF`) и, если задан `SO_SITE_URL`, «Открыть на сайте» (`/check?…` из `chatParams`).
- Выбор выпуска (pick):
  - текст VM и по кнопке на каждого кандидата: подпись из VM, `callback_data` `pk:<ISIN ?? SECID>` (не больше 64 байт);
  - нажатие = реплика `pickMessage(c)`;
  - если ход ещё идёт — `answerCallbackQuery(BOT.busy)`, реплика не уходит.
- `notfound` и `err` — текст VM. `{error}` — текст ошибки и ничего сверх.
- Термин: при `found: true` — `<b>title</b>` и текст, ничего сверх; при `found: false` — ничего.
- **Сверх VM — ничего.** В сообщениях отчёта и ветки нет букв и цифр, кроме строк VM и подписей кнопок `BOT.fullReport` и `BOT.openOnSite` (TG.6-tg).
- **Правка снимает клавиатуру.** `editMessageText` без `keyboard` снимает inline-клавиатуру — так в Bot API, так же ведёт себя фейк харнеса. Если кнопки должны остаться, клавиатура передаётся заново.
- Ответ 400 «can't parse entities» → то же сообщение уходит простым текстом, событие пишется в журнал.

## 5. Шаги

Агент-часы указаны с двумя ревью. Пакеты не пересекаются по файлам.

**Зависимости и `package-lock.json`.** Новые workspace (`packages/present`, `apps/bot`) и новые зависимости попадают в `node_modules` только после `npm install`. Без этого `@so/present` и `grammy` не разрешаются: сценарии харнеса дают ERROR вместо RED или GREEN, typecheck `@so/web` красный. Поэтому:
- исполнители `npm install` не запускают и lock не правят. Пакет, который меняет `package.json`, сначала сдаёт этот файл оркестратору;
- оркестратор ставит зависимости в общем дереве (`npm install --no-audit --no-fund`), по одной установке за раз; пока идёт установка, прогоны харнеса и typecheck не запускаются:
  - **У1** — после приёмки файлов P1, до прогона харнеса на P1 и до старта P2, P3 и P4. Появляется ссылка `node_modules/@so/present`; в lock добавляются только workspace `packages/present` и зависимость `apps/web`;
  - **У2** — в начале P4. Исполнитель первым делом сдаёт `apps/bot/package.json` (grammy, ai, tsx, zod, workspace-зависимости) и пишет код после установки; приёмка P4 — после У2;
  - **У3** — в начале P5, если меняется `tools/validate/package.json`;
  - **У4** — на сведении: итоговый `npm install`, затем проверка с нуля `rm -rf node_modules && npm ci`. Так же ставит `deploy.sh` на heidi, а `npm ci` падает, если lock расходится с `package.json` (например, после правки `packages/blocks/package.json` в P2).

| Шаг | Что | Файлы | Приёмка | Агент-ч |
|---|---|---|---|---|
| 1 | **Красный харнес WP-TG** (§6) | `apps/web/audit/checks/wp-tg.ts`; `apps/web/audit/tg/{scenarios,normalize,fake-tg,actions,mods,top3-shim}.ts`; `apps/web/audit/fixtures/tg/ssr_golden.json` (снимок с `d16c809`); `apps/web/audit/harness.ts` (регистрация). В baseline только добавляются ключи TG.* (`--only TG --write-baseline`, делает оркестратор) | 24 RED с понятным detail; 6 guard GREEN; прежние 65 статусов без изменений (52 GREEN · 11 RED · 2 SKIP); typecheck `@so/web` зелёный | 3,5 |
| 2 | **P1. `@so/present` (protocol, entry, copy) и одна схема ввода** | `packages/present/{package.json,tsconfig.json,src/protocol.ts,src/entry.ts,src/copy.ts}`; `packages/engine/src/contract.ts`; `apps/web/lib/{tools.ts,session.ts}`; `apps/web/app/chat/page.tsx`; `apps/web/app/check/{page.tsx,CheckClient.tsx}`; `apps/web/app/api/report/route.ts`; `apps/web/components/{ChatApp.tsx,ToolUIs.tsx,Thread.tsx}`; `apps/web/next.config.ts` (`transpilePackages`, `env.SO_BUILD_SHA`); `apps/web/package.json` | После У1: TG.10, TG.13, R.7-web GREEN; G1, G2, G5 GREEN; typecheck `@so/web`; тексты веба не изменились | 1,5 |
| 3 | **P2. View-model отчёта** (после P1). React-блоки берут все литералы и числовые фразы из VM, текст не меняется | `packages/present/src/report.ts`; `packages/blocks/src/{blocks,branches,ReportView,ui}.tsx`; `packages/blocks/package.json` | TG.6, TG.7 GREEN; G5 GREEN (SSR 16 golden побайтно); `selftest` | 2,5 |
| 4 | **P3. Сервер** (после P1): ключ и канал, тексты отказа, `channel` в журнале, промпт, top3, `version` сборки в health (`SO_BUILD_SHA`), разрез журнала, H.7 | `apps/web/lib/{channel.ts (новый),budget.ts,prompt.ts,gate.ts,jev.ts}`; `apps/web/app/api/{chat/route.ts,health/route.ts}`; `apps/web/scripts/usage-report.ts` | TG.3, TG.11, TG.12, TG.14, TG.15, **H.7** GREEN; G1–G3, G6 GREEN; S.*/H.* не хуже baseline | 1,5 |
| 5 | **P4. Ядро бота и рендер** (после P1; `render.ts` — после P2). Первым — `apps/bot/package.json` и У2. Контрольная точка после ядра (§12) | `apps/bot/{package.json,tsconfig.json,.env.example}`; `apps/bot/src/{main,config,core,request,turn,render,html,telegram,ids,queue,limits,log,heartbeat,version}.ts`; `.gitignore` (`apps/bot/.state/`, `VERSION`) | TG.1, TG.2, TG.4, TG.5, TG.6-tg, TG.8, TG.9, TG.16–TG.22 GREEN; G4 GREEN | 5 (ядро 3 + рендер, `main` и обвязка 2) |
| 6 | **P5. E2E и эксплуатация** | `tools/validate/src/{e2e-bot.ts,fake-bot-api.ts}`; `tools/validate/package.json`; `package.json` (`e2e:bot`); `deploy/heidi/{setup.sh,deploy.sh,README.md}` | TG.23 GREEN. `npm run e2e:bot` зелёный: бот отдельным процессом через grammY (`apiRoot` = фейк Bot API) против Next в MOCK; если `/api/health` ≠ `mock`, отказ с кодом 2 | 1,5 |
| 7 | **Сведение**: У4 (lock и `npm ci` с нуля), полный прогон, отчёт со смоук-чеклистом | `package-lock.json` | §13, пункты 1–4 | 1 |
| 8 | **Выкатка** по «катить» | root-шаг `setup.sh` — владелец; `release.sh`; прод-токен; `SO_TG_ALLOW` = коды пилота | §13, пункт 5 | — |
| 9 | **Пилот неделя** → решение о публичном запуске | — | предусловия §9 | — |

Параллельность. Сначала шаг 1, затем P1. После P1 параллельно идут P2, P3 и ядро P4; рендер P4 ждёт P2. Затем P5 и сведение.
- Критический путь: 1 → P1 → P4 → P5 → 7 ≈ 12,5 ч.
- Сумма агент-часов ≈ 16,5 ч.

## 6. Харнес WP-TG

### Как устроен

- **Файл и id.** `apps/web/audit/checks/wp-tg.ts`, `wp: "TG"`, регистрация в `harness.ts`. Префикс TG.*, потому что T.* уже занят движковым `wp-t.ts`.
- **Сценарии с сервером идут в дочернем процессе**, как `wp-u-gate.ts:353`: `node --import tsx apps/web/audit/tg/scenarios.ts --scenario <id>`, cwd = `apps/web`. Причина: `engine.ts` фиксирует `SO_OFFLINE` при импорте и ищет golden от cwd.
  - Окружение: `SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0`; ключи LLM и Jev сняты; `SO_USAGE_DIR` — временный каталог; `SO_USAGE_LOG=1`; `SO_BOT_KEY` — тестовое значение. В сценарии `misc` ещё `SO_BUILD_SHA` — тестовый sha сборки: `route.ts` грузится без `next build`, и значение, которое в проде подставляет сборка, даёт окружение (TG.23). Временный `VERSION` для `readVersion` бота создаётся в `SO_USAGE_DIR` с другим sha, в репозиторий харнес не пишет.
  - Внешний `fetch` бросает исключение. `"server-only"` подменяется пустым модулем, как в `wp-h.ts:71-81`.
  - `route.POST` вызывается как функция. Бот получает `fetch = (url, init) => route.POST(new Request(url, init))`.
  - Только в сценарии `misc`: импорт `@so/engine/inputs` из `lib/engine.ts` перенаправлен на `audit/tg/top3-shim.ts`. Обёртка переставляет `truth_score.top3`, это нужно для TG.14. Код продукта не меняется.
- **Модульные проверки бота идут в процессе харнеса:** TG.6-tg, TG.8, TG.9, TG.16–TG.19, бот-часть TG.21.
  - Ядро получает фейковый Telegram и заглушку сервера.
  - На время проверки `globalThis.fetch` бросает исключение. Если ядро обращается к сети мимо внедрённого `fetch`, это нарушение с detail «ядро ходит в сеть мимо внедрённого fetch». Побочного эффекта не будет: на `127.0.0.1:3000` с живым `next dev` или на `api.telegram.org` запрос не уйдёт.
  - Отрицательные проверки очереди (TG.16) сначала ждут нужного события, а не паузу. Только потом идёт короткое окно, в котором лишний POST появиться не должен.
- **Модулей ещё нет** (`apps/bot/src/*`, `@so/present/*`, `lib/channel.ts`). Харнес грузит их динамическим `import` по вычисляемому пути. Нет модуля → `fail("нет модуля …; ожидаемо до шага N")`, то есть RED, а не ERROR. Сигнатуры из §4 продублированы в харнесе структурными типами, поэтому typecheck `@so/web` не ломается.
- **Действия диалога → апдейты Telegram:**
  - `type:X` и `open:/chat?m=X` → `message` с текстом X;
  - `open:/chat?q=…` → `message` с текстом `"/start " + encodeStartPayload(параметры)`;
  - `pick:i` → `callback_query` с `callback_data` i-й кнопки последнего сообщения бота с клавиатурой. Так проверяется и сама клавиатура.
- **Фейковый Telegram** записывает все вызовы `TgClient` и выдаёт возрастающие `message_id`. Как и Bot API, `editMessageText` без клавиатуры снимает её: нажать можно только кнопку, которую пользователь видит.
- **Снимок `fixtures/tg/ssr_golden.json`** пишется один раз в шаге 1, флагом `--record-tg-ssr`, с кода `d16c809`. Дальше его, как и фикстуры диалогов, меняет только оркестратор после разбора диффа — по правилам golden.

### Проверки, RED до правки (утверждают желаемое)

| Id | Вид | Утверждает | Почему RED сейчас | Шаг |
|---|---|---|---|---|
| TG.1 | static | И1. `apps/bot/src` есть. Транзитивный граф импортов (исходники `.ts` и `.js`) — только из белого списка: `grammy` и сетевые `node:http/https/http2/net/tls/dgram/dns` (только `main.ts`, `telegram.ts`); из `ai` — `parseJsonEventStream`, `uiMessageChunkSchema`, `readUIMessageStream`, `generateId` и типы; `@so/present/*`; `@so/engine/contract` и `/format`; `zod`; `node:*`. Запрещены: `apps/web/**`, `@/lib`, корень `@so/engine`, `@so/engine/inputs`, `@ai-sdk/*`, `@openrouter/*`, `streamText`, `generateText`, `convertToModelMessages`, `tool(`; имена `ANTHROPIC_`, `OPENROUTER_`, `TYPESAFE_`, `JEV_`, `LLM_`; хосты openrouter, anthropic, typesafe; обращения `.username`, `.first_name`, `.last_name` | каталога `apps/bot` нет | 5 |
| TG.2 | static | В `apps/bot/src` нет кириллицы в строковых и шаблонных литералах исходников `.ts`/`.js` вне комментариев и в прочих файлах (JSON, текст): все тексты — из `@so/present/copy` | каталога `apps/bot` нет | 5 |
| TG.3 | fixture | И2. 7 диалогов браузера дважды прогоняются через `route.POST`: как веб и как бот (id `tg_…`, `x-so-channel`, валидный ключ). Ответы (сборка `ai`, нормализация §4.5) побайтно равны. В `usage.jsonl` у записей `gate` и `answer` первого прогона `channel:"web"`, второго — `"telegram"` | поля `channel` в журнале нет | 4 |
| TG.4 | fixture | **И5.** Бот (`createCore` + фейковый Telegram + `fetch` → `route.POST`) на действиях 7 диалогов шлёт ровно 15 запросов. Для каждого k: N(тело бота k) ≡ N(тело браузера k). Заголовки — по §4.5 | нет `apps/bot/src/core.ts` | 5 |
| TG.5 | fixture | Состояние сервера после каждого диалога: у сессии бота `query`, `result.kind`, `result.report.inputs`, `pendingInputs`, `userMessages` равны значениям сессии, полученной повтором тел браузера | бота нет | 5 |
| TG.6 | unit | И3, сайт. Входы: 16 golden expected, 3 live-фикстуры, ветки pick/notfound/err; VM — `presentReport(r)` без опций (§4.1). (1) Каждая строка `vmStrings(...)` есть в тексте SSR `ReportView` compact (как в чате) и `ResultApp` (страница `/check`). (2) Обратно, для видов чата (`ReportView`/`PickView`/`NotFoundView`/`ErrView` compact): после вычета строк VM и `WEB_ONLY_CONTROLS` (§4.1) в тексте SSR нет ни буквы, ни цифры | нет `@so/present/report` | 3 |
| TG.6-tg | unit | И3, Telegram. На тех же входах: (1) каждая строка VM есть в сообщении `renderTurn` (после снятия тегов и раскодирования сущностей) или в подписях кнопок; (2) обратно — в сообщении нет букв и цифр сверх строк VM и подписей `BOT.fullReport`/`BOT.openOnSite`. Синтетика §4.7, которой нет в фикстурах: термин `found:true` → `<b>title</b>` и текст, ничего сверх; `found:false` → ничего; выход `{error}` → текст ошибки, ничего сверх | нет `render.ts` | 5 |
| TG.7 | static | Нет кириллицы в литералах и JSX-тексте вне комментариев — в `packages/blocks/src/{blocks,branches,ReportView,ui}.tsx` и во всём замыкании их относительных импортов (новый `texts.ts`, JSON; `app.tsx`, если его импортируют). Нарушения: импорт за пределы `packages/blocks`, самоимпорт `@so/blocks`, `import()` с вычисляемым путём. Перенос текстов в `WEB` ловит обратная часть TG.6 | сейчас там 79 литералов: заголовки карточек, подписи баров, тексты веток, категории ликвидности в `ui.tsx:20` | 3 |
| TG.8 | unit | Ограничения Telegram на всех golden, фикстурах и синтетике §4.7: `visibleLength` каждого сообщения ≤ 4096; HTML только из `b/i/code/a` и сбалансирован; shortname, query и название термина с `<b>&"` экранированы; `callback_data` ≤ 64 байт; кнопок ≤ 100 | нет `render.ts` | 5 |
| TG.9 | unit | Порядок. `renderTurn` сохраняет порядок `parts` во всех сообщениях ассистента из фикстур и в синтетике §4.7. Отрисованы: `found:true`, `{error}`. Не отрисованы: `found:false`, `step-start`. В прогоне d1 первый ход даёт вызовы `sendMessage(WAIT_REPORT)` → `editMessageText` (тот же `message_id`, отчёт) → `sendMessage` (текст) | бота нет | 5 |
| TG.10 | unit | Вход. Для всех golden-отчётов `initialOf(decode(encode(chatParams)))` ≡ `initialOf(chatParams)`; payload ≤ 64 символов из `[A-Za-z0-9_-]`. `pickMessage` (кандидат 0 из d2) ≡ вторая реплика d2 «Проверь RU000A1094F2». `firstText(initialOf(ссылка d6))` ≡ реплика d6 | нет `@so/present/entry` | 2 |
| TG.11 | fixture | Ключ, 9 случаев. `route.POST` отвечает 403 на: (a) id `tg_…` без заголовков бота; (b) `tg_`-id и `x-so-channel: telegram` без ключа; (c) `tg_`-id, канал и неверный ключ той же длины; (d) канал и верный ключ при id без `tg_`; (d2) `tg_`-id и верный ключ без `x-so-channel`; (h) `SO_BOT_KEY` на сервере пуст, запрос бота с ключом; (h2) `SO_BOT_KEY` на сервере пуст и ключ в запросе пуст. При каждом 403 `userMessages` = 0 и `budget.messages` не меняется. (e) Всё верно → 200; (f) тело браузера → 200 и `channel: web` в журнале. Статика `lib/channel.ts` (§4.3): есть вызовы `timingSafeEqual` и `createHash("sha256")`; нет `===`/`!==`/`==`/`!=` с операндом про ключ (`SO_BOT_KEY`, `botKey`, `x-so-bot-key`), кроме проверки на пустоту | (a) сейчас 200; `lib/channel.ts` нет | 4 |
| TG.12 | fixture | Тексты отказа для Telegram. При `SO_MESSAGE_LIMIT=2` третий ход бота получает `limitText("telegram")`: есть `/new`, нет «Обновите страницу». Бюджет исчерпан → `budgetExhaustedText("telegram")`: нет «откройте главную страницу» | сервер отдаёт только веб-тексты | 4 |
| TG.13 | fixture | И4. `contract` экспортирует `ReportInputsSchema`; `tools.inputsSchema` — тот же объект. Таблица значений (NaN, pos 999, k 3,5, promised 101, price 0 и 301, плюс валидные) одинаково отклоняется и принимается в `/api/report` (GET и POST), `body.inputs` `/api/chat`, `initialOf`, `decodeStartPayload`. В `check/page.tsx` нет своего `num()` без схемы | схемы в `contract` нет | 2 |
| TG.14 | static+fixture | «Главные red flags» гейта = `truth_score.top3`. Статика по AST: в `gate.ts` нет `.sort`/`.toSorted` с `points`, есть обращение к `top3`. На golden-отчётах названия в тексте гейта ≡ названия top3 в том же порядке. Там top3 всегда совпадает с сортировкой по баллам, поэтому есть второй прогон: `top3-shim.ts` переставляет top3 (обратный порядок) в 6 кейсах, где он тогда отличается от порядка по баллам, — гейт обязан назвать флаги в порядке top3 | `gate.ts:118` сортирует флаги сам: в синтетике 5 расхождений | 4 |
| TG.15 | static | Нейтральные слова. В `SYSTEM_PROMPT` нет «справа», «слева», «ниже». В telegram-текстах `copy` нет «справа», «ниже», «обновите страницу» | `prompt.ts:11` | 4 |
| TG.16 | unit | Очередь. Повторный `update_id` → один POST. Два сообщения одного чата обрабатываются последовательно, разные чаты — параллельно. 6 чатов при concurrency 4 → в полёте не больше 4. Третье ожидающее сообщение чата → `BOT.busy` без POST. Кнопка во время хода → `answerCallbackQuery(busy)` без POST. Проверка ждёт события (первый POST, 4 POST, `busy`), а не фиксированную паузу | бота нет | 5 |
| TG.17 | unit | Повтор только при ECONNREFUSED. Два отказа ECONNREFUSED, потом ответ → 3 POST (паузы 2 и 8 с), ответ доставлен. ECONNREFUSED всегда → 4 POST (паузы 2/8/20 с), `BOT.serviceRestarting`, реплики в истории нет. HTTP 500, обрыв потока, таймаут и **ECONNRESET** → ровно 1 POST, `BOT.turnFailed`, реплика в истории остаётся (запрос мог дойти до сервера) | бота нет | 5 |
| TG.18 | unit | Сбои Telegram. 429 с `retry_after: 3` → пауза 3000 мс и повтор. 400 «can't parse entities» → тот же текст без HTML. Ошибка с токеном в тексте → в журнале `<redacted>` | бота нет | 5 |
| TG.19 | unit | Доступ и лимиты. `allow ""` → никого; `"*"` → всех; список → только перечисленных, остальным отказ с кодом доступа. При `dailyTurns=2` третий ход за сутки МСК → `BOT.dailyLimit` без POST, в следующие сутки ходы снова идут. `group` и `supergroup` → игнор. Фото, голос, документ → `BOT.onlyText` без POST | бота нет | 5 |
| TG.20 | fixture | Приватность. Прогон TG.4 с журналами. В строках журнала бота и в `usage.jsonl` нет chat_id, user_id, username и имени из тестовых апдейтов, нет токена, `SO_BOT_KEY` и соли. В журнале бота нет текстов реплик. Поле `chat` в `usage.jsonl` у бота начинается с `tg_`. Записи без `chat` (например, `step:"error"` из `onError`) на секреты проверяются, но сессией не считаются | бота нет | 5 |
| TG.21 | unit | Сессия. `session.ts` берёт TTL из `SESSION_TTL_MS`. История бота живёт `SESSION_TTL_MS − BOT_TTL_MARGIN_MS` (> 0). id имеет формат `tg_<12>_<8>`. `/new` и новый экземпляр ядра с той же солью дают другой id. После TTL — новый id, пустая история, `BOT.sessionExpired` | бота нет; TTL — литерал в `session.ts:21` | 2+5 |
| TG.22 | static | Версии. В `apps/bot`: `"ai": "7.0.133"` (как в `apps/web`) и `"grammy": "1.46.0"` — точные. `node_modules/ai` — одна копия. В зависимостях бота нет `@ai-sdk/*` и `@openrouter/*` | нет `apps/bot/package.json` | 5 |
| TG.23 | static+unit | Эксплуатация (§7). **Юнит** `second-opinion-bot` в `setup.sh`: `User=ez`, `ConditionPathExists=…/apps/bot/.env`, `EnvironmentFile=-…/apps/bot/.env`, `MemoryMax=512M`, `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `StateDirectory=second-opinion-bot`, `Restart=always` и `RestartPreventExitStatus=78`, `Wants=` без `Requires=`; `ReadWritePaths=` без префикса «-» запрещён (несуществующий путь роняет юнит на NAMESPACE, exit 226); строка sudoers. **`deploy.sh`**: порядок стоп бота < запись `VERSION` < `npm ci` < `web:build` < рестарт веба < `/api/health` < старт бота < проверка heartbeat; есть `git rev-parse --short` (может стоять в другой строке, чем запись); нет пути `apps/bot/.state`. **Версия сервера**: в `next.config.ts` `env` содержит `SO_BUILD_SHA`; `health/route.ts` читает `process.env.SO_BUILD_SHA` точечным доступом и не трогает файл `VERSION` (нет `fs`, `readFile*`, литерала `VERSION`); в сценарии локальный `/api/health` отдаёт `SO_BUILD_SHA` процесса, а не содержимое `VERSION`; внешний — только `{ok}`. **Версия бота**: `readVersion` → `<dir>/VERSION` или `"dev"`; `checkServerVersion` против `/api/health`: свой sha → `ok`, чужой → `ok:false` и версия сервера; `readVersion` вызывается только в `main.ts`, до `checkServerVersion` и до `bot.start({allowed_updates…})`; в `main.ts` есть код выхода 78; бот читает `STATE_DIRECTORY`. Heartbeat старше 120 с → `exit(1)` | ничего из этого нет | 2+4+5+6 |

### Guard-проверки (GREEN уже сейчас, должны остаться GREEN)

| Id | Вид | Держит |
|---|---|---|
| TG.G1 | fixture | **Тексты веба при `channel=web` не меняются.** Запрос без канала получает текст лимита ≡ «В этой сессии лимит 2 сообщений исчерпан. Обновите страницу, чтобы начать новую проверку.», а текст бюджета ≡ `BUDGET_EXHAUSTED_TEXT` на 14.10. Литералы заморожены в проверке |
| TG.G2 | fixture | **Эталон воспроизводим.** Все 15 тел браузера получают 200. Ответ на запрос k, собранный `ai`, ≡ N(сообщение ассистента в теле k+1) — таких пар 8. Префикс истории тела k+1 ≡ телу k. Этим эталонный сборщик привязан к настоящему браузеру. Ожидается GREEN: запись сделана с этого же кода. Если при написании харнеса проверка красная — расхождение разбирается до шага 5. Красная в будущем означает, что намеренная правка текстов гейта или MOCK-модели устарила фикстуры: перезапись только по решению оркестратора |
| TG.G3 | static | **Канал не попадает в решения.** В `gate.ts`, `jev.ts`, `tools.ts`, `digest.ts`, `prompt.ts`, `glossary.ts`, `engine.ts`, `session.ts`, `model.ts` нет `channel`, `telegram`, `x-so-channel`, `x-so-bot-key` |
| TG.G4 | unit | **Компаратор паритета чувствителен.** 6 мутантов тел браузера дают «не равно»: HTML вместо текста ассистента; «Проверить» вместо «Проверь»; снят `inputs` в d6; снят `metadata.custom`; лишнее поле `channel` в теле; пропущено сообщение. Тождественная копия даёт «равно». От кода продукта не зависит |
| TG.G5 | fixture | **SSR 16 golden неизменен.** Текст SSR (теги сняты, пробелы схлопнуты, плюс `aria-label`) для `ReportView` compact (чат), `ResultApp` (страница `/check`) и веток ≡ снимку `fixtures/tg/ssr_golden.json`. Держит шаг 3 |
| TG.G6 | fixture | **Пределы сервера пропускают историю.** 15 тел браузера и синтетическая история из 20 сообщений с 10 отчётами (~170 КБ JSON) не получают 400/413. Держит будущие правки H.5 и S.2: предел S.2 считается по текстовым частям, а не по JSON tool-выходов. Один отчёт ≈ 17 КБ, план S.2 — 20 000 символов |

Итого 24 RED и 6 guard. После правки в веб-харнесе 95 проверок.

## 7. Эксплуатация на heidi

Юнит пишет `setup.sh`; root-шаг выполняет владелец один раз.

```
[Unit]
Description=Second opinion Telegram bot
After=network-online.target second-opinion.service
Wants=network-online.target second-opinion.service
ConditionPathExists=/opt/second-opinion/apps/bot/.env
[Service]
Type=simple
User=ez
WorkingDirectory=/opt/second-opinion/apps/bot
EnvironmentFile=-/opt/second-opinion/apps/bot/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --import tsx src/main.ts
Restart=always
RestartSec=5
RestartPreventExitStatus=78
MemoryMax=512M
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
StateDirectory=second-opinion-bot
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
```

- **Без `Requires=`:** рестарт веба не убивает бота, бот переживает ECONNREFUSED повтором.
- **Каталог состояния — `StateDirectory=second-opinion-bot`.**
  - systemd сам создаёт `/var/lib/second-opinion-bot` с владельцем `ez` до старта, открывает его на запись при `ProtectSystem=strict` и передаёт путь в `STATE_DIRECTORY` (§4.4).
  - Каталог лежит вне рабочего дерева: `git checkout -f` его не трогает, `mkdir` в `setup.sh` и `deploy.sh` не нужен.
  - Отклонённый вариант — `ReadWritePaths=…/apps/bot/.state`. Каталог в `.gitignore`, его никто не создаёт, а бот под `ProtectSystem=strict` создать его не может. Несуществующий путь в `ReadWritePaths` без «-» роняет юнит на шаге NAMESPACE (exit 226), и с `Restart=always` получается цикл перезапусков.
- **Без `apps/bot/.env` юнит пропускается.** `ConditionPathExists`: при загрузке heidi без `.env` юнит не стартует и не крутит рестарты каждые 5 с. «-» у `EnvironmentFile` — на случай, если файл исчезнет между проверкой условия и стартом.
- **Коды выхода.**
  - 78 (EX_CONFIG) — username не совпал с `TG_BOT_USERNAME` или версия сервера не совпала с версией бота. `RestartPreventExitStatus=78`: без рестартов, нужен человек.
  - 1 — веб недоступен при старте или heartbeat протух. systemd поднимает бота через 5 с.
- **`ExecStart` запускает node напрямую**, а не `npm run start`:
  - код 78 доходит до systemd без посредника;
  - SIGTERM получает сам процесс бота;
  - нет попыток npm писать свой журнал в `~/.npm`: под `ProtectSystem=strict` домашний каталог только для чтения.

  Скрипт `"start": "tsx src/main.ts"` остаётся для запуска на Mac.
- **sudoers** (`setup.sh:139`): добавить `restart|start|stop|status second-opinion-bot`.
- **Порядок в `deploy.sh`:**
  1. `systemctl stop second-opinion-bot`, если юнит есть;
  2. checkout; `git rev-parse --short` → `$APP_DIR/VERSION`. Это sha кода на диске; его же сборка запечёт в `SO_BUILD_SHA` (§4.3), поэтому `VERSION` пишется до сборки;
  3. `npm ci`;
  4. `web:build`;
  5. рестарт `second-opinion`, проверка `is-active`;
  6. `curl 127.0.0.1:3000/api/health` — `version` (sha сборки) должен совпасть с `VERSION`, иначе `exit 1`: сервер работает не на новой сборке;
  7. если есть `apps/bot/.env` и `SO_TG≠0`: `start second-opinion-bot`, затем ждать до 70 с, пока heartbeat станет новее старта, и найти в журнале строку `getMe ok version=<sha>`.
- **Heartbeat** — файл `/var/lib/second-opinion-bot/heartbeat` (`$STATE_DIRECTORY/heartbeat`; на Mac — `apps/bot/.state/heartbeat`). Обновляется после каждого `getUpdates` (таймаут опроса 50 с). Отметка старше 120 с → бот сам делает `exit(1)`, systemd поднимает его. Принцип: «active» ≠ «работает».
- **Выключатели:**
  - `SO_TG=0` в `apps/bot/.env`: бот не опрашивает Telegram, heartbeat пишет;
  - `systemctl stop second-opinion-bot`;
  - пустой `SO_BOT_KEY` в `apps/web/.env`: сервер отвечает 403 на все tg-запросы.
- **Откат:** `release.sh` с прошлой ветки.
- **Логи:** `journalctl -u second-opinion-bot` — только `LogRec`.
- **Секреты.**
  - `apps/bot/.env` (chmod 600): `TG_BOT_TOKEN`, `TG_BOT_USERNAME`, `SO_TG_SALT`, `SO_BOT_KEY`, `SO_TG_ALLOW`, `SO_TG_DAILY`, `SO_TG_CONCURRENCY`, `SO_SITE_URL`.
  - В `apps/web/.env` добавляется только `SO_BOT_KEY`. Токен бота туда не кладётся.
- **Тестовый бот** — только на Mac, против MOCK, со своим токеном. Два опросчика с одним токеном получают 409.
- **Доступ heidi → `api.telegram.org`** владелец проверяет до шага 5. При блокировке — `HTTPS_PROXY`, как в `iss/client.ts:17-30`; это отдельное решение.

## 8. Приватность

- **Где живёт сырой chat_id и user_id.** Только в памяти бота, в записи разговора, пока она жива: не дольше 55 мин простоя, плюс вытеснение LRU. На диск бот не пишет ничего, кроме времени heartbeat.
- **Что уходит на сервер.** Сессия `tg_<псевдоним>_<случайное>`. Псевдоним — HMAC-SHA256(`SO_TG_SALT`, chat_id), 12 символов; соль есть только у бота.
- **Чего бот не читает.** username, имя и фамилия; TG.1 проверяет это статикой.
- **Журналы.**
  - Бот пишет только `LogRec`: без текстов, id и токена.
  - Сервер пишет как для веба (80 символов реплики, 500 символов ответа) плюс `channel`.
- **Allowlist хранит псевдонимы, а не id.** Тому, кого нет в списке, бот отвечает кодом доступа (псевдонимом). Владелец вносит код в `SO_TG_ALLOW`.
- **Соль не ротируется без переиздания кодов.**
  - Allowlist и коды доступа держатся на `SO_TG_SALT`. Смена соли или её потеря (например, переустановка heidi без `apps/bot/.env`) меняет коды у всех: `SO_TG_ALLOW` перестаёт пускать пилотов, и пилот приходится собирать заново.
  - Копию `apps/bot/.env` владелец хранит у себя, вне heidi и вне репозитория.
  - Ротация обязательна, только если соль утекла: пространство chat_id невелико, и с солью псевдонимы из `usage.jsonl` перебором сводятся к chat_id. Тогда ротация идёт вместе с переизданием кодов.
- **Группы запрещены:** в BotFather и игнором не-private чатов в боте.
- **`/start` показывает уведомление:** что передаётся, сколько хранится, ссылка на политику. Текст утверждает владелец.
- **152-ФЗ.** Локализация ПДн (где физически стоит heidi) и срок хранения `usage.jsonl` — решение владельца с юристом. Вопрос касается и уже работающего веб-журнала.

## 9. Бюджет и лимиты

- **Сейчас на проде:** `SO_DAILY_BUDGET_USD=0` (без лимита) и `SO_MESSAGE_LIMIT=1000000` (решение от 10.10). README говорит «$2» — это устарело.
- **Бюджет общий.** Бот тратит тот же бюджет в том же процессе, гонки за `budget.json` нет.
- **Предусловие публичного запуска** (`SO_TG_ALLOW="*"`):
  1. на проде `SO_DAILY_BUDGET_USD > 0`, значение выбирает владелец;
  2. H.7 GREEN: вызовы Jev в `parseInputs` списываются в бюджет.

  Пилот по allowlist может идти и без этого, но потолок рекомендуется задать и для пилота.
- **Лимиты бота** (это транспорт, не решения):
  - `SO_TG_DAILY=60` ходов за сутки МСК на псевдоним — закрывает обход лимита сессии через `/new`;
  - `SO_TG_CONCURRENCY=4` хода одновременно на весь бот;
  - очередь — 2 сообщения на чат;
  - `SO_TG_MAX_CHATS=300` разговоров в памяти.
- **Бюджет исчерпан.** Сервер отказывает до гейта текстом `budgetExhaustedText("telegram")`, и в боте не работают даже бесплатные проверки. Выход — команда `/check` через `/api/report` (вне объёма, кандидат следующего шага).
- **Будущий per-IP лимит (S.1).** Запросы с валидным `x-so-bot-key` исключаются из него: все они идут с 127.0.0.1. Их ограничивают лимиты бота.

## 10. Риски

| Риск | Защита |
|---|---|
| Фикстуры устаревают при намеренной правке текстов гейта или MOCK-модели | TG.G2 краснеет и показывает дифф; перезапись — как golden, только оркестратор |
| Апгрейд `ai` меняет протокол сразу для браузера и бота | точный одинаковый пин (TG.22); TG.G2 и TG.4 ловят расхождение |
| В историю бота попадает отрисованный текст, и гейт тихо меняет маршрут | история — только сырые `UIMessage`; TG.4 и мутант TG.G4 |
| Тексты блоков уезжают из VM в отдельный модуль (`texts.ts`, `app.tsx`, `WEB`), VM остаётся с одной шапкой. Прямые проверки при этом зелёные, а Telegram теряет текст отчёта | обратная часть TG.6 и TG.6-tg (видимый текст ⊆ VM); TG.7 по замыканию импортов |
| Ядро бота ходит в сеть мимо внедрённого `fetch` | в процессе харнеса `globalThis.fetch` бросает, нарушение — RED (TG.6-tg, TG.8, TG.9, TG.16–TG.19, TG.21); статика TG.1 — сетевые модули только в `main.ts`/`telegram.ts` |
| Telegram выедает общий бюджет; при исчерпании бот не может даже бесплатной проверки | лимиты бота (§9); решение владельца о бюджете; `/check` в боте — следующий шаг |
| Рестарт Next посреди хода | ECONNREFUSED → повтор. Обрыв потока → «не получилось» без повтора: ход не идемпотентен (бюджет, `session.result`). Серверная сессия теряется — как у веба |
| Память: полные отчёты (~17 КБ JSON) в истории до 300 разговоров | `MemoryMax=512M`, LRU; вытеснение = новый разговор с уведомлением |
| Обработчик только ставит ход в очередь, поэтому апдейт подтверждается до конца хода | падение посреди хода теряет этот ход — осознанно: лучше потерять ход, чем дважды списать |
| Два опросчика одного токена (409) | отдельный тестовый бот; сверка `getMe` с `TG_BOT_USERNAME` |
| heidi не достаёт до `api.telegram.org` | проверка владельцем до шага 5; при блокировке — `HTTPS_PROXY` |
| HTML-инъекция через shortname или запрос | экранирование (TG.8), откат на простой текст (TG.18) |
| «active», но не работает (повис опрос) | heartbeat, watchdog, проверка в `deploy.sh` (TG.23) |
| Подделка канала извне через Caddy | ключ и 403 (TG.11) |
| Будущие H.5 и S.2 режут историю с отчётами | TG.G6; решение: S.2 считает текстовые части |
| Паритет доказан на MOCK/OFFLINE без Jev, а живые модель и Jev недетерминированы | вход одинаков, и исполняет его один процесс — расходиться нечему |
| Сборка `ai` в боте и assistant-ui в браузере расходятся в мелочах формы (`metadata.custom`, `state`) | TG.4 против реальных тел; `toWire` фиксирует форму браузера |
| Каталог состояния не существует, и юнит под `ProtectSystem=strict` не стартует (NAMESPACE, exit 226) | `StateDirectory=`: каталог создаёт systemd (§7, TG.23) |
| Сборка упала: на диске новый код, в памяти старый сервер, а сверка версий проходит вхолостую | sha сборки `SO_BUILD_SHA` против `VERSION` кода на диске (§4.3, TG.23); расхождение → `exit(78)` без рестартов |
| Без `apps/bot/.env` юнит крутит рестарты каждые 5 с | `ConditionPathExists` и `EnvironmentFile=-` (§7, TG.23) |
| Смена или потеря `SO_TG_SALT` обнуляет allowlist и коды доступа | соль не ротируется без переиздания кодов; копия `apps/bot/.env` у владельца (§8, §11) |
| Оценка ядра бота | самые рискованные часы; контрольная точка после ядра P4, при выходе за +30 % — остановка и доклад владельцу (§12) |

## 11. Решения и действия владельца

**Решения:**
1. Утвердить план: архитектура «Один мозг, два клиента», grammY 1.46.0, long polling, отдельный юнит.
2. Значение `SO_DAILY_BUDGET_USD` к публичному запуску (сейчас 0 = без лимита) и возвращать ли `SO_MESSAGE_LIMIT=20`.
3. Лимиты бота: `SO_TG_DAILY` (предлагается 60) и `SO_TG_CONCURRENCY` (4).
4. Состав пилота (коды доступа), срок (неделя) и критерии перехода к публичному запуску.
5. Текст уведомления о приватности в `/start`; срок хранения `usage.jsonl` (предлагается 30 дней); локализация ПДн — с юристом.
6. Имя, @username, описание и аватар бота.
7. Изменения, видимые пользователю:
   - формулировка промпта (`prompt.ts:11`);
   - тексты лимита и бюджета для Telegram;
   - `/check` игнорирует невалидные параметры по общей схеме.
8. При будущей правке S.2 предел истории считать по текстовым частям.
9. Нужна ли кнопка «Открыть на сайте» и с каким адресом (`SO_SITE_URL`: sslip.io или домен).
10. Отдельное «катить» на каждую выкатку heidi и на root-шаг `setup.sh`.

**Действия руками** (≈ 1–1,5 ч без пилота):
1. **BotFather:**
   - тестовый бот (только для Mac) и прод-бот;
   - `/setjoingroups` → Disable;
   - `/setcommands`: start, new, help.

   Токены в чат не присылать.
2. **Проверить доступ:** `ssh heidi "curl -sS -o /dev/null -w '%{http_code}\n' https://api.telegram.org"`. Ожидается 2xx или 3xx.
3. **Секреты:**
   - `ssh heidi nano /opt/second-opinion/apps/bot/.env`: `TG_BOT_TOKEN`, `TG_BOT_USERNAME`, `SO_TG_SALT` и `SO_BOT_KEY` (оба — `openssl rand -base64 32`), `SO_TG_ALLOW`; затем chmod 600;
   - копию `apps/bot/.env` сохранить у себя, вне heidi. `SO_TG_SALT` после выдачи кодов не менять: новая соль — новые коды у всех пилотов, и пилот собирается заново (§8);
   - тот же `SO_BOT_KEY` — в `apps/web/.env`;
   - тестовый токен — только в локальный `apps/bot/.env`.
4. **Root-шаг:** `scp deploy/heidi/setup.sh heidi:setup.sh && ssh -t heidi bash setup.sh`.
5. **Смоук на тестовом боте** (Mac, MOCK): 7 диалогов эталона, `/new`, 21-е сообщение, выбор выпуска кнопкой, deep-link. Чеклист будет в отчёте шага 7.
6. **«Катить» и пилот:** получить свой код доступа от бота, внести коды пилота в `SO_TG_ALLOW`.
7. **Через неделю** — решение о публичном запуске. До него `SO_DAILY_BUDGET_USD > 0`.

## 12. Оценка

Единица — часы работы агентов. Калибровка: WP-U (18 проблем, 4 пакета, ревью) занял ≈ 7 ч. Здесь 24 RED-проверки, новое приложение и новый пакет — примерно в 2,4 раза больше.

**Ответ на F1.10** (судья 1: «оценка оптимистична»). Возражение принято частично.
- В среднем оценка не мягче WP-U. WP-U — ≈ 7 ч на 18 проблем, около 23 мин на проблему. Здесь пакеты P1–P5 — 12 ч на 24 RED-проверки, около 30 мин на проверку; харнес (3,5 ч) и сведение (1 ч) считаются отдельно.
- Мягче всего P4: 5 ч на 14 RED-проверок (плюс бот-часть TG.23), около 21 мин на проверку, хотя это новое приложение, а не правки. Довод «за»: около трети его проверок — мелкие чистые модули с замороженными сигнатурами (`ids`, `limits`, `log`, `heartbeat`, `version`, политика Telegram; TG.18, TG.22, части TG.19, TG.21, TG.23) и статика TG.1, TG.2. Довод «против»: риск сосредоточен в ядре (очередь, повтор, таймаут, сборка потока, сессия; TG.4, TG.5, TG.16, TG.17, TG.20, TG.21) и в рендере с обратной проверкой и ограничениями Telegram (TG.6-tg, TG.8, TG.9), и у правок WP-U такого риска не было.
- Поэтому вместо прибавки часов вслепую — **контрольная точка в P4**. После ядра (`config`, `request`, `turn`, `queue`, `ids`, `limits`, `log`, `core`), до `render.ts`, должны быть GREEN TG.16, TG.17, TG.19, TG.21, TG.22, а TG.4 и TG.5 — по их detail на всех диалогах, кроме d2-pick (ему нужны кнопки рендера). В этот момент оркестратор сверяет потраченное с планом ядра (3 ч) и переоценивает остаток (план 2 ч).
- Если на ядро ушло больше 3,9 ч или переоценка остатка больше 2,6 ч, то есть P4 выходит за +30 %, работа останавливается, и владелец получает доклад с новой оценкой. Тихо продолжать нельзя.
- То же правило для проекта в целом: если сумма выходит за 21 ч — остановка и доклад.

| Что | Агент-часы |
|---|---|
| Шаг 1. Харнес WP-TG | 3,5 |
| P1. `@so/present` (protocol/entry/copy) и одна схема | 1,5 |
| P2. VM отчёта и перевод блоков | 2,5 |
| P3. Сервер: ключ, канал, тексты, промпт, top3, версия, H.7 | 1,5 |
| P4. Ядро бота и рендер | 5 |
| P5. E2E и эксплуатация | 1,5 |
| Сведение и приёмка | 1 |
| **Итого** | **≈ 16,5 ч**, с запасом +30 % — до 21 ч. Критический путь ≈ 12,5 ч |

Отдельно от агентов:
- **Владелец:** ≈ 1–1,5 ч действий руками (§11) и 5–10 мин на каждое «катить».
- **Пилот:** календарная неделя по allowlist; разбор журнала по каналу `telegram` и смоук в живом Telegram.

## 13. Приёмка

1. `npm run -s -w @so/web audit -- --baseline` → exit 0.
   - Все TG.* GREEN.
   - Ни одна проверка, бывшая GREEN, не покраснела.
   - H.7 и R.7-web GREEN; прочие перевороты вверх перечислены.
2. `npm run -s -w @so/engine audit -- --baseline` → exit 0 (движок не трогаем).
3. `npm run -s selftest`; typecheck `@so/web`, `@so/blocks`, `@so/present`, `@so/bot`; `npm run -s golden:diff` пуст.
4. `npm run e2e:bot` и `npm run e2e:chat` против MOCK. Если Playwright-браузер не скачан, `e2e:chat` отмечается в отчёте как не прогнанный; решающими остаются TG.4 и TG.G5.
5. После выкатки:
   - на heidi `second-opinion-bot` в состоянии active, heartbeat моложе 60 с;
   - строка `getMe ok version=<sha>` равна `version` локального `/api/health`;
   - смоук владельца в живом Telegram по allowlist пройден;
   - в `usage.jsonl` есть записи `channel:"telegram"` с `tg_`-сессиями и без сырых id.

## 14. Вне объёма

- `/check <ISIN>` в боте через `/api/report`: 0 токенов, работает и при исчерпанном бюджете. Сюда же кнопка «Открыть в Telegram» на `/check`. Следующий шаг по решению владельца.
- Вебхук; несколько экземпляров бота; история в Redis или на диске.
- Вынос `gate/jev/tools` в пакет (`runTurn`).
- Голос, фото и документы продавца; группы и каналы; inline-режим; оплата и вход в кабинет через Telegram.
- Доля бюджета по каналам.
- ForceReply на вопрос о цене и кнопки-пресеты сумм — после пилота и только с доказательством, что гейт их разбирает.
- Открытые RED, кроме H.7 и R.7-web: R.8, S.1, S.2, H.5 и остальные.
- Ротация `usage.jsonl` — отдельной задачей по решению владельца.
- Фолбэк сессии `"anon"` в `route.ts:27` → 400 (graft судьи 2, G2.11). Сейчас запрос без `body.id` и без `x-so-chat` попадает в общую сессию `"anon"`. Это дефект веба, а не паритета: браузер и бот всегда шлют `body.id` (TG.4), а `"anon"` без `tg_` для `channelOf` — канал `web`. Отдельная правка S/H-пакета с проверкой «без id → 400».
- Границы React-форм против `ReportInputsSchema` (graft судьи 1, G1.12, в части форм): цена в `AskPrice` (`blocks.tsx:110`) и поля `InputsPanel` (`blocks.tsx:281, 292, 305`). Это третья и четвёртая копии границ, но не вход сервера: всё, что форма пропустила, отклоняет схема (И4, TG.13). Сведение меняет видимое поведение форм: сейчас цена 0,5 проходит форму и отклоняется сервером, а «обещали 0» форма не отправляет, хотя схема его принимает. Поэтому это отдельная правка после пилота: формы берут границы из `ReportInputsSchema.shape` через `safeParse`, тексты ошибок — из `WEB`. `gate.ts:176` уже валидирует через `inputsSchema`, там правка не нужна.
