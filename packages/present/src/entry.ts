/**
 * Вход в разговор — общий для сайта и Telegram-бота (план WP-TG §4.1, §4.6): ссылка /chat?…, первая реплика, переход
 * «отчёт → ассистент», реплика выбора выпуска, подсказки пустого чата и deep-link бота `/start <payload>`.
 * Перенос из apps/web без изменения поведения: initialOf — app/chat/page.tsx, firstText — components/ChatApp.tsx,
 * chatParams — ядро chatHref из app/check/CheckClient.tsx, pickMessage — components/ToolUIs.tsx, SUGGESTIONS — components/Thread.tsx.
 */
import { ReportInputsSchema, type BuildResultT, type ReportInputs } from "@so/engine/contract";

/** Параметры входа, значения — строки, как в URL: /chat?q=…&promised=…&pos=…&k=…&price=… или /chat?m=… */
export type EntryParams = { q?: string; promised?: string; pos?: string; k?: string; price?: string; m?: string };

/** Вход в чат, уже проверенный схемой: переход с /check — бумага и вводы; вопрос с главной — text (?m=…). */
export type ChatInitial = { q: string; inputs: ReportInputs; text?: never } | { text: string; q?: never; inputs?: never };

/** Длина запроса q (как /api/report) */
const Q_MAX = 200;
/** Длина текста первого сообщения с главной (?m=…) */
const M_MAX = 500;

type InputField = keyof typeof ReportInputsSchema.shape;

/** Число из параметра: пробелы убираются, десятичная запятая → точка; пусто или не число — undefined */
const num = (s: string | undefined) => {
  if (!s) return undefined;
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
};

/** Вход в чат — недоверенный ввод, невалидное игнорируется (не ошибка):
 *  (1) переход «отчёт → ассистент»: /chat?q=…&promised=…&pos=…&k=…&price=… (как у /check) и deep-link бота. q — до 200 символов
 *      (как /api/report), числа — поодиночке через ReportInputsSchema. Есть q — решает только он, m не смотрим (приоритет у q).
 *  (2) вопрос с главной: /chat?m=<текст> — первое сообщение пользователя как есть (trim, до M_MAX символов; пустое — без автоотправки).
 *      Проверяется только длина: дальше это обычная реплика — гейт и модель разбирают её как любой ввод. */
export function initialOf(p: EntryParams): ChatInitial | undefined {
  const q = (p.q ?? "").trim();
  if (q) {
    if (q.length > Q_MAX) return undefined;
    const raw: [InputField, number | undefined][] = [
      ["promised_pct", num(p.promised)], ["position_size", num(p.pos)], ["k_pct", num(p.k)], ["offer_price_pct", num(p.price)],
    ];
    const inputs: ReportInputs = Object.fromEntries(
      raw.filter(([k, v]) => v !== undefined && (k !== "promised_pct" || v > 0) && ReportInputsSchema.safeParse({ [k]: v }).success), // «обещали 0%» — не обещание
    );
    return { q, inputs };
  }
  const text = (p.m ?? "").trim();
  return text && text.length <= M_MAX ? { text } : undefined;
}

/** Первое сообщение. С главной — текст пользователя как есть. С /check — только то, что гейт надёжно разбирает в одной реплике
 *  (check_security + «обещали»); сумма / комиссия / цена идут полем inputs тела запроса, не текстом (одна реплика — одно намерение, R2-21). */
export function firstText(i: ChatInitial): string {
  return i.text ?? `Проверь ${i.q}` + (i.inputs?.promised_pct != null ? `, обещали ${String(i.inputs.promised_pct).replace(".", ",")}%` : "");
}

/** Переход «отчёт → ассистент»: та же бумага (ISIN стабильнее текста запроса) и те же вводы — актуальные, из отчёта.
 *  Контракт параметров — docs/PLAN_check-to-chat_2026-10-10.md §3; вход их валидирует сам (initialOf). Не отчёт — null. */
export function chatParams(res: BuildResultT, query: string): EntryParams | null {
  if (res.kind !== "report") return null;
  const r = res.report;
  const q = (r.security.isin ?? r.security.secid ?? query).trim();
  if (!q || q.length > Q_MAX) return null;
  const out: EntryParams = { q };
  const i = r.inputs;
  if (i.promised_pct != null && i.promised_pct > 0) out.promised = String(i.promised_pct);
  if (i.position_size != null) out.pos = String(i.position_size);
  if (i.k_pct != null) out.k = String(i.k_pct);
  if (i.offer_price_pct != null) out.price = String(i.offer_price_pct); // отчёт собран по цене пользователя (ветка «нет цены»)
  return out;
}

/** Реплика выбора выпуска из списка: ISIN, а без него — SECID */
export function pickMessage(c: { isin?: string | null; secid: string }): string {
  return `Проверь ${c.isin ?? c.secid}`;
}

/** Подсказки пустого чата */
export const SUGGESTIONS: readonly string[] = [
  "Проверь РОЛЬФ 1Р07, обещали 26%",
  "RU000A0JS4Z7 — говорят, 18% годовых",
  "Черкизово",
  "Что такое НКД?",
];

/* ───── deep-link бота: /start <payload> (§4.6) ─────
 * payload — не больше 64 символов из [A-Za-z0-9_-]: обязательная часть q<ISIN|SECID> (q — [A-Za-z0-9]{1,20}), затем
 * необязательные целые части _p<обещали×100>, _s<сумма>, _k<комиссия×100>, _o<цена×100>.
 * Пример: qRU000A1038V6_p1500_s1000000_k30 ≡ /chat?q=RU000A1038V6&promised=15&pos=1000000&k=0.3.
 * Текст с главной (?m=…) не кодируется: в боте его просто пишут. */

const PAYLOAD_MAX = 64;
const PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;
const Q_RE = /^[A-Za-z0-9]{1,20}$/;
/** Части payload в порядке записи: буква, поле EntryParams, масштаб (сотые доли или целое) */
const PARTS = [
  { tag: "p", key: "promised", scale: 100 },
  { tag: "s", key: "pos", scale: 1 },
  { tag: "k", key: "k", scale: 100 },
  { tag: "o", key: "price", scale: 100 },
] as const;

/** Значение части: x = Number(значение), n = Math.round(x × масштаб); пишется n, только если n / масштаб === x точно
 *  (у суммы — x целое) и n — неотрицательное целое; иначе null — ссылка не строится. 0.07 × 100 = 7.000000000000001 → 7. */
function partValue(v: string, scale: number): string | null {
  const x = Number(v);
  const n = Math.round(x * scale);
  return Number.isSafeInteger(n) && n >= 0 && n / scale === x ? String(n) : null;
}

/** EntryParams → payload deep-link; null, если ссылку не построить (нет q, q не из [A-Za-z0-9]{1,20}, число не в сотых, длина > 64) */
export function encodeStartPayload(p: EntryParams): string | null {
  const q = (p.q ?? "").trim();
  if (!Q_RE.test(q)) return null;
  let out = "q" + q;
  for (const part of PARTS) {
    const v = p[part.key];
    if (v === undefined || v === "") continue;
    const n = partValue(v, part.scale);
    if (n == null) return null;
    out += `_${part.tag}${n}`;
  }
  return out.length <= PAYLOAD_MAX ? out : null;
}

/** payload deep-link → EntryParams (значения — строки, как в URL: String(n / 100), сумма — String(n)); невалидный — null.
 *  Дальше — как ссылка /chat?q=…: initialOf (та же схема), первая реплика firstText и inputs в теле каждого запроса. */
export function decodeStartPayload(s: string): EntryParams | null {
  if (s.length > PAYLOAD_MAX || !PAYLOAD_RE.test(s)) return null;
  const [head, ...rest] = s.split("_");
  if (!head.startsWith("q") || !Q_RE.test(head.slice(1))) return null;
  const out: EntryParams = { q: head.slice(1) };
  const vals = new Map<string, string>();
  for (const seg of rest) {
    const part = PARTS.find((x) => x.tag === seg[0]);
    const digits = seg.slice(1);
    if (!part || vals.has(part.key) || !/^\d+$/.test(digits)) return null;
    vals.set(part.key, String(Number(digits) / part.scale));
  }
  for (const part of PARTS) {
    const v = vals.get(part.key);
    if (v !== undefined) out[part.key] = v;
  }
  return out;
}
