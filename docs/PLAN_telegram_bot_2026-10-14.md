# План: Telegram-бот на том же движке решений (WP-TG)

**Дата:** 14.10.2026 · **Основание:** проектирование 14.10 (карта связности, три проекта, два судьи) — оба судьи выбрали проект «Один мозг, два клиента», плюс решения оркестратора (ниже они обязательны) · **База:** ветка `e2-blocks-page`, HEAD `d16c809` (по коду = прод `a1d695d`) · **Эталон паритета:** `apps/web/audit/fixtures/dialogs/*.json` — 7 диалогов, 15 реальных тел запросов браузера · **Харнес:** WP-TG, `apps/web/audit/checks/wp-tg.ts`; до правки ожидается 24 RED до шага 1а (23 RED после: TG.22 зеленеет на 1а) и 6 guard GREEN · **Исполнители:** Opus 5.5; на каждый пакет два независимых ревью · **Эталоны и фикстуры** меняет только оркестратор после разбора диффа · **Выкатка:** только по явному «катить». Root-шаг `setup.sh` одобряется отдельно.

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
| И1 | **Бот не принимает решений.** В `apps/bot` нет гейта, правил и Jev, промпта, модели, инструментов, `build` и `applyInputs`, нет ключей LLM и Jev | TG.1 (графы `apps/bot/src` и `packages/present/src`), TG.2, TG.22 |
| И2 | **Канал не влияет на гейт.** На одну и ту же реплику сервер отвечает одинаково при канале `web` и `telegram`. Канал читают только проверка ключа, тексты отказа и журнал | TG.3, TG.G3. «Вход модели одинаков» держит статическая часть TG.G3 по `route.ts`, а не TG.3: MOCK-модель системный промпт не читает (`model.ts:91-134`) |
| И3 | **Один текст отчёта.** Всё, что пользователь видит в блоках отчёта, приходит из `presentReport(r)`. React и Telegram только раскладывают этот текст | TG.6, TG.6-tg (включение в обе стороны), TG.7, TG.G5 |
| И4 | **Одна схема ввода.** `ReportInputsSchema` из `@so/engine/contract` проверяет ввод на `/check`, в `/api/report`, `/api/chat` (поле `inputs` и `set_inputs`), в `/chat?q=…` и в deep-link бота | TG.13, TG.7 (AskPrice), R.7-web |
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
   - Фразы «смотрите блоки выше» и «в списке выше» верны и в Telegram: бот отправляет части ответа строго в порядке `parts` (текст модели перед инструментом уходит до заглушки — правило `onToolInput`, §4.4), а отчёт появляется правкой заглушки на её месте (TG.9).
   - Меняется только промпт:
     - `prompt.ts:11` «доходность в блоке ниже», «Truth Score показан справа» → «в блоке «Доходность»», «в блоке Truth Score». Здесь порядок в Telegram другой, а «справа» неверно уже на мобильном сайте;
     - `prompt.ts:20` (правило 10) «доходность к колл-дате, если она ниже биржевой» → «…если она меньше биржевой». Смысл тот же; TG.15 запрещает слово «ниже» в промпте целиком.
   - Поэтому фикстуры диалогов остаются валидными.
7. **`gate/jev/tools` не выносим в пакет и не делаем `runTurn`.**
   - Это дорого: пришлось бы мигрировать `wp-s` (`analyzeRoute`) и `mkWriter` во всех гейт-проверках.
   - При одном процессе решений это ничего не даёт.
   - Вернуться к вопросу стоит, если появится канал без HTTP или второй сервер.

| Где | Что | Чего там нет |
|---|---|---|
| `apps/web` | все решения; `lib/channel.ts` (ключ бота); тексты отказа по каналу; `channel` в журнале; `version` в локальном `/api/health` | кода Telegram, токена бота |
| `packages/present` (`@so/present`, новый; чистый TS без React, Node и `ai`) | протокол: имена инструментов, типы выходов, TTL, заголовки; вход: `initialOf`, `firstText`, `chatParams`, `pickMessage`, `SUGGESTIONS`, deep-link; тексты каналов; view-model отчёта и веток | решений диалога |
| `packages/engine/src/contract.ts` | `ReportInputsSchema` (перенос из `tools.ts:22-27`) | — |
| `packages/blocks` | раскладка VM в React | собственных текстов (TG.7) |
| `apps/bot` | транспорт Telegram, очередь, история, сборка тела, рендер VM в HTML | гейта, Jev, промпта, модели, `build`/`applyInputs`, ключей LLM/Jev, кириллических литералов |

## 4. Интерфейсы

Харнес вызывает эти интерфейсы до того, как написан код. Если модуля нет, проверка RED с detail «нет модуля …», а не ERROR. Если сигнатура меняется, правится этот раздел и харнес, решение принимает оркестратор.

### 4.1 `@so/present` (`packages/present`)

`package.json` (создаёт оркестратор в шаге 1а):
- `"name": "@so/present"`;
- exports `./protocol`, `./entry`, `./copy`, `./report` → `./src/<имя>.ts`;
- зависимости — `@so/engine` (contract, format, config) и `zod`.

В `apps/web/next.config.ts` в `transpilePackages` добавляется `"@so/present"`.

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
export const CABINET_HREF = "https://vfo.autremus.com"; // перенос из ReportView.tsx:31; @so/blocks реэкспортирует (P2), бот берёт отсюда

// @so/present/entry — перенос без изменения поведения
export type EntryParams = { q?: string; promised?: string; pos?: string; k?: string; price?: string; m?: string };
export type ChatInitial = { q: string; inputs: ReportInputs; text?: never } | { text: string; q?: never; inputs?: never }; // дословно ChatApp.tsx:10
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
export const WEB: Record<string, string>; // литералы React, которых нет в VM: формы ввода, «Новая проверка», кнопки.
//   P1 создаёт заготовку `{}`, заполняет P2 (шаг 3). Обратная проверка TG.6 вычитает только литералы своего закрытого списка

// @so/present/report
export type Tone = "good" | "mid" | "bad" | "none";                // как ui.tsx:13-21
export function scoreTone(score: number): Tone;                    // перенос из ui.tsx:13-16; @so/blocks реэкспортирует
export function liquidityTone(cat: string, noExit: boolean): Tone; // перенос из ui.tsx:18-21; @so/blocks реэкспортирует
export interface SectionVM { id: PanelIdT; title: string; subtitle?: string; big?: string; tone?: Tone; lines: string[];
  barsCaption?: string;                                            // «Доходность» / «Доходность флоатера по сценариям ставок» (blocks.tsx:65,76,90)
  bars?: { label: string; value: string }[]; items?: { title: string; text: string; badge?: string }[] } // badge — «−N» флага
export interface ReportVM { dataTime: string | null; kicker: string; name: string; isin: string | null;
  sections: SectionVM[]; plaque: { title: string; items: string[] } | null }
export function presentReport(r: BondReportT, o?: { askPriceNote?: string }): ReportVM; // секции — по раскладке ReportView, только из r.panels;
//   askPriceNote в vmStrings не входит (показывается только после submit, blocks.tsx:111,128)
//   Решение оркестратора 16.10 (по итогам P2): SectionVM.note?: string — askPriceNote секции ask_price (в vmStrings не входит;
//   бот note не выводит и askPriceNote не передаёт). Для сайта @so/present/report дополнительно экспортирует presentSection,
//   presentPlaque, presentDataTime, yieldBars, yieldVariant, типы SectionId/PickVM/YieldBar/YieldVariant и перегрузку
//   presentBranch(pick): PickVM — блоки получают только { r }. Раскладка строк секций — шапка packages/present/src/report.ts;
//   секции «Доходность» после первой идут с пустым title (продолжение карточки) — рендер пустой заголовок пропускает.
export type BranchVM =
  | { kind: "pick"; title: string; lines: string[];
      options: { label: string; sub: string; reg: string; trading: string; message: string; traded: boolean }[] }
      // sub — ISIN или SECID; reg — рег. номер или «—»; trading — «торгуется» / «не торгуется» (branches.tsx:44-46)
  | { kind: "notfound" | "err"; title: string; lines: string[] };
export function presentBranch(res: Exclude<BuildResultT, { kind: "report" }>): BranchVM;
export function vmStrings(vm: ReportVM | BranchVM): string[];    // все видимые строки — для TG.6 и TG.6-tg;
//   barsCaption, bars[].label и bars[].value — отдельными строками; составную aria-строку баров vmStrings не возвращает (TG.6(б))
```

В VM переезжает всё, что сейчас дописывает React:
- заголовки карточек;
- «+X% за период до колла…» (`blocks.tsx:61-64`);
- крупное число комиссий с подписью (`blocks.tsx:152-158`);
- подписи баров и их caption (`barsCaption`);
- «N / 100» (в `big` секции score), «−N» баллов флага (`items[].badge`), «Ни один из N red flags не сработал», «Ещё N — в полном отчёте» (`blocks.tsx:186-206`);
- метка ликвидности (`blocks.tsx:139`);
- поясняющий абзац AskPrice (`blocks.tsx:117-119`);
- тексты веток со склонением через `plural` из `format.ts` (`branches.tsx:13-14, 30-32, 71-93`), у кандидатов pick — ISIN/SECID, рег. номер, «торгуется»/«не торгуется»;
- плашка полного отчёта, включая «Без входа базовый отчёт доступен только в этой сессии.»;
- тон по `CONFIG` (из `ui.tsx`).

### 4.2 `@so/engine/contract`

- `export const ReportInputsSchema = z.object({ position_size, k_pct, promised_pct, offer_price_pct })` — границы как в `tools.ts:22-27`.
- `apps/web/lib/tools.ts`: `export const inputsSchema = ReportInputsSchema` — тот же объект.
- Потребители схемы:
  - `route.ts` — `body.inputs`, через `tools`;
  - `set_inputs`;
  - `initialOf` и deep-link;
  - `app/check/page.tsx` — поле за полем, невалидное игнорируется, как в `initialOf`;
  - `app/api/report/route.ts` — невалидное → `{kind:"err"}` 4xx (R.7-web);
  - форма AskPrice (`packages/blocks/src/blocks.tsx:110`, P2) — границы цены из схемы: `ReportInputsSchema.shape.offer_price_pct.safeParse(n).success && n != null` (TG.7). Сейчас форма пропускает 0 < цена < 1, а схема требует `min(1)` (`tools.ts:26`): пересборка получила бы 4xx, `CheckClient.tsx:34-38` статус не смотрит, и пользователь увидел бы ErrView. Текст сообщения прежний, SSR не меняется.

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
- Пустой или незаданный `SO_BOT_KEY` → условие 3 считается невыполненным без сравнения (сравнение sha256("") с sha256("") запрещено: иначе пустой заголовок `x-so-bot-key:` прошёл бы на сервере без ключа).

**`route.ts`.**
- До `getSession`, `userMessages` и `countMessage`:
  `const id = body.id ?? req.headers.get("x-so-chat") ?? "anon"; const ch = channelOf(req, id); if (!ch.ok) return new Response(null, { status: 403 }); const session = getSession(id);`
- Ключ сессии передаётся в `getSession` переменной `id` (или выражением с `body.id`). Имена вроде `sid`/`key`/`sessionId` guard S.3 не распознаёт как client-side id (`wp-s.ts:782`, регэксп `/\b(?:\w+\.)?id\b/`), и S.3 становится RED; `wp-s.ts` в P3 не правится. Внутренний `const id = "lim"` в `plainReply` (`route.ts:37`) остаётся: это вложенная область видимости, typecheck зелёный.
- Импорт `import { channelOf } from "@/lib/channel"` — разрешённый фрагмент TG.G3(б); других импортов, содержащих `channel`, в `route.ts` нет.
- Во все `log({...})` добавляется `channel`.
- Тексты отказа: `limitText(ch.channel, MESSAGE_LIMIT)`, `budgetExhaustedText(ch.channel)`.
- Больше `channel` в сервере нигде не появляется (TG.G3: lib-модули и статическая часть по `route.ts`).

**Остальные файлы:**
- `health/route.ts`: в локальный ответ добавляется `version` — содержимое `<repo>/VERSION` после trim (пустое — `"dev"`; `deploy.sh` пишет файл с переводом строки), его пишет `deploy.sh`; если файла нет — `"dev"`. Наружу по-прежнему только `{ok}`. VERSION читается один раз, константой на уровне модуля (в Next 16 модуль маршрута грузится лениво, при первом запросе к `/api/health`, поэтому `deploy.sh` обращается к нему сразу после рестарта); внутри `GET` файл не читается. Иначе сервер и бот читают один и тот же файл, который `deploy.sh` пишет до рестарта, и сверка версий ничего не проверяет. Путь = `${process.env.SO_APP_DIR ?? path.resolve(process.cwd(), "../..")}/VERSION` (на проде cwd = `$APP_DIR/apps/web`, `setup.sh:122`); харнес задаёт `SO_APP_DIR` (TG.23).
- `session.ts`: TTL берётся из `SESSION_TTL_MS`.
- `budget.ts`: `BUDGET_EXHAUSTED_TEXT = budgetExhaustedText("web")`.
- `prompt.ts:11` и `prompt.ts:20` (правило 10, «ниже» → «меньше») — нейтральные слова (§3, решение 6).
- `gate.ts:118` — «Главные red flags» из `truth_score.top3`; текст отчёта гейта — экспортируемая чистая функция (`export` у `reportText` или выделенная `topFlagsText(r)`) для TG.14.
- `jev.ts` — `parseInputs` возвращает usage вызова `jevKind`, маршрут его списывает (H.7).
- `scripts/usage-report.ts` — разрез по `channel`.

### 4.4 `apps/bot/src`

- `grammy` импортируют только `main.ts` и `telegram.ts`.
- `core.ts` не читает `process.env` и ходит в сеть только через внедрённые `fetch` и `TgClient`.

```ts
// config.ts
export interface BotConfig { webUrl: string; botKey: string; salt: string; allow: string; dailyTurns: number; concurrency: number;
  perChatPending: number; maxChats: number; turnTimeoutMs: number; siteUrl?: string }
export interface MainConfig extends BotConfig { token: string; botHandle: string; stateDir: string; appDir: string; enabled: boolean;
  apiRoot?: string }
export function loadConfig(env: Record<string, string | undefined>): MainConfig; // в тексте ошибок нет значения токена
//   botHandle = env.TG_BOT_USERNAME.
//   apiRoot = env.TG_API_ROOT (только e2e), разбор через new URL: принимается только http:, hostname 127.0.0.1 или localhost,
//   явный порт, без пути, query и учётных данных; иначе ошибка, в тексте которой нет ни токена, ни значения.
//   NODE_ENV=production и задан TG_API_ROOT → ошибка (иначе токен уйдёт на любой хост).

// identity.ts — единственное место, где читается username (исключение TG.1)
export function sameBot(me: { username?: string }, handle: string): boolean;

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
  handleUpdate(u: TgUpdate): Promise<void>;  // промис завершается после хода (или отказа) и никогда не отклоняется;
                                             // main.ts вызывает без await, дополнительно вешает .catch(r => log({ev:"tg_error", err:...})) и bot.catch(log)
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
- В `renderTurn` ядро передаёт `cabinetHref: CABINET_HREF` из `@so/present/protocol`; литерала URL кабинета в `apps/bot` нет.

**Ошибки доставки.**
1. Каждая операция `TgClient` в ядре (`sendMessage`, `editMessageText`, `answerCallbackQuery`, `sendChatAction`, в том числе отказы, приветствие и `notAllowed`) обёрнута в try/catch. Ошибка пишется в `LogRec` `{ev:"tg_error", status:String(error_code ?? "net")}` без текста реплики.
2. Ассистентское сообщение из `TurnOutcome` записывается в историю `Conv` до рендера и доставки. Ошибка доставки историю не откатывает: сервер уже списал ход и обновил `session.result`.
3. 403 (бот заблокирован) → оставшиеся `TgOp` этого хода не отправляются. 400 «message to edit not found» или «message can't be edited» → отчёт уходит новым `sendMessage`. Сетевая ошибка или 429 сверх 3 повторов → текущая `TgOp` пропускается, следующие идут.
4. `ChatQueues.run` освобождает слот в `finally` и сам не отклоняется, даже если job бросил исключение.

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
  onToolInput?(toolCallId: string, toolName: string, partial: UIMessage): void }): Promise<TurnOutcome>;
// partial — текущий снимок из readUIMessageStream. Правило ядра на onToolInput: сначала sendMessage каждой text-части
//   partial.parts с индексом меньше индекса этого tool-part, которая ещё не отправлена, — независимо от state
//   (у OpenRouter text-end приходит только в flush после tool-call, @openrouter/ai-sdk-provider/dist/index.js:5011-5016);
//   потом заглушка. Отправленные partIndex запоминаются; после хода операции renderTurn с уже отправленным partIndex
//   пропускаются, а если итоговый текст части отличается от отправленного — она правится через editMessageText.
// POST повторяется ТОЛЬКО если fetch отклонён с code ECONNREFUSED (или cause.code):
//   до 3 повторов с паузами 2/8/20 с, после этого реплика убирается из истории.
// HTTP-ошибка, обрыв потока, таймаут turnTimeoutMs (90 с) — без повтора;
//   реплика и частичный ответ остаются в истории, как у AbstractChat.

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
export function newSessionId(random: (n: number) => Uint8Array): string; // `tg_${base64url(random(9))}` — без псевдонима;
//   Conv.pseudo остаётся в боте только для allowlist и DailyLimit

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
//   Формат строки: `${ev}`, затем ` ${k}=${v}` по полям в фиксированном порядке (pseudo, upd, ms, status, err, version);
//   {ev:"getMe ok", version:"abc1234"} → «getMe ok version=abc1234» — эту строку ищет deploy.sh.
//   pseudo пишется только в событиях отказа (notAllowed, dailyLimit); в записях хода его нет

// heartbeat.ts
export function makeHeartbeat(o: { file: string; staleMs: number; now(): number; exit(code: number): void;
  write(file: string): void; mtime(file: string): number | null }): { beat(): void; check(): void };

// version.ts
export function readVersion(appDir: string): string;                 // <appDir>/VERSION после trim; нет файла или пусто — "dev" (как health, §4.3)
export function checkServerVersion(f: typeof fetch, webUrl: string, mine: string): Promise<{ ok: boolean; server: string | null }>;
```

**Запуск `main.ts`:**
1. `loadConfig(process.env)`; `readVersion(cfg.appDir)` — один раз, до `getMe`.
2. `new Bot(cfg.token, cfg.apiRoot ? { client: { apiRoot: cfg.apiRoot } } : undefined)`; `if (!sameBot(await bot.api.getMe(), cfg.botHandle)) exit(1)`; затем `log({ev:"getMe ok", version})`.
3. `checkServerVersion`: версии бота и сервера должны совпасть, иначе `exit(1)`.
4. `bot.start({ allowed_updates: ["message", "callback_query"], timeout: 50, onStart: () => hb.beat() })` (без `timeout` у grammY 30 с).
5. Heartbeat пишется после каждого `getUpdates` (transformer `bot.api.config.use`), watchdog проверяет его каждые 30 с.
6. По SIGTERM: `bot.stop()`, затем `core.idle()` — не дольше 30 с.

`apps/bot/package.json` (создаёт оркестратор в шаге 1а):
- `"name": "@so/bot"`;
- точные версии: `grammy 1.46.0`, `ai 7.0.133`;
- `@so/present`, `@so/engine` (только `contract` и `format`; `config` — только транзитивно через `@so/present/report`), `zod`, `tsx`;
- `"start": "tsx src/main.ts"` (на heidi env даёт `EnvironmentFile`); `"dev": "tsx --env-file=.env src/main.ts"` (Node ≥ 20.6, как в `jev-eval.ts:15`) — для запуска на Mac.

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
- Части `_p`, `_k`, `_o`: `x = Number(значение)`, `n = Math.round(x*100)`. Часть пишется как `n`, если `n/100 === x` (точное равенство, без допуска), иначе `encode` возвращает `null`, и ссылка не строится. Равносильно этому — строковая проверка `^\d+(\.\d{1,2})?$`. `Number.isInteger(x*100)` использовать нельзя: `0.07*100 = 7.000000000000001`, `0.29*100 = 28.999999999999996`. Декодер даёт `String(n/100)`.
- В этом WP `encode` вызывает только харнес; продуктовый потребитель появится вместе с кнопкой «Открыть в Telegram» (§14).
- Декодер: `EntryParams` → `initialOf` (та же схема) → первая реплика `firstText` и `inputs` в теле каждого запроса.
- Текст с главной (`?m=…`) в deep-link не кодируется: в боте его просто пишут.

### 4.7 Отрисовка в Telegram

- Части ответа идут строго по порядку `parts`; текст модели перед инструментом уходит до заглушки (правило `onToolInput`, §4.4).
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
  - кнопки «Полный отчёт — после входа» (`CABINET_HREF` из `@so/present/protocol`) и, если задан `SO_SITE_URL`, «Открыть на сайте» (`/check?…` из `chatParams`).
- Выбор выпуска (pick):
  - текст VM и по кнопке на каждого кандидата: подпись из VM, `callback_data` `pk:<ISIN ?? SECID>` (не больше 64 байт). Подписи вариантов из VM считаются показанными через кнопки (TG.6-tg);
  - нажатие = реплика `pickMessage(c)`;
  - если ход ещё идёт — `answerCallbackQuery(BOT.busy)`, реплика не уходит.
- `notfound` и `err` — текст VM. `{error}` — текст ошибки.
- Термин: при `found: true` — `<b>title</b>` и текст; при `found: false` — ничего.
- Ответ 400 «can't parse entities» → то же сообщение уходит простым текстом, событие пишется в журнал.

## 5. Шаги

Агент-часы указаны с двумя ревью. Пакеты не пересекаются по файлам. `package-lock.json` правит только оркестратор: lock меняется только в шаге 1а. Исполнители P1–P5 делают только `npm ci` и не правят ни `package.json` (исключение — раздел `scripts` у P5: `e2e:bot`; lock от него не меняется), ни lock. Если пакету нужна новая зависимость, это решение оркестратора с повтором 1а. `packages/present/src/copy.ts`: раздел `WEB` заполняет только P2; новые ключи `BOT` добавляет только P1 либо оркестратор, P4 `copy.ts` не правит.

| Шаг | Что | Файлы | Приёмка | Агент-ч |
|---|---|---|---|---|
| 1 | **Красный харнес WP-TG** (§6) | `apps/web/audit/checks/wp-tg.ts`; `apps/web/audit/tg/{scenarios,normalize,fake-tg,actions}.ts`; `apps/web/audit/fixtures/tg/ssr_golden.json` (снимок с `d16c809`); `apps/web/audit/harness.ts` (регистрация). В baseline только добавляются ключи TG.* (`--only TG --write-baseline`, делает оркестратор) | 24 RED с понятным detail; 6 guard GREEN; прежние 65 статусов без изменений (52 GREEN · 11 RED · 2 SKIP); typecheck `@so/web` зелёный | 3,5 |
| 1а | **Зависимости (оркестратор)**, после шага 1 и до P1. Без них `@so/present` и `grammy` не резолвятся: после P1 `ChatApp.tsx`, `ToolUIs.tsx`, `chat/page.tsx`, `session.ts`, `check/page.tsx` импортируют `@so/present/*`, typecheck `@so/web` падает, а U.12 (`wp-u-ui.ts:279`) и U.20 (`wp-u-ui.ts:644`) уходят в ERROR | `packages/present/package.json` (name `@so/present`, exports `./protocol\|./entry\|./copy\|./report` → `./src/<имя>.ts`, deps `@so/engine` и `zod`); `apps/bot/package.json` (§4.4: `@so/bot`, точные `grammy 1.46.0` и `ai 7.0.133`, `@so/present`, `@so/engine`, `zod`, `tsx`, скрипты `start` и `dev`); у обоих — скрипт `typecheck` и devDependencies `typescript` (у бота и `@types/node`), как у `@so/blocks`; `"@so/present": "0.1.0"` в `apps/web/package.json` и `packages/blocks/package.json`; один `npm install`, коммит `package-lock.json` | есть `node_modules/@so/present` (symlink) и `node_modules/grammy`; `npm ls ai` — одна копия 7.0.133; typecheck `@so/web` зелёный; 65 прежних статусов без изменений (52/11/2); TG.22 GREEN, прочие TG.* как после шага 1 (23 RED, 6 guard) | 0,25 |
| 2 | **P1. `@so/present` (protocol, entry, copy) и одна схема ввода** | `packages/present/{tsconfig.json,src/protocol.ts,src/entry.ts,src/copy.ts}` (в `copy.ts` — заготовка `WEB = {}`); `packages/engine/src/contract.ts`; `apps/web/lib/{tools.ts,session.ts}`; `apps/web/app/chat/page.tsx`; `apps/web/app/check/{page.tsx,CheckClient.tsx}`; `apps/web/app/api/report/route.ts`; `apps/web/components/{ChatApp.tsx,ToolUIs.tsx,Thread.tsx}`; `apps/web/next.config.ts` | TG.10, TG.13, R.7-web GREEN; G1, G2, G5 GREEN; тексты веба не изменились; `npm run -s -w @so/engine audit -- --baseline` → exit 0 | 1,5 |
| 3 | **P2. View-model отчёта** (после P1). React-блоки берут все литералы и числовые фразы из VM, текст не меняется. AskPrice берёт границы цены из схемы (§4.2). Публичный API `@so/blocks` сохраняется: `BLOCKS: Record<PanelIdT, ComponentType<{ r: BondReportT }>>`, `Claim`/`FlagsScore` с пропсом `{ r }`, экспорты `scoreTone` (реэкспорт из `@so/present/report`), `BrandMark`, `SiteHeader`, `ResultApp`, `CABINET_HREF` (реэкспорт из `@so/present/protocol`) | `packages/present/src/report.ts`; `packages/present/src/copy.ts` — только раздел `WEB`; `packages/blocks/src/{blocks,branches,ReportView,ui}.tsx`; `packages/blocks/src/index.ts` (литерал `index.ts:30` → `CABINET_HREF`) | TG.6, TG.7 GREEN; G5 GREEN (SSR 16 golden побайтно); `selftest`; `npm run -s -w @so/engine audit -- --baseline` → exit 0, G.7 GREEN; `npm run -s -w @so/static typecheck`; `npm run -s pages`; `npm run -s validate`, если есть Chromium (иначе в отчёте «не прогнан») | 2,5 |
| 4 | **P3. Сервер** (после P1): ключ и канал, тексты отказа, `channel` в журнале, промпт, top3 (и экспорт функции текста отчёта для TG.14), `version` в health, разрез журнала, H.7 | `apps/web/lib/{channel.ts (новый),budget.ts,prompt.ts,gate.ts,jev.ts}`; `apps/web/app/api/{chat/route.ts,health/route.ts}`; `apps/web/scripts/usage-report.ts` | TG.3, TG.11, TG.12, TG.14, TG.15, **H.7** GREEN; G1–G3, G6 GREEN; S.*/H.* не хуже baseline | 1,5 |
| 5 | **P4. Ядро бота и рендер** (после P1; `render.ts` — после P2) | `apps/bot/{tsconfig.json,.env.example}` (в `.env.example` — закомментированная `TG_API_ROOT` с пометкой «только e2e»); `apps/bot/src/{main,config,identity,core,request,turn,render,html,telegram,ids,queue,limits,log,heartbeat,version}.ts`; `.gitignore` (`apps/bot/.state/`, `VERSION`) | TG.1, TG.2, TG.4, TG.5, TG.6-tg, TG.8, TG.9, TG.16–TG.21 GREEN; TG.23 — части `loadConfig` и `makeLogger` GREEN; TG.22 остаётся GREEN; G4 GREEN | 5 |
| 6 | **P5. E2E и эксплуатация** | `tools/validate/src/{e2e-bot.ts,fake-bot-api.ts}`; `tools/validate/package.json` и `package.json` — только `scripts` (`e2e:bot`); `deploy/heidi/{setup.sh,deploy.sh,README.md}` | TG.23 GREEN. `npm run e2e:bot` зелёный: `e2e-bot.ts` запускает бота отдельным процессом (`npm -w @so/bot start`, то есть `main.ts`) с `TG_API_ROOT=http://127.0.0.1:<порт fake-bot-api>` и фиктивным токеном против Next в MOCK; фейк отвечает на `getMe` значением `TG_BOT_USERNAME`; файлы P4 не меняются; если `/api/health` ≠ `mock`, отказ с кодом 2 | 1,5 |
| 7 | **Сведение**: `npm ci && git diff --exit-code package-lock.json`, полный прогон, отчёт со смоук-чеклистом | — | §13, пункты 1–4 | 1 |
| 8 | **Выкатка** по «катить» | root-шаг `setup.sh` — владелец; `release.sh`; прод-токен; `SO_TG_ALLOW` = коды пилота | §13, пункт 5 | — |
| 9 | **Пилот неделя** → решение о публичном запуске | — | предусловия §9 | — |

Параллельность. Сначала шаг 1, затем 1а и P1. После P1 параллельно идут P2, P3 и ядро P4; рендер P4 ждёт P2. Затем P5 и сведение.
- Критический путь: 1 → 1а → P1 → P4 → P5 → 7 ≈ 12,75 ч.
- Сумма агент-часов ≈ 16,75 ч.

## 6. Харнес WP-TG

### Как устроен

- **Файл и id.** `apps/web/audit/checks/wp-tg.ts`, `wp: "TG"`, регистрация в `harness.ts`. Префикс TG.*, потому что T.* уже занят движковым `wp-t.ts`.
- **Сценарии с сервером идут в дочернем процессе**, как `wp-u-gate.ts:353`: `node --import tsx apps/web/audit/tg/scenarios.ts --scenario <id>`, cwd = `apps/web`. Причина: `engine.ts` фиксирует `SO_OFFLINE` при импорте и ищет golden от cwd.
  - Общее окружение всех дочерних процессов: `SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0`; ключи LLM и Jev сняты; `SO_USAGE_DIR` — временный каталог; `SO_USAGE_LOG=1`; `SO_BOT_KEY` — тестовое значение; явно `SO_DAILY_BUDGET_USD=2`, как в `wp-h.ts:83` и `wp-u-ui.ts:85`; унаследованный `SO_MESSAGE_LIMIT` удаляется (действует 20 из `session.ts:22`), иначе TG.3, TG.4, TG.5, TG.20 и G2 упрутся в лимит в диалогах с 3 и более запросами.
  - G1 и TG.12 идут в отдельном сценарии (`--scenario limits`): `SO_MESSAGE_LIMIT=2` и собственный временный `SO_USAGE_DIR`. Бюджет исчерпывается записью `budget.json` с `spent ≥ 2` за `mskDay()` только в этот каталог: `budget.ts` перечитывает файл при каждом вызове, и общий каталог исчерпал бы бюджет и для сценариев паритета.
  - Unit health из TG.23 идёт в отдельном сценарии (`--scenario health-version`) с собственным `SO_APP_DIR`: VERSION читается при импорте модуля (§4.3), а в процессе харнеса `app/api/health/route` уже закэширован проверками H.7-health и U.14.
  - Обоснование: `MESSAGE_LIMIT` и `DAILY_BUDGET_USD` фиксируются при импорте (`session.ts:22`, `budget.ts:13`); экспортированные в оболочку значения (на проде `SO_DAILY_BUDGET_USD=0`, `SO_MESSAGE_LIMIT=1000000`) не должны влиять на результат.
  - Внешний `fetch` бросает исключение. `"server-only"` подменяется пустым модулем, как в `wp-h.ts:71-81`.
  - `route.POST` вызывается как функция. Бот получает `fetch = (url, init) => route.POST(new Request(url, init))`.
- **Модулей ещё нет** (`apps/bot/src/*`, `@so/present/*`, `lib/channel.ts`). Харнес грузит их динамическим `import` по вычисляемому пути. Нет модуля → `fail("нет модуля …; ожидаемо до шага N")`, то есть RED, а не ERROR. Сигнатуры из §4 продублированы в харнесе структурными типами, поэтому typecheck `@so/web` не ломается.
- **Действия диалога → апдейты Telegram:**
  - `type:X` и `open:/chat?m=X` → `message` с текстом X;
  - `open:/chat?q=…` → `message` с текстом `"/start " + encodeStartPayload(параметры)`;
  - `pick:i` → `callback_query` с `callback_data` i-й кнопки последнего сообщения бота с клавиатурой. Так проверяется и сама клавиатура.
- **Фейковый Telegram** записывает все вызовы `TgClient` и выдаёт возрастающие `message_id`.
- **Текст SSR** — одна функция `ssrText(html)` в `apps/web/audit/tg/normalize.ts`:
  - каждый тег `<…>` заменяется пробелом;
  - HTML-сущности раскодируются;
  - `\s+` схлопывается в один пробел, затем trim;
  - значения `aria-label` добавляются отдельными фрагментами.

  Ею пользуются TG.6 и TG.G5, ею же пишется снимок `ssr_golden.json`. Самопроверка харнеса шага 1: на golden veb `ssrText` содержит «40 / 100», на cherk2p2 — «+0,24% за период до колла» (спаны идут встык: `…>40</span><span class="score__of">/ 100</span>`, `blocks.tsx:186-187`, `62-63`; замена тегов на "", как в U.12, дала бы «40/ 100»). Для TG.6-tg правило не переносится: в Telegram-HTML теги `b/i/code/a` пробелов не добавляют, там теги снимаются на "" и раскодируются сущности — иначе `<b>40</b>/ 100` прошёл бы как «40 / 100».
- **Снимок `fixtures/tg/ssr_golden.json`** пишется один раз в шаге 1, флагом `--record-tg-ssr`, с кода `d16c809`. Дальше его, как и фикстуры диалогов, меняет только оркестратор после разбора диффа — по правилам golden.

### Проверки, RED до правки (утверждают желаемое)

| Id | Вид | Утверждает | Почему RED сейчас | Шаг |
|---|---|---|---|---|
| TG.1 | static | И1. `apps/bot/src` есть. Граф импортов обходится так: от всех файлов `apps/bot/src` по относительным импортам и по спецификаторам `@so/present/*` в исходники `packages/present/src`. Спецификаторы внешних пакетов (`ai`, `grammy`, `zod`, `@so/engine/*`) проверяются только по имени и импортируемым именам; в `node_modules` и `packages/engine/src` обход не заходит (иначе `ai` через `@ai-sdk/provider-utils` даёт вечный RED). **Зона `apps/bot/src`:** разрешены `grammy` (только в `main.ts` и `telegram.ts`); из `ai` — `parseJsonEventStream`, `uiMessageChunkSchema`, `readUIMessageStream`, `generateId` и типы; `@so/present/*`; `@so/engine/contract` и `/format`; `zod`; `node:*`. **Зона `packages/present/src`:** разрешены `@so/engine/contract`, `/format`, `/config`, `zod` и относительные импорты; запрещены `ai`, `grammy`, `react*`, `node:*` (§3: «чистый TS без React, Node и `ai`»). `@so/engine/config` в графе допускается только как ребро `packages/present/src/* → @so/engine/config`. В обеих зонах запрещены: `apps/web/**`, `@/lib`, корень `@so/engine`, `@so/engine/inputs`, `@ai-sdk/*`, `@openrouter/*`, `streamText`, `generateText`, `convertToModelMessages`, `tool(`; имена `ANTHROPIC_`, `OPENROUTER_`, `TYPESAFE_`, `JEV_`, `LLM_`; хосты openrouter, anthropic, typesafe; идентификаторы `username`, `first_name`, `last_name` (любое вхождение `\b(username\|first_name\|last_name)\b` вне комментариев: точка, `?.`, деструктуризация, `["…"]`) во всех файлах графа, кроме `identity.ts`. В `identity.ts` допускается только чтение `me.username` в `sameBot` | нет `apps/bot/src` (после 1а в `apps/bot` есть только `package.json`) | 5 |
| TG.2 | static | В `apps/bot/src` нет кириллицы в строковых и шаблонных литералах вне комментариев: все тексты — из `@so/present/copy` | нет `apps/bot/src` (после 1а в `apps/bot` есть только `package.json`) | 5 |
| TG.3 | fixture | И2. 7 диалогов браузера дважды прогоняются через `route.POST`: как веб и как бот (id `tg_…`, `x-so-channel`, валидный ключ). Ответы (сборка `ai`, нормализация §4.5) побайтно равны. В `usage.jsonl` у записей `gate` и `answer` первого прогона `channel:"web"`, второго — `"telegram"` | поля `channel` в журнале нет | 4 |
| TG.4 | fixture | **И5.** Бот (`createCore` + фейковый Telegram + `fetch` → `route.POST`) на действиях 7 диалогов шлёт ровно 15 запросов. Для каждого k: N(тело бота k) ≡ N(тело браузера k). Заголовки — по §4.5 | нет `apps/bot/src/core.ts` | 5 |
| TG.5 | fixture | Состояние сервера после каждого диалога: у сессии бота `query`, `result.kind`, `result.report.inputs`, `pendingInputs`, `userMessages` равны значениям сессии, полученной повтором тел браузера | бота нет | 5 |
| TG.6 | unit | И3, сайт, в обе стороны. Входы: 16 golden expected, 3 live-фикстуры, ветки pick/notfound/err. **(а) VM ⊂ SSR:** каждая строка `vmStrings(...)` есть в `ssrText` (§6, «Как устроен»: теги заменены пробелами, пробелы схлопнуты, плюс значения `aria-label`) SSR `ReportView` compact (как в чате) и `ResultApp` (страница `/check`); без `aria-label` `barsCaption` «Доходность флоатера по сценариям ставок» (cherk1p7, `blocks.tsx:76` → `ui.tsx:60`) не нашёлся бы. **(б) SSR ⊂ VM:** SSR compact-рендера, как в чате (`ReportView compact showInputs={false} askPriceUnavailableNote=…`, `ToolUIs.tsx:35`; `PickView`/`NotFoundView`/`ErrView compact`), строится через `renderToStaticMarkup`. Фрагменты — части, на которые HTML режут теги; к каждой применяются раскодирование сущностей и схлопывание пробелов. Каждый непустой фрагмент и каждый `aria-label`, кроме баров, должен быть подстрокой хотя бы одной строки `vmStrings(vm)` либо литералом закрытого списка исключений; иначе RED, в detail — фрагмент. Подстрока, а не равенство: React режет фразы («73» и «/ 100»). `aria-label` у `[data-chart=yield-bars]` (`ui.tsx:60,62`, составной: `Доходность: Обещали 18%, На самом деле 9,62%, …`) сверяется по составу: он равен `${barsCaption}: ${bars.map(b => b.label + " " + b.value).join(", ")}` секции VM с `bars`; иначе RED, в detail — `aria-label` и остаток после вырезания `barsCaption`, `bars[].label` и `bars[].value` (длинные первыми). Закрытый список задан в самой проверке — только элементы управления, которых в Telegram нет: label, placeholder и кнопка «Посчитать» формы AskPrice; кнопки «Проверить» в pick; aria-hidden шапка таблицы pick («Выпуск и ISIN», «Рег. номер», «Торги»); aria-label «Найденные выпуски»; отключённая кнопка «Загрузить документ продавца»; CTA плашки «Войти и получить полный отчёт» (в Telegram её заменяет кнопка `BOT.fullReport`). Всё прочее, в том числе абзац AskPrice (`blocks.tsx:117-119`), «торгуется»/«не торгуется», «Без входа базовый отчёт доступен только в этой сессии.», «Проверка по документу продавца появится…», «/ 100», «−N», «Worst-case», «Product Truth Score», пункты worst и flags, должно быть в VM; исключить строку из VM может только оркестратор, явно внеся её в список. `ResultApp` добавляет к compact только шапку сайта, «Новая проверка», `[data-inputs]` и дисклеймер — это WEB, в (б) не входят. **(в) Чувствительность:** VM с удалённой строкой (без пункта worst или без «/ 100») даёт RED в (б); VM без одного элемента `bars[]` даёт RED в (б) | нет `@so/present/report` | 3 |
| TG.6-tg | unit | И3, Telegram, в обе стороны. На тех же входах: (а) каждая строка `vmStrings(...)` есть в выводе `renderTurn` — в тексте его сообщений (теги сняты на "", не на пробел, сущности раскодированы; `ssrText` здесь не применяется) или в подписях кнопок их `keyboard` (`inline_keyboard[][].text`); для баров требуется только наличие `barsCaption`, каждого `label` и `value`, формат строки баров в Telegram свободный; (б) текст сообщения `renderReport`/`renderBranch` (теги сняты на "", сущности раскодированы) вместе с подписями кнопок после вырезания `vmStrings` (длинные первыми) и значений `BOT` даёт остаток только из пробелов и знаков `: , · — / % + −` (без букв и цифр); иначе RED, в detail — остаток | нет `render.ts` | 5 |
| TG.7 | static | В `packages/blocks/src/{blocks,branches,ReportView,ui}.tsx` нет кириллицы в литералах и JSX-тексте вне комментариев. Кроме того: в `ui.tsx` нет `pct2`, `pctMax`, `cap1`, `scoreTone`, `liquidityTone` (переехали в VM и `@so/present/report`); в `blocks.tsx` `fmt`/`fmtMax`/`CONFIG` встречаются только внутри `InputsPanel` и `AskPrice`; в `branches.tsx` нет функций склонения; в `AskPrice` (`blocks.tsx`) цена проверяется через `ReportInputsSchema.shape.offer_price_pct` (`safeParse`), числовых литералов границ цены (0, 1, 300) в сравнениях нет (И4, §4.2). Числовые значения `r` для ширины баров и data-атрибутов валидатора остаются разрешены | сейчас там десятки литералов: заголовки карточек, подписи баров, тексты веток, категории ликвидности в `ui.tsx:20`; `blocks.tsx:62,154,186,202` форматируют числа сами; `blocks.tsx:110` — свои границы цены `n <= 0 \|\| n > 300` | 3 |
| TG.8 | unit | Ограничения Telegram на всех golden и фикстурах: `visibleLength` каждого сообщения ≤ 4096; HTML только из `b/i/code/a` и сбалансирован; shortname и query с `<b>&"` экранированы; `callback_data` ≤ 64 байт; кнопок ≤ 100 | нет `render.ts` | 5 |
| TG.9 | unit | Порядок. `renderTurn` сохраняет порядок `parts` во всех сообщениях ассистента из фикстур. В прогоне d1 первый ход даёт вызовы `sendMessage(WAIT_REPORT)` → `editMessageText` (тот же `message_id`, отчёт) → `sendMessage` (текст). Юнит-сценарий без `route` (MOCK текста перед инструментом не порождает, `model.ts:91-134`): фейковый `fetch` отдаёт рукописный SSE UI-потока, проходящий `uiMessageChunkSchema`: `start → start-step → text-start/text-delta("A") → tool-input-start/tool-input-available(resolve_security) → text-end → tool-output-available(report) → finish-step → start-step → text-start/delta("B")/text-end → finish-step → finish`. Ожидается `sendMessage("A")` → `sendMessage(WAIT_REPORT)` → `editMessageText` (тот же `message_id`, отчёт) → `sendMessage("B")`; «A» повторно не отправляется. Второй вариант — `text-end` до `tool-input-start` (как у провайдера Anthropic), ожидается та же последовательность | бота нет | 5 |
| TG.10 | unit | Вход. Для всех golden-отчётов `initialOf(decode(encode(chatParams)))` ≡ `initialOf(chatParams)`; payload ≤ 64 символов из `[A-Za-z0-9_-]`. У golden k и цена равны null, а promised целые, поэтому добавлены синтетические `EntryParams` (значения строками `String(v)`, как у `chatParams`), подаются прямо в `encodeStartPayload`: для k ∈ {0.07, 0.14, 0.29, 0.3, 1.1}, promised ∈ {15.5, 15.15, 18.55}, price ∈ {98.55, 98.75, 100}, pos ∈ {1000, 1e10} — `encode ≠ null`, `initialOf(decode(encode(p)))` ≡ `initialOf(p)`, payload ≤ 64; отрицательные — `encode → null` при k 0.035 и 0.075, promised 15.155 и 18.555; вектор длины — q из 20 символов, все четыре части, pos 1e10 → payload ≤ 64 из `[A-Za-z0-9_-]`. `live_rolf_p26` — для покрытия k и pos. `pickMessage` (кандидат 0 из d2) ≡ вторая реплика d2 «Проверь RU000A1094F2». `firstText(initialOf(ссылка d6))` ≡ реплика d6 | нет `@so/present/entry` | 2 |
| TG.11 | fixture | Ключ. `route.POST` отвечает 403 на: (a) id `tg_x` без заголовков; (b) `x-so-channel: telegram` без ключа; (c) неверный ключ той же длины; (d) ключ без `tg_`-id. При этом `userMessages` = 0 и `budget.messages` не меняется. (e) Всё верно → 200; (f) тело браузера → 200 и `channel: web`. Пустой ключ (окружение переключается внутри дочернего процесса сценария — §4.3 требует читать `SO_BOT_KEY` при каждом вызове): (g) `delete process.env.SO_BOT_KEY`; запрос с id `tg_x`, `x-so-channel: telegram`, `x-so-bot-key: ""` → 403; (h) `SO_BOT_KEY=""`: тот же запрос → 403, и запрос с прежним тестовым ключом бота → 403 (выключатель §7); (i) ключ сервера непуст, заголовок `x-so-bot-key: ""` → 403. Во всех случаях `userMessages` = 0 и `budget.messages` без изменений. После (g)/(h) вернуть тестовое значение и повторить (e) → 200 | (a) сейчас 200 | 4 |
| TG.12 | fixture | Тексты отказа для Telegram. При `SO_MESSAGE_LIMIT=2` третий ход бота получает `limitText("telegram")`: есть `/new`, нет «Обновите страницу». Бюджет исчерпан → `budgetExhaustedText("telegram")`: нет «откройте главную страницу» | сервер отдаёт только веб-тексты | 4 |
| TG.13 | fixture | И4. `contract` экспортирует `ReportInputsSchema`; `tools.inputsSchema` — тот же объект. Таблица значений (NaN, pos 999, k 3,5, promised 101, price 0, 0,5 и 301, плюс валидные) одинаково отклоняется и принимается в `/api/report` (GET и POST), `body.inputs` `/api/chat`, `initialOf`, `decodeStartPayload`. В `check/page.tsx` нет своего `num()` без схемы. Границы цены в `AskPrice` (`blocks.tsx`, файл P2) проверяет TG.7 | схемы в `contract` нет | 2 |
| TG.14 | static+fixture+unit | «Главные red flags» гейта = `truth_score.top3`. (а) static: в `gate.ts` нет `.sort(`/`.toSorted(` по `points`, и есть обращение к `truth_score.top3`. (б) fixture, защита от регрессии: на 10 golden-отчётах, где текст гейта доходит до списка флагов (cherk1p7, cherk2p1, cherk2p2, ofz26238, ofz26243-name, perpetual, pkb-amort, rolf, structured, veb), фраза «Главные red flags: …» есть, и названия в ней ≡ названиям top3 по порядку. У no_price/not_traded/no_coupon_rate (cherk1p6, not_traded, cherk2p6; ранний return `gate.ts:115-117`) этой фразы нет, ветки pick/notfound в проверку не входят. (в) unit, различающая часть: экспортируемая из `gate.ts` чистая функция текста отчёта (`reportText` или `topFlagsText(r)`) на копии golden-отчёта veb с вручную переставленным `truth_score.top3` ([5,12,4]) даёт «…: <title 5>, <title 12>, <title 4>.». Через `runGate` синтетику не подать: `applyInputs` пересчитывает top3 (`inputs.ts:181-186`). Алгоритм `gate.ts:118` совпадает с движком, поэтому (б) одна ничего не различает | (а) и (в): `gate.ts:118` сортирует флаги сам, нужной экспортируемой функции нет | 4 |
| TG.15 | static | Нейтральные слова. В `SYSTEM_PROMPT` нет «справа», «слева», «ниже» (строго по слову, через `includes`). В telegram-текстах `copy` нет «справа», «ниже», «обновите страницу». Если проверку пишут регуляркой, границы слова задаются для кириллицы: `/(?<![а-яё])(справа\|слева\|ниже)(?![а-яё])/i`, а не через `\b` (в JS `\b` с кириллицей не работает) | `prompt.ts:11` (позиционные «ниже», «справа») и `prompt.ts:20` («ниже» в смысле «меньше», правило 10) | 4 |
| TG.16 | unit | Очередь. Повторный `update_id` → один POST. Два сообщения одного чата обрабатываются последовательно, разные чаты — параллельно. 6 чатов при concurrency 4 → в полёте не больше 4. Третье ожидающее сообщение чата → `BOT.busy` без POST. Кнопка во время хода → `answerCallbackQuery(busy)` без POST. Если job бросил исключение, `run` не отклоняется, и следующий `run` с тем же ключом выполняется | бота нет | 5 |
| TG.17 | unit | Повтор только при ECONNREFUSED. Два отказа ECONNREFUSED, потом ответ → 3 POST, ответ доставлен. ECONNREFUSED всегда → 4 POST, `BOT.serviceRestarting`, реплики в истории нет. HTTP 500, обрыв потока, таймаут → ровно 1 POST и `BOT.turnFailed` | бота нет | 5 |
| TG.18 | unit | Сбои Telegram. 429 с `retry_after: 3` → пауза 3000 мс и повтор. 400 «can't parse entities» → тот же текст без HTML. Ошибка с токеном в тексте → в журнале `<redacted>`. Ошибки доставки (§4.4): фейковый `TgClient` бросает 403 «bot was blocked by the user» на `sendMessage`; 400 «message to edit not found» на `editMessageText`; `HttpError` на `sendMessage`; 429 четыре раза подряд. В каждом кейсе: `await core.handleUpdate(u)` разрешается; нет `unhandledRejection` (харнес вешает `process.on('unhandledRejection')` на время кейса); `idle()` завершается; следующий апдейт того же чата даёт ровно 1 POST, и тело содержит ассистентское сообщение прошлого хода; в журнале есть `ev:"tg_error"`; при «message to edit not found» отчёт доставлен новым `sendMessage` | бота нет | 5 |
| TG.19 | unit | Доступ и лимиты. `allow ""` → никого; `"*"` → всех; список → только перечисленных, остальным отказ с кодом доступа. При `dailyTurns=2` третий ход за сутки МСК → `BOT.dailyLimit` без POST, в следующие сутки ходы снова идут. `group` и `supergroup` → игнор. Фото, голос, документ → `BOT.onlyText` без POST | бота нет | 5 |
| TG.20 | fixture | Приватность. Прогон TG.4 с журналами. Тестовые апдейты собираются в форме сырого апдейта Telegram, а не по урезанному `TgUpdate` (структурный тип харнеса допускает лишние поля, или объект передаётся в `handleUpdate` через переменную): в `message.from`, `message.chat`, `callback_query.from` и `callback_query.message.chat` есть `username`, `first_name`, `last_name` со значениями-маркерами (`zz_user_marker`, `Zzfirstmarker`, `Zzlastmarker`); как в настоящем private-чате, `chat.id` = `from.id`; диалогу k дан длинный отличимый id (`7000000100 + k`). В строках журнала бота и в `usage.jsonl` нет chat_id и user_id (ищутся как отдельное число, `(?<![0-9])<id>(?![0-9])`), маркеров имён (подстрокой), токена, `SO_BOT_KEY` и соли; хотя бы раз харнес убеждается, что поиск находит маркер в строке, куда он подставлен намеренно. В `usage.jsonl` нет `pseudonymOf(chatId, salt)` ни одного тестового чата. В журнале бота нет текстов реплик, в записях хода нет `pseudo`. Поле `chat` в `usage.jsonl` у бота начинается с `tg_` | бота нет | 5 |
| TG.21 | unit | Сессия. `session.ts` берёт TTL из `SESSION_TTL_MS`. История бота живёт `SESSION_TTL_MS − BOT_TTL_MARGIN_MS` (> 0). id имеет формат `tg_<12>` (`/^tg_[A-Za-z0-9_-]{12}$/`). `/new` и новый экземпляр ядра с той же солью дают другой id; две сессии одного chat_id не имеют общей части, кроме `tg_`: не содержат `pseudonymOf(chatId, salt)`, общая подстрока длиной ≥ 4 — RED. После TTL — новый id, пустая история, `BOT.sessionExpired` | бота нет; TTL — литерал в `session.ts:21` | 2+5 |
| TG.22 | static | Версии. В `apps/bot`: `"ai": "7.0.133"` (как в `apps/web`) и `"grammy": "1.46.0"` — точные. `node_modules/ai` — одна копия. В зависимостях бота нет `@ai-sdk/*` и `@openrouter/*` | нет `apps/bot/package.json` | 1а |
| TG.23 | static+unit | Эксплуатация (§7). В `setup.sh` — юнит `second-opinion-bot` (unquoted heredoc с `$APP_USER`/`$APP_DIR`, как юнит веба) с полями харденинга, `ConditionPathExists=` на `apps/bot/package.json`, `ReadWritePaths=` без префикса «-», и `Wants=` без `Requires=`; строка sudoers для него; создание `apps/bot/.state` в `setup.sh`. В `deploy.sh` порядок: стоп бота < `npm ci` < `web:build` < рестарт веба < `/api/health` < создание `apps/bot/.state` < старт бота < проверка heartbeat; `deploy.sh` пишет `VERSION`. Локальный `/api/health` отдаёт `version`, внешний — только `{ok}`; unit — в дочернем процессе, как остальные сценарии (§6, «Как устроен»): `--scenario health-version`, cwd = `apps/web`, общее окружение сценариев (в т. ч. `JEV_ENABLED=0`, внешний `fetch` бросает), `SO_APP_DIR` = временный каталог с `VERSION`=A; импортировать `app/api/health/route`, переписать файл на B, `GET(new Request("http://127.0.0.1:3000/api/health"))` → `version === "A"`, `GET()` без запроса → только `{ok}`; второй дочерний процесс с пустым временным каталогом → `version === "dev"`. Импорт health в процессе харнеса запрещён: при полном прогоне модуль уже закэширован проверками H.7-health (`wp-h.ts:507`) и U.14 (`wp-u-ui.ts:372`) с VERSION, прочитанной без `SO_APP_DIR` харнеса (`harness.ts:18`: TG идёт после H и U). Допустимая альтернатива в том же процессе — новый экземпляр модуля: `import(pathToFileURL(<abs>/app/api/health/route.ts).href + "?tg23=" + Date.now())` под `withEnv({ ...SERVER_ENV(), SO_APP_DIR: tmp, JEV_ENABLED: "0" })` и `withFetch(noNetwork)`. Heartbeat старше 120 с → `exit(1)`. `loadConfig` принимает `TG_API_ROOT=http://127.0.0.1:8081`; отклоняет `https://evil.example`, `http://10.0.0.1:1`, `http://user@127.0.0.1:1` и адреса без явного порта `http://127.0.0.1`, `http://localhost`; при `NODE_ENV=production` с `TG_API_ROOT` бросает ошибку; текст ошибки не содержит токена. `makeLogger` для `{ev:"getMe ok",version:"abc1234"}` даёт строку, которую находит тот же шаблон, что в `deploy.sh` | ничего из этого нет | 4+5+6 |

### Guard-проверки (GREEN уже сейчас, должны остаться GREEN)

| Id | Вид | Держит |
|---|---|---|
| TG.G1 | fixture | **Тексты веба при `channel=web` не меняются.** Запрос без канала получает текст лимита ≡ «В этой сессии лимит 2 сообщений исчерпан. Обновите страницу, чтобы начать новую проверку.», а текст бюджета ≡ `BUDGET_EXHAUSTED_TEXT` на 14.10. Литералы заморожены в проверке |
| TG.G2 | fixture | **Эталон воспроизводим.** Все 15 тел браузера получают 200. Ответ на запрос k, собранный `ai`, ≡ N(сообщение ассистента в теле k+1) — таких пар 8. Префикс истории тела k+1 ≡ телу k. Этим эталонный сборщик привязан к настоящему браузеру. Ожидается GREEN: запись сделана с этого же кода. Если при написании харнеса проверка красная — расхождение разбирается до шага 5. Красная в будущем означает, что намеренная правка текстов гейта или MOCK-модели устарила фикстуры: перезапись только по решению оркестратора |
| TG.G3 | static | **Канал не попадает в решения.** (а) В `gate.ts`, `jev.ts`, `tools.ts`, `digest.ts`, `prompt.ts`, `glossary.ts`, `engine.ts`, `session.ts`, `model.ts` нет `channel`, `telegram`, `x-so-channel`, `x-so-bot-key`. (б) `apps/web/app/api/chat/route.ts` (там выбираются промпт, инструменты и модель, `route.ts:85-90`): из текста без комментариев удаляются разрешённые фрагменты — импорт `import { channelOf } from "@/lib/channel";` (§4.3; вырезается ровно один раз регэкспом без привязки к форматированию: `/^\s*import\s*\{\s*channelOf\s*\}\s*from\s*["']@\/lib\/channel["']\s*;?\s*$/m`); `const ch = channelOf(req, <id>)`; `if (!ch.ok) return new Response(null, { status: 403 })`; `channel: ch.channel` внутри объектов-аргументов `log({...})`; `limitText(ch.channel, MESSAGE_LIMIT)`; `budgetExhaustedText(ch.channel)`. В остатке нет `\bch\b`, `channel` (подстрокой, через `includes`, а не `\bchannel\b`: так RED остаётся любой лишний вызов `channelOf(...)`, кроме разрешённого), `telegram`, `tg_`, `x-so-channel`, `x-so-bot-key`; `req.headers.get` — только с `"x-so-chat"`. Так запрещены и алиасы вида `const c = ch.channel`, ветвления `if`/`?:` по каналу и обход через `id.startsWith("tg_")`. (в) В аргументах `streamText(`, `makeTools(`, `runGate(`, `chatModel(`, `convertToModelMessages(`, `callProviderOptions(` нет `ch`/`channel`. На `d16c809` (б) и (в) тривиально GREEN |
| TG.G4 | unit | **Компаратор паритета чувствителен.** Вход мутанта — пара (заголовки, тело). 12 мутантов дают «не равно»: (1) HTML вместо текста ассистента; (2) «Проверить» вместо «Проверь»; (3) снят `inputs` в d6; (4) снят `metadata.custom`; (5) лишнее поле `channel` в теле; (6) пропущено сообщение; (7) у бота нет заголовка `x-so-chat`; (8) у бота лишний заголовок `x-so-foo` сверх `x-so-channel` и `x-so-bot-key`; (9) из `parts` ответа ассистента удалён `step-start`; (10) у `tool-*` `state: "input-available"` вместо `"output-available"`; (11) `trigger: "regenerate-message"`; (12) у сообщения пользователя нет ключа `id` (нормализация подменяет значение, а не удаляет ключ; то же для `toolCallId`). Тождественная копия даёт «равно». От кода продукта не зависит |
| TG.G5 | fixture | **SSR 16 golden неизменен.** `ssrText` (§6, «Как устроен»: теги заменены пробелами, пробелы схлопнуты, плюс `aria-label`) для `ReportView` compact (чат), `ResultApp` (страница `/check`) и веток ≡ снимку `fixtures/tg/ssr_golden.json`. Держит шаг 3 |
| TG.G6 | fixture | **Пределы сервера пропускают историю.** 15 тел браузера и синтетическая история из 20 сообщений с 10 реальными отчётами (golden через `build`/`applyInputs`, ≈ 65–70 тыс. символов, ≈ 85–90 КБ UTF-8) не получают 400/413. Синтетика задаётся числом отчётов (10 штук из golden), а не килобайтами. Держит будущие правки H.5 и S.2: предел S.2 считается по текстовым частям, а не по JSON tool-выходов. Один отчёт (tool-выход `{query,result}`) ≈ 5,4–6,9 тыс. символов (≈ 7–9 КБ UTF-8), больше всего весят flags; план S.2 — 20 000 символов |

Итого 24 RED до шага 1а (23 RED после: TG.22 зеленеет на 1а) и 6 guard. После правки в веб-харнесе 95 проверок.

## 7. Эксплуатация на heidi

Юнит пишет `setup.sh` в unquoted heredoc, как юнит веба (`setup.sh:113-134`), поэтому `$APP_USER` и `$APP_DIR` подставляются (`setup.sh:13,19-20`); root-шаг выполняет владелец один раз.

```
[Unit]
Description=Second opinion Telegram bot
After=network-online.target second-opinion.service
Wants=network-online.target second-opinion.service
ConditionPathExists=$APP_DIR/apps/bot/package.json
[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/apps/bot
EnvironmentFile=$APP_DIR/apps/bot/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
MemoryMax=512M
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=$APP_DIR/apps/bot/.state
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
```

- **Без `Requires=`:** рестарт веба не убивает бота, бот переживает ECONNREFUSED повтором.
- **`ConditionPathExists=`:** после отката на коммит без `apps/bot` юнит при рестарте или перезагрузке пропускается, а не крутится в `Restart=always`.
- **Каталог `.state`.** systemd не стартует сервис, если путь из `ReadWritePaths=` без префикса «-» не существует (226/NAMESPACE), а `.state` в `.gitignore`, и checkout его не создаёт. Поэтому:
  - `setup.sh:110`: `sudo mkdir -p "$APP_DIR/apps/web/.usage" "$APP_DIR/apps/bot/.state" && sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"` — каталог переживёт `checkout -f`, неотслеживаемые каталоги тот не удаляет;
  - `deploy.sh`, п. 7 — до старта бота.
  
  Префикс «-» не годится: он лишь скрыл бы ошибку — при `ProtectSystem=strict` путь остался бы только на чтение, heartbeat не писался бы, и сторож через 120 с перезапускал бы бот бесконечно.
- **sudoers** (`setup.sh:139`): добавить `restart|start|stop|status second-opinion-bot`.
- **Порядок в `deploy.sh`:**
  1. `systemctl stop second-opinion-bot`, если юнит есть;
  2. checkout; `git rev-parse --short` → `$APP_DIR/VERSION`;
  3. `npm ci`;
  4. `web:build`;
  5. рестарт `second-opinion`, проверка `is-active`;
  6. `curl 127.0.0.1:3000/api/health` — `version` должен совпасть с `VERSION`. Сверка ловит только процесс, запущенный до записи VERSION: незаменённый рестартом или «осиротевший» на порту (health читает VERSION один раз при старте, §4.3);
  7. если есть `apps/bot/.env` и `SO_TG≠0`: `install -d -m 700 "$APP_DIR/apps/bot/.state"` (скрипт идёт от ez, владельца `APP_DIR`, sudo не нужен), `start second-opinion-bot`, затем ждать до 70 с, пока heartbeat станет новее старта, и найти в журнале строку `getMe ok version=<sha>` (формат строки — `makeLogger`, §4.4).
- **Heartbeat** — файл `apps/bot/.state/heartbeat`, обновляется после каждого `getUpdates` (таймаут опроса 50 с, `bot.start({ timeout: 50 })`, §4.4). Отметка старше 120 с → бот сам делает `exit(1)`, systemd поднимает его. Принцип: «active» ≠ «работает».
- **Выключатели:**
  - `SO_TG=0` в `apps/bot/.env`, затем `sudo systemctl restart second-opinion-bot`: бот не опрашивает Telegram, heartbeat пишет;
  - `systemctl stop second-opinion-bot`;
  - пустой `SO_BOT_KEY` в `apps/web/.env`, затем `sudo systemctl restart second-opinion` (Next читает `.env` только при старте). После этого сервер отвечает 403 на все tg-запросы.
- **Откат:**
  - на версию WP-TG (бот уже есть): `release.sh` с нужной ветки, новый `deploy.sh` сам останавливает и запускает бота;
  - на версию до WP-TG: сначала `ssh heidi sudo systemctl stop second-opinion-bot` (разрешено sudoers), иначе живой процесс продолжит ходить в старый сервер без проверки ключа; потом `release.sh`. Checkout удалит код бота, старый `deploy.sh` про бота не знает. Юнит после этого пропускается по `ConditionPathExists=`; отключить его (`systemctl disable second-opinion-bot`) — root-шаг владельца, либо добавить `disable|enable second-opinion-bot` в строку sudoers (`setup.sh:139`) и в TG.23.
- **Логи:** `journalctl -u second-opinion-bot` — только `LogRec`.
- **Секреты.**
  - `apps/bot/.env` (chmod 600): `TG_BOT_TOKEN`, `TG_BOT_USERNAME`, `SO_TG_SALT`, `SO_BOT_KEY`, `SO_TG_ALLOW`, `SO_TG_DAILY`, `SO_TG_CONCURRENCY`, `SO_SITE_URL`. Переменной `TG_API_ROOT` в прод-`.env` нет (она только для e2e; `loadConfig` при `NODE_ENV=production` с ней падает).
  - В `apps/web/.env` добавляется только `SO_BOT_KEY`. Токен бота туда не кладётся.
- **Тестовый бот** — только на Mac, против MOCK, со своим токеном. Два опросчика с одним токеном получают 409.
- **Доступ heidi → `api.telegram.org`** владелец проверяет до шага 5. При блокировке — прокси только для клиента grammY: `new Bot(token, { client: { baseFetchConfig: { agent: new HttpsProxyAgent(process.env.HTTPS_PROXY) } } })` (grammY на Node ходит через node-fetch v2, `out/shim.node.js:6-7`, он учитывает `agent`) либо `client.fetch` — обёртка над fetch с `dispatcher: new ProxyAgent(...)` на каждый запрос. НЕ через `setGlobalDispatcher`, как в `iss/client.ts:19-30`: так через прокси пойдёт и POST бота на 127.0.0.1:3000. Это отдельное решение.

## 8. Приватность

- **Где живёт сырой chat_id и user_id.** Только в памяти бота, в записи разговора, пока она жива: не дольше 55 мин простоя, плюс вытеснение LRU. На диск бот не пишет ничего, кроме времени heartbeat.
- **Что уходит на сервер.** Сессия `tg_<12 случайных символов>` (`base64url(random(9))`), без псевдонима: иначе по коду доступа из allowlist можно было бы связать все записи `usage.jsonl` одного человека за все сессии (80 символов каждой реплики и 500 символов каждого ответа с его суммами и комиссией). Псевдоним — HMAC-SHA256(`SO_TG_SALT`, chat_id), 12 символов; соль есть только у бота, сервер псевдоним не получает.
- **Чего бот не читает.** username, имя и фамилия собеседника (`from`/`chat`), кроме собственного username бота из getMe, который сверяется в `identity.ts`; TG.1 проверяет это статикой.
- **Журналы.**
  - Бот пишет только `LogRec`: без текстов, id и токена. `pseudo` — только в событиях отказа (`notAllowed`, `dailyLimit`), в записях хода его нет, чтобы связка не восстанавливалась по времени через journalctl.
  - Сервер пишет как для веба (80 символов реплики, 500 символов ответа) плюс `channel`.
- **Allowlist хранит псевдонимы, а не id.** Тому, кого нет в списке, бот отвечает кодом доступа (псевдонимом). Владелец вносит код в `SO_TG_ALLOW`. Код доступа — постоянный идентификатор человека; сервер его не получает.
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
| Telegram выедает общий бюджет; при исчерпании бот не может даже бесплатной проверки | лимиты бота (§9); решение владельца о бюджете; `/check` в боте — следующий шаг |
| Рестарт Next посреди хода | ECONNREFUSED → повтор. Обрыв потока → «не получилось» без повтора: ход не идемпотентен (бюджет, `session.result`). Серверная сессия теряется — как у веба |
| Память: полные отчёты (~6–7 тыс. символов, ≈ 9 КБ JSON) в истории до 300 разговоров | `MemoryMax=512M`, LRU; вытеснение = новый разговор с уведомлением |
| Обработчик только ставит ход в очередь, поэтому апдейт подтверждается до конца хода | падение посреди хода теряет этот ход — осознанно: лучше потерять ход, чем дважды списать |
| Два опросчика одного токена (409) | отдельный тестовый бот; сверка `getMe` с `TG_BOT_USERNAME` |
| heidi не достаёт до `api.telegram.org` | проверка владельцем до шага 5; при блокировке — `HTTPS_PROXY` |
| HTML-инъекция через shortname или запрос | экранирование (TG.8), откат на простой текст (TG.18) |
| «active», но не работает (повис опрос) | heartbeat, watchdog, проверка в `deploy.sh` (TG.23) |
| Подделка канала извне через Caddy | ключ и 403 (TG.11) |
| Будущие H.5 и S.2 режут историю с отчётами | TG.G6; решение: S.2 считает текстовые части |
| Паритет доказан на MOCK/OFFLINE без Jev, а живые модель и Jev недетерминированы | вход одинаков, и исполняет его один процесс — расходиться нечему. «Вход модели одинаков» держит статическая часть TG.G3 по `route.ts`, а не TG.3: MOCK-модель системный промпт не читает (`model.ts:91-134`) |
| Сборка `ai` в боте и assistant-ui в браузере расходятся в мелочах формы (`metadata.custom`, `state`) | TG.4 против реальных тел; `toWire` фиксирует форму браузера |
| Оценка ядра бота | самые рискованные часы; запас +30 % (§12) |

## 11. Решения и действия владельца

**Решения:**
1. Утвердить план: архитектура «Один мозг, два клиента», grammY 1.46.0, long polling, отдельный юнит.
2. Значение `SO_DAILY_BUDGET_USD` к публичному запуску (сейчас 0 = без лимита) и возвращать ли `SO_MESSAGE_LIMIT=20`.
3. Лимиты бота: `SO_TG_DAILY` (предлагается 60) и `SO_TG_CONCURRENCY` (4).
4. Состав пилота (коды доступа), срок (неделя) и критерии перехода к публичному запуску.
5. Текст уведомления о приватности в `/start`; срок хранения `usage.jsonl` (предлагается 30 дней); локализация ПДн — с юристом.
6. Имя, @username, описание и аватар бота.
7. Изменения, видимые пользователю:
   - формулировки промпта: `prompt.ts:11` и `prompt.ts:20` (правило 10, «ниже» → «меньше», смысл не меняется);
   - тексты лимита и бюджета для Telegram;
   - `/check` игнорирует невалидные параметры по общей схеме;
   - форма цены предложения на `/check` отклоняет цену < 1 % номинала (раньше 0 < p < 1 давало отчёт).
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
   - тот же `SO_BOT_KEY` — в `apps/web/.env`;
   - тестовый токен — только в локальный `apps/bot/.env`.
4. **Root-шаг:** `scp deploy/heidi/setup.sh heidi:setup.sh && ssh -t heidi bash setup.sh`.
5. **Смоук на тестовом боте** (Mac, MOCK, `npm run -w @so/bot dev` — читает `apps/bot/.env`): 7 диалогов эталона, `/new`, 21-е сообщение, выбор выпуска кнопкой, deep-link. Чеклист будет в отчёте шага 7.
6. **«Катить» и пилот:** получить свой код доступа от бота, внести коды пилота в `SO_TG_ALLOW`.
7. **Через неделю** — решение о публичном запуске. До него `SO_DAILY_BUDGET_USD > 0`.

## 12. Оценка

Единица — часы работы агентов. Калибровка: WP-U (18 проблем, 4 пакета, ревью) занял ≈ 7 ч. Здесь 24 RED-проверки, новое приложение и новый пакет — примерно в 2,4 раза больше.

| Что | Агент-часы |
|---|---|
| Шаг 1. Харнес WP-TG | 3,5 |
| Шаг 1а. Зависимости и lock (оркестратор) | 0,25 |
| P1. `@so/present` (protocol/entry/copy) и одна схема | 1,5 |
| P2. VM отчёта и перевод блоков | 2,5 |
| P3. Сервер: ключ, канал, тексты, промпт, top3, версия, H.7 | 1,5 |
| P4. Ядро бота и рендер | 5 |
| P5. E2E и эксплуатация | 1,5 |
| Сведение и приёмка | 1 |
| **Итого** | **≈ 16,75 ч**, с запасом +30 % — до 22 ч. Критический путь ≈ 12,75 ч |

Отдельно от агентов:
- **Владелец:** ≈ 1–1,5 ч действий руками (§11) и 5–10 мин на каждое «катить».
- **Пилот:** календарная неделя по allowlist; разбор журнала по каналу `telegram` и смоук в живом Telegram.

## 13. Приёмка

1. `npm run -s -w @so/web audit -- --baseline` → exit 0.
   - Все TG.* GREEN.
   - Ни одна проверка, бывшая GREEN, не покраснела.
   - H.7 и R.7-web GREEN; прочие перевороты вверх перечислены.
2. `npm run -s -w @so/engine audit -- --baseline` → exit 0. Движок: меняется только `contract.ts` (P1, перенос `ReportInputsSchema`); аудит движка также рендерит и разбирает `packages/blocks/src/blocks.tsx`: G.2 — `Claim` (`wp-g.ts:171,181`), G.7 — `FlagsScore` (`wp-g.ts:321,333`), поэтому он обязателен после P2.
3. `npm run -s selftest`; typecheck `@so/web`, `@so/blocks`, `@so/present`, `@so/bot`, `@so/static`; `npm run -s pages` (SSG и esbuild-бандл `client.tsx`, который после P2 тянет `@so/present`); `npm run -s validate`, если есть Chromium (иначе в отчёте «не прогнан», как `e2e:chat` в п. 4); `npm run -s golden:diff` пуст.
4. `npm run e2e:bot` и `npm run e2e:chat` против MOCK. Если Playwright-браузер не скачан, `e2e:chat` отмечается в отчёте как не прогнанный; решающими остаются TG.4 и TG.G5.
5. После выкатки:
   - на heidi `second-opinion-bot` в состоянии active, heartbeat моложе 60 с;
   - строка `getMe ok version=<sha>` равна `version` локального `/api/health` (сверка ловит только процесс, запущенный до записи VERSION: незаменённый рестартом или «осиротевший» на порту);
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
