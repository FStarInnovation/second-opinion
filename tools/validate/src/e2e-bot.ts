/**
 * E2E Telegram-бота (план WP-TG §5 шаг 6, §7, §13 п. 4) без Telegram и без ключей: настоящий процесс бота
 * (`npm -w @so/bot start`, то есть apps/bot/src/main.ts) + фейковый Bot API (fake-bot-api.ts, 127.0.0.1) + сервер apps/web в MOCK.
 *
 *   tsx src/e2e-bot.ts [--base http://localhost:3000] [--bot-key <ключ>] [--message-limit 20] [--usage-dir <каталог>]
 *   npm run e2e:bot -- --base http://127.0.0.1:<порт> --usage-dir <каталог>
 *
 * Сервер для e2e (тот же, что для e2e-chat, плюс ключ бота). Из корня репозитория:
 *   export SO_BOT_KEY=e2e-$(openssl rand -hex 8)
 *   SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0 npm run web:build
 *   cd apps/web && SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0 SO_BOT_KEY=$SO_BOT_KEY SO_USAGE_DIR=$(mktemp -d) \
 *     ../../node_modules/.bin/next start -H 127.0.0.1 -p 3100
 *   npm run e2e:bot -- --base http://127.0.0.1:3100 --usage-dir <тот же SO_USAGE_DIR>
 * Ключей LLM и Jev в окружении сервера быть не должно (MOCK_LLM=1 их и не читает); SO_MESSAGE_LIMIT не задавать — тогда действует
 * 20 из session.ts, и сценарий лимита ждёт ровно его; иначе передать то же значение в --message-limit (0 — сценарий пропускается).
 * Отдельный Next для лимита не нужен: лимит считается на сессию, а сценарий ведёт свой чат. SO_DAILY_BUDGET_USD — по умолчанию (2):
 * MOCK ничего не тратит. `next dev` тоже годится, но первый запрос каждого маршрута компилируется — таймауты сценариев рассчитаны на
 * `next start`.
 *
 * Защита (как e2e-chat): /api/health сервера ≠ mode "mock" → выход с кодом 2 — сценарии не тратят бюджет живых ключей. Выход 2 и
 * при --base не на loopback (бот шлёт SO_BOT_KEY только на 127.0.0.1/localhost, SO_WEB_URL) и без ключа бота.
 * Ключ бота: --bot-key или SO_BOT_KEY окружения — тот же, что у сервера (иначе сервер отвечает 403 и ходы падают).
 *
 * Бот запускается отдельным процессом с TG_API_ROOT=http://127.0.0.1:<порт фейка>, фиктивным токеном, TG_BOT_USERNAME фейка,
 * SO_TG_ALLOW="*", SO_WEB_URL=--base, SO_SITE_URL=--base и SO_APP_DIR = временный каталог (VERSION = version сервера, там же
 * apps/bot/.state/heartbeat). Журнал бота — его stdout/stderr (на heidi это journalctl -u second-opinion-bot).
 * Сценарии: старт (getMe ok version=…, опрос, heartbeat); /start (приветствие, приватность, кнопки sg); кнопка sg (Черкизово →
 * список выпусков кнопками pk:); кнопка pk: (выбор выпуска → отчёт); реплика с ISIN (заглушка WAIT_REPORT → editMessageText
 * отчётом → текст); продолжение и /new; deep-link /start <payload> (ссылка d6); не-текст → BOT.onlyText; группа — игнор;
 * лимит сообщений сессии (limitText telegram); SIGTERM во время хода → ход доставлен, выход ≤ 30 с; приватность журнала бота
 * (нет chat_id, user_id, имён, текстов реплик и аргументов команд — payload deep-link, токена, ключа, соли) и usage.jsonl
 * (--usage-dir: channel telegram, tg_-сессии без сырых id).
 * SIGTERM получает только процесс npm — как systemd при KillMode=mixed в юните setup.sh: npm передаёт его tsx, tsx — main.ts.
 * Скрипт start исполняет bash (npm_config_script_shell=/bin/bash, как Environment= юнита): bash делает exec, промежуточного sh нет.
 * Почему не вся группа, как при KillMode=control-group по умолчанию: main.ts получил бы SIGTERM дважды — от systemd и от tsx,
 * которому его передал npm, — а второй SIGTERM процесс tsx завершает сразу (exit 143), ход в полёте теряется.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOT, WAIT_REPORT, limitText } from "@so/present/copy";
import { encodeStartPayload, SUGGESTIONS } from "@so/present/entry";
import { CABINET_HREF } from "@so/present/protocol";
import { parseTgHtml, startFakeBotApi, type ApiCall, type FakeBotApi } from "./fake-bot-api";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const BASE = arg("--base", "http://localhost:3000").replace(/\/+$/, "");
const BOT_KEY = arg("--bot-key", process.env.SO_BOT_KEY ?? "");
const MESSAGE_LIMIT = Number(arg("--message-limit", "20"));
const USAGE_DIR = arg("--usage-dir", "");
/** Ожидание одного шага сценария (ход в MOCK — доли секунды; запас на холодный старт маршрута) */
const STEP_MS = 30_000;
/** §4.4: остановка по SIGTERM — не дольше 30 с */
const STOP_MAX_MS = 30_000;

function refuse(msg: string): never { console.error(`e2e-bot: ${msg}`); process.exit(2); }

/* ───── предусловия: loopback, MOCK, ключ бота ───── */
let baseUrl: URL;
try { baseUrl = new URL(BASE); } catch { refuse(`--base ${BASE} — не URL`); }
if (baseUrl!.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(baseUrl!.hostname))
  refuse(`--base ${BASE}: бот ходит только в loopback http (SO_WEB_URL: 127.0.0.1 или localhost) — укажите локальный сервер`);
if (!Number.isInteger(MESSAGE_LIMIT) || MESSAGE_LIMIT < 0) refuse(`--message-limit ${MESSAGE_LIMIT}: ожидалось целое ≥ 0`);
type Health = { mode?: string; version?: string; budget?: { messages?: number } };
const health = async (): Promise<Health | null> =>
  (await fetch(`${BASE}/api/health`, { headers: { accept: "application/json" } }).then((r) => r.json()).catch(() => null)) as Health | null;
const h0 = await health();
if (h0?.mode !== "mock")
  refuse(`${BASE} отвечает mode=${h0?.mode ?? "нет ответа"} — не MOCK. Сценарии тратят бюджет живых ключей: запустите сервер с ` +
    "SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0 и SO_BOT_KEY (см. шапку e2e-bot.ts) и передайте --base на его порт.");
if (typeof h0?.version !== "string" || !h0.version) refuse(`${BASE}/api/health без поля version — сервер старше шага 4 (P3) плана WP-TG; бот сверяет версию и не стартует`);
if (!BOT_KEY) refuse("нет ключа бота: --bot-key или SO_BOT_KEY в окружении — тот же, что SO_BOT_KEY сервера");
const SERVER_VERSION = h0!.version!;

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "ok   " : "FAIL "} ${name}${detail ? "  — " + detail : ""}`); return cond; };
const q = (s: string, n = 140) => JSON.stringify(s.length > n ? s.slice(0, n) + "…" : s);

/* ───── фейковый Telegram и бот ───── */
const TOKEN = `7000999001:E2E${randomBytes(18).toString("hex")}`;
const USERNAME = "so_e2e_test_bot";
const SALT = randomBytes(16).toString("hex");
const MARK = { username: "zz_user_marker", first: "Zzfirstmarker", last: "Zzlastmarker" };
const fake: FakeBotApi = await startFakeBotApi({ token: TOKEN, username: USERNAME });
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "so-e2e-bot-"));
fs.writeFileSync(path.join(appDir, "VERSION"), SERVER_VERSION + "\n"); // как deploy.sh: VERSION с переводом строки
const heartbeatFile = path.join(appDir, "apps", "bot", ".state", "heartbeat");

const env: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(env)) if (/^(TG_|SO_TG|SO_SITE_URL$|SO_WEB_URL$|SO_APP_DIR$|NODE_ENV$|ANTHROPIC_|OPENROUTER_|TYPESAFE_|JEV_)/.test(k)) delete env[k];
Object.assign(env, {
  TG_BOT_TOKEN: TOKEN, TG_BOT_USERNAME: USERNAME, TG_API_ROOT: fake.root,
  SO_TG_SALT: SALT, SO_BOT_KEY: BOT_KEY, SO_TG_ALLOW: "*", SO_TG_DAILY: "60", SO_TG_CONCURRENCY: "4", SO_TG: "1",
  SO_WEB_URL: baseUrl!.origin, SO_SITE_URL: baseUrl!.origin, SO_APP_DIR: appDir,
  // npm не ходит в реестр за обновлениями; запросы бота к loopback — мимо прокси
  npm_config_update_notifier: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  // как Environment= юнита (setup.sh): bash исполняет скрипт start через exec — дерево npm → tsx → main.ts без промежуточного sh,
  // и SIGTERM процессу npm доходит до main.ts ровно один раз (KillMode=mixed)
  npm_config_script_shell: "/bin/bash",
});
delete env.npm_config_loglevel; // npm run -s e2e:bot передал бы «silent» и боту

/** Журнал бота: строки stdout и stderr по порядку */
const journal: string[] = [];
const journalWaiters = new Set<() => void>();
/** выход процесса npm бота (заполняется в обработчике exit; объект — чтобы TS не сужал поле до null) */
const proc: { exit: { code: number | null; signal: NodeJS.Signals | null; at: number } | null } = { exit: null };
const botStart = Date.now();
const bot: ChildProcess = spawn("npm", ["-w", "@so/bot", "start"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
const feed = (stream: NodeJS.ReadableStream | null) => {
  let buf = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { journal.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    for (const w of [...journalWaiters]) w();
  });
  stream?.on("end", () => { if (buf) journal.push(buf); buf = ""; for (const w of [...journalWaiters]) w(); });
};
feed(bot.stdout);
feed(bot.stderr);
const exited = new Promise<void>((resolve) => bot.on("exit", (code, signal) => { proc.exit = { code, signal, at: Date.now() }; for (const w of [...journalWaiters]) w(); resolve(); }));
// бот в своей группе процессов (detached): Ctrl+C или падение e2e не должны оставить его жить, а временный SO_APP_DIR — остаться
const killGroup = () => { if (bot.pid) { try { process.kill(-bot.pid, "SIGKILL"); } catch { /* группы уже нет */ } } };
// синхронно (обработчик exit асинхронного не ждёт); force — повтор после cleanup() безопасен
const rmAppDir = () => { try { fs.rmSync(appDir, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on("exit", () => { killGroup(); rmAppDir(); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { killGroup(); rmAppDir(); process.exit(130); });

/** Убрать за собой: группа процессов бота (npm → tsx → node), фейк, временный каталог */
async function cleanup(): Promise<void> {
  killGroup(); // вся группа, даже если npm уже вышел: осиротевший процесс бота не должен пережить e2e
  if (!proc.exit) await Promise.race([exited, sleep(3000)]);
  await fake.close();
  rmAppDir();
}
function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
const dumpJournal = () => { console.log("── журнал бота ──"); for (const l of journal) console.log("   " + l); };

/** Ждать строку журнала (с индекса from), подходящую под re; бот завершился или таймаут → null */
function waitLog(re: RegExp, timeoutMs: number, from = 0): Promise<{ line: string; index: number } | null> {
  const find = () => { for (let i = from; i < journal.length; i++) if (re.test(journal[i])) return { line: journal[i], index: i }; return null; };
  const hit = find();
  if (hit || proc.exit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const check = () => { const f = find(); if (f || proc.exit) { done(); resolve(f); } };
    const done = () => { clearTimeout(t); journalWaiters.delete(check); };
    const t = setTimeout(() => { done(); resolve(null); }, timeoutMs);
    journalWaiters.add(check);
  });
}
const TURN_RE = /^turn(?: |$)/;
const turnsSoFar = () => journal.filter((l) => TURN_RE.test(l)).length;
/** Ждать конца n-го по счёту хода (строка журнала «turn …» пишется в finally, после доставки) */
async function waitTurn(n: number): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < STEP_MS && !proc.exit) {
    const lines = journal.filter((l) => TURN_RE.test(l));
    if (lines.length >= n) return lines[n - 1];
    await waitLog(TURN_RE, Math.max(1, STEP_MS - (Date.now() - t0)), journal.length);
  }
  const lines = journal.filter((l) => TURN_RE.test(l));
  return lines.length >= n ? lines[n - 1] : null;
}

/* ───── апдейты Telegram: сырая форма, с именами-маркерами (бот их читать не должен) ───── */
let msgId = 500;
const user = (id: number) => ({ id, is_bot: false, first_name: MARK.first, last_name: MARK.last, username: MARK.username, language_code: "ru" });
const pchat = (id: number) => ({ id, type: "private", first_name: MARK.first, last_name: MARK.last, username: MARK.username });
const now = () => Math.floor(Date.now() / 1000);
function textMsg(chatId: number, text: string) {
  const cmd = /^\/\S+/.exec(text)?.[0];
  return { message: { message_id: ++msgId, date: now(), chat: pchat(chatId), from: user(chatId), text, ...(cmd ? { entities: [{ type: "bot_command", offset: 0, length: cmd.length }] } : {}) } };
}
let cbId = 0;
function callback(chatId: number, messageId: number, data: string) {
  return { callback_query: { id: `cbq-${++cbId}-${randomBytes(4).toString("hex")}`, from: user(chatId), chat_instance: "e2e-instance", data,
    message: { message_id: messageId, date: now(), chat: pchat(chatId), from: { id: 7000999001, is_bot: true, first_name: "Second opinion e2e", username: USERNAME }, text: "…" } } };
}
/** Все тексты, отправленные боту пользователями (их не должно быть в журнале бота) */
const userTexts: string[] = [];
const chatIds = new Set<number>();
function push(u: Record<string, unknown>): number {
  const m = (u.message ?? (u.callback_query as { message?: unknown } | undefined)?.message) as { chat?: { id?: number } } | undefined;
  if (typeof m?.chat?.id === "number") chatIds.add(m.chat.id);
  const t = (u.message as { text?: string } | undefined)?.text;
  if (t) userTexts.push(t);
  return fake.push(u);
}

/* ───── разбор вызовов Bot API ───── */
const chatOf = (c: ApiCall) => Number(c.params.chat_id);
const textOf = (c: ApiCall) => String(c.params.text ?? "");
const kbOf = (c: ApiCall) => ((c.params.reply_markup as { inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
const isSend = (c: ApiCall) => c.method === "sendMessage" && c.ok;
const isEdit = (c: ApiCall) => c.method === "editMessageText" && c.ok;
/** Вызовы для чата после seq (без typing) */
const outFor = (chatId: number, after: number) => fake.calls.filter((c) => c.seq > after && c.ok && (isSend(c) || isEdit(c)) && chatOf(c) === chatId);
const lastSeq = () => (fake.calls.length ? fake.calls[fake.calls.length - 1].seq : 0);
const visible = (c: ApiCall) => { if (c.params.parse_mode !== "HTML") return textOf(c); const p = parseTgHtml(textOf(c)); return "text" in p ? p.text : textOf(c); };
const show = (cs: ApiCall[]) => cs.map((c) => `${c.method}${c.params.parse_mode ? "[HTML]" : ""}${c.method === "editMessageText" ? `#${String(c.params.message_id)}` : c.messageId ? `→#${c.messageId}` : ""}: ${q(visible(c), 60)}${kbOf(c).length ? ` +${kbOf(c).length} кн.` : ""}`).join(" | ");
const budgetMessages = async () => (await health())?.budget?.messages ?? -1;

/**
 * Ход «отчёт»: среди вызовов чата — sendMessage(WAIT_REPORT) → editMessageText того же message_id (HTML) → затем простой текст.
 * @returns правка (отчёт или ветка) и простой текст после неё; detail — причина, если формы нет
 */
function reportTurn(cs: ApiCall[]): { edit: ApiCall | null; text: ApiCall | null; detail: string } {
  const wi = cs.findIndex((c) => isSend(c) && textOf(c) === WAIT_REPORT && !c.params.parse_mode);
  if (wi < 0) return { edit: null, text: null, detail: `нет заглушки WAIT_REPORT: ${show(cs)}` };
  const wait = cs[wi];
  const ei = cs.findIndex((c, i) => i > wi && isEdit(c) && Number(c.params.message_id) === wait.messageId);
  if (ei < 0) return { edit: null, text: null, detail: `заглушка #${wait.messageId} не исправлена в отчёт: ${show(cs)}` };
  const edit = cs[ei];
  if (edit.params.parse_mode !== "HTML") return { edit: null, text: null, detail: `правка заглушки без parse_mode HTML: ${show(cs)}` };
  const ti = cs.findIndex((c, i) => i > ei && isSend(c) && !c.params.parse_mode && textOf(c).trim() !== "");
  return { edit, text: ti >= 0 ? cs[ti] : null, detail: ti >= 0 ? show(cs) : `после отчёта нет простого текста: ${show(cs)}` };
}

const CHAT = { start: 7000000301, isin: 7000000302, deep: 7000000303, other: 7000000304, limit: 7000000305, group: -1007000000306 };
let turns = 0;
let step = "старт";
try {
  /* ═══ 0. Старт: getMe ok version=…, сверка версии с сервером, опрос, heartbeat ═══ */
  const getMe = await waitLog(/^getMe /, 60_000);
  ok("старт: getMe → «getMe ok version=<version /api/health>»", getMe?.line === `getMe ok version=${SERVER_VERSION}`, getMe?.line ?? `нет строки getMe за 60 с${proc.exit ? `; бот завершился: code=${proc.exit.code} signal=${proc.exit.signal}` : ""}`);
  const polling = await waitLog(/^polling(?: |$)|^version mismatch|^getMe (?!ok)/, 60_000);
  if (!ok("старт: версия совпала с сервером, опрос запущен («polling version=…»)", polling?.line === `polling version=${SERVER_VERSION}`, polling?.line ?? "нет строки polling")) {
    dumpJournal();
    throw new Error("бот не запустился — дальше сценарии не имеют смысла");
  }
  const poll = await fake.waitFor((c) => c.method === "getUpdates" && Number(c.params.timeout) > 0, STEP_MS);
  const allowed = JSON.stringify(poll?.params.allowed_updates ?? null);
  ok("старт: long polling — getUpdates timeout=50, allowed_updates [message, callback_query]; deleteWebhook до опроса",
    !!poll && Number(poll.params.timeout) === 50 && allowed === JSON.stringify(["message", "callback_query"]) && fake.calls.some((c) => c.method === "deleteWebhook" && c.seq < poll.seq),
    poll ? `timeout=${String(poll.params.timeout)}, allowed_updates=${allowed}` : "getUpdates с timeout не пришёл");
  let hbMtime = -Infinity;
  try { hbMtime = fs.statSync(heartbeatFile).mtimeMs; } catch { /* нет файла */ }
  ok("старт: heartbeat в <SO_APP_DIR>/apps/bot/.state/heartbeat свежий (новее старта)", hbMtime >= botStart - 1000 && Date.now() - hbMtime < 60_000,
    Number.isFinite(hbMtime) ? `возраст ${Math.round((Date.now() - hbMtime) / 1000)} с` : "файла нет");

  /* ═══ 1. /start: приветствие + уведомление о приватности, кнопки sg:<i> ═══ */
  step = "/start";
  let m0 = await budgetMessages();
  let s0 = lastSeq();
  push(textMsg(CHAT.start, "/start"));
  const hello = await fake.waitFor((c) => isSend(c) && chatOf(c) === CHAT.start, STEP_MS, s0);
  const kb = hello ? kbOf(hello) : [];
  ok("/start: приветствие и уведомление о приватности одним сообщением, простой текст", !!hello && textOf(hello) === `${BOT.start}\n\n${BOT.privacy}` && !hello.params.parse_mode,
    hello ? q(textOf(hello), 90) : "нет ответа");
  ok("/start: кнопки подсказок sg:<i> = SUGGESTIONS", JSON.stringify(kb.map((b) => [b.text, b.callback_data])) === JSON.stringify(SUGGESTIONS.map((s, i) => [s, `sg:${i}`])),
    kb.map((b) => `${b.text}=${b.callback_data}`).join(", "));
  ok("/start: хода нет (POST /api/chat не уходил)", (await budgetMessages()) === m0 && turnsSoFar() === turns, `budget.messages ${m0} → ${await budgetMessages()}`);

  /* ═══ 2. Кнопка sg:2 («Черкизово») → список выпусков кнопками pk: ═══ */
  step = "кнопка sg";
  s0 = lastSeq();
  const sgIdx = SUGGESTIONS.indexOf("Черкизово");
  const cb1 = callback(CHAT.start, hello?.messageId ?? 1, `sg:${sgIdx}`);
  push(cb1);
  const turnLine1 = await waitTurn(++turns);
  const ans1 = fake.calls.find((c) => c.seq > s0 && c.method === "answerCallbackQuery" && c.params.callback_query_id === cb1.callback_query.id);
  ok("кнопка sg: answerCallbackQuery на нажатие", !!ans1, ans1 ? "" : "нет answerCallbackQuery");
  let cs = outFor(CHAT.start, s0);
  const pick = reportTurn(cs);
  const pkButtons = pick.edit ? kbOf(pick.edit).filter((b) => b.callback_data?.startsWith("pk:")) : [];
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/engine/golden/expected/pick-cherkizovo.json"), "utf8")) as { candidates: { isin: string | null; secid: string }[] };
  const wantPk = golden.candidates.map((c) => `pk:${c.isin ?? c.secid}`);
  ok("кнопка sg «Черкизово»: заглушка → правка в список выпусков (HTML)", !!pick.edit, pick.detail);
  ok("кнопка sg «Черкизово»: кнопки pk:<ISIN|SECID> — все кандидаты эталона pick-cherkizovo по порядку",
    JSON.stringify(pkButtons.map((b) => b.callback_data)) === JSON.stringify(wantPk), `${pkButtons.length} кнопок из ${wantPk.length}; первая ${pkButtons[0]?.callback_data ?? "—"}`);
  ok("кнопка sg: ход завершён без ошибок", /status=ok$/.test(turnLine1 ?? ""), turnLine1 ?? "нет строки turn");

  /* ═══ 3. Кнопка pk: (выбор выпуска) → отчёт по выбранному выпуску ═══ */
  step = "кнопка pk";
  s0 = lastSeq();
  const pkData = pkButtons[0]?.callback_data ?? wantPk[0];
  const pkCode = pkData.slice(3);
  const cb2 = callback(CHAT.start, pick.edit ? Number(pick.edit.params.message_id) : 1, pkData);
  push(cb2);
  const turnLine2 = await waitTurn(++turns);
  ok("кнопка pk: answerCallbackQuery на нажатие", fake.calls.some((c) => c.seq > s0 && c.method === "answerCallbackQuery" && c.params.callback_query_id === cb2.callback_query.id));
  cs = outFor(CHAT.start, s0);
  const rep1 = reportTurn(cs);
  ok(`кнопка pk (${pkCode}): заглушка WAIT_REPORT → editMessageText отчётом → текст`, !!rep1.edit && !!rep1.text, rep1.detail);
  ok(`кнопка pk: в отчёте выбранный выпуск <code>${pkCode}</code>`, !!rep1.edit && textOf(rep1.edit).includes(`<code>${pkCode}</code>`), rep1.edit ? q(visible(rep1.edit), 120) : "");
  const urls = rep1.edit ? kbOf(rep1.edit).filter((b) => b.url) : [];
  const site = urls.find((b) => b.text === BOT.openOnSite);
  ok("кнопка pk: под отчётом «Открыть на сайте» → SO_SITE_URL/check?q=<выпуск>", !!site && site.url!.startsWith(`${baseUrl!.origin}/check?`) && new URL(site.url!).searchParams.get("q") === pkCode,
    urls.map((b) => `${b.text} → ${b.url}`).join("; ") || "url-кнопок нет");
  const cab = urls.find((b) => b.text === BOT.fullReport);
  ok("кнопка pk: «Полный отчёт — после входа» ведёт в кабинет (CABINET_HREF), если кнопка есть", !cab || cab.url === CABINET_HREF, cab ? cab.url : "кнопки нет (нет плашки)");
  ok("кнопка pk: ход завершён без ошибок", /status=ok$/.test(turnLine2 ?? ""), turnLine2 ?? "нет строки turn");

  /* ═══ 4. Реплика с ISIN → заглушка → отчёт → текст; typing ═══ */
  step = "реплика с ISIN";
  m0 = await budgetMessages();
  s0 = lastSeq();
  push(textMsg(CHAT.isin, "RU000A10ASE2"));
  const turnLine3 = await waitTurn(++turns);
  cs = outFor(CHAT.isin, s0);
  const rep2 = reportTurn(cs);
  ok("реплика «RU000A10ASE2»: sendMessage(WAIT_REPORT) → editMessageText того же сообщения отчётом (HTML) → простой текст", !!rep2.edit && !!rep2.text, rep2.detail);
  ok("реплика с ISIN: отчёт по бумаге (<b>имя</b> <code>RU000A10ASE2</code>), превью ссылок выключено",
    !!rep2.edit && /<b>[^<]+<\/b> <code>RU000A10ASE2<\/code>/.test(textOf(rep2.edit)) && (rep2.edit.params.link_preview_options as { is_disabled?: boolean } | undefined)?.is_disabled === true,
    rep2.edit ? q(textOf(rep2.edit), 160) : "");
  ok("реплика с ISIN: typing во время хода", fake.calls.some((c) => c.seq > s0 && c.method === "sendChatAction" && chatOf(c) === CHAT.isin && c.params.action === "typing"));
  ok("реплика с ISIN: ход засчитан сервером один раз (budget.messages +1)", (await budgetMessages()) === m0 + 1, `budget.messages ${m0} → ${await budgetMessages()}`);
  ok("реплика с ISIN: ход завершён без ошибок", /status=ok$/.test(turnLine3 ?? ""), turnLine3 ?? "нет строки turn");

  /* ═══ 5. Продолжение разговора и /new ═══ */
  step = "/new";
  s0 = lastSeq();
  push(textMsg(CHAT.isin, "вложу 1 млн"));
  await waitTurn(++turns);
  cs = outFor(CHAT.isin, s0);
  const cont = cs.filter((c) => textOf(c).includes("<code>RU000A10ASE2</code>"));
  ok("продолжение «вложу 1 млн»: сервер помнит бумагу — отчёт RU000A10ASE2 пересобран", cont.length > 0, show(cs));
  m0 = await budgetMessages();
  s0 = lastSeq();
  push(textMsg(CHAT.isin, "/new"));
  const fresh = await fake.waitFor((c) => isSend(c) && chatOf(c) === CHAT.isin, STEP_MS, s0);
  ok("/new: BOT.newSession, хода нет", !!fresh && textOf(fresh) === BOT.newSession && turnsSoFar() === turns && (await budgetMessages()) === m0, fresh ? q(textOf(fresh)) : "нет ответа");
  s0 = lastSeq();
  push(textMsg(CHAT.isin, "вложу 1 млн"));
  await waitTurn(++turns);
  cs = outFor(CHAT.isin, s0);
  ok("после /new: новая сессия — «вложу 1 млн» уже не пересобирает отчёт RU000A10ASE2", cs.length > 0 && !cs.some((c) => textOf(c).includes("RU000A10ASE2")), show(cs));

  /* ═══ 6. Deep-link /start <payload> (ссылка d6) ═══ */
  step = "deep-link";
  const d6 = JSON.parse(fs.readFileSync(path.join(ROOT, "apps/web/audit/fixtures/dialogs/d6.json"), "utf8")) as { actions: { kind: string; url?: string }[] };
  const link = new URL(d6.actions.find((a) => a.kind === "open")!.url!, "http://x");
  const payload = encodeStartPayload(Object.fromEntries(link.searchParams)) ?? "";
  ok("deep-link: payload ссылки d6 по §4.6", payload === "qRU000A1038V6_p1500_s1000000_k30", payload);
  s0 = lastSeq();
  push(textMsg(CHAT.deep, `/start ${payload}`));
  const turnLine4 = await waitTurn(++turns);
  cs = outFor(CHAT.deep, s0);
  ok("deep-link: сначала уведомление о приватности", cs.length > 0 && isSend(cs[0]) && textOf(cs[0]) === BOT.privacy, show(cs.slice(0, 1)));
  const rep3 = reportTurn(cs);
  ok("deep-link: ход firstText — заглушка → отчёт RU000A1038V6 → текст", !!rep3.edit && !!rep3.text && textOf(rep3.edit).includes("<code>RU000A1038V6</code>"), rep3.detail);
  const v3 = rep3.edit ? visible(rep3.edit).replace(/[\s ]+/g, " ") : "";
  ok("deep-link: вводы ссылки в отчёте (обещали 15%, сумма 1 000 000, комиссия 0,3%)", /15\s?%/.test(v3) && /1 000 000/.test(v3) && /0,3\s?%/.test(v3), q(v3, 200));
  ok("deep-link: ход завершён без ошибок", /status=ok$/.test(turnLine4 ?? ""), turnLine4 ?? "нет строки turn");

  /* ═══ 7. Не-текст → BOT.onlyText; группа → игнор ═══ */
  step = "не-текст";
  m0 = await budgetMessages();
  s0 = lastSeq();
  push({ message: { message_id: ++msgId, date: now(), chat: pchat(CHAT.other), from: user(CHAT.other), photo: [{ file_id: "AgACAgIAAxkBAAE", file_unique_id: "AQAD", width: 90, height: 90, file_size: 1024 }] } });
  const only1 = await fake.waitFor((c) => isSend(c) && chatOf(c) === CHAT.other, STEP_MS, s0);
  s0 = lastSeq();
  push({ message: { message_id: ++msgId, date: now(), chat: pchat(CHAT.other), from: user(CHAT.other), voice: { file_id: "AwACAgIAAxkBAAE", file_unique_id: "AgAD", duration: 2, mime_type: "audio/ogg", file_size: 2048 } } });
  const only2 = await fake.waitFor((c) => isSend(c) && chatOf(c) === CHAT.other, STEP_MS, s0);
  ok("фото и голос → BOT.onlyText, хода нет", !!only1 && !!only2 && textOf(only1) === BOT.onlyText && textOf(only2) === BOT.onlyText && turnsSoFar() === turns && (await budgetMessages()) === m0,
    `${only1 ? q(textOf(only1), 50) : "нет ответа"} / ${only2 ? q(textOf(only2), 50) : "нет ответа"}`);
  s0 = lastSeq();
  push({ message: { message_id: ++msgId, date: now(), chat: { id: CHAT.group, type: "supergroup", title: "e2e group" }, from: user(CHAT.other), text: "RU000A10ASE2" } });
  push(textMsg(CHAT.other, "/help"));
  const help = await fake.waitFor((c) => isSend(c) && chatOf(c) === CHAT.other, STEP_MS, s0);
  ok("/help → BOT.help; сообщение из группы до него — проигнорировано", !!help && textOf(help) === BOT.help && !fake.calls.some((c) => c.seq > s0 && chatOf(c) === CHAT.group),
    help ? q(textOf(help), 60) : "нет ответа на /help");

  /* ═══ 8. Лимит сообщений сессии → limitText("telegram") ═══ */
  step = "лимит сообщений";
  if (MESSAGE_LIMIT === 0) console.log("skip  лимит сообщений: --message-limit 0");
  else {
    let firstBad = "";
    for (let i = 1; i <= MESSAGE_LIMIT; i++) {
      s0 = lastSeq();
      push(textMsg(CHAT.limit, "Что такое НКД?"));
      const line = await waitTurn(++turns);
      const out = outFor(CHAT.limit, s0);
      if (!firstBad && (!/status=ok$/.test(line ?? "") || out.some((c) => textOf(c) === limitText("telegram", MESSAGE_LIMIT)) || !out.length))
        firstBad = `ход ${i}: ${line ?? "нет строки turn"}; ${show(out)}`;
    }
    ok(`лимит: ходы 1–${MESSAGE_LIMIT} обычные`, !firstBad, firstBad);
    s0 = lastSeq();
    push(textMsg(CHAT.limit, "Что такое НКД?"));
    await waitTurn(++turns);
    const out = outFor(CHAT.limit, s0);
    const want = limitText("telegram", MESSAGE_LIMIT);
    ok(`лимит: ход ${MESSAGE_LIMIT + 1} → limitText("telegram") (с /new, без «обновите страницу»)`, out.length === 1 && textOf(out[0]) === want && !out[0].params.parse_mode, show(out));
  }

  /* ═══ 9. Bot API: все вызовы приняты (ограничения Telegram), чужих путей нет ═══ */
  step = "ограничения Telegram";
  const refused = fake.calls.filter((c) => !c.ok);
  ok("Bot API: все вызовы бота приняты фейком (HTML, длина ≤ 4096, callback_data ≤ 64 байт, правки своих сообщений)", refused.length === 0,
    refused.map((c) => `${c.method}: ${c.error?.description}`).slice(0, 5).join(" | "));
  ok("Bot API: запросов с чужим токеном и к неизвестным методам нет", fake.rejected.length === 0, fake.rejected.map((r) => `${r.path}: ${r.why}`).join("; "));
  const htmlNoPreview = fake.calls.filter((c) => (isSend(c) || isEdit(c)) && (c.params.link_preview_options as { is_disabled?: boolean } | undefined)?.is_disabled !== true);
  ok("Bot API: превью ссылок выключено во всех сообщениях", htmlNoPreview.length === 0, show(htmlNoPreview.slice(0, 3)));

  /* ═══ 10. SIGTERM во время хода: ход доставлен, выход ≤ 30 с, offset подтверждён ═══ */
  step = "SIGTERM";
  s0 = lastSeq();
  // «медленный Telegram»: правка заглушки отвечает через HOLD_MS — ход гарантированно в полёте, когда приходит SIGTERM
  const HOLD_MS = 3000;
  fake.delay = (m, p) => (m === "editMessageText" && Number(p.chat_id) === CHAT.isin ? HOLD_MS : 0);
  const lastUpd = push(textMsg(CHAT.isin, "RU000A1094F2"));
  const inFlight = await fake.waitFor((c) => isSend(c) && chatOf(c) === CHAT.isin && textOf(c) === WAIT_REPORT, STEP_MS, s0);
  const tStop = Date.now();
  if (inFlight && bot.pid) process.kill(bot.pid, "SIGTERM"); // только процессу npm — как systemd при KillMode=mixed (юнит setup.sh)
  await Promise.race([exited, sleep(STOP_MAX_MS + 5000)]);
  fake.delay = null;
  const stopMs = proc.exit ? proc.exit.at - tStop : Infinity;
  const stopped = journal.find((l) => /^stopped(?: |$)/.test(l));
  ok("SIGTERM: сигнал пришёл во время хода (заглушка отправлена, правка ещё не ответила)", !!inFlight, inFlight ? `правка держится ${HOLD_MS / 1000} с` : "заглушки нет");
  ok(`SIGTERM: процесс завершился за ≤ ${STOP_MAX_MS / 1000} с с кодом 0`, stopMs <= STOP_MAX_MS && proc.exit?.code === 0,
    proc.exit ? `${(stopMs / 1000).toFixed(1)} с, code=${proc.exit.code} signal=${proc.exit.signal}` : "не завершился");
  ok("SIGTERM: «stopping» → «stopped status=idle» — ходы доработали до выхода", journal.some((l) => /^stopping(?: |$)/.test(l)) && stopped === "stopped status=idle", stopped ?? "нет строки stopped");
  cs = outFor(CHAT.isin, s0);
  const rep4 = reportTurn(cs);
  ok("SIGTERM: ход, начатый до сигнала, доставлен целиком (заглушка → отчёт RU000A1094F2 → текст)", !!rep4.edit && !!rep4.text && textOf(rep4.edit).includes("<code>RU000A1094F2</code>"), rep4.detail);
  ok("SIGTERM: offset подтверждён (getUpdates offset = последний update_id + 1) — после рестарта апдейт не придёт повторно", fake.lastOffset() === lastUpd + 1, `offset ${fake.lastOffset()}, последний update_id ${lastUpd}`);
  turns = turnsSoFar();

  const refusedTurns = journal.filter((l) => TURN_RE.test(l) && /status=http:403\b/.test(l));
  ok("ходы: сервер не отказывал боту по ключу (403 — SO_BOT_KEY e2e ≠ SO_BOT_KEY сервера)", refusedTurns.length === 0, refusedTurns.slice(0, 2).join("; "));

  /* ═══ 11. Приватность журнала бота и usage.jsonl ═══ */
  step = "приватность";
  const text = journal.join("\n");
  const numRe = (n: number) => new RegExp(`(?<![0-9])${String(n).replace("-", "\\-")}(?![0-9])`);
  const leaks: string[] = [];
  for (const id of chatIds) if (numRe(id).test(text) || numRe(Math.abs(id)).test(text)) leaks.push(`chat_id/user_id ${id}`);
  for (const v of Object.values(MARK)) if (text.includes(v)) leaks.push(`имя-маркер ${v}`);
  for (const [k, v] of [["токен", TOKEN], ["хвост токена", TOKEN.split(":")[1]], ["SO_BOT_KEY", BOT_KEY], ["соль", SALT]] as const) if (v && text.includes(v)) leaks.push(k);
  // как TG.20: у команды ищется её аргумент (payload /start <payload> — ISIN, цена, сумма, комиссия); голые /start, /new, /help — пусто
  const userPart = (t: string) => (t.startsWith("/") ? t.replace(/^\/\S+\s*/, "") : t);
  for (const t of new Set(userTexts)) { const s = userPart(t); if (s && text.includes(s)) leaks.push(`текст реплики ${q(s, 40)}`); }
  if (journal.some((l) => TURN_RE.test(l) && /\bpseudo=/.test(l))) leaks.push("pseudo в записи хода");
  // контроль поиска: маркер, подставленный намеренно, находится; из deep-link ищется именно payload
  const probe = numRe(CHAT.isin).test(`x ${CHAT.isin} y`) && `x ${MARK.first} y`.includes(MARK.first) &&
    userPart(`/start ${payload}`) === payload && userPart("/new") === "" && `x ${payload} y`.includes(userPart(`/start ${payload}`));
  ok("приватность: в журнале бота нет chat_id/user_id, имён, текстов реплик и payload deep-link, токена, ключа и соли; pseudo нет в записях хода", leaks.length === 0 && probe,
    leaks.length ? leaks.join("; ") : `${journal.length} строк журнала, ${turns} ходов`);
  if (USAGE_DIR) {
    const file = path.join(USAGE_DIR, "usage.jsonl");
    let lines: Record<string, unknown>[] = [];
    try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>); } catch { /* нет файла */ }
    const tg = lines.filter((r) => r.channel === "telegram");
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const uLeaks = [...chatIds].filter((id) => numRe(id).test(raw)).map((id) => `chat_id ${id}`).concat(Object.values(MARK).filter((v) => raw.includes(v)));
    ok("usage.jsonl: записи бота с channel:\"telegram\" и сессиями tg_<12>, без сырых id и имён", tg.length > 0 && tg.every((r) => r.chat === undefined || /^tg_[A-Za-z0-9_-]{12}$/.test(String(r.chat))) && uLeaks.length === 0,
      `${tg.length} записей telegram из ${lines.length}${uLeaks.length ? `; утечки: ${uLeaks.join(", ")}` : ""}`);
  } else console.log("skip  usage.jsonl: не передан --usage-dir (SO_USAGE_DIR сервера)");
} catch (e) {
  ok(`сценарий «${step}» прерван`, false, e instanceof Error ? e.message : String(e));
} finally {
  if (failures) dumpJournal();
  await cleanup();
}

console.log(`\n${failures ? `FAIL: ${failures} проверок не прошли` : "OK: все проверки прошли"}`);
process.exit(failures ? 1 : 0);
