/**
 * Запуск Telegram-бота (план WP-TG §3, §4.4 «Запуск main.ts», §7). Процесс second-opinion-bot.service: long polling Bot API
 * (только исходящий HTTPS), ходы — в POST http://127.0.0.1:3000/api/chat того же сервера решений, что у сайта.
 *  1. loadConfig(process.env); readVersion(appDir) — один раз, до getMe.
 *  2. Bot (apiRoot — только e2e); getMe → sameBot с TG_BOT_USERNAME, иначе exit(1); журнал «getMe ok version=<sha>».
 *  3. checkServerVersion: версия бота = version локального /api/health, иначе exit(1) (сервер недоступен — несколько попыток).
 *  4. bot.start({ allowed_updates: ["message", "callback_query"], timeout: 50 }); обработчик апдейта только ставит ход в
 *     очередь ядра и не блокирует опрос.
 *  5. Heartbeat — после каждого getUpdates (transformer bot.api.config.use); сторож раз в 30 с, отметка старше 120 с → exit(1).
 *  6. SIGTERM/SIGINT: bot.stop() (подтверждение offset, не дольше 10 с) и core.idle() параллельно — всего не дольше 30 с.
 * SO_TG=0: Telegram не опрашивается, heartbeat пишется (выключатель §7).
 * grammY импортируют только этот файл и telegram.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { Bot } from "grammy";
import { loadConfig, type MainConfig } from "./config";
import { createCore, type TgUpdate } from "./core";
import { makeHeartbeat } from "./heartbeat";
import { sameBot } from "./identity";
import { makeLogger, type LogRec } from "./log";
import { grammyClient, tgErrorInfo, withTelegramPolicy } from "./telegram";
import { checkServerVersion, readVersion } from "./version";

const HEARTBEAT_STALE_MS = 120_000;
const WATCHDOG_EVERY_MS = 30_000;
const SWEEP_EVERY_MS = 60_000;
const POLL_TIMEOUT_S = 50;
const STOP_GRACE_MS = 30_000;
/** Сколько ждать подтверждения offset (bot.stop()) — внутри STOP_GRACE_MS */
const STOP_POLL_MS = 10_000;
/** Таймаут HTTP-клиента grammY: больше long poll (50 с), вместо 500 с по умолчанию — зависший вызов Bot API не висит вечно */
const CLIENT_TIMEOUT_S = 70;
/** Сервер недоступен при старте (рестарт веба): столько попыток сверки версии с паузой */
const VERSION_TRIES = 10;
const VERSION_PAUSE_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const errShort = (e: unknown) => tgErrorInfo(e).short || (e instanceof Error ? e.name : "error");

async function main(): Promise<void> {
  let cfg: MainConfig;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    // текст ConfigError — без значений переменных
    process.stderr.write(`config error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  const version = readVersion(cfg.appDir);
  const log: (r: LogRec) => void = makeLogger((line) => { process.stdout.write(line + "\n"); }, [cfg.token, cfg.botKey, cfg.salt]);
  process.on("unhandledRejection", (r) => { log({ ev: "unhandled", err: errShort(r) }); });

  try { fs.mkdirSync(cfg.stateDir, { recursive: true }); } catch { /* каталог создают setup.sh и deploy.sh */ }
  const hb = makeHeartbeat({
    file: path.join(cfg.stateDir, "heartbeat"), staleMs: HEARTBEAT_STALE_MS, now: () => Date.now(),
    exit: (code) => { log({ ev: "heartbeat stale", status: String(code) }); process.exit(code); },
    write: (f) => { fs.writeFileSync(f, String(Date.now())); },
    mtime: (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } },
  });
  hb.beat();
  const watchdog = setInterval(() => hb.check(), WATCHDOG_EVERY_MS);

  if (!cfg.enabled) {
    log({ ev: "disabled", version });
    setInterval(() => hb.beat(), WATCHDOG_EVERY_MS);
    const stop = () => { clearInterval(watchdog); process.exit(0); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return;
  }

  const bot = new Bot(cfg.token, { client: { timeoutSeconds: CLIENT_TIMEOUT_S, ...(cfg.apiRoot ? { apiRoot: cfg.apiRoot } : {}) } });
  let me: Awaited<ReturnType<typeof bot.api.getMe>>;
  try {
    me = await bot.api.getMe();
  } catch (e) {
    log({ ev: "getMe failed", status: String(tgErrorInfo(e).code ?? "net"), err: errShort(e) });
    process.exit(1);
  }
  if (!sameBot(me, cfg.botHandle)) {
    log({ ev: "getMe mismatch", err: "TG_BOT_USERNAME" });
    process.exit(1);
  }
  log({ ev: "getMe ok", version });

  let v = await checkServerVersion(fetch, cfg.webUrl, version);
  for (let i = 1; !v.ok && v.server === null && i < VERSION_TRIES; i++) {
    await sleep(VERSION_PAUSE_MS);
    hb.beat();
    v = await checkServerVersion(fetch, cfg.webUrl, version);
  }
  if (!v.ok) {
    log({ ev: "version mismatch", version, status: v.server ?? "unreachable" });
    process.exit(1);
  }

  // heartbeat после каждого getUpdates (в том числе пустого по таймауту опроса)
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (method === "getUpdates") hb.beat();
    return res;
  });

  const tg = withTelegramPolicy(grammyClient(bot.api), { sleep, log });
  const core = createCore({ config: cfg, tg, fetch, sleep, log });
  const sweeper = setInterval(() => core.sweep(), SWEEP_EVERY_MS);

  // обработчик апдейта не ждёт хода: опрос не блокируется
  bot.use((ctx) => {
    core.handleUpdate(ctx.update as unknown as TgUpdate).catch((r: unknown) => { log({ ev: "tg_error", err: errShort(r) }); });
  });
  bot.catch((e) => { log({ ev: "bot_error", err: errShort(e.error) }); });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log({ ev: "stopping" });
    clearInterval(watchdog);
    clearInterval(sweeper);
    // общий бюджет 30 с на подтверждение offset и доработку ходов: bot.stop() шлёт getUpdates без отмены и может висеть
    const deadline = sleep(STOP_GRACE_MS).then(() => false);
    const idle = core.idle().then(() => true); // ходы дорабатывают параллельно с подтверждением offset
    const polled = bot.stop().then(() => true, (e: unknown) => { log({ ev: "stop error", err: errShort(e) }); return true; });
    if (!(await Promise.race([polled, sleep(STOP_POLL_MS).then(() => false)]))) log({ ev: "stop error", err: "getUpdates timeout" });
    const drained = await Promise.race([idle, deadline]);
    log({ ev: "stopped", status: drained ? "idle" : "grace timeout" });
    process.exit(0);
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });

  await bot.start({
    allowed_updates: ["message", "callback_query"],
    timeout: POLL_TIMEOUT_S,
    onStart: () => { hb.beat(); log({ ev: "polling", version }); },
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${errShort(e)}\n`);
  process.exit(1);
});
