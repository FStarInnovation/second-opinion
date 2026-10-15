/**
 * WP-TG: нормализация N и компаратор паритета тел (docs/PLAN_telegram_bot_2026-10-14.md §4.5).
 *
 * Единственные допуски N (всё остальное сравнивается побайтно через канонический JSON):
 *   body.id                      → "<SESSION>"
 *   значение заголовка x-so-chat → "<CHAT>"
 *   messages[].id                → "<MSG>"            (id сообщения ассистента, собранного ai, — тоже "<MSG>")
 *   toolCallId (любая глубина)   → "<CALL#n>"         (n — порядок первого появления в нормализуемом объекте)
 *   built_at (любая глубина)     → "<BUILT_AT>"       (время сборки отчёта)
 *   diagnostics.snapshot_dir     → "<SNAPSHOT_DIR>"   (абсолютный путь машины записи; null остаётся null)
 * Порядок ключей не важен (канонический JSON с сортировкой ключей), порядок элементов массивов — важен.
 * У бота сверх браузерных заголовков разрешены только x-so-channel и x-so-bot-key.
 * Модуль чистый: не зависит от кода продукта (его чувствительность доказывает TG.G4).
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));

/** Канонический JSON: ключи объектов отсортированы, undefined выброшен (как JSON.stringify) */
export function canon(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

/** Заменить toolCallId/built_at/diagnostics.snapshot_dir на месте; calls — общий счётчик id вызовов в одном нормализуемом объекте */
function scrub(v: unknown, calls: Map<string, string>, parentKey: string | null): unknown {
  if (Array.isArray(v)) return v.map((x) => scrub(x, calls, null));
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    if (k === "toolCallId" && typeof x === "string") {
      if (!calls.has(x)) calls.set(x, `<CALL#${calls.size + 1}>`);
      out[k] = calls.get(x);
    } else if (k === "built_at" && typeof x === "string") out[k] = "<BUILT_AT>";
    else if (k === "snapshot_dir" && parentKey === "diagnostics" && typeof x === "string") out[k] = "<SNAPSHOT_DIR>";
    else out[k] = scrub(x, calls, k);
  }
  return out;
}

const msgId = (m: unknown) => {
  if (m && typeof m === "object" && !Array.isArray(m) && "id" in m) (m as Record<string, unknown>).id = "<MSG>";
};

/** N(сообщение): id → "<MSG>", плюс общие допуски */
export function normalizeMessage(m: unknown): unknown {
  const c = clone(m);
  msgId(c);
  return scrub(c, new Map(), null);
}

/** N(тело запроса /api/chat): нумерация toolCallId — общая на всё тело */
export function normalizeBody(body: unknown): unknown {
  const b = clone(body) as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return b;
  if ("id" in b) b.id = "<SESSION>";
  if (Array.isArray(b.messages)) b.messages.forEach(msgId);
  return scrub(b, new Map(), null);
}

/** Первое расхождение двух значений — путь и оба значения (для detail); null — равны */
export function firstDiff(a: unknown, b: unknown, p = "$"): string | null {
  if (canon(a) === canon(b)) return null;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb) return `${p}: ${short(a)} ≠ ${short(b)}`;
  if (ta === "array") {
    const x = a as unknown[], y = b as unknown[];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = firstDiff(x[i], y[i], `${p}[${i}]`);
      if (d) return d;
    }
    return `${p}: длина ${x.length} ≠ ${y.length}`;
  }
  if (ta === "object") {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
    for (const k of keys) {
      if (!(k in x) || x[k] === undefined) return `${p}.${k}: нет у первого, у второго ${short(y[k])}`;
      if (!(k in y) || y[k] === undefined) return `${p}.${k}: у первого ${short(x[k])}, нет у второго`;
      const d = firstDiff(x[k], y[k], `${p}.${k}`);
      if (d) return d;
    }
  }
  return `${p}: ${short(a)} ≠ ${short(b)}`;
}
const short = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 90 ? s.slice(0, 89) + "…" : s;
};

export interface BodyCompare { equal: boolean; diff: string | null }
/** N(тело бота) ≡ N(тело браузера) */
export function compareBodies(bot: unknown, browser: unknown): BodyCompare {
  const a = normalizeBody(bot), b = normalizeBody(browser);
  const diff = firstDiff(a, b);
  return { equal: diff == null, diff };
}
/** N(сообщение ассистента) ≡ N(сообщение ассистента) */
export function compareMessages(a: unknown, b: unknown): BodyCompare {
  const diff = firstDiff(normalizeMessage(a), normalizeMessage(b));
  return { equal: diff == null, diff };
}

export const BOT_EXTRA_HEADERS = ["x-so-channel", "x-so-bot-key"] as const;
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * Заголовки бота против заголовков браузера (§4.5): те же имена плюс ровно x-so-channel и x-so-bot-key; значения равны,
 * кроме x-so-chat (N). Дополнительно (§4.4 buildChatRequest): x-so-chat бота = body.id и начинается с tg_, канал telegram, ключ = ожидаемому.
 */
export function compareHeaders(
  bot: Record<string, string>, browser: Record<string, string>, o: { bodyId: unknown; botKey: string },
): { equal: boolean; problems: string[] } {
  const b = lower(bot), w = lower(browser);
  const problems: string[] = [];
  const extra = Object.keys(b).filter((k) => !(k in w) && !(BOT_EXTRA_HEADERS as readonly string[]).includes(k));
  const missing = Object.keys(w).filter((k) => !(k in b));
  if (extra.length) problems.push(`лишние заголовки ${extra.join(", ")}`);
  if (missing.length) problems.push(`нет заголовков браузера ${missing.join(", ")}`);
  for (const k of Object.keys(w)) if (k in b && k !== "x-so-chat" && b[k] !== w[k]) problems.push(`${k}: «${b[k]}» ≠ «${w[k]}»`);
  for (const k of BOT_EXTRA_HEADERS) if (!(k in b)) problems.push(`нет ${k}`);
  if ("x-so-channel" in b && b["x-so-channel"] !== "telegram") problems.push(`x-so-channel=«${b["x-so-channel"]}» (ожид. telegram)`);
  if ("x-so-bot-key" in b && b["x-so-bot-key"] !== o.botKey) problems.push("x-so-bot-key не равен ключу конфигурации");
  if (b["x-so-chat"] !== o.bodyId) problems.push(`x-so-chat=«${b["x-so-chat"]}» ≠ body.id=«${String(o.bodyId)}»`);
  if (typeof o.bodyId !== "string" || !o.bodyId.startsWith("tg_")) problems.push(`body.id=«${String(o.bodyId)}» не начинается с tg_`);
  return { equal: problems.length === 0, problems };
}

/** Видимый текст ответа: части text подряд */
export const textOfMessage = (m: unknown): string => {
  const parts = (m as { parts?: Array<Record<string, unknown>> } | null)?.parts ?? [];
  return parts.filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join(" ").replace(/\s+/g, " ").trim();
};
