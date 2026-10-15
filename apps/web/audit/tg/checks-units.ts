/**
 * WP-TG, группа «units» (docs/PLAN_telegram_bot_2026-10-14.md §4.1, §4.4, §4.6, §4.7, §6): TG.8, TG.10, TG.16, TG.17, TG.18, TG.19.
 * Все шесть — RED до правки и утверждают желаемое поведение; guard-проверок в группе нет.
 *
 * Юниты бота и входа. Сервер (route) им не нужен, поэтому дочерних процессов нет: ядро бота (`createCore`) работает в процессе
 * харнеса с фейковым Telegram (`FakeTg`) и фейковым сервером — `fetch`, который отдаёт рукописный SSE UI-потока (`sseResponse`)
 * и умеет держать запросы («в полёте»), отказывать с ECONNREFUSED/ECONNRESET, отвечать 500, обрывать поток и зависать
 * (с учётом `init.signal`). Паузы (`sleep` в CoreDeps и в `withTelegramPolicy`) внедряются и записываются: 2/8/20 с повтора и
 * 3 с 429 реально не ждутся (длинные ≥ 60 с — по-настоящему, это таймаут хода). Часы суток МСК (DailyLimit) тоже внедрены.
 *
 * Модулей ещё нет (`apps/bot/src/*` — шаг 5, `@so/present/{entry,copy}` — шаг 2): грузятся только `tryImport` по вычисляемому пути,
 * нет модуля → RED с detail «нет модуля …; ожидаемо до шага N». Статических импортов несуществующих модулей нет; сигнатуры — из
 * структурных типов types.ts. Исключение внутри кода бота → RED с текстом исключения (не ERROR).
 *
 * Каждая проверка идёт под защитой процесса харнеса (guard.ts, guardRun): unhandledRejection и исключения из таймеров/слушателей
 * кода бота, обращения к глобальному fetch (мимо внедрённого, §4.4) и process.exit записываются ✗-пунктами этой проверки, а не
 * роняют весь прогон; поздние события (таймер сработал после проверки) — ✗-пунктом следующей проверки под защитой и в stderr.
 * Синхронный бесконечный цикл в коде бота в процессе не ловится (таймаута у проверок харнеса нет).
 *
 * `makeUnitChecks(loaders)` — те же проверки с другими загрузчиками модулей (самопроверка на эталонных и испорченных модулях);
 * в харнесе `checks = makeUnitChecks()` (модули из репозитория).
 */
import { createHmac } from "node:crypto";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { fail, pass, type Check, type Verdict } from "../lib";
import { guardRun, withGuard, type GuardWindow } from "./guard";
import { entryParamsOf, lastUserText, loadDialog, loadDialogs, UpdateFactory, type RawUpdate } from "./actions";
import { FakeHttpError, FakeTg, tgError, type TgCall, type TgFakeError } from "./fake-tg";
import { brief, canonical, collapseWs, decodeEntities, diff, sseResponse, tgPlain } from "./normalize";
import { ssrInputs } from "./record-ssr";
import { TG_TEST, testBotConfig, testRandom } from "./scenarios";
import {
  loadAll, loadBot, loadPresent,
  type BotConfig, type BotCore, type BotMods, type BuildResultT, type ChatBody, type ChatInitial, type CoreMod,
  type EntryMod, type EntryParams, type InlineKeyboard, type Loaded, type LogMod, type LogRec, type PresentMods,
  type QueueMod, type ReportInputs, type TelegramMod, type TgClient, type TgOp, type TgUpdate, type UIMessage, type WireMessage,
} from "./types";

/* ═══════════════════════════ загрузчики (подменяются в самопроверке) ═══════════════════════════ */

export interface UnitLoaders {
  bot<K extends keyof BotMods>(name: K): Promise<Loaded<BotMods[K]>>;
  present<K extends keyof PresentMods>(name: K): Promise<Loaded<PresentMods[K]>>;
}
export const REPO_LOADERS: UnitLoaders = {
  bot: <K extends keyof BotMods>(name: K) => loadBot(name),
  present: <K extends keyof PresentMods>(name: K) => loadPresent(name),
};

/* ═══════════════════════════ мелочи ═══════════════════════════ */

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n = 160) => { const t = oneLine(s); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const errText = (e: unknown) => cut(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 300);
const q = (s: string | null | undefined, n = 90) => (s == null ? "—" : `«${cut(s, n)}»`);
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

/** Ждать условия (опрос раз в 2 мс), не дольше ms; true — дождались */
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await tick(2);
  }
  return true;
}
type Within<T> = { ok: true; v: T } | { ok: false; timeout: boolean; err?: string };
/** Промис с таймаутом: разрешился / отклонился (err) / не уложился (timeout) */
async function within<T>(p: Promise<T>, ms: number): Promise<Within<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then((v): Within<T> => ({ ok: true, v }), (e: unknown): Within<T> => ({ ok: false, timeout: false, err: errText(e) })),
      new Promise<Within<T>>((r) => { timer = setTimeout(() => r({ ok: false, timeout: true }), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const whyNot = (w: { timeout: boolean; err?: string }, ms: number) => (w.timeout ? `не завершился за ${ms} мс` : `отклонён: ${w.err}`);

interface Deferred { p: Promise<void>; resolve(): void }
const deferred = (): Deferred => { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; };

/** Подпроверка: имя, итог, пояснение (что ожидалось / что получено) */
interface Sub { name: string; ok: boolean; text: string }
const sub = (name: string, ok: boolean, text: string): Sub => ({ name, ok, text });
/** Итог проверки: сначала проваленные подпроверки (✗ с пояснением), затем прошедшие (✓) */
function verdict(subs: Sub[], tail = ""): Verdict {
  const bad = subs.filter((s) => !s.ok);
  const good = subs.filter((s) => s.ok);
  const lines = [...bad.map((s) => `✗ ${s.name}: ${s.text}`), ...good.map((s) => `✓ ${s.name}${s.text ? ` (${s.text})` : ""}`)];
  const head = bad.length ? `не выполнено ${bad.length} из ${subs.length}: ` : `все ${subs.length} подпроверок: `;
  return bad.length ? fail(head + lines.join(" | ") + tail) : pass(head + lines.join(" | ") + tail);
}
/**
 * Проверка id под защитой процесса харнеса (guard.ts: unhandledRejection, исключения из таймеров, глобальный fetch и process.exit
 * из кода бота записываются, процесс не падает) + исключение в коде бота → RED с текстом (не ERROR): харнес здесь ни при чём.
 * Проверки с подпроверками (TG.16–TG.19) сами забирают проблемы окна через w.settle() — пунктами в своём списке; что пришло
 * позже, withGuard добавит ✗ впереди detail.
 */
async function guarded(id: string, fn: (w: GuardWindow) => Promise<Verdict>): Promise<Verdict> {
  const g = await guardRun(id, fn);
  const v = g.ok ? g.v
    : fail(`исключение в коде бота или входа: ${errText(g.error)}${g.error instanceof Error && g.error.stack ? ` @ ${cut(g.error.stack.split("\n").slice(1, 3).join(" "), 200)}` : ""}`);
  return withGuard(v, g.rest);
}

/** Псевдоним — ровно §4.4: base64url(HMAC-SHA256(salt, String(chatId))).slice(0, 12) (харнес считает сам, ids.ts не нужен) */
export const pseudonym = (chatId: number, salt: string = TG_TEST.salt) =>
  createHmac("sha256", salt).update(String(chatId)).digest("base64url").slice(0, 12);

/* ═══════════════════════════ UI-поток (SSE) для фейкового сервера ═══════════════════════════ */

type Chunk = Record<string, unknown>;
/** Ответ ассистента одной text-частью: start → start-step → text-start/delta/end → finish-step → finish */
export function textChunks(text: string, id = "txt-1"): Chunk[] {
  return [
    { type: "start" }, { type: "start-step" },
    { type: "text-start", id }, { type: "text-delta", id, delta: text }, { type: "text-end", id },
    { type: "finish-step" }, { type: "finish" },
  ];
}
/** Ход с инструментом отчёта: tool-input-start/available → tool-output-available ({query, result}) → текст */
export function reportChunks(query: string, result: BuildResultT, text: string, o: { toolName?: string; toolCallId?: string } = {}): Chunk[] {
  const toolName = o.toolName ?? "resolve_security";
  const toolCallId = o.toolCallId ?? "call_units_1";
  return [
    { type: "start" }, { type: "start-step" },
    { type: "tool-input-start", toolCallId, toolName },
    { type: "tool-input-available", toolCallId, toolName, input: { query } },
    { type: "tool-output-available", toolCallId, output: { query, result } },
    { type: "finish-step" }, { type: "start-step" },
    { type: "text-start", id: "txt-2" }, { type: "text-delta", id: "txt-2", delta: text }, { type: "text-end", id: "txt-2" },
    { type: "finish-step" }, { type: "finish" },
  ];
}
const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
/** Поток, который отдаёт чанки и зависает (таймаут хода); при abort сигнала запроса — ошибка AbortError, как у fetch */
function stalledResponse(chunks: Chunk[], signal: AbortSignal | null): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      signal?.addEventListener("abort", () => { try { ctl.error(abortError()); } catch { /* уже закрыт */ } }, { once: true });
    },
    pull(ctl) {
      if (i < chunks.length) { ctl.enqueue(enc.encode(`data: ${JSON.stringify(chunks[i++])}\n\n`)); return; }
      return new Promise<void>(() => { /* висит, пока не abort */ });
    },
  });
  return new Response(body, { status: 200, headers: { ...UI_MESSAGE_STREAM_HEADERS } });
}
/** fetch отклонён, как undici при остановленном Next: TypeError("fetch failed") с cause.code (§4.4: «code … (или cause.code)») */
const refusedViaCause = () => Object.assign(new TypeError("fetch failed"), {
  cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), { code: "ECONNREFUSED", errno: -111, syscall: "connect", address: "127.0.0.1", port: 3000 }),
});
/** То же, код прямо на ошибке */
const refusedDirect = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), { code: "ECONNREFUSED", errno: -111, syscall: "connect" });
/** Другая сетевая ошибка (сброс соединения) — не ECONNREFUSED, повтора быть не должно */
const resetViaCause = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", errno: -104, syscall: "read" }) });

/* ═══════════════════════════ фейковый сервер /api/chat ═══════════════════════════ */

export interface Post {
  n: number; url: string; method: string; headers: Record<string, string>; raw: string; body: ChatBody | null;
  /** x-so-chat или body.id */
  session: string;
  /** текст последней реплики пользователя в теле */
  lastUser: string;
  signal: AbortSignal | null;
}
export type Responder = (p: Post) => Response | Promise<Response>;
/** Ответ по умолчанию: текст, по которому видно, на какую реплику он дан */
export const answerTo = (lastUser: string) => `Ответ сервера на «${lastUser}»`;
const defaultRespond: Responder = (p) => sseResponse(textChunks(answerTo(p.lastUser)));

/** fetch бота → сервер. hold = true: запросы «в полёте», пока их не отпустят (release) — для очереди и параллельности */
export class FakeServer {
  readonly posts: Post[] = [];
  inFlight = 0;
  maxInFlight = 0;
  hold = false;
  private readonly waiters: { post: Post; go: () => void }[] = [];
  constructor(public respond: Responder = defaultRespond) {}
  /** Отпустить n самых ранних ожидающих запросов (по умолчанию все) */
  release(n = Infinity): number {
    const w = this.waiters.splice(0, n);
    for (const x of w) x.go();
    return w.length;
  }
  waiting(): number { return this.waiters.length; }
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request && init === undefined ? input : new Request(input, init);
    const raw = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    let body: ChatBody | null = null;
    try { body = raw ? (JSON.parse(raw) as ChatBody) : null; } catch { body = null; }
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const signal = init?.signal ?? req.signal ?? null;
    const post: Post = {
      n: this.posts.length + 1, url: req.url, method: req.method, headers, raw, body,
      session: headers["x-so-chat"] ?? body?.id ?? "", lastUser: body ? lastUserText(body) : "", signal,
    };
    this.posts.push(post);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.hold) {
        await new Promise<void>((res, rej) => {
          const w = { post, go: res };
          this.waiters.push(w);
          signal?.addEventListener("abort", () => {
            const i = this.waiters.indexOf(w);
            if (i >= 0) this.waiters.splice(i, 1);
            rej(abortError());
          }, { once: true });
        });
      }
      return await this.respond(post);
    } finally {
      this.inFlight--;
    }
  }) as typeof fetch;
  /** Запросы чата (по сессии из peek) */
  bySession(sid: string | undefined): Post[] { return sid ? this.posts.filter((p) => p.session === sid) : []; }
}

/** Тексты user-сообщений тела */
const userTexts = (b: ChatBody | null): string[] =>
  (b?.messages ?? []).filter((m) => m.role === "user").map((m) => (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" "));
/** Есть ли в теле ассистентское сообщение, текст которого содержит needle */
const hasAssistantText = (b: ChatBody | null, needle: string): boolean =>
  (b?.messages ?? []).some((m: WireMessage) => m.role === "assistant" && (m.parts ?? []).some((p) => p.type === "text" && (p.text ?? "").includes(needle)));

/* ═══════════════════════════ пауза и ошибки grammY ═══════════════════════════ */

/** Внедряемый sleep: пишет длительность; паузы < 60 с не ждёт (≈1 мс), ≥ 60 с ждёт по-настоящему (это таймаут хода, не пауза) */
function sleeper(): { log: number[]; sleep: (ms: number) => Promise<void> } {
  const log: number[] = [];
  const sleep = (ms: number) => {
    log.push(ms);
    if (ms >= 60_000) return new Promise<void>((r) => { const t = setTimeout(r, ms); (t as unknown as { unref?: () => void }).unref?.(); });
    return tick(Math.min(Math.max(ms, 0), 1));
  };
  return { log, sleep };
}
const RETRY_PAUSES = [2000, 8000, 20000];
const retryPauses = (log: number[]) => log.filter((ms) => RETRY_PAUSES.includes(ms));

interface TgErrors {
  /** настоящие классы grammY (пакет установлен, шаг 1а) или фейки fake-tg.ts той же формы */
  real: boolean;
  api(code: number, description: string, retryAfter?: number, method?: string): TgFakeError;
  http(method: string, message?: string): TgFakeError;
}
type GrammyErrorCtor = new (message: string, err: { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } }, method: string, payload: Record<string, unknown>) => Error;
type HttpErrorCtor = new (message: string, error: unknown) => Error;
let tgErrorsP: Promise<TgErrors> | null = null;
/**
 * Ошибки Telegram для TG.18. Если `grammy` установлен (после шага 1а), берутся НАСТОЯЩИЕ GrammyError/HttpError: так ядро,
 * которое распознаёт ошибки через `instanceof GrammyError`, не получит ложный RED. Иначе — фейки той же формы (fake-tg.ts).
 */
function tgErrors(): Promise<TgErrors> {
  return (tgErrorsP ??= (async (): Promise<TgErrors> => {
    try {
      const spec = "grammy";
      const g = (await import(spec)) as { GrammyError?: GrammyErrorCtor; HttpError?: HttpErrorCtor };
      const GE = g.GrammyError, HE = g.HttpError;
      if (typeof GE === "function" && typeof HE === "function") {
        return {
          real: true,
          api: (code, description, retryAfter, method = "sendMessage") =>
            new GE("Call to '" + method + "' failed!", { ok: false, error_code: code, description, ...(retryAfter != null ? { parameters: { retry_after: retryAfter } } : {}) }, method, {}),
          http: (method, message) => {
            const cause = Object.assign(new Error(message ?? "connect ETIMEDOUT"), { code: "ETIMEDOUT" });
            const e = new HE(`Network request for '${method}' failed!`, cause);
            if (message) e.message = `Network request for '${method}' failed! ${message}`;
            return e;
          },
        };
      }
    } catch { /* grammy ещё не установлен — фейки */ }
    return {
      real: false,
      api: (code, description, retryAfter) => tgError(code, description, retryAfter),
      http: (method, message) => {
        const e = new FakeHttpError(method, Object.assign(new Error(message ?? "connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
        if (message) e.message = `Network request for '${method}' failed! ${message}`;
        return e;
      },
    };
  })());
}

/* ═══════════════════════════ стенд ядра ═══════════════════════════ */

interface Rig {
  core: BotCore; tg: FakeTg; srv: FakeServer; recs: LogRec[]; lines: string[]; sleeps: number[]; f: UpdateFactory; cfg: BotConfig;
}
/**
 * Ядро бота с фейковым Telegram и фейковым сервером.
 * @param m.telegram если задан — ядро получает `withTelegramPolicy(FakeTg)`, как в main.ts (TG.18); иначе голый FakeTg
 * @param m.log      если задан — записи журнала идут и в `makeLogger` (строки в `lines`, секреты TG_TEST вырезаются)
 */
function mkRig(m: { core: CoreMod; telegram?: TelegramMod; log?: LogMod }, o: {
  config?: Partial<BotConfig>; respond?: Responder; now?: () => number; firstUpdateId?: number;
} = {}): Rig {
  const tg = new FakeTg();
  const srv = new FakeServer(o.respond);
  const recs: LogRec[] = [];
  const lines: string[] = [];
  const { log: sleeps, sleep } = sleeper();
  const toLine = m.log ? m.log.makeLogger((l) => { lines.push(l); }, [TG_TEST.token, TG_TEST.botKey, TG_TEST.salt]) : null;
  const log = (r: LogRec) => { recs.push(r); toLine?.(r); };
  const cfg = testBotConfig(o.config);
  const client: TgClient = m.telegram ? m.telegram.withTelegramPolicy(tg, { sleep, log }) : tg;
  const core = m.core.createCore({ config: cfg, tg: client, fetch: srv.fetch, sleep, random: testRandom(), log, ...(o.now ? { now: o.now } : {}) });
  return { core, tg, srv, recs, lines, sleeps, f: new UpdateFactory(o.firstUpdateId != null ? { firstUpdateId: o.firstUpdateId } : {}), cfg };
}
const HANDLE_MS = 10_000;
/** handleUpdate (сырой апдейт передаётся переменной — лишние поля допустимы) */
const handle = (r: Rig, u: RawUpdate) => { const upd: TgUpdate = u; return within(r.core.handleUpdate(upd), HANDLE_MS); };
/** handleUpdate + idle; detail при сбое */
async function send(r: Rig, u: RawUpdate): Promise<string | null> {
  const h = await handle(r, u);
  if (!h.ok) return `handleUpdate ${whyNot(h, HANDLE_MS)}`;
  const i = await within(r.core.idle(), HANDLE_MS);
  return i.ok ? null : `idle() ${whyNot(i, HANDLE_MS)}`;
}
const sid = (r: Rig, chatId: number) => { try { return r.core.peek(chatId)?.sessionId; } catch { return undefined; } };
/** Успешные sendMessage/editMessageText чата (с индексом в tg.calls) */
const delivered = (tg: FakeTg, chatId: number, from = 0) =>
  tg.calls.map((c, i) => ({ c, i })).filter(({ c, i }) => i >= from && !c.error && (c.method === "sendMessage" || c.method === "editMessageText") && c.chatId === chatId);
const sentTexts = (tg: FakeTg, chatId: number, from = 0) => delivered(tg, chatId, from).map(({ c }) => ((c as { opts?: { html?: boolean } }).opts?.html ? tgPlain((c as { text: string }).text) : (c as { text: string }).text));
const sentExactly = (tg: FakeTg, chatId: number, text: string, from = 0) =>
  tg.calls.filter((c, i) => i >= from && !c.error && c.method === "sendMessage" && c.chatId === chatId && c.text === text).length;

/* ═══════════════════════════ TG.8: Telegram-HTML ═══════════════════════════ */

/** Разрешённая разметка §4.7: b, i, code, a href; сбалансирована; `<`, `>`, `&` вне тегов — только сущностями */
export function tgHtmlProblems(h: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (let i = 0; i < h.length;) {
    const c = h[i];
    if (c === "<") {
      const j = h.indexOf(">", i);
      if (j < 0) { out.push(`сырой «<» без «>» в позиции ${i}: ${q(h.slice(i, i + 30), 40)}`); break; }
      const tag = h.slice(i, j + 1);
      const open = tag.match(/^<(b|i|code)>$/) ?? tag.match(/^<(a) href=(?:"[^"<>]*"|'[^'<>]*')>$/);
      const close = tag.match(/^<\/(b|i|code|a)>$/);
      if (open) stack.push(open[1]);
      else if (close) {
        const top = stack.pop();
        if (top !== close[1]) out.push(`закрывающий ${tag} ${top ? `при открытом <${top}>` : "без открывающего"} (позиция ${i})`);
      } else out.push(`тег вне b/i/code/a href или «<» не экранирован: ${q(tag, 50)} (позиция ${i})`);
      i = j + 1;
      continue;
    }
    if (c === ">") out.push(`сырой «>» в позиции ${i}: ${q(h.slice(Math.max(0, i - 20), i + 10), 40)}`);
    if (c === "&" && !/^&(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/.test(h.slice(i, i + 12)))
      out.push(`«&» не экранирован в позиции ${i}: ${q(h.slice(Math.max(0, i - 20), i + 12), 40)}`);
    i++;
  }
  if (stack.length) out.push(`не закрыты: ${stack.map((t) => `<${t}>`).join(" ")}`);
  return uniq(out).slice(0, 6);
}
/** Длина текста после разбора сущностей (UTF-16, как в Bot API) */
const tgLen = (h: string) => tgPlain(h).length;

const CABINET = "https://vfo.autremus.com"; // CABINET_HREF §4.1 (значение нужно только как опция renderTurn)
const SITE = "https://so.example.ru";
const DANGER = `<b>&"`;

interface Tg8Input {
  label: string;
  message: UIMessage;
  /** вид входа: report/pick/notfound/err/term — нужен хотя бы один HTML-op; error — хотя бы один op; dialog — без требования */
  need: "html" | "op" | "none";
  /** группы строк: из каждой группы хотя бы одна должна быть видна дословно (после разбора сущностей) в тексте или на кнопке */
  visible?: string[][];
}
const toolMessage = (id: string, toolName: string, input: unknown, output: unknown): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "step-start" }, { type: `tool-${toolName}`, toolCallId: `call_${id}`, state: "output-available", input, output }] }) as unknown as UIMessage;

/** Синтетика с опасными символами `<b>&"` в shortname, name, query, msg, title */
export function dangerInputs(veb: BuildResultT): Tg8Input[] {
  const out: Tg8Input[] = [];
  if (veb.kind === "report") {
    const r = clone(veb);
    if (r.kind === "report") {
      r.report.security.shortname = `ВЭБ${DANGER}21`;
      r.report.security.name = `Облигация ${DANGER}</b><i> «ВЭБ»`;
      r.report.security.emitent_title = `ГК ${DANGER} & Co`;
    }
    out.push({ label: "синтетика: отчёт, shortname/name с <b>&\"", need: "html", visible: [[`ВЭБ${DANGER}21`, `Облигация ${DANGER}</b><i> «ВЭБ»`]],
      message: toolMessage("danger-report", "set_inputs", { position_size: 500000 }, { query: `ВЭБ ${DANGER}`, result: r }) });
  }
  const pick: BuildResultT = {
    kind: "pick", query: `Черк${DANGER}зово`, note: "Уточните выпуск",
    candidates: [
      { secid: "RU000A1094F2", isin: "RU000A1094F2", shortname: `ЧеркизБ1P7${DANGER}`, regnumber: `4B02-07${DANGER}`, is_traded: true, emitent_title: `ПАО ${DANGER}` },
      { secid: "SU26238RMFS4", isin: null, shortname: "ОФЗ 26238 <i>", regnumber: null, is_traded: false, emitent_title: null },
      { secid: "RU000A10B4V0", isin: "RU000A10B4V0", shortname: "Черкиз & сыновья", regnumber: "4B02-01-10797-A-002P", is_traded: true, emitent_title: null },
    ],
  };
  out.push({ label: "синтетика: pick, query и shortname с <b>&\"", need: "html", visible: [[`Черк${DANGER}зово`], [`ЧеркизБ1P7${DANGER}`], ["Черкиз & сыновья"]],
    message: toolMessage("danger-pick", "resolve_security", { query: pick.query }, { query: pick.query, result: pick }) });
  const nf: BuildResultT = { kind: "notfound", query: `RU000A10E2A5${DANGER}`, isinValid: false };
  out.push({ label: "синтетика: notfound, query с <b>&\"", need: "html", visible: [[`RU000A10E2A5${DANGER}`]],
    message: toolMessage("danger-notfound", "resolve_security", { query: nf.query }, { query: nf.query, result: nf }) });
  const err: BuildResultT = { kind: "err", query: DANGER, msg: `Не разобрали запрос ${DANGER} &amp; — попробуйте ISIN.` };
  out.push({ label: "синтетика: err, msg с <b>&\" и буквальным «&amp;»", need: "html", visible: [[`Не разобрали запрос ${DANGER} &amp; — попробуйте ISIN.`]],
    message: toolMessage("danger-err", "build_bond_report", { query: DANGER }, { query: DANGER, result: err }) });
  out.push({ label: "синтетика: explain_term found, title/text с <b>&\"", need: "html", visible: [[`Дюрация ${DANGER}`], [`Срок ${DANGER} в годах`]],
    message: toolMessage("danger-term", "explain_term", { term: "дюрация" }, { found: true, id: "duration", title: `Дюрация ${DANGER}`, text: `Срок ${DANGER} в годах` }) });
  out.push({ label: "set_inputs → {error} (текст ошибки)", need: "op",
    message: toolMessage("set-inputs-error", "set_inputs", { k_pct: 0.3 }, { error: "Отчёт ещё не собран — сначала назови бумагу." }) });
  return out;
}

/** Все входы TG.8: 21 вход SSR (16 golden, 3 live, 2 err), синтетика, сообщения ассистента из 7 диалогов эталона */
function tg8Inputs(): Tg8Input[] {
  const ins = ssrInputs();
  const out: Tg8Input[] = ins.map((s) => {
    const res = s.result;
    const query = res.kind === "report" ? res.report.security.shortname : res.query;
    const tool = s.name.startsWith("live_") ? "build_bond_report" : "resolve_security";
    return { label: `${s.name} (${res.kind})`, need: "html" as const, message: toolMessage(`ssr-${s.name}`, tool, { query }, { query, result: res }) };
  });
  const veb = ins.find((s) => s.name === "veb")?.result;
  if (veb) out.push(...dangerInputs(veb));
  const seen = new Set<string>();
  for (const d of loadDialogs())
    for (const r of d.requests)
      r.body.messages.forEach((m, i) => {
        if (m.role !== "assistant") return;
        const key = canonical(m);
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ label: `${d.id}: ассистент #${i} тела ${d.requests.indexOf(r) + 1}`, need: "none", message: clone(m) as unknown as UIMessage });
      });
  return out;
}

/* ═══════════════════════════ TG.10: замороженное поведение d16c809 (§4.1 «перенос без изменения поведения») ═══════════════════════════ */

/** inputsSchema tools.ts:22-27 на d16c809 — поле за полем (границы ReportInputsSchema те же, §4.2) */
const frozenFieldOk = (k: keyof ReportInputs, v: number): boolean => {
  if (!Number.isFinite(v)) return false;
  if (k === "position_size") return Number.isInteger(v) && v >= 1000 && v <= 1e10;
  if (k === "k_pct") return v >= 0 && v <= 3;
  if (k === "promised_pct") return v >= 0 && v <= 100;
  if (k === "offer_price_pct") return v >= 1 && v <= 300;
  return false;
};
/** app/chat/page.tsx:29-43 на d16c809 (Search → EntryParams: значения — строки) */
export function frozenInitialOf(p: EntryParams): ChatInitial | undefined {
  const num = (s: string | undefined) => {
    if (!s) return undefined;
    const n = Number(s.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  };
  const qv = (p.q ?? "").trim();
  if (qv) {
    if (qv.length > 200) return undefined;
    const raw: [keyof ReportInputs, number | undefined][] = [
      ["promised_pct", num(p.promised)], ["position_size", num(p.pos)], ["k_pct", num(p.k)], ["offer_price_pct", num(p.price)],
    ];
    const inputs: ReportInputs = Object.fromEntries(raw.filter(([k, v]) => v !== undefined && (k !== "promised_pct" || v > 0) && frozenFieldOk(k, v)));
    return { q: qv, inputs };
  }
  const text = (p.m ?? "").trim();
  return text && text.length <= 500 ? { text } : undefined;
}
/** components/ChatApp.tsx:14-15 на d16c809 */
export const frozenFirstText = (i: ChatInitial): string =>
  i.text ?? `Проверь ${i.q}` + (i.inputs?.promised_pct != null ? `, обещали ${String(i.inputs.promised_pct).replace(".", ",")}%` : "");
/** Ядро chatHref, app/check/CheckClient.tsx:8-20 на d16c809 (URLSearchParams → EntryParams) */
export function frozenChatParams(res: BuildResultT, query: string): EntryParams | null {
  if (res.kind !== "report") return null;
  const r = res.report;
  const qv = (r.security.isin ?? r.security.secid ?? query).trim();
  if (!qv || qv.length > 200) return null;
  const out: EntryParams = { q: qv };
  const i = r.inputs;
  if (i.promised_pct != null && i.promised_pct > 0) out.promised = String(i.promised_pct);
  if (i.position_size != null) out.pos = String(i.position_size);
  if (i.k_pct != null) out.k = String(i.k_pct);
  if (i.offer_price_pct != null) out.price = String(i.offer_price_pct);
  return out;
}
const PAYLOAD_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Пример §4.6 */
const EXAMPLE_PARAMS: EntryParams = { q: "RU000A1038V6", promised: "15", pos: "1000000", k: "0.3" };
const EXAMPLE_PAYLOAD = "qRU000A1038V6_p1500_s1000000_k30";

/* ═══════════════════════════ проверки ═══════════════════════════ */

export function makeUnitChecks(L: UnitLoaders = REPO_LOADERS): Check[] {
  /* ─────────────── TG.8 ─────────────── */
  const TG8: Check = {
    id: "TG.8", wp: "TG", kind: "unit",
    title: "Ограничения Telegram: на всех golden и фикстурах renderTurn даёт сообщения ≤ 4096 видимых символов, HTML только b/i/code/a и сбалансирован, <b>&\" экранированы, callback_data ≤ 64 байт, кнопок ≤ 100",
    run: () => guarded("TG.8", async () => {
      const m = await loadAll({ render: () => L.bot("render"), html: () => L.bot("html") });
      if (!m.ok) return fail(`render.ts/html.ts бота ещё нет: ${m.detail}`);
      const { render, html } = m.mods;
      const subs: Sub[] = [];

      // (1) html.ts: escapeHtml, visibleLength — на векторах
      {
        const probs: string[] = [];
        for (const s of [DANGER, `ВЭБ${DANGER}21`, "a < b > c & d", "&amp; уже сущность", `'"<>&`]) {
          const e = html.escapeHtml(s);
          if (decodeEntities(e) !== s) probs.push(`escapeHtml(${q(s)}) = ${q(e)}: после разбора сущностей ${q(decodeEntities(e))} ≠ исходной строке`);
          const hp = tgHtmlProblems(e);
          if (hp.length) probs.push(`escapeHtml(${q(s)}) = ${q(e)}: ${hp[0]}`);
        }
        const vec: [string, number][] = [["<b>a&amp;b</b>", 3], ["&lt;&gt;", 2], ['<a href="https://x.ru/?a=1&amp;b=2">ссылка</a>', 6], ["<i>Доходность</i> <code>RU000A0JS4Z7</code>", 23]];
        for (const [h, n] of vec) {
          const v = html.visibleLength(h);
          if (v !== n) probs.push(`visibleLength(${q(h)}) = ${v}, ожидалось ${n} (длина после разбора тегов и сущностей, как считает Telegram)`);
        }
        subs.push(sub("html.ts: escapeHtml и visibleLength на векторах", !probs.length, probs.slice(0, 4).join("; ")));
      }
      // (2) html.ts: splitHtml режет длинный HTML на сообщения ≤ max, не разрезая теги и не теряя текст
      {
        const section = (i: number) => `<b>Раздел ${i} &amp; «итог»</b>\n` +
          Array.from({ length: 12 }, (_, j) => `Строка ${i}.${j}: доходность 19,21% &lt; обещанных 20% — <i>курсив</i> <code>RU000A0JS4Z7</code>`).join("\n");
        const long = Array.from({ length: 14 }, (_, i) => section(i + 1)).join("\n\n");
        const probs: string[] = [];
        for (const max of [4096, 1000, undefined]) {
          const lim = max ?? 4096;
          let chunks: string[];
          try { chunks = max === undefined ? html.splitHtml(long) : html.splitHtml(long, max); } catch (e) { probs.push(`splitHtml(…, ${max ?? "по умолчанию"}) бросил: ${errText(e)}`); continue; }
          if (!Array.isArray(chunks) || !chunks.length) { probs.push(`splitHtml(…, ${max ?? "по умолчанию"}) вернул ${brief(chunks)}`); continue; }
          const minParts = Math.ceil(tgLen(long) / lim);
          if (chunks.length < minParts) probs.push(`splitHtml(${tgLen(long)} видимых, max ${lim}): ${chunks.length} частей, нужно не меньше ${minParts}`);
          chunks.forEach((c, k) => {
            if (tgLen(c) > lim) probs.push(`splitHtml(…, ${lim}): часть ${k + 1} — ${tgLen(c)} видимых символов > ${lim}`);
            const hp = tgHtmlProblems(c);
            if (hp.length) probs.push(`splitHtml(…, ${lim}): часть ${k + 1} — ${hp[0]}`);
          });
          const joined = collapseWs(chunks.map(tgPlain).join(" "));
          if (joined !== collapseWs(tgPlain(long))) probs.push(`splitHtml(…, ${lim}): текст частей ≠ исходному (${diff(collapseWs(tgPlain(long)), joined, { labels: ["исходный", "части"] })})`);
        }
        const short = "<b>Коротко</b> &amp; ясно";
        try {
          const one = html.splitHtml(short, 4096);
          if (one.length !== 1 || collapseWs(tgPlain(one[0])) !== collapseWs(tgPlain(short))) probs.push(`splitHtml(${q(short)}) = ${brief(one)}: короткий HTML должен остаться одним сообщением`);
        } catch (e) { probs.push(`splitHtml(короткий) бросил: ${errText(e)}`); }
        subs.push(sub("html.ts: splitHtml — части ≤ max, теги не режутся, текст не теряется", !probs.length, probs.slice(0, 4).join("; ")));
      }
      // (3) renderTurn на всех входах
      const inputs = tg8Inputs();
      const probs: string[] = [];
      let ops = 0, htmlOps = 0, buttons = 0, maxLen = 0, maxData = 0, maxButtons = 0;
      for (const inp of inputs) {
        let out: TgOp[];
        try { out = render.renderTurn(clone(inp.message), { siteUrl: SITE, cabinetHref: CABINET }); } catch (e) { probs.push(`${inp.label}: renderTurn бросил ${errText(e)}`); continue; }
        if (!Array.isArray(out)) { probs.push(`${inp.label}: renderTurn вернул ${brief(out)}`); continue; }
        ops += out.length;
        if (inp.need === "html" && !out.some((o) => o.html)) probs.push(`${inp.label}: нет ни одного HTML-сообщения (§4.7: отчёт, ветка и термин — parse_mode HTML); ops: ${brief(out, 160)}`);
        if (inp.need === "op" && !out.length) probs.push(`${inp.label}: renderTurn не дал ни одного сообщения`);
        const seenText: string[] = [];
        for (const [k, o] of out.entries()) {
          const where = `${inp.label}, op ${k + 1}/${out.length}${o.html ? " (HTML)" : ""}`;
          if (typeof o.text !== "string") { probs.push(`${where}: text ${brief(o.text)}`); continue; }
          if (o.html) {
            htmlOps++;
            for (const p of tgHtmlProblems(o.text)) probs.push(`${where}: ${p}`);
            const mine = tgLen(o.text), cps = [...tgPlain(o.text)].length;
            let vl: number;
            try { vl = html.visibleLength(o.text); } catch (e) { probs.push(`${where}: visibleLength бросил ${errText(e)}`); vl = mine; }
            if (vl !== mine && vl !== cps) probs.push(`${where}: visibleLength = ${vl}, а после разбора тегов и сущностей ${mine} символов`);
            const len = Math.max(mine, vl);
            maxLen = Math.max(maxLen, len);
            if (len > 4096) probs.push(`${where}: ${len} видимых символов > 4096`);
            if (!tgPlain(o.text).trim()) probs.push(`${where}: пустое сообщение (Telegram отвечает 400)`);
            seenText.push(collapseWs(tgPlain(o.text)));
          } else {
            maxLen = Math.max(maxLen, o.text.length);
            if (o.text.length > 4096) probs.push(`${where}: простой текст ${o.text.length} символов > 4096 (§4.7: делится по предложениям)`);
            if (!o.text.trim()) probs.push(`${where}: пустое сообщение (Telegram отвечает 400)`);
            seenText.push(collapseWs(o.text));
          }
          const kb: InlineKeyboard | undefined = o.keyboard;
          if (kb) {
            const flat = (kb.inline_keyboard ?? []).flat();
            buttons += flat.length;
            maxButtons = Math.max(maxButtons, flat.length);
            if (flat.length > 100) probs.push(`${where}: ${flat.length} кнопок > 100`);
            for (const b of flat) {
              if (!b.text || !b.text.trim()) probs.push(`${where}: кнопка без подписи ${brief(b)}`);
              if ((b.callback_data != null) === (b.url != null)) probs.push(`${where}: у кнопки ${q(b.text)} должно быть ровно одно из callback_data/url: ${brief(b)}`);
              if (b.callback_data != null) {
                const bytes = Buffer.byteLength(b.callback_data, "utf8");
                maxData = Math.max(maxData, bytes);
                if (bytes < 1 || bytes > 64) probs.push(`${where}: callback_data ${q(b.callback_data)} — ${bytes} байт (допустимо 1–64)`);
              }
              if (/&(?:lt|gt|amp|quot|#\d+);/.test(b.text)) probs.push(`${where}: подпись кнопки ${q(b.text)} HTML-экранирована — подписи кнопок Telegram показывает как есть`);
              seenText.push(collapseWs(b.text));
            }
          }
        }
        for (const group of inp.visible ?? []) {
          if (!group.some((s) => seenText.some((t) => t.includes(collapseWs(s)))))
            probs.push(`${inp.label}: строка ${group.map((s) => q(s)).join(" / ")} не видна ни в тексте (после разбора сущностей), ни на кнопках — экранирование потеряло или исказило символы; видно: ${q(seenText.join(" ‖ "), 220)}`);
        }
      }
      subs.push(sub(`renderTurn: ${inputs.length} входов (21 SSR, синтетика, ассистент 7 диалогов)`, !probs.length,
        probs.length ? `${probs.length} нарушений: ${probs.slice(0, 6).join("; ")}${probs.length > 6 ? `; … ещё ${probs.length - 6}` : ""}`
          : `сообщений ${ops}, из них HTML ${htmlOps}; максимум ${maxLen} видимых символов; кнопок ${buttons}, на сообщение до ${maxButtons}; callback_data до ${maxData} байт`));
      return verdict(subs);
    }),
  };

  /* ─────────────── TG.10 ─────────────── */
  const TG10: Check = {
    id: "TG.10", wp: "TG", kind: "unit",
    title: "Вход: initialOf(decode(encode(chatParams))) ≡ initialOf(chatParams) на golden и синтетике, payload ≤ 64 из [A-Za-z0-9_-]; неточные k/promised → null; pickMessage и firstText ≡ репликам d2 и d6",
    run: () => guarded("TG.10", async () => {
      const e = await L.present("entry");
      if (!e.ok) return fail(`@so/present/entry ещё нет: ${e.detail}`);
      const E: EntryMod = e.mod;
      const subs: Sub[] = [];
      const show = (v: unknown) => brief(v, 140);
      /** encode → payload-проверка → decode → initialOf; null — всё сошлось, иначе текст расхождения */
      const roundTrip = (p: EntryParams, label: string): string | null => {
        const payload = E.encodeStartPayload(p);
        if (payload == null) return `${label}: encodeStartPayload(${show(p)}) = null, ожидалась строка`;
        if (!PAYLOAD_RE.test(payload)) return `${label}: payload ${q(payload)} — ${payload.length} символов; нужно 1–64 из [A-Za-z0-9_-]`;
        const dec = E.decodeStartPayload(payload);
        if (dec == null) return `${label}: decodeStartPayload(${q(payload)}) = null`;
        const a = E.initialOf(p), b = E.initialOf(dec);
        const d = diff(a ?? null, b ?? null, { labels: ["initialOf(p)", "initialOf(decode(encode(p)))"] });
        return d ? `${label}: payload ${q(payload)}, decode = ${show(dec)}; ${d}` : null;
      };

      // (1) golden и live: chatParams ≡ chatHref d16c809; круг через payload
      {
        const probs: string[] = [];
        let n = 0;
        const all = ssrInputs();
        const reports = all.filter((x) => x.result.kind === "report").length;
        for (const s of all) {
          const res = s.result;
          const query = res.kind === "report" ? res.report.security.shortname : res.query;
          const p = E.chatParams(res, query);
          const want = frozenChatParams(res, query);
          const d = diff(want, p, { labels: ["chatHref d16c809", "chatParams"] });
          if (d) { probs.push(`${s.name}: ${d}`); continue; }
          if (p == null) continue;
          n++;
          const di = diff(frozenInitialOf(p), E.initialOf(p) ?? null, { labels: ["initialOf d16c809", "initialOf"] });
          if (di) probs.push(`${s.name}: initialOf(${show(p)}): ${di}`);
          const r = roundTrip(p, s.name);
          if (r) probs.push(r);
        }
        subs.push(sub(`golden и live (${reports} отчётов; ветки → chatParams = null): chatParams как chatHref на d16c809, круг encode/decode без потерь`, !probs.length && n === reports && n > 0,
          probs.length ? probs.slice(0, 4).join(" | ") : n !== reports || !n ? `отчётов с chatParams ${n} из ${reports}` : ""));
      }
      // (2) синтетика: точные сотые доли
      {
        const base = "RU000A1038V6";
        const vectors: [string, EntryParams][] = [
          ...[0.07, 0.14, 0.29, 0.3, 1.1].map((k): [string, EntryParams] => [`k=${k}`, { q: base, k: String(k) }]),
          ...[15.5, 15.15, 18.55].map((v): [string, EntryParams] => [`promised=${v}`, { q: base, promised: String(v) }]),
          ...[98.55, 98.75, 100].map((v): [string, EntryParams] => [`price=${v}`, { q: base, price: String(v) }]),
          ...[1000, 1e10].map((v): [string, EntryParams] => [`pos=${v}`, { q: base, pos: String(v) }]),
          ["все части", { q: base, promised: "15.15", pos: "1000", k: "0.07", price: "98.55" }],
        ];
        const probs: string[] = [];
        for (const [label, p] of vectors) {
          const di = diff(frozenInitialOf(p), E.initialOf(p) ?? null, { labels: ["initialOf d16c809", "initialOf"] });
          if (di) { probs.push(`${label}: ${di}`); continue; }
          const r = roundTrip(p, label);
          if (r) probs.push(r);
        }
        subs.push(sub(`синтетика (${vectors.length} векторов: k 0.07/0.14/0.29/0.3/1.1, promised 15.5/15.15/18.55, price 98.55/98.75/100, pos 1000/1e10): encode ≠ null, круг без потерь`, !probs.length, probs.slice(0, 4).join(" | ")));
      }
      // (3) отрицательные: значение не равно n/100 точно → null
      {
        const probs: string[] = [];
        for (const [label, p] of [
          ["k=0.035", { q: "RU000A1038V6", k: "0.035" }], ["k=0.075", { q: "RU000A1038V6", k: "0.075" }],
          ["promised=15.155", { q: "RU000A1038V6", promised: "15.155" }], ["promised=18.555", { q: "RU000A1038V6", promised: "18.555" }],
        ] as [string, EntryParams][]) {
          const payload = E.encodeStartPayload(p);
          if (payload !== null) probs.push(`${label}: encodeStartPayload = ${q(payload)}, ожидался null (n/100 ≠ x — ссылка не строится, §4.6)`);
        }
        subs.push(sub("отрицательные векторы (k 0.035/0.075, promised 15.155/18.555) → null", !probs.length, probs.join(" | ")));
      }
      // (4) длина: q из 20 символов и все четыре части
      {
        const p: EntryParams = { q: "ABCDEFGHIJ0123456789", promised: "99.99", pos: "10000000000", k: "2.99", price: "299.99" };
        const r = roundTrip(p, "q из 20 символов, все части, pos 1e10");
        const payload = E.encodeStartPayload(p);
        subs.push(sub("вектор длины: q из 20 символов, _p _s _k _o, pos 1e10 → payload ≤ 64", !r, r ?? `payload ${q(payload)} (${payload?.length ?? 0} символов)`));
      }
      // (5) пример §4.6
      {
        const probs: string[] = [];
        const payload = E.encodeStartPayload(EXAMPLE_PARAMS);
        if (payload !== EXAMPLE_PAYLOAD) probs.push(`encodeStartPayload(${show(EXAMPLE_PARAMS)}) = ${q(payload)}, по §4.6 ${q(EXAMPLE_PAYLOAD)}`);
        const dec = E.decodeStartPayload(EXAMPLE_PAYLOAD);
        const d = diff(EXAMPLE_PARAMS, dec, { labels: ["§4.6", "decodeStartPayload"] });
        if (d) probs.push(`decodeStartPayload(${q(EXAMPLE_PAYLOAD)}): ${d}`);
        subs.push(sub(`пример §4.6: ${EXAMPLE_PAYLOAD} ≡ /chat?q=RU000A1038V6&promised=15&pos=1000000&k=0.3`, !probs.length, probs.join(" | ")));
      }
      // (6) pickMessage(кандидат 0 из d2) ≡ вторая реплика d2; без ISIN — SECID
      {
        const d2 = loadDialog("d2");
        const want = lastUserText(d2.requests[1].body);
        const tool = d2.requests[1].body.messages.find((m) => m.role === "assistant")?.parts.find((p) => p.type.startsWith("tool-"));
        const res = (tool?.output as { result?: BuildResultT } | undefined)?.result;
        const c0 = res?.kind === "pick" ? res.candidates[0] : undefined;
        const probs: string[] = [];
        if (!c0) probs.push(`дефект фикстуры: в теле 2 d2 нет pick с кандидатами`);
        else {
          const got = E.pickMessage({ isin: c0.isin, secid: c0.secid });
          if (got !== want) probs.push(`pickMessage(${show({ isin: c0.isin, secid: c0.secid })}) = ${q(got)}, реплика браузера ${q(want)}`);
        }
        const noIsin = E.pickMessage({ isin: null, secid: "SU26238RMFS4" });
        if (noIsin !== "Проверь SU26238RMFS4") probs.push(`pickMessage({isin:null, secid:"SU26238RMFS4"}) = ${q(noIsin)}, ожидалось «Проверь SU26238RMFS4» (ToolUIs.tsx:23)`);
        subs.push(sub(`pickMessage(кандидат 0 из d2) ≡ ${q(want)}`, !probs.length, probs.join(" | ")));
      }
      // (7) firstText(initialOf(ссылка d6)) ≡ реплика d6; inputs ≡ полю inputs тела браузера; то же через deep-link; d3 (?m=)
      {
        const probs: string[] = [];
        const d6 = loadDialog("d6");
        const a6 = d6.actions[0];
        const p6: EntryParams = a6.kind === "open" ? entryParamsOf(a6.url) : {};
        const want6 = lastUserText(d6.requests[0].body);
        const i6 = E.initialOf(p6);
        if (!i6) probs.push(`initialOf(${show(p6)}) = undefined`);
        else {
          const t = E.firstText(i6);
          if (t !== want6) probs.push(`firstText(initialOf(ссылка d6)) = ${q(t)}, реплика браузера ${q(want6)}`);
          const di = diff(d6.requests[0].body.inputs, i6.inputs, { labels: ["inputs тела браузера d6", "initialOf(…).inputs"] });
          if (di) probs.push(di);
          const { m: _m, ...qp } = p6;
          void _m;
          const payload = E.encodeStartPayload(qp);
          const dec = payload != null ? E.decodeStartPayload(payload) : null;
          const iDeep = dec ? E.initialOf(dec) : undefined;
          if (!iDeep) probs.push(`deep-link d6: encode → ${q(payload)}, decode → ${show(dec)}, initialOf → undefined`);
          else {
            const td = E.firstText(iDeep);
            if (td !== want6) probs.push(`deep-link d6 (/start ${payload}): firstText = ${q(td)}, реплика браузера ${q(want6)}`);
            const dd = diff(d6.requests[0].body.inputs, iDeep.inputs, { labels: ["inputs тела браузера d6", "inputs deep-link"] });
            if (dd) probs.push(`deep-link d6: ${dd}`);
          }
        }
        const d3 = loadDialog("d3");
        const a3 = d3.actions[0];
        const p3: EntryParams = a3.kind === "open" ? entryParamsOf(a3.url) : {};
        const i3 = E.initialOf(p3);
        const want3 = lastUserText(d3.requests[0].body);
        const t3 = i3 ? E.firstText(i3) : undefined;
        if (t3 !== want3) probs.push(`firstText(initialOf(ссылка d3 ?m=)) = ${q(t3)}, реплика браузера ${q(want3)}`);
        subs.push(sub(`firstText(initialOf(ссылка d6)) ≡ ${q(want6)} (и через deep-link); d3 ?m= ≡ ${q(want3)}`, !probs.length, probs.join(" | ")));
      }
      return verdict(subs);
    }),
  };

  /* ─────────────── TG.16 ─────────────── */
  const TG16: Check = {
    id: "TG.16", wp: "TG", kind: "unit",
    title: "Очередь: дубль update_id → один POST; один чат последовательно, разные чаты параллельно; 6 чатов при concurrency 4 → в полёте ≤ 4; сверх очереди и кнопка во время хода → BOT.busy без POST; упавший job не роняет run",
    run: () => guarded("TG.16", async (w) => {
      const m = await loadAll({ core: () => L.bot("core"), queue: () => L.bot("queue"), copy: () => L.present("copy") });
      if (!m.ok) return fail(`бота нет: ${m.detail}`);
      const { core, queue, copy } = m.mods;
      const BUSY = copy.BOT.busy;
      const subs = await (async (): Promise<Sub[]> => {
        const subs: Sub[] = [];
        subs.push(...(await queueUnits(queue.ChatQueues)));

        // (5) дубль update_id
        {
          const r = mkRig({ core }, { firstUpdateId: 610_000_001 });
          const A = 7000000301;
          const u = r.f.message(A, "ОФЗ 26238 (дубль апдейта)");
          const h = await within(Promise.all([r.core.handleUpdate(u as TgUpdate), r.core.handleUpdate(clone(u) as TgUpdate)]), HANDLE_MS);
          const i1 = await within(r.core.idle(), HANDLE_MS);
          const late = await send(r, clone(u));
          const ok = h.ok && i1.ok && !late && r.srv.posts.length === 1;
          subs.push(sub("повторный update_id (одновременно и после хода, копией объекта) → один POST", ok,
            !h.ok ? `handleUpdate ${whyNot(h, HANDLE_MS)}` : !i1.ok ? `idle() ${whyNot(i1, HANDLE_MS)}` : late ??
              (ok ? `апдейт ${u.update_id} доставлен трижды, POST 1` : `POST: ${r.srv.posts.length}, ожидался 1 на три доставки апдейта ${u.update_id}`)));
        }
        // (6) один чат — последовательно; следующий ход видит ответ предыдущего
        {
          const r = mkRig({ core }, { firstUpdateId: 620_000_001 });
          const A = 7000000302;
          r.srv.hold = true;
          const t1 = "первое сообщение чата A", t2 = "второе сообщение чата A";
          const h1 = handle(r, r.f.message(A, t1));
          await until(() => r.srv.posts.length >= 1, 3000);
          const h2 = handle(r, r.f.message(A, t2));
          await tick(80);
          const whileFirst = r.srv.posts.length;
          r.srv.release(1);
          await until(() => r.srv.posts.length >= 2, 3000);
          r.srv.hold = false;
          r.srv.release();
          const hs = await Promise.all([h1, h2]);
          const idle = await within(r.core.idle(), HANDLE_MS);
          const p2 = r.srv.posts[1];
          const probs: string[] = [];
          if (whileFirst !== 1) probs.push(`пока первый ход в полёте, POST уже ${whileFirst} (второе сообщение того же чата ушло параллельно)`);
          if (r.srv.posts.length !== 2) probs.push(`всего POST ${r.srv.posts.length}, ожидалось 2`);
          if (p2 && p2.lastUser !== t2) probs.push(`второй POST несёт реплику ${q(p2.lastUser)}, ожидалась ${q(t2)}`);
          if (p2 && !hasAssistantText(p2.body, answerTo(t1))) probs.push(`во втором POST нет ответа на первую реплику (${q(answerTo(t1))}) — ход начат до завершения предыдущего`);
          hs.forEach((x, k) => { if (!x.ok) probs.push(`handleUpdate #${k + 1} ${whyNot(x, HANDLE_MS)}`); });
          if (!idle.ok) probs.push(`idle() ${whyNot(idle, HANDLE_MS)}`);
          subs.push(sub("два сообщения одного чата → последовательно", !probs.length, probs.join("; ")));
        }
        // (7) разные чаты — параллельно
        {
          const r = mkRig({ core }, { firstUpdateId: 630_000_001 });
          r.srv.hold = true;
          const hA = handle(r, r.f.message(7000000303, "сообщение чата A"));
          const hB = handle(r, r.f.message(7000000304, "сообщение чата B"));
          const both = await until(() => r.srv.posts.length >= 2, 3000);
          const seen = r.srv.posts.length;
          r.srv.hold = false;
          r.srv.release();
          const hs = await Promise.all([hA, hB]);
          const idle = await within(r.core.idle(), HANDLE_MS);
          const ok = both && hs.every((x) => x.ok) && idle.ok;
          subs.push(sub("разные чаты → параллельно (оба POST в полёте одновременно)", ok,
            !both ? `пока ход чата A в полёте, POST чата B не ушёл (в полёте ${seen} из 2) — чаты обслуживаются последовательно` : !idle.ok ? `idle() ${whyNot(idle, HANDLE_MS)}` : hs.filter((x) => !x.ok).map((x) => `handleUpdate ${whyNot(x as { timeout: boolean; err?: string }, HANDLE_MS)}`).join("; ")));
        }
        // (8) 6 чатов при concurrency 4
        {
          const r = mkRig({ core }, { config: { concurrency: 4 }, firstUpdateId: 640_000_001 });
          r.srv.hold = true;
          const hs = Array.from({ length: 6 }, (_, i) => handle(r, r.f.message(7000000310 + i, `чат ${i + 1} из 6`)));
          await until(() => r.srv.posts.length >= 4, 3000);
          await tick(100);
          const first = r.srv.posts.length;
          r.srv.release(1);
          await until(() => r.srv.posts.length >= 5, 3000);
          await tick(60);
          const second = r.srv.posts.length;
          r.srv.hold = false;
          r.srv.release();
          const res = await Promise.all(hs);
          const idle = await within(r.core.idle(), HANDLE_MS);
          const probs: string[] = [];
          if (first !== 4) probs.push(`при 4 ходах в полёте ушло POST: ${first} (ожидалось ровно 4: concurrency 4 из BotConfig)`);
          if (second !== 5) probs.push(`после завершения одного хода POST: ${second}, ожидалось 5`);
          if (r.srv.maxInFlight > 4) probs.push(`максимум одновременно в полёте ${r.srv.maxInFlight} > 4`);
          if (r.srv.posts.length !== 6) probs.push(`всего POST ${r.srv.posts.length}, ожидалось 6`);
          res.forEach((x, k) => { if (!x.ok) probs.push(`handleUpdate чата ${k + 1}: ${whyNot(x, HANDLE_MS)}`); });
          if (!idle.ok) probs.push(`idle() ${whyNot(idle, HANDLE_MS)}`);
          subs.push(sub("6 чатов при concurrency 4 → в полёте не больше 4", !probs.length, probs.length ? probs.join("; ") : `максимум в полёте ${r.srv.maxInFlight}`));
        }
        // (9) сверх очереди чата → BOT.busy без POST
        {
          const r = mkRig({ core }, { config: { perChatPending: 2 }, firstUpdateId: 650_000_001 });
          const A = 7000000320;
          r.srv.hold = true;
          const texts = ["ход 1 (в полёте)", "сообщение 2", "сообщение 3", "сообщение 4"];
          const hs = [handle(r, r.f.message(A, texts[0]))];
          await until(() => r.srv.posts.length >= 1, 3000);
          for (const t of texts.slice(1)) { hs.push(handle(r, r.f.message(A, t))); await tick(25); }
          const gotBusy = await until(() => sentExactly(r.tg, A, BUSY) >= 1, 2000);
          const postsWhileHeld = r.srv.posts.length;
          r.srv.hold = false;
          r.srv.release();
          const res = await Promise.all(hs);
          const idle = await within(r.core.idle(), HANDLE_MS);
          const busyN = sentExactly(r.tg, A, BUSY);
          const posted = r.srv.posts.map((p) => p.lastUser);
          const accepted = texts.slice(0, texts.length - busyN);
          const probs: string[] = [];
          if (!gotBusy) probs.push(`пока ход 1 в полёте и в очереди уже ${texts.length - 1} сообщения, BOT.busy ${q(BUSY)} не отправлен`);
          if (postsWhileHeld !== 1) probs.push(`пока ход 1 в полёте, POST: ${postsWhileHeld} (ожидался 1)`);
          if (busyN < 1 || busyN > 2) probs.push(`BOT.busy отправлен ${busyN} раз; при perChatPending 2 отказ должен получить 3-е или 4-е сообщение и все следующие (1–2 отказа из 4)`);
          if (posted.length + busyN !== texts.length) probs.push(`POST ${posted.length} + отказов ${busyN} ≠ ${texts.length} сообщений (сообщение и потеряно, и не отклонено, или наоборот)`);
          if (canonical(posted) !== canonical(accepted)) probs.push(`ушли реплики ${brief(posted)}, ожидались первые ${accepted.length}: ${brief(accepted)} (отказ — последним, а не раньше)`);
          res.forEach((x, k) => { if (!x.ok) probs.push(`handleUpdate сообщения ${k + 1}: ${whyNot(x, HANDLE_MS)}`); });
          if (!idle.ok) probs.push(`idle() ${whyNot(idle, HANDLE_MS)}`);
          subs.push(sub("сообщение сверх очереди чата (perChatPending 2) → BOT.busy без POST", !probs.length, probs.length ? probs.join("; ") : `POST ${posted.length}, BOT.busy ${busyN}`));
        }
        // (10) кнопка во время хода → answerCallbackQuery(BOT.busy) без POST; после хода та же кнопка → POST
        {
          const r = mkRig({ core }, { firstUpdateId: 660_000_001 });
          const A = 7000000321;
          r.srv.hold = true;
          const h1 = handle(r, r.f.message(A, "Черкизово"));
          await until(() => r.srv.posts.length >= 1, 3000);
          const cb = r.f.callback(A, "pk:RU000A1094F2", { messageId: 1001, text: "Уточните выпуск" });
          const cbId = cb.callback_query?.id ?? "";
          const hc = handle(r, cb);
          const answered = await until(() => r.tg.calls.some((c) => c.method === "answerCallbackQuery" && c.callbackId === cbId), 2000);
          const ans = r.tg.calls.find((c): c is Extract<TgCall, { method: "answerCallbackQuery" }> => c.method === "answerCallbackQuery" && c.callbackId === cbId);
          r.srv.hold = false;
          r.srv.release();
          const res = await Promise.all([h1, hc]);
          const idle = await within(r.core.idle(), HANDLE_MS);
          const postsAfterTurn = r.srv.posts.length;
          const cb2 = r.f.callback(A, "pk:RU000A1094F2", { messageId: 1001, text: "Уточните выпуск" });
          const e2 = await send(r, cb2);
          const p2 = r.srv.posts[1];
          const probs: string[] = [];
          if (!answered) probs.push(`на нажатие во время хода нет answerCallbackQuery (§4.7: answerCallbackQuery(BOT.busy)); вызовы: ${r.tg.summary()}`);
          else if (ans?.text !== BUSY) probs.push(`answerCallbackQuery(${q(ans?.text ?? "без текста")}), ожидался BOT.busy ${q(BUSY)}`);
          if (postsAfterTurn !== 1) probs.push(`кнопка во время хода ушла в сервер: POST ${postsAfterTurn}, ожидался 1 (реплика не должна уходить)`);
          res.forEach((x, k) => { if (!x.ok) probs.push(`handleUpdate ${k ? "кнопки" : "сообщения"} ${whyNot(x, HANDLE_MS)}`); });
          if (!idle.ok) probs.push(`idle() ${whyNot(idle, HANDLE_MS)}`);
          if (e2) probs.push(`контроль (та же кнопка после хода): ${e2}`);
          else if (r.srv.posts.length !== 2 || p2?.lastUser !== "Проверь RU000A1094F2")
            probs.push(`контроль: та же кнопка после хода должна дать POST с репликой «Проверь RU000A1094F2»; POST ${r.srv.posts.length}, реплика ${q(p2?.lastUser)}`);
          subs.push(sub("кнопка pk: во время хода → answerCallbackQuery(BOT.busy) без POST (после хода — POST «Проверь …»)", !probs.length, probs.join("; ")));
        }
        return subs;
      })();
      subs.push(...(await w.settle())); // unhandledRejection, исключения вне await, глобальный fetch, process.exit — пунктами проверки
      return verdict(subs);
    }),
  };

  /* ─────────────── TG.17 ─────────────── */
  const TG17: Check = {
    id: "TG.17", wp: "TG", kind: "unit",
    title: "Повтор только при ECONNREFUSED: 2 отказа → 3 POST и ответ; всегда отказ → 4 POST, BOT.serviceRestarting, реплики в истории нет; HTTP 500, обрыв потока, таймаут → 1 POST и BOT.turnFailed",
    run: () => guarded("TG.17", async (w) => {
      const m = await loadAll({ core: () => L.bot("core"), copy: () => L.present("copy") });
      if (!m.ok) return fail(`бота нет: ${m.detail}`);
      const { core, copy } = m.mods;
      const { serviceRestarting: RESTART, turnFailed: FAILED } = copy.BOT;
      const subs = await (async (): Promise<Sub[]> => {
        const subs: Sub[] = [];
        if (!RESTART || !FAILED || RESTART === FAILED)
          subs.push(sub("тексты BOT различимы", false, `BOT.serviceRestarting ${q(RESTART)} и BOT.turnFailed ${q(FAILED)} должны быть непустыми и разными — иначе исход хода не различить`));
        const pauses = (r: Rig) => retryPauses(r.sleeps);

        // (1) два отказа ECONNREFUSED (cause.code), затем ответ
        {
          const OK = "Ответ после рестарта сервера (маркер TG.17)";
          const r = mkRig({ core }, { respond: (p) => { if (p.n <= 2) throw refusedViaCause(); return sseResponse(textChunks(OK)); }, firstUpdateId: 710_000_001 });
          const A = 7000000401;
          const e = await send(r, r.f.message(A, "ОФЗ 26238 (сервер перезапускается)"));
          const probs: string[] = [];
          if (e) probs.push(`${e} — паузы повтора, похоже, ждутся по-настоящему: sleep из CoreDeps не дошёл до runTurn`);
          if (r.srv.posts.length !== 3) probs.push(`POST: ${r.srv.posts.length}, ожидалось 3 (2 отказа ECONNREFUSED + успешный)`);
          if (canonical(pauses(r)) !== canonical([2000, 8000])) probs.push(`паузы повтора ${brief(pauses(r))}, ожидались [2000, 8000] (все паузы sleep: ${brief(r.sleeps.slice(0, 12))})`);
          if (uniq(r.srv.posts.map((p) => p.raw)).length > 1) probs.push(`повторный POST несёт другое тело: ${diff(r.srv.posts[0]?.body, r.srv.posts.at(-1)?.body, { labels: ["POST 1", "последний POST"] })}`);
          if (!sentTexts(r.tg, A).some((t) => t.includes(OK))) probs.push(`ответ ${q(OK)} не доставлен; вызовы Telegram: ${r.tg.summary()}`);
          if (sentExactly(r.tg, A, RESTART) || sentExactly(r.tg, A, FAILED)) probs.push(`после успешного повтора пользователь получил сообщение об ошибке; вызовы: ${r.tg.summary()}`);
          subs.push(sub("два отказа ECONNREFUSED (в cause.code), затем ответ → 3 POST, паузы 2 и 8 с, ответ доставлен", !probs.length, probs.join("; ")));
        }
        // (2) всегда ECONNREFUSED (code на ошибке) → 4 POST, BOT.serviceRestarting, реплики в истории нет
        {
          const T1 = "реплика при лежащем сервере";
          const r = mkRig({ core }, { respond: () => { throw refusedDirect(); }, firstUpdateId: 720_000_001 });
          const A = 7000000402;
          const e = await send(r, r.f.message(A, T1));
          const probs: string[] = [];
          if (e) probs.push(`${e} — паузы повтора, похоже, ждутся по-настоящему: sleep из CoreDeps не дошёл до runTurn`);
          if (r.srv.posts.length !== 4) probs.push(`POST: ${r.srv.posts.length}, ожидалось 4 (1 + 3 повтора)`);
          if (canonical(pauses(r)) !== canonical(RETRY_PAUSES)) probs.push(`паузы повтора ${brief(pauses(r))}, ожидались [2000, 8000, 20000]`);
          if (sentExactly(r.tg, A, RESTART) !== 1) probs.push(`BOT.serviceRestarting ${q(RESTART)} отправлен ${sentExactly(r.tg, A, RESTART)} раз, ожидался 1; вызовы: ${r.tg.summary()}`);
          let hist: string[] = [];
          try { hist = (r.core.peek(A)?.messages ?? []).filter((x) => x.role === "user").map((x) => collapseWs(x.parts.map((p) => (p.type === "text" ? p.text : "")).join(" "))); } catch (er) { probs.push(`peek бросил ${errText(er)}`); }
          if (hist.includes(T1)) probs.push(`реплика ${q(T1)} осталась в истории (peek) — после исчерпания повторов её нужно убрать`);
          r.srv.respond = defaultRespond;
          const T2 = "реплика после подъёма сервера";
          const e2 = await send(r, r.f.message(A, T2));
          const p = r.srv.posts[4];
          if (e2) probs.push(`следующее сообщение: ${e2}`);
          else if (!p) probs.push(`следующее сообщение не дало POST (всего ${r.srv.posts.length})`);
          else if (userTexts(p.body).includes(T1)) probs.push(`в теле следующего хода снова реплика ${q(T1)}: ${brief(userTexts(p.body))} — она не убрана из истории`);
          else if (!userTexts(p.body).includes(T2)) probs.push(`в теле следующего хода нет новой реплики ${q(T2)}: ${brief(userTexts(p.body))}`);
          subs.push(sub("ECONNREFUSED всегда (code на ошибке) → 4 POST, паузы 2/8/20 с, BOT.serviceRestarting, реплики в истории нет", !probs.length, probs.join("; ")));
        }
        // (3)–(5) HTTP 500, обрыв потока, таймаут → 1 POST, BOT.turnFailed, реплика остаётся в истории (§4.4, как AbstractChat)
        const oneShot = async (name: string, chatId: number, upd0: number, respond: Responder, config: Partial<BotConfig> = {}) => {
          const T1 = `реплика: ${name}`;
          const r = mkRig({ core }, { respond, config, firstUpdateId: upd0 });
          const e = await send(r, r.f.message(chatId, T1));
          const probs: string[] = [];
          if (e) probs.push(e);
          if (r.srv.posts.length !== 1) probs.push(`POST: ${r.srv.posts.length}, ожидался ровно 1 (повтор только при ECONNREFUSED)`);
          if (pauses(r).length) probs.push(`были паузы повтора ${brief(pauses(r))}`);
          if (sentExactly(r.tg, chatId, FAILED) !== 1) probs.push(`BOT.turnFailed ${q(FAILED)} отправлен ${sentExactly(r.tg, chatId, FAILED)} раз, ожидался 1; вызовы: ${r.tg.summary()}`);
          r.srv.respond = defaultRespond;
          const e2 = await send(r, r.f.message(chatId, "следующая реплика"));
          const p = r.srv.posts[1];
          if (e2) probs.push(`следующее сообщение: ${e2}`);
          else if (!p) probs.push(`следующее сообщение не дало POST`);
          else if (!userTexts(p.body).includes(T1)) probs.push(`в теле следующего хода нет реплики неудачного хода ${q(T1)} (${brief(userTexts(p.body))}) — она должна остаться в истории (§4.4)`);
          return sub(`${name} → 1 POST, BOT.turnFailed, реплика остаётся в истории`, !probs.length, probs.join("; "));
        };
        subs.push(await oneShot("HTTP 500", 7000000403, 730_000_001, () => new Response("Internal Server Error", { status: 500 })));
        subs.push(await oneShot("обрыв потока после 4 чанков", 7000000404, 740_000_001, () => sseResponse(textChunks("начало ответа, затем обрыв"), { breakAfter: 4 })));
        subs.push(await oneShot("таймаут хода (turnTimeoutMs 300, поток завис)", 7000000405, 750_000_001,
          (p) => stalledResponse(textChunks("думаю…").slice(0, 4), p.signal), { turnTimeoutMs: 300 }));
        // (6) другая сетевая ошибка (ECONNRESET) — без повтора
        {
          const r = mkRig({ core }, { respond: () => { throw resetViaCause(); }, firstUpdateId: 760_000_001 });
          const A = 7000000406;
          const e = await send(r, r.f.message(A, "реплика при сбросе соединения"));
          const told = sentExactly(r.tg, A, FAILED) + sentExactly(r.tg, A, RESTART);
          const probs: string[] = [];
          if (e) probs.push(e);
          if (r.srv.posts.length !== 1) probs.push(`POST: ${r.srv.posts.length}, ожидался 1 — повтор только при ECONNREFUSED, а здесь ECONNRESET`);
          if (pauses(r).length) probs.push(`были паузы повтора ${brief(pauses(r))}`);
          if (!told) probs.push(`пользователь не получил сообщения о сбое; вызовы: ${r.tg.summary()}`);
          subs.push(sub("ECONNRESET (не ECONNREFUSED) → 1 POST, без пауз", !probs.length, probs.join("; ")));
        }
        return subs;
      })();
      subs.push(...(await w.settle())); // unhandledRejection, исключения вне await, глобальный fetch, process.exit — пунктами проверки
      return verdict(subs);
    }),
  };

  /* ─────────────── TG.18 ─────────────── */
  const TG18: Check = {
    id: "TG.18", wp: "TG", kind: "unit",
    title: "Сбои Telegram: 429 → пауза retry_after и повтор (≤ 3), «can't parse entities» → тот же текст без HTML, токен в журнале → <redacted>; 403, «message to edit not found», HttpError, 429×4 не роняют ход и следующий ход",
    run: () => guarded("TG.18", async (w) => {
      const m = await loadAll({ core: () => L.bot("core"), telegram: () => L.bot("telegram"), log: () => L.bot("log") });
      if (!m.ok) return fail(`бота нет: ${m.detail}`);
      const { core, telegram, log } = m.mods;
      const E = await tgErrors();
      const subs = await (async (): Promise<Sub[]> => {
        const subs: Sub[] = [];
        const tooMany = (s = 3, method = "sendMessage") => E.api(429, `Too Many Requests: retry after ${s}`, s, method);
        const cantParse = (method = "sendMessage") => E.api(400, "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 0", undefined, method);

        // (1) withTelegramPolicy: 429 retry_after 3 → пауза 3000 и повтор
        {
          const raw = new FakeTg();
          const { log: sl, sleep } = sleeper();
          const recs: LogRec[] = [];
          raw.inject({ method: "sendMessage", error: () => tooMany(3), times: 1 });
          const w = telegram.withTelegramPolicy(raw, { sleep, log: (r) => { recs.push(r); } });
          const res = await within(w.sendMessage(7000000501, "текст после 429"), 5000);
          const sends = raw.calls.filter((c) => c.method === "sendMessage");
          const probs: string[] = [];
          if (!res.ok) probs.push(`sendMessage ${whyNot(res, 5000)}`);
          else if (res.v?.message_id !== sends[1]?.messageId) probs.push(`вернул ${brief(res.v)}, ожидался message_id ${sends[1]?.messageId} второй попытки`);
          if (sends.length !== 2) probs.push(`попыток sendMessage ${sends.length}, ожидалось 2 (429, затем успех)`);
          if (canonical(sl) !== canonical([3000])) probs.push(`паузы ${brief(sl)}, ожидалась одна 3000 мс (retry_after 3)`);
          subs.push(sub("429 с retry_after 3 → пауза 3000 мс и повтор", !probs.length, probs.join("; ")));
        }
        // (2) 429 четыре раза подряд → 3 повтора, затем ошибка
        {
          const raw = new FakeTg();
          const { log: sl, sleep } = sleeper();
          raw.inject({ method: "sendMessage", error: () => tooMany(3), times: 4 });
          const w = telegram.withTelegramPolicy(raw, { sleep, log: () => {} });
          const res = await within(w.sendMessage(7000000502, "текст"), 5000);
          const sends = raw.calls.filter((c) => c.method === "sendMessage").length;
          const probs: string[] = [];
          if (res.ok) probs.push(`sendMessage разрешился ${brief(res.v)} — после 3 повторов ошибка должна уйти вызывающему (ядро запишет tg_error)`);
          else if (res.timeout) probs.push(`sendMessage не завершился за 5000 мс`);
          if (sends !== 4) probs.push(`попыток ${sends}, ожидалось 4 (1 + не больше 3 повторов)`);
          if (canonical(sl) !== canonical([3000, 3000, 3000])) probs.push(`паузы ${brief(sl)}, ожидались [3000, 3000, 3000]`);
          subs.push(sub("429 четыре раза подряд → не больше 3 повторов, затем ошибка", !probs.length, probs.join("; ")));
        }
        // (3) 400 «can't parse entities» → тот же текст без HTML (sendMessage и editMessageText), клавиатура сохраняется, событие в журнале
        {
          const H = "<b>ВЭБ.РФ 21</b> <code>RU000A0JS4Z7</code>\n<i>Данные &amp; цены</i> &lt;x&gt;";
          const PLAIN = tgPlain(H);
          const KB: InlineKeyboard = { inline_keyboard: [[{ text: "ЧеркизБ1P7", callback_data: "pk:RU000A1094F2" }]] };
          const probs: string[] = [];
          for (const method of ["sendMessage", "editMessageText"] as const) {
            const raw = new FakeTg();
            const recs: LogRec[] = [];
            const { sleep } = sleeper();
            const { message_id } = await raw.sendMessage(7000000503, "заглушка");
            const from = raw.calls.length;
            raw.inject({ method, error: () => cantParse(method), times: 1, when: (c) => !!(c as { opts?: { html?: boolean } }).opts?.html });
            const w = telegram.withTelegramPolicy(raw, { sleep, log: (r) => { recs.push(r); } });
            const res = await within<unknown>(method === "sendMessage" ? w.sendMessage(7000000503, H, { html: true, keyboard: KB }) : w.editMessageText(7000000503, message_id, H, { html: true, keyboard: KB }), 5000);
            const tries = raw.calls.slice(from).filter((c) => c.method === method) as (TgCall & { text: string; opts?: { html?: boolean; keyboard?: InlineKeyboard } })[];
            const second = tries[1];
            if (!res.ok) probs.push(`${method}: ${whyNot(res, 5000)}`);
            if (tries.length !== 2) probs.push(`${method}: попыток ${tries.length}, ожидалось 2 (HTML, затем простой текст); вызовы: ${raw.summary(from)}`);
            else {
              if (second.opts?.html) probs.push(`${method}: вторая попытка снова с HTML`);
              if (second.text !== PLAIN) probs.push(`${method}: вторая попытка ${q(second.text)}, ожидался тот же текст без HTML ${q(PLAIN)}`);
              if (canonical(second.opts?.keyboard ?? null) !== canonical(KB)) probs.push(`${method}: во второй попытке потеряна клавиатура (${brief(second.opts?.keyboard ?? null)}) — без неё не выбрать выпуск`);
            }
            if (!recs.length) probs.push(`${method}: откат на простой текст не записан в журнал (§4.7: «событие пишется в журнал»)`);
          }
          subs.push(sub("400 «can't parse entities» → тот же текст без HTML (sendMessage и editMessageText), клавиатура на месте, запись в журнал", !probs.length, probs.join("; ")));
        }
        // (4) makeLogger: токен, ключ и соль в тексте ошибки → <redacted>; «bot<цифры>:…» вырезается и без списка секретов
        {
          const probs: string[] = [];
          const lines: string[] = [];
          const lg = log.makeLogger((l) => { lines.push(l); }, [TG_TEST.token, TG_TEST.botKey, TG_TEST.salt]);
          lg({ ev: "tg_error", status: "net", err: `HttpError: Network request for 'sendMessage' failed! https://api.telegram.org/bot${TG_TEST.token}/sendMessage key=${TG_TEST.botKey} salt=${TG_TEST.salt}` });
          const l1 = lines.join("\n");
          const tokenSecret = TG_TEST.token.split(":")[1];
          if (!l1.includes("tg_error")) probs.push(`строка журнала без ev: ${q(l1, 200)}`);
          if (!l1.includes("<redacted>")) probs.push(`в строке нет <redacted>: ${q(l1, 200)}`);
          for (const [what, s] of [["токен", TG_TEST.token], ["секретная часть токена", tokenSecret], ["SO_BOT_KEY", TG_TEST.botKey], ["соль", TG_TEST.salt]] as const)
            if (l1.includes(s)) probs.push(`в строке журнала есть ${what}: ${q(l1, 200)}`);
          const other: string[] = [];
          log.makeLogger((l) => { other.push(l); }, [])({ ev: "tg_error", err: "GET https://api.telegram.org/bot5550001234:XYZ-other_token-1/getMe failed" });
          const l2 = other.join("\n");
          if (l2.includes("XYZ-other_token-1") || l2.includes("5550001234:")) probs.push(`токен вида «bot<цифры>:…» вне списка секретов не вырезан: ${q(l2, 200)}`);
          if (!l2.includes("<redacted>")) probs.push(`вместо токена вне списка нет <redacted>: ${q(l2, 200)}`);
          subs.push(sub("ошибка с токеном в тексте → в журнале <redacted> (makeLogger)", !probs.length, probs.join("; ")));
        }
        // (5)–(8) ошибки доставки в ядре (§4.4): ход с отчётом veb, затем следующий ход того же чата
        const veb = ssrInputs().find((s) => s.name === "veb")?.result;
        if (!veb) throw new Error("дефект харнеса: нет golden veb");
        const MARK = "Отчёт выше (маркер TG.18)";
        const delivery = async (name: string, chatId: number, upd0: number, inject: (tg: FakeTg) => void, extra: (r: Rig, turnFrom: number, turnTo: number) => string[]) => {
          const r = mkRig({ core, telegram, log }, { respond: () => sseResponse(reportChunks("ВЭБ.РФ 21", veb, MARK)), firstUpdateId: upd0 });
          inject(r.tg);
          const probs: string[] = [];
          const turnFrom = r.tg.calls.length;
          const h = await handle(r, r.f.message(chatId, "ВЭБ.РФ 21"));
          if (!h.ok) probs.push(`await handleUpdate ${whyNot(h, HANDLE_MS)} (должен разрешаться всегда)`);
          const i = await within(r.core.idle(), HANDLE_MS);
          if (!i.ok) probs.push(`idle() ${whyNot(i, HANDLE_MS)}`);
          const turnTo = r.tg.calls.length;
          const failed = r.tg.calls.slice(turnFrom, turnTo).filter((c) => c.error);
          if (!failed.length) probs.push(`внедрённая ошибка не сработала: ядро не вызвало нужный метод; вызовы: ${r.tg.summary(turnFrom)}`);
          if (!r.recs.some((x) => x.ev === "tg_error")) probs.push(`в журнале нет ev:"tg_error" (записи: ${brief(r.recs.map((x) => x.ev))})`);
          const leaked = r.lines.filter((l) => l.includes(TG_TEST.token) || l.includes(TG_TEST.token.split(":")[1]) || l.includes(TG_TEST.botKey));
          if (leaked.length) probs.push(`в строке журнала секрет: ${q(leaked[0], 160)}`);
          if (failed.length) probs.push(...extra(r, turnFrom, turnTo));
          r.tg.clearInjections();
          const before = r.srv.posts.length;
          const e2 = await send(r, r.f.message(chatId, "ты уверен?"));
          const p = r.srv.posts[before];
          if (e2) probs.push(`следующий ход: ${e2}`);
          else if (r.srv.posts.length - before !== 1) probs.push(`следующий ход дал POST: ${r.srv.posts.length - before}, ожидался ровно 1`);
          else if (!hasAssistantText(p?.body ?? null, MARK)) probs.push(`тело следующего хода без ассистентского сообщения прошлого хода (${q(MARK)}): ошибка доставки откатила историю (§4.4: ответ пишется в историю до доставки)`);
          return sub(name, !probs.length, probs.join("; "));
        };
        subs.push(await delivery("403 «bot was blocked by the user» на sendMessage → оставшиеся сообщения хода не отправляются", 7000000511, 810_000_001,
          (tg) => tg.inject({ method: "sendMessage", error: () => E.api(403, "Forbidden: bot was blocked by the user", undefined, "sendMessage"), times: 1 }),
          (r, a, b) => {
            const idx = r.tg.calls.findIndex((c, k) => k >= a && c.error);
            const after = delivered(r.tg, 7000000511, idx + 1).filter(({ i }) => i < b);
            return after.length ? [`после 403 в том же ходе ещё ${after.length} сообщений: ${r.tg.summary(idx)}`] : [];
          }));
        subs.push(await delivery("400 «message to edit not found» на editMessageText → отчёт новым sendMessage", 7000000512, 820_000_001,
          (tg) => tg.inject({ method: "editMessageText", error: () => E.api(400, "Bad Request: message to edit not found", undefined, "editMessageText"), times: 1 }),
          (r, a, b) => {
            const bad = r.tg.calls.slice(a, b).find((c): c is Extract<TgCall, { method: "editMessageText" }> => c.method === "editMessageText" && !!c.error);
            if (!bad) return [`ошибка пришлась не на editMessageText: ${r.tg.summary(a)}`];
            const k = r.tg.calls.indexOf(bad);
            const re = r.tg.calls.slice(k + 1, b).find((c) => c.method === "sendMessage" && !c.error && c.text === bad.text);
            return re ? [] : [`после «message to edit not found» отчёт не отправлен новым sendMessage с тем же текстом; вызовы: ${r.tg.summary(k)}`];
          }));
        subs.push(await delivery("HttpError на sendMessage (с токеном в тексте) → сообщение пропущено, следующие идут", 7000000513, 830_000_001,
          (tg) => tg.inject({ method: "sendMessage", error: () => E.http("sendMessage", `(https://api.telegram.org/bot${TG_TEST.token}/sendMessage) connect ETIMEDOUT`), times: 1 }),
          (r, a, b) => {
            const idx = r.tg.calls.findIndex((c, k) => k >= a && c.error);
            return delivered(r.tg, 7000000513, idx + 1).some(({ i }) => i < b) ? [] : [`после сетевой ошибки остальные сообщения хода не ушли: ${r.tg.summary(idx)}`];
          }));
        subs.push(await delivery("429 четыре раза подряд на sendMessage → после 3 повторов сообщение пропущено, следующие идут", 7000000514, 840_000_001,
          (tg) => tg.inject({ method: "sendMessage", error: () => tooMany(1), times: 4 }),
          (r, a, b) => {
            const errs = r.tg.calls.slice(a, b).filter((c) => c.error).length;
            const lastErr = r.tg.calls.reduce((acc, c, k) => (k >= a && k < b && c.error ? k : acc), -1);
            const out: string[] = [];
            if (errs !== 4) out.push(`ошибок 429 в ходе ${errs}, ожидалось 4 (1 + 3 повтора withTelegramPolicy); вызовы: ${r.tg.summary(a)}`);
            if (!delivered(r.tg, 7000000514, lastErr + 1).some(({ i }) => i < b)) out.push(`после исчерпания повторов остальные сообщения хода не ушли: ${r.tg.summary(Math.max(a, lastErr))}`);
            return out;
          }));
        return subs;
      })();
      subs.push(...(await w.settle())); // нет unhandledRejection (process.on на время кейсов), исключений вне await, глобального fetch, process.exit
      return verdict(subs, ` | ошибки Telegram: ${E.real ? "настоящие GrammyError/HttpError" : "фейки формы GrammyError/HttpError (grammy не установлен)"}`);
    }),
  };

  /* ─────────────── TG.19 ─────────────── */
  const TG19: Check = {
    id: "TG.19", wp: "TG", kind: "unit",
    title: "Доступ и лимиты: allow \"\" — никого, \"*\" — всех, список — только своих (остальным код доступа); 3-й ход за сутки МСК при dailyTurns 2 → BOT.dailyLimit без POST; group/supergroup — игнор; фото/голос/документ → BOT.onlyText",
    run: () => guarded("TG.19", async (w) => {
      const m = await loadAll({ core: () => L.bot("core"), limits: () => L.bot("limits"), copy: () => L.present("copy") });
      if (!m.ok) return fail(`бота нет: ${m.detail}`);
      const { core, limits, copy } = m.mods;
      const BOT = copy.BOT;
      const subs = await (async (): Promise<Sub[]> => {
        const subs: Sub[] = [];
        // (1) isAllowed
        {
          const a = pseudonym(7000000601), b = pseudonym(7000000602), c = pseudonym(7000000603);
          const vec: [string, string, boolean][] = [
            [a, "", false], [a, "*", true], [a, `${a},${b}`, true], [b, `${a},${b}`, true], [c, `${a},${b}`, false],
            [a.slice(0, 6), a, false], [a, `${a}x`, false], [a, b, false],
          ];
          const bad = vec.filter(([p, al, want]) => limits.isAllowed(p, al) !== want);
          subs.push(sub("isAllowed: \"\" — никто, \"*\" — все, список через запятую — точное совпадение", !bad.length,
            bad.map(([p, al, want]) => `isAllowed(${q(p)}, ${q(al, 40)}) = ${!want}, ожидалось ${want}`).join("; ")));
        }
        // (2) DailyLimit: сутки по МСК (UTC+3), а не по UTC
        {
          const clock = { t: Date.UTC(2026, 9, 15, 20, 50) }; // 23:50 МСК 15.10
          const dl = new limits.DailyLimit(2, () => clock.t);
          const seq1 = [dl.take("p"), dl.take("p"), dl.take("p"), dl.take("q")];
          clock.t = Date.UTC(2026, 9, 15, 21, 5); // 00:05 МСК 16.10 (по UTC ещё 15.10)
          const nextMsk = dl.take("p");
          const clock2 = { t: Date.UTC(2026, 9, 15, 21, 10) }; // 00:10 МСК 16.10
          const dl2 = new limits.DailyLimit(2, () => clock2.t);
          const seq2 = [dl2.take("p"), dl2.take("p"), dl2.take("p")];
          clock2.t = Date.UTC(2026, 9, 16, 0, 30); // 03:30 МСК 16.10 (по UTC уже 16.10)
          const sameMsk = dl2.take("p");
          const probs: string[] = [];
          if (canonical(seq1) !== canonical([true, true, false, true])) probs.push(`23:50 МСК: take p,p,p,q = ${brief(seq1)}, ожидалось [true,true,false,true]`);
          if (nextMsk !== true) probs.push(`00:05 МСК следующих суток (по UTC — те же сутки): take = ${nextMsk}, ожидалось true — сутки считаются не по МСК`);
          if (canonical(seq2) !== canonical([true, true, false])) probs.push(`00:10 МСК: take ×3 = ${brief(seq2)}, ожидалось [true,true,false]`);
          if (sameMsk !== false) probs.push(`03:30 МСК тех же суток (по UTC — новые сутки): take = ${sameMsk}, ожидалось false — сутки считаются не по МСК`);
          subs.push(sub("DailyLimit(2): третий ход за сутки МСК — отказ, после 00:00 МСК — снова можно", !probs.length, probs.join("; ")));
        }
        // (3) ядро: allow ""
        {
          const r = mkRig({ core }, { config: { allow: "" }, firstUpdateId: 910_000_001 });
          const A = 7000000611;
          const e = await send(r, r.f.message(A, "ОФЗ 26238"));
          const want = BOT.notAllowed(pseudonym(A));
          const probs: string[] = [];
          if (e) probs.push(e);
          if (r.srv.posts.length) probs.push(`POST: ${r.srv.posts.length}, ожидалось 0`);
          if (!sentExactly(r.tg, A, want)) probs.push(`нет ответа BOT.notAllowed(код доступа) ${q(want)}; вызовы: ${r.tg.summary()}`);
          subs.push(sub("allow \"\" → никого: отказ с кодом доступа (псевдоним), без POST", !probs.length, probs.join("; ")));
        }
        // (4) ядро: allow "*"
        {
          const r = mkRig({ core }, { config: { allow: "*" }, firstUpdateId: 920_000_001 });
          const e = await send(r, r.f.message(7000000612, "ОФЗ 26238"));
          const ok = !e && r.srv.posts.length === 1;
          subs.push(sub("allow \"*\" → все: сообщение уходит в сервер", ok, e ?? (ok ? "" : `POST: ${r.srv.posts.length}, ожидался 1; вызовы: ${r.tg.summary()}`)));
        }
        // (5) ядро: список
        {
          const A = 7000000613, B = 7000000614;
          const r = mkRig({ core }, { config: { allow: `${pseudonym(7000000699)},${pseudonym(A)}` }, firstUpdateId: 930_000_001 });
          const eA = await send(r, r.f.message(A, "ОФЗ 26238"));
          const eB = await send(r, r.f.message(B, "ОФЗ 26238"));
          const want = BOT.notAllowed(pseudonym(B));
          const probs: string[] = [];
          if (eA || eB) probs.push([eA, eB].filter(Boolean).join("; "));
          if (r.srv.posts.length !== 1) probs.push(`POST: ${r.srv.posts.length}, ожидался 1 (только чат из списка)`);
          if (!sentExactly(r.tg, B, want)) probs.push(`чату не из списка нет BOT.notAllowed(его код) ${q(want)}; вызовы: ${r.tg.summary()}`);
          if (sentExactly(r.tg, A, BOT.notAllowed(pseudonym(A)))) probs.push(`чат из списка получил отказ`);
          subs.push(sub("allow = список псевдонимов → только перечисленные; остальным отказ с их кодом", !probs.length, probs.join("; ")));
        }
        // (6) ядро: dailyTurns 2, часы МСК внедрены
        {
          const clock = { t: Date.UTC(2026, 9, 15, 20, 58) }; // 23:58 МСК
          const r = mkRig({ core }, { config: { dailyTurns: 2 }, now: () => clock.t, firstUpdateId: 940_000_001 });
          const A = 7000000615;
          const errs: string[] = [];
          for (const t of ["ход 1", "ход 2"]) { const e = await send(r, r.f.message(A, t)); if (e) errs.push(e); }
          const posts2 = r.srv.posts.length;
          const e3 = await send(r, r.f.message(A, "ход 3"));
          const posts3 = r.srv.posts.length;
          const limitMsg = sentExactly(r.tg, A, BOT.dailyLimit(2));
          clock.t = Date.UTC(2026, 9, 15, 21, 2); // 00:02 МСК следующих суток
          const e4 = await send(r, r.f.message(A, "ход на следующие сутки"));
          const probs: string[] = [];
          for (const e of [...errs, e3, e4]) if (e) probs.push(e);
          if (posts2 !== 2) probs.push(`первые два хода: POST ${posts2}, ожидалось 2`);
          if (posts3 !== 2) probs.push(`третий ход за сутки ушёл в сервер (POST ${posts3})`);
          if (limitMsg !== 1) probs.push(`BOT.dailyLimit(2) ${q(BOT.dailyLimit(2))} отправлен ${limitMsg} раз, ожидался 1; вызовы: ${r.tg.summary()}`);
          if (r.srv.posts.length !== 3) probs.push(`после 00:00 МСК ход не пошёл: POST ${r.srv.posts.length}, ожидалось 3`);
          subs.push(sub("dailyTurns 2: третий ход за сутки МСК → BOT.dailyLimit без POST, в следующие сутки ходы идут", !probs.length, probs.join("; ")));
        }
        // (7) ядро: group и supergroup — игнор
        {
          const r = mkRig({ core }, { firstUpdateId: 950_000_001 });
          const G = 7000000616;
          const errs: string[] = [];
          for (const chatType of ["group", "supergroup"] as const) {
            for (const t of ["/start", "ОФЗ 26238"]) { const e = await send(r, r.f.message(G, t, { chatType })); if (e) errs.push(e); }
            const e = await send(r, r.f.callback(G, "sg:0", { messageId: 5 }, { chatType })); if (e) errs.push(e);
          }
          const sends = r.tg.calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText");
          const probs: string[] = [...errs];
          if (r.srv.posts.length) probs.push(`POST из группового чата: ${r.srv.posts.length}`);
          if (sends.length) probs.push(`бот ответил в групповой чат: ${r.tg.summary()}`);
          const ctl = await send(r, r.f.message(7000000617, "ОФЗ 26238"));
          if (ctl || r.srv.posts.length !== 1) probs.push(`контроль (private-чат тем же ядром): ${ctl ?? `POST ${r.srv.posts.length}, ожидался 1`}`);
          subs.push(sub("group и supergroup (сообщения, /start, кнопки) → игнор", !probs.length, probs.join("; ")));
        }
        // (8) ядро: не текст → BOT.onlyText без POST
        {
          const r = mkRig({ core }, { firstUpdateId: 960_000_001 });
          const A = 7000000618;
          const errs: string[] = [];
          for (const kind of ["photo", "voice", "document"] as const) { const e = await send(r, r.f.nonText(A, kind)); if (e) errs.push(`${kind}: ${e}`); }
          const n = sentExactly(r.tg, A, BOT.onlyText);
          const probs: string[] = [...errs];
          if (r.srv.posts.length) probs.push(`POST: ${r.srv.posts.length}, ожидалось 0`);
          if (n !== 3) probs.push(`BOT.onlyText ${q(BOT.onlyText)} отправлен ${n} раз, ожидалось 3 (фото, голос, документ); вызовы: ${r.tg.summary()}`);
          subs.push(sub("фото, голос, документ → BOT.onlyText без POST", !probs.length, probs.join("; ")));
        }
        return subs;
      })();
      subs.push(...(await w.settle())); // unhandledRejection, исключения вне await, глобальный fetch, process.exit — пунктами проверки
      return verdict(subs);
    }),
  };

  return [TG8, TG10, TG16, TG17, TG18, TG19];
}

/* ═══════════════════════════ TG.16: ChatQueues напрямую ═══════════════════════════ */

async function queueUnits(Q: QueueMod["ChatQueues"]): Promise<Sub[]> {
  const subs: Sub[] = [];
  // (1) 6 ключей при concurrency 4
  {
    const q4 = new Q({ concurrency: 4, perChatPending: 2 });
    const gates = Array.from({ length: 6 }, deferred);
    let started = 0, cur = 0, maxIn = 0;
    const runs = gates.map((g, i) => q4.run(`chat${i}`, async () => { started++; cur++; maxIn = Math.max(maxIn, cur); await g.p; cur--; }));
    await until(() => started >= 4, 1000);
    await tick(40);
    const s1 = started, inF = q4.inFlight();
    gates[0].resolve();
    await until(() => started >= 5, 1000);
    await tick(20);
    const s2 = started;
    gates.forEach((g) => g.resolve());
    const res = await within(Promise.all(runs), 3000);
    const idle = await within(q4.idle(), 3000);
    const probs: string[] = [];
    if (s1 !== 4) probs.push(`при 6 ключах и concurrency 4 стартовало ${s1} задач, ожидалось 4`);
    if (inF > 4) probs.push(`inFlight() = ${inF} > 4`);
    if (s2 !== 5) probs.push(`после завершения одной задачи стартовало ${s2}, ожидалось 5`);
    if (maxIn > 4) probs.push(`одновременно выполнялось ${maxIn} > 4`);
    if (!res.ok) probs.push(`run ${whyNot(res, 3000)}`);
    else if (!res.v.every((x) => x === "done")) probs.push(`run вернул ${brief(res.v)}, ожидалось "done" ×6`);
    if (!idle.ok) probs.push(`idle() ${whyNot(idle, 3000)}`);
    subs.push(sub("ChatQueues: 6 ключей при concurrency 4 → выполняется не больше 4", !probs.length, probs.join("; ")));
  }
  // (2) один ключ — последовательно
  {
    const q = new Q({ concurrency: 4, perChatPending: 2 });
    const g1 = deferred();
    let second = false;
    const r1 = q.run("a", async () => { await g1.p; });
    const r2 = q.run("a", async () => { second = true; });
    await tick(40);
    const early = second;
    g1.resolve();
    const res = await within(Promise.all([r1, r2]), 3000);
    const probs: string[] = [];
    if (early) probs.push(`вторая задача ключа "a" стартовала, пока первая не завершилась`);
    if (!res.ok) probs.push(`run ${whyNot(res, 3000)}`);
    else if (!second || canonical(res.v) !== canonical(["done", "done"])) probs.push(`результаты ${brief(res.v)}, вторая выполнена: ${second}`);
    subs.push(sub("ChatQueues: задачи одного ключа — строго по очереди", !probs.length, probs.join("; ")));
  }
  // (3) сверх perChatPending → "busy" сразу, без выполнения
  {
    const q = new Q({ concurrency: 4, perChatPending: 2 });
    const g1 = deferred();
    const ran: number[] = [];
    const settled: (string | null)[] = [null, null, null, null, null];
    const runs = [0, 1, 2, 3, 4].map((i) => {
      const p = q.run("a", async () => { ran.push(i + 1); if (i === 0) await g1.p; });
      void p.then((v) => { settled[i] = v; }, () => { settled[i] = "отклонён"; });
      return p;
    });
    await tick(40);
    const early = [...settled];
    g1.resolve();
    const res = await within(Promise.all(runs), 3000);
    const firstBusy = early.findIndex((v) => v === "busy");
    const probs: string[] = [];
    if (firstBusy < 0) probs.push(`при 1 выполняемой и 4 ожидающих задачах ключа ни одна не получила "busy" сразу (результаты до освобождения: ${brief(early)})`);
    else {
      if (firstBusy !== 2 && firstBusy !== 3) probs.push(`первый "busy" у задачи ${firstBusy + 1}; при perChatPending 2 — у 3-й или 4-й`);
      if (early.slice(firstBusy).some((v) => v !== "busy")) probs.push(`после первого "busy" не все следующие "busy": ${brief(early)}`);
      if (early.slice(1, firstBusy).some((v) => v !== null)) probs.push(`задачи в очереди разрешились до освобождения: ${brief(early)}`);
    }
    if (!res.ok) probs.push(`run ${whyNot(res, 3000)}`);
    else {
      const busyIdx = res.v.map((v, i) => (v === "busy" ? i + 1 : 0)).filter(Boolean);
      if (ran.some((i) => busyIdx.includes(i))) probs.push(`задачи с "busy" всё равно выполнены: ${brief(ran)}`);
      if (res.v.filter((v) => v === "done").length !== ran.length) probs.push(`"done" ${res.v.filter((v) => v === "done").length}, выполнено ${ran.length}`);
    }
    subs.push(sub("ChatQueues: сверх perChatPending → \"busy\" сразу, задача не выполняется", !probs.length, probs.length ? probs.join("; ") : `"busy" с задачи ${firstBusy + 1}`));
  }
  // (4) упавшая задача: run не отклоняется, слот освобождается, следующая задача того же ключа выполняется
  {
    const q = new Q({ concurrency: 1, perChatPending: 2 });
    const r1 = await within(q.run("x", async () => { throw new Error("аудит TG.16: job упал"); }), 2000);
    const r1s = await within(q.run("x", (() => { throw new Error("аудит TG.16: job упал синхронно"); }) as unknown as () => Promise<void>), 2000);
    let ran2 = false, ran3 = false;
    const r2 = await within(q.run("x", async () => { ran2 = true; }), 2000);
    const r3 = await within(q.run("y", async () => { ran3 = true; }), 2000);
    const idle = await within(q.idle(), 2000);
    const inF = q.inFlight();
    const probs: string[] = [];
    if (!r1.ok) probs.push(`run с упавшей задачей ${whyNot(r1, 2000)} — должен разрешиться`);
    if (!r1s.ok) probs.push(`run с задачей, бросившей синхронно, ${whyNot(r1s, 2000)}`);
    if (!r2.ok || !ran2) probs.push(`следующий run того же ключа: ${r2.ok ? `разрешился ${brief(r2.v)}, но задача не выполнена` : whyNot(r2, 2000)}`);
    if (!r3.ok || !ran3) probs.push(`run другого ключа при concurrency 1: ${r3.ok ? "задача не выполнена" : whyNot(r3, 2000)} — слот не освобождён`);
    if (!idle.ok) probs.push(`idle() ${whyNot(idle, 2000)}`);
    if (inF !== 0) probs.push(`inFlight() после всего = ${inF}`);
    subs.push(sub("ChatQueues: job бросил исключение → run не отклоняется, слот свободен, следующий run ключа выполняется", !probs.length, probs.join("; ")));
  }
  return subs;
}

export const checks: Check[] = makeUnitChecks();
