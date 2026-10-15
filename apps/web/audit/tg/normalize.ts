/**
 * WP-TG: нормализация и сравнение тел /api/chat (§4.5), текст SSR (§6 «Текст SSR»), сборка ответа из SSE (§3, решение 3).
 *
 * Нормализация N (§4.5) — единственные допуски, значение ПОДМЕНЯЕТСЯ константой, ключ не удаляется
 * (нет ключа → его нет и после N, так мутант «у сообщения пользователя нет id» остаётся различимым):
 *   - body.id                     → "<body.id>"
 *   - значение заголовка x-so-chat → "<x-so-chat>"
 *   - messages[].id               → "<messages[].id>"
 *   - toolCallId (любой глубины)  → "<toolCallId#1>", "<toolCallId#2>", … по порядку первого появления (одинаковые id — один номер)
 *   - built_at (любой глубины)    → "<built_at>"
 *   - diagnostics.snapshot_dir    → "<diagnostics.snapshot_dir>" (абсолютный путь машины записи)
 * Порядок ключей не важен: сравнивается канонический JSON (ключи отсортированы). Всё остальное — побайтно.
 *
 * Заголовки: сравниваются только content-type и x-* (имена в нижнем регистре). У бота сверх браузерных допустимы только
 * x-so-channel и x-so-bot-key (их значения компаратор не проверяет — это дело TG.4/TG.11); прочие заголовки (accept,
 * user-agent, …) не сравниваются.
 */
import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, UI_MESSAGE_STREAM_HEADERS, type UIMessage, type UIMessageChunk } from "ai";

/* ═══════════════════════════ канонический JSON и N ═══════════════════════════ */

/** Подстановки нормализации N */
export const PH = {
  bodyId: "<body.id>",
  chat: "<x-so-chat>",
  messageId: "<messages[].id>",
  toolCallId: (n: number) => `<toolCallId#${n}>`,
  builtAt: "<built_at>",
  snapshotDir: "<diagnostics.snapshot_dir>",
} as const;

/** Заголовки, которые бот вправе слать сверх браузерных (§4.5) */
export const BOT_EXTRA_HEADERS: readonly string[] = ["x-so-channel", "x-so-bot-key"];

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v);

/** Копия значения с рекурсивно отсортированными ключами (undefined в объектах выпадает, как в JSON) */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortKeys(x)));
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeys(v[k]);
  return out;
}
/** Канонический JSON: ключи отсортированы на всех уровнях, без пробелов */
export const canonical = (v: unknown): string => JSON.stringify(sortKeys(v)) ?? "undefined";

/** Обход дерева для N: toolCallId — нумерация по появлению (ключи — в отсортированном порядке), built_at, diagnostics.snapshot_dir */
function normTree(v: unknown, tc: Map<string, string>): unknown {
  if (Array.isArray(v)) return v.map((x) => normTree(x, tc));
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) {
    const val = v[k];
    if (val === undefined) continue;
    if (k === "toolCallId" && typeof val === "string") {
      if (!tc.has(val)) tc.set(val, PH.toolCallId(tc.size + 1));
      out[k] = tc.get(val);
    } else if (k === "built_at") out[k] = PH.builtAt;
    else if (k === "diagnostics" && isObj(val)) {
      const d = normTree(val, tc) as Record<string, unknown>;
      if ("snapshot_dir" in d) d.snapshot_dir = PH.snapshotDir;
      out[k] = d;
    } else out[k] = normTree(val, tc);
  }
  return out;
}

/** N для тела POST /api/chat (объект или сырой JSON-текст): body.id, messages[].id, toolCallId, built_at, diagnostics.snapshot_dir */
export function normalizeBody(body: unknown): unknown {
  const b = typeof body === "string" ? (JSON.parse(body) as unknown) : body;
  const out = normTree(b, new Map());
  if (!isObj(out)) return out;
  if ("id" in out) out.id = PH.bodyId;
  if (Array.isArray(out.messages)) out.messages = out.messages.map((m) => (isObj(m) && "id" in m ? { ...m, id: PH.messageId } : m));
  return out;
}

/** N для одного сообщения UIMessage (id → "<messages[].id>", toolCallId нумеруются внутри сообщения, built_at, snapshot_dir).
 *  Для TG.G2: N(сборка ответа k) ≡ N(сообщение ассистента в теле k+1) — нормализуйте оба этой функцией. */
export function normalizeMessage(m: unknown): unknown {
  const out = normTree(m, new Map());
  if (isObj(out) && "id" in out) out.id = PH.messageId;
  return out;
}

/** N для произвольного значения: только toolCallId, built_at, diagnostics.snapshot_dir (id не трогаются) */
export const normalizeValue = (v: unknown): unknown => normTree(v, new Map());

type HeaderInput = Record<string, string> | Headers | [string, string][];
/** Заголовки для сравнения: имена в нижнем регистре, только content-type и x-*, значение x-so-chat → "<x-so-chat>" */
export function normalizeHeaders(h: HeaderInput): Record<string, string> {
  const entries: [string, string][] = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h);
  const out: Record<string, string> = {};
  for (const [name, value] of entries.map(([n, v]) => [n.toLowerCase(), String(v)] as [string, string]).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (name !== "content-type" && !name.startsWith("x-")) continue;
    out[name] = name === "x-so-chat" ? PH.chat : value;
  }
  return out;
}

/* ═══════════════════════════ diff ═══════════════════════════ */

const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const keyPath = (p: string, k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `${p}.${k}` : `${p}[${JSON.stringify(k)}]`);
/** Короткое представление значения для detail */
export function brief(v: unknown, max = 120): string {
  if (v === undefined) return "нет";
  const s = typeof v === "string" ? `«${v}»` : canonical(v);
  const one = s.replace(/\s+/g, " ");
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}
function strDiff(a: string, b: string, la: string, lb: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 30);
  const win = (s: string) => `«${from > 0 ? "…" : ""}${s.slice(from, i + 60)}${s.length > i + 60 ? "…" : ""}»`;
  return `${la} ${win(a)} ≠ ${lb} ${win(b)} (первое расхождение — символ ${i}, длины ${a.length} и ${b.length})`;
}

/**
 * Первое расхождение двух JSON-значений с путём, или null, если равны (канонически).
 * Ключ со значением undefined считается отсутствующим. Пример результата:
 *   `body.messages[1].parts[0].state: браузер «output-available» ≠ бот «input-available»`
 * @param o.path   корень пути (по умолчанию "$")
 * @param o.labels подписи сторон (по умолчанию ["ожидалось", "получено"])
 */
export function diff(a: unknown, b: unknown, o: { path?: string; labels?: readonly [string, string] } = {}): string | null {
  const [la, lb] = o.labels ?? ["ожидалось", "получено"];
  const walk = (x: unknown, y: unknown, p: string): string | null => {
    if (x === y) return null;
    const tx = kindOf(x), ty = kindOf(y);
    if (tx !== ty) return `${p}: ${la} ${brief(x)} ≠ ${lb} ${brief(y)}`;
    if (tx === "array") {
      const xa = x as unknown[], ya = y as unknown[];
      const n = Math.min(xa.length, ya.length);
      const lenNote = xa.length !== ya.length ? `${p}: длина ${xa.length} (${la}) ≠ ${ya.length} (${lb}); ` : "";
      for (let i = 0; i < n; i++) {
        const r = walk(xa[i], ya[i], `${p}[${i}]`);
        if (r) return lenNote ? `${lenNote}первое расхождение — ${r}` : r;
      }
      if (lenNote) {
        const longer = xa.length > ya.length ? la : lb;
        const extra = (xa.length > ya.length ? xa : ya)[n];
        return `${lenNote}лишний элемент [${n}] у стороны «${longer}»: ${brief(extra)}`;
      }
      return null;
    }
    if (tx === "object") {
      const xo = x as Record<string, unknown>, yo = y as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(xo), ...Object.keys(yo)])].filter((k) => xo[k] !== undefined || yo[k] !== undefined).sort();
      for (const k of keys) {
        const kp = keyPath(p, k);
        if (xo[k] === undefined) return `${kp}: у стороны «${la}» ключа нет, у «${lb}» ${brief(yo[k])}`;
        if (yo[k] === undefined) return `${kp}: у стороны «${lb}» ключа нет, у «${la}» ${brief(xo[k])}`;
        const r = walk(xo[k], yo[k], kp);
        if (r) return r;
      }
      return null;
    }
    if (tx === "string") return `${p}: ${strDiff(x as string, y as string, la, lb)}`;
    if (tx === "number" && Number.isNaN(x) && Number.isNaN(y)) return null;
    return `${p}: ${la} ${brief(x)} ≠ ${lb} ${brief(y)}`;
  };
  return walk(a, b, o.path ?? "$");
}

/* ═══════════════════════════ сравнение пары «браузер vs бот» (И5) ═══════════════════════════ */

/** Запрос в проводе: заголовки (объект, Headers или пары) и тело (объект или сырой JSON-текст) */
export interface WireRequest { headers: HeaderInput; body: unknown }
export interface ParityResult {
  /** заголовки и тело равны после N */
  equal: boolean;
  /** первое расхождение (сначала заголовки, потом тело) — для detail; null при равенстве */
  diff: string | null;
  headerDiffs: string[];
  bodyDiff: string | null;
}

/**
 * Сравнение пары (заголовки, тело) браузера и бота по §4.5. Заголовки: каждый content-type/x-* браузера должен быть у бота
 * с тем же значением (x-so-chat — после N); у бота сверх браузерных разрешены только BOT_EXTRA_HEADERS. Тело: canonical(N(·)).
 * @param o.labels подписи сторон в detail (по умолчанию ["браузер", "бот"])
 */
export function comparePair(browser: WireRequest, bot: WireRequest, o: { labels?: readonly [string, string] } = {}): ParityResult {
  const labels = o.labels ?? (["браузер", "бот"] as const);
  const hb = normalizeHeaders(browser.headers), ht = normalizeHeaders(bot.headers);
  const headerDiffs: string[] = [];
  for (const [k, v] of Object.entries(hb)) {
    if (!(k in ht)) headerDiffs.push(`headers.${k}: у стороны «${labels[1]}» заголовка нет (у «${labels[0]}» ${brief(v)})`);
    else if (ht[k] !== v) headerDiffs.push(`headers.${k}: ${labels[0]} ${brief(v)} ≠ ${labels[1]} ${brief(ht[k])}`);
  }
  for (const k of Object.keys(ht))
    if (!(k in hb) && !BOT_EXTRA_HEADERS.includes(k)) headerDiffs.push(`headers.${k}: лишний заголовок у стороны «${labels[1]}» (${brief(ht[k])}); сверх браузерных допустимы только ${BOT_EXTRA_HEADERS.join(", ")}`);
  let bodyDiff: string | null;
  try {
    bodyDiff = diff(normalizeBody(browser.body), normalizeBody(bot.body), { path: "body", labels });
  } catch (e) {
    bodyDiff = `body: тело не разбирается как JSON (${String(e).slice(0, 120)})`;
  }
  const all = [...headerDiffs, ...(bodyDiff ? [bodyDiff] : [])];
  return { equal: all.length === 0, diff: all[0] ?? null, headerDiffs, bodyDiff };
}

/* ═══════════════════════════ текст SSR (§6) и Telegram-HTML ═══════════════════════════ */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", minus: "−", thinsp: " ",
};
/** Раскодирование HTML-сущностей: именованные (amp, lt, gt, quot, apos, nbsp, …) и числовые &#NNN; / &#xHH; Неизвестные остаются как есть */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
/** `\s+` → один пробел, trim. В JS `\s` включает U+00A0 и U+202F: строки VM (с неразрывными пробелами Intl ru-RU) перед
 *  поиском в ssrText пропускайте через collapseWs — иначе «1 000 ₽» с NBSP не найдётся в тексте с обычными пробелами. */
export const collapseWs = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Разделитель фрагментов ssrText: текст страницы, затем каждое значение aria-label с новой строки */
export const SSR_SEP = "\n";

/** Тег HTML (React экранирует `<`/`>` и в тексте, и в атрибутах, поэтому `<[^>]*>` режет ровно по тегам) */
const TAG_RE = /<[^>]*>/g;
/** Атрибуты открывающего тега: имя → раскодированное значение (булевы — "") */
export function tagAttrs(tag: string): Record<string, string> {
  const inner = tag.replace(/^<\s*\/?\s*[^\s>/]+/, "").replace(/\/?>$/, "");
  const out: Record<string, string> = {};
  for (const m of inner.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g))
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}
const tagName = (tag: string) => (tag.match(/^<\s*\/?\s*([^\s>/]+)/)?.[1] ?? "").toLowerCase();

export interface AriaLabel { value: string; tag: string; attrs: Record<string, string> }
/** Все aria-label в порядке документа: значение (раскодировано, пробелы схлопнуты), тег и все атрибуты элемента */
export function ariaLabels(html: string): AriaLabel[] {
  const out: AriaLabel[] = [];
  for (const m of html.matchAll(TAG_RE)) {
    const t = m[0];
    if (t.startsWith("</") || t.startsWith("<!")) continue;
    const attrs = tagAttrs(t);
    if ("aria-label" in attrs) out.push({ value: collapseWs(attrs["aria-label"]), tag: tagName(t), attrs });
  }
  return out;
}

/**
 * Текст SSR — ровно §6 «Текст SSR»: каждый тег `<…>` → пробел; HTML-сущности раскодированы; `\s+` → " ", trim;
 * затем значения aria-label отдельными фрагментами: `[текст, ...aria].join(SSR_SEP)` (каждое значение тоже раскодировано
 * и схлопнуто). Спаны встык дают пробел: `…>40</span><span class="score__of">/ 100</span>` → «40 / 100».
 * Ею пишется снимок fixtures/tg/ssr_golden.json (TG.G5) и ищутся строки VM (TG.6(а): `ssrText(html).includes(collapseWs(s))`).
 */
export function ssrText(html: string): string {
  const text = collapseWs(decodeEntities(html.replace(TAG_RE, " ")));
  return [text, ...ariaLabels(html).map((a) => a.value)].join(SSR_SEP);
}

export interface HtmlFragments {
  /** части, на которые HTML режут теги; каждая раскодирована и схлопнута; пустые выброшены */
  text: string[];
  /** все aria-label (с атрибутами элемента: бары доходности — `attrs["data-chart"] === "yield-bars"`) */
  aria: AriaLabel[];
}
/** Фрагментация SSR для TG.6(б): «фрагменты — части, на которые HTML режут теги» + каждый aria-label */
export function htmlFragments(html: string): HtmlFragments {
  const text = html.split(TAG_RE).map((s) => collapseWs(decodeEntities(s))).filter((s) => s.length > 0);
  return { text, aria: ariaLabels(html) };
}

/** Текст Telegram-HTML для TG.6-tg и TG.8: теги снимаются на "" (не на пробел), сущности раскодированы, пробелы не трогаются.
 *  Так `<b>40</b>/ 100` даёт «40/ 100», а не «40 / 100» (§6). */
export const tgPlain = (html: string): string => decodeEntities(html.replace(TAG_RE, ""));

/* ═══════════════════════════ сборка ответа из SSE (как в браузере) ═══════════════════════════ */

export interface Assembled {
  status: number;
  /** итоговое сообщение ассистента — последний снимок readUIMessageStream; null, если частей не было */
  message: UIMessage | null;
  /** все разобранные чанки UI-потока по порядку (для TG.9 и detail) */
  chunks: UIMessageChunk[];
  /** ошибки разбора/сборки (невалидный чанк, chunk type "error" и т. п.) */
  errors: string[];
}

/**
 * Ответ POST /api/chat (SSE UI-потока) → UIMessage функциями ai@7.0.133: parseJsonEventStream + uiMessageChunkSchema +
 * readUIMessageStream — тот же processUIMessageStream, что под assistant-ui в браузере (DefaultChatTransport). Свой разбор SSE
 * запрещён (§3, решение 3). Невалидный чанк не бросает: попадает в errors, сборка продолжается до конца потока.
 * @param o.message предыдущее сообщение ассистента, к которому дописывается поток (как в AbstractChat при продолжении); обычно не нужно
 */
export async function assembleUIMessage(res: Response, o: { message?: UIMessage } = {}): Promise<Assembled> {
  const errors: string[] = [];
  const chunks: UIMessageChunk[] = [];
  if (!res.body) return { status: res.status, message: null, chunks, errors: ["у ответа нет тела"] };
  const stream = parseJsonEventStream({ stream: res.body, schema: uiMessageChunkSchema }).pipeThrough(
    new TransformStream<{ success: boolean; value?: UIMessageChunk; error?: unknown }, UIMessageChunk>({
      transform(part, ctl) {
        if (!part.success) { errors.push(`чанк не прошёл uiMessageChunkSchema: ${String(part.error).slice(0, 200)}`); return; }
        const v = part.value as UIMessageChunk;
        chunks.push(v);
        if (v.type === "error") errors.push(`чанк error: ${(v as { errorText?: string }).errorText ?? ""}`);
        ctl.enqueue(v);
      },
    }),
  );
  let last: UIMessage | null = null;
  for await (const m of readUIMessageStream<UIMessage>({ stream, message: o.message, onError: (e) => errors.push(`readUIMessageStream: ${String(e).slice(0, 200)}`) }))
    last = m;
  return { status: res.status, message: last ? (JSON.parse(JSON.stringify(last)) as UIMessage) : null, chunks, errors };
}

/** Текст сообщения: text-части подряд через пробел, пробелы схлопнуты */
export function messageText(m: { parts?: ReadonlyArray<{ type: string; text?: string }> } | null | undefined): string {
  return collapseWs((m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" "));
}

/**
 * Рукописный ответ сервера — SSE UI-потока в точности как createUIMessageStreamResponse (`data: <JSON>\n\n` на чанк,
 * в конце `data: [DONE]\n\n`, заголовки UI_MESSAGE_STREAM_HEADERS). Для фейкового fetch в TG.9 и TG.17.
 * Чанки не валидируются здесь: TG.9 требует, чтобы они проходили uiMessageChunkSchema, — проверьте через assembleUIMessage (errors пуст).
 * @param o.status    HTTP-статус (по умолчанию 200)
 * @param o.breakAfter оборвать поток ошибкой после N чанков (обрыв потока, TG.17): без [DONE], чтение body отклоняется
 * @param o.delayMs   пауза перед каждым чанком (по умолчанию 0)
 */
export function sseResponse(chunks: ReadonlyArray<Record<string, unknown>>, o: { status?: number; breakAfter?: number; delayMs?: number } = {}): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (o.breakAfter != null && i >= o.breakAfter) { ctl.error(new Error("аудит WP-TG: обрыв потока")); return; }
      if (i >= chunks.length) { ctl.enqueue(enc.encode("data: [DONE]\n\n")); ctl.close(); return; }
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      ctl.enqueue(enc.encode(`data: ${JSON.stringify(chunks[i++])}\n\n`));
    },
  });
  return new Response(body, { status: o.status ?? 200, headers: { ...UI_MESSAGE_STREAM_HEADERS } });
}
