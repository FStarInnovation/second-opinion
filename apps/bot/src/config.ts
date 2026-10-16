/**
 * Конфигурация бота из окружения (план WP-TG §4.4, §7, §9). Переменные apps/bot/.env (на проде — EnvironmentFile юнита):
 *   TG_BOT_TOKEN, TG_BOT_USERNAME — токен и @username бота (сверка getMe, identity.ts);
 *   SO_TG_SALT — соль псевдонимов; SO_BOT_KEY — ключ бота для сервера (тот же, что в apps/web/.env);
 *   SO_TG_ALLOW — коды доступа через запятую ("" — никто, "*" — все); SO_TG_DAILY (60), SO_TG_CONCURRENCY (4), SO_TG_MAX_CHATS (300);
 *   SO_SITE_URL — адрес сайта для кнопки «Открыть на сайте» (не задан — кнопки нет); SO_TG=0 — не опрашивать Telegram.
 *   SO_WEB_URL — адрес сервера решений, только loopback http (по умолчанию http://127.0.0.1:3000; туда уходит SO_BOT_KEY);
 *   SO_APP_DIR — каталог репозитория (VERSION, apps/bot/.state), по умолчанию три уровня вверх от этого файла.
 *   TG_API_ROOT — ТОЛЬКО e2e: фейковый Bot API на loopback (http, 127.0.0.1 или localhost, явный порт, без пути, query и
 *   учётных данных); при NODE_ENV=production — ошибка (иначе токен ушёл бы на чужой хост).
 * Тексты ошибок не содержат значений переменных: ни токена, ни адресов.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BotConfig {
  webUrl: string; botKey: string; salt: string; allow: string; dailyTurns: number; concurrency: number;
  perChatPending: number; maxChats: number; turnTimeoutMs: number; siteUrl?: string;
}
export interface MainConfig extends BotConfig {
  token: string; botHandle: string; stateDir: string; appDir: string; enabled: boolean;
  apiRoot?: string;
}

/** Каталог репозитория по умолчанию: apps/bot/src/config.ts → три уровня вверх */
const DEFAULT_APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_WEB_URL = "http://127.0.0.1:3000";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
/** Очередь чата — 2 сообщения (§9); ход — не дольше 90 с (§4.4) */
const PER_CHAT_PENDING = 2;
const TURN_TIMEOUT_MS = 90_000;

class ConfigError extends Error { name = "ConfigError"; }

const str = (env: Record<string, string | undefined>, k: string): string => String(env[k] ?? "").trim();

/** Целое ≥ min из переменной; пусто — по умолчанию; иначе ошибка с именем переменной (значение в текст не попадает) */
function int(env: Record<string, string | undefined>, k: string, def: number, min: number): number {
  const v = str(env, k);
  if (!v) return def;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw new ConfigError(`${k}: expected an integer >= ${min}`);
  return n;
}

/** Loopback-адрес http с явным портом, без пути, query, фрагмента и учётных данных → origin; иначе ошибка без значения */
function loopbackOrigin(k: string, v: string, o: { requirePort: boolean }): string {
  let u: URL;
  try { u = new URL(v); } catch { throw new ConfigError(`${k}: not a valid URL`); }
  if (u.protocol !== "http:") throw new ConfigError(`${k}: only http: is allowed`);
  if (!LOOPBACK_HOSTS.has(u.hostname)) throw new ConfigError(`${k}: only 127.0.0.1 or localhost is allowed`);
  if (o.requirePort && u.port === "") throw new ConfigError(`${k}: an explicit port is required`);
  // без учётных данных, пути, query и фрагмента: адрес целиком — это origin
  if (u.href !== `${u.origin}/`) throw new ConfigError(`${k}: credentials, path, query and fragment are not allowed`);
  return u.origin;
}

/** Адрес сайта для кнопки «Открыть на сайте»: http(s), без query и фрагмента; путь-префикс допустим */
function siteUrlOf(v: string): string | undefined {
  if (!v) return undefined;
  let u: URL;
  try { u = new URL(v); } catch { throw new ConfigError("SO_SITE_URL: not a valid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConfigError("SO_SITE_URL: only http: or https: is allowed");
  if (u.href !== u.origin + u.pathname) throw new ConfigError("SO_SITE_URL: credentials, query and fragment are not allowed");
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

/**
 * Конфигурация из env (обычно process.env). Бросает ConfigError; в тексте ошибки — имя переменной и правило, без значения.
 * При SO_TG=0 бот Telegram не опрашивает: токен и имя бота не обязательны.
 */
export function loadConfig(env: Record<string, string | undefined>): MainConfig {
  const enabled = str(env, "SO_TG") !== "0";
  const token = str(env, "TG_BOT_TOKEN");
  const botHandle = str(env, "TG_BOT_USERNAME").replace(/^@/, "");
  if (enabled) {
    if (!token) throw new ConfigError("TG_BOT_TOKEN is required (or SO_TG=0)");
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new ConfigError("TG_BOT_TOKEN: unexpected format (<digits>:<secret>)");
    if (!/^[A-Za-z0-9_]{3,64}$/.test(botHandle)) throw new ConfigError("TG_BOT_USERNAME is required: the bot's own handle");
  }
  const salt = str(env, "SO_TG_SALT");
  if (salt.length < 8) throw new ConfigError("SO_TG_SALT is required (at least 8 characters)");
  const botKey = str(env, "SO_BOT_KEY");
  if (!botKey) throw new ConfigError("SO_BOT_KEY is required (the same key as in apps/web/.env)");

  const rawRoot = str(env, "TG_API_ROOT");
  let apiRoot: string | undefined;
  if (rawRoot) {
    if (str(env, "NODE_ENV") === "production") throw new ConfigError("TG_API_ROOT is for e2e only and must not be set when NODE_ENV=production");
    apiRoot = loopbackOrigin("TG_API_ROOT", rawRoot, { requirePort: true });
  }
  const rawWeb = str(env, "SO_WEB_URL");
  const webUrl = rawWeb ? loopbackOrigin("SO_WEB_URL", rawWeb, { requirePort: false }) : DEFAULT_WEB_URL;
  const appDir = str(env, "SO_APP_DIR") ? path.resolve(str(env, "SO_APP_DIR")) : DEFAULT_APP_DIR;

  const cfg: MainConfig = {
    webUrl, botKey, salt,
    allow: str(env, "SO_TG_ALLOW"),
    dailyTurns: int(env, "SO_TG_DAILY", 60, 0),
    concurrency: int(env, "SO_TG_CONCURRENCY", 4, 1),
    perChatPending: PER_CHAT_PENDING,
    maxChats: int(env, "SO_TG_MAX_CHATS", 300, 1),
    turnTimeoutMs: TURN_TIMEOUT_MS,
    token, botHandle,
    stateDir: path.join(appDir, "apps", "bot", ".state"),
    appDir, enabled,
  };
  const site = siteUrlOf(str(env, "SO_SITE_URL"));
  if (site) cfg.siteUrl = site;
  if (apiRoot) cfg.apiRoot = apiRoot;
  return cfg;
}
