/**
 * WP-TG, группа «server» — сценарии ДОЧЕРНЕГО процесса для проверок apps/web/audit/tg/checks-server.ts
 * (TG.3, TG.11, TG.12, TG.13, TG.14, TG.23 — часть health, TG.G1, TG.G2, TG.G6). Запуск только из родителя:
 * `scenario("server:<name>", { env })` (scenarios.ts) — cwd = apps/web, окружение §6 «Как устроен» (SO_OFFLINE=1 MOCK_LLM=1
 * JEV_ENABLED=0, ключи LLM/Jev сняты, свой временный SO_USAGE_DIR, SO_USAGE_LOG=1, SO_BOT_KEY = TG_TEST.botKey,
 * SO_DAILY_BUDGET_USD=2, SO_MESSAGE_LIMIT снят), "server-only" → пустой модуль, внешний fetch бросает.
 *
 * Сценарии (имя → что делает; результат — JSON для родителя, судит проверка):
 *   parity          — 15 тел эталона как веб (заголовки и тела браузера) и те же тела как бот (id `tg_…`, x-so-chat = id,
 *                     x-so-channel: telegram, x-so-bot-key = тестовый ключ): ответы, собранные ai, пары «ответ k ≡ ассистент в
 *                     теле k+1», префиксы истории, записи gate/answer usage.jsonl (TG.G2, TG.3, TG.G6 — статусы 15 тел);
 *   tg11            — подслучаи (a)–(i) ключа бота ((b) и (d) — в двух вариантах: два условия из трёх и одно; (j) — третий
 *                     вариант «два из трёх»: tg_-id и верный ключ без x-so-channel) и повтор (e)
 *                     после переключения SO_BOT_KEY внутри процесса (TG.11);
 *   limits          — запускать с SO_MESSAGE_LIMIT=2: три хода веба и бота в одной сессии, затем budget.json со spent ≥ 2 за mskDay()
 *                     и по ходу веба и бота в новых сессиях (TG.G1, TG.12);
 *   tg13            — таблица значений ввода через /api/report (GET, POST), body.inputs /api/chat, /check (CheckPage как функция),
 *                     initialOf, decodeStartPayload;
 *                     ReportInputsSchema из @so/engine/contract и тождество с tools.inputsSchema; пределы цены: константа
 *                     CONFIG.inputs.offerPricePct, схема и форма AskPrice (submit формы, SSR react-dom/server) на min−ε/min/внутри/max/max+ε;
 *                     AskPrice при подменённой на месте константе (сужение и расширение, blocks.tsx загружается заново);
 *                     плотная сверка схемы с константой: ~210 точек до 0,001 (seed), принять ⇔ min ≤ v ≤ max (TG.13);
 *   tg14            — текст гейта на 13 golden-запросах (вводы кейса — как вводы /check: session.pendingInputs) и экспортируемая
 *                     функция текста отчёта на veb с переставленным truth_score.top3 (TG.14 (б), (в));
 *   health-version  — запускать с SO_APP_DIR: импорт app/api/health/route, перезапись VERSION на HEALTH_VERSION_B, локальный и
 *                     внешний GET (TG.23);
 *   g6              — синтетическая история: 10 golden-отчётов (buildCached = build + applyInputs на снимках) в 10 ответах
 *                     ассистента + новая реплика, POST /api/chat (TG.G6).
 */
import fs from "node:fs";
import path from "node:path";
import type { UIMessage } from "ai";
import type { BondReportT, BuildResultT, ReportInputs } from "@so/engine/contract";
import { REPO_ROOT } from "../lib";
import { loadDialog, loadDialogs } from "./actions";
import { assembleUIMessage, diff, normalizeBody, normalizeMessage } from "./normalize";
import { loadServer, readUsage, TG_TEST, writeBudget, type Server } from "./scenarios";
import { loadPresent, repoAbs, tryImport, type ChatBody } from "./types";

/* ═══════════════════════════ общие константы (их же читает родитель) ═══════════════════════════ */

/**
 * VERSION, которую родитель кладёт в SO_APP_DIR до импорта health. Пишется БЕЗ перевода строки — буквально по TG.23 («VERSION=A →
 * version === A»): ни §4.3, ни TG.23 не требуют срезать перевод строки, который оставляет `git rev-parse --short HEAD > VERSION`.
 * Когда план это требование запишет (§4.3 «без пробельных символов по краям», §4.4 readVersion, TG.23 «VERSION = "A\n"»),
 * родителю писать HEALTH_VERSION_A + "\n".
 */
export const HEALTH_VERSION_A = "a1b2c3d";
/** VERSION, на которую сценарий переписывает файл ПОСЛЕ импорта health: health должен отдать A (читается один раз при загрузке) */
export const HEALTH_VERSION_B = "b2c3d4e";
/** Заголовки бота (§4.4 buildChatRequest): content-type, x-so-chat = id сессии, x-so-channel: telegram, x-so-bot-key */
export const botHeaders = (sid: string, key: string = TG_TEST.botKey): Record<string, string> =>
  ({ "content-type": "application/json", "x-so-chat": sid, "x-so-channel": "telegram", "x-so-bot-key": key });
/** id сессий бота в TG.3: `tg_` + 12 символов, как newSessionId (§4.4) */
export const tg3SessionId = (dialogId: string) => `tg_tg3-dialog-${dialogId.replace(/^d/, "")}`;

/* ═══════════════════════════ мелочи ═══════════════════════════ */

const errStr = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, " ").slice(0, 400);
/** Текст ответа побайтно: text-части подряд, без схлопывания пробелов */
const rawText = (m: UIMessage | null): string =>
  (m?.parts ?? []).filter((p) => p.type === "text").map((p) => (p as { text?: string }).text ?? "").join("");
const userMsg = (id: string, text: string) => ({ id, role: "user" as const, parts: [{ type: "text", text }], metadata: { custom: {} } });

interface Asm { status: number; message: UIMessage | null; errors: string[]; error: string | null }
/** POST и сборка ответа ai; исключение маршрута — в error (сценарий не падает: остальные запросы идут) */
async function send(p: () => Promise<Response>): Promise<Asm> {
  try {
    const res = await p();
    const a = await assembleUIMessage(res);
    return { status: a.status, message: a.message, errors: a.status === 200 ? a.errors : [], error: null };
  } catch (e) {
    return { status: 0, message: null, errors: [], error: errStr(e) };
  }
}
/** Записи gate/answer журнала (usage.jsonl ребёнка) — сжато: chat, step, есть ли поле channel и его значение */
export interface UsageGA { chat: string; step: string; hasChannel: boolean; channel: unknown }
const usageGA = (from = 0): UsageGA[] =>
  readUsage().slice(from).filter((r) => r.step === "gate" || r.step === "answer")
    .map((r) => ({ chat: String(r.chat ?? ""), step: String(r.step), hasChannel: "channel" in r, channel: "channel" in r ? (r.channel ?? null) : null }));

/* ═══════════════════════════ parity: TG.G2 + TG.3 ═══════════════════════════ */

export interface ParityWeb {
  dialog: string; k: number; sid: string; status: number; errors: string[]; error: string | null; text: string;
  /** есть ли следующий запрос того же диалога (пара k → k+1); у последнего запроса диалога пары нет, diff — null */
  hasNext: boolean;
  pairDiff: string | null; prefixDiff: string | null;
}
export interface ParityBot { dialog: string; k: number; sid: string; status: number; errors: string[]; error: string | null; text: string; vsWeb: string | null }
export interface ParityOut { web: ParityWeb[]; bot: ParityBot[]; usage: UsageGA[] }

async function parity(): Promise<ParityOut> {
  const srv = await loadServer();
  const web: ParityWeb[] = [];
  const bot: ParityBot[] = [];
  for (const d of loadDialogs()) {
    const webMsgs: (UIMessage | null)[] = [];
    for (let k = 0; k < d.requests.length; k++) {
      const r = d.requests[k];
      const w = await send(() => srv.postRecorded(r));
      webMsgs.push(w.message);
      const next = d.requests[k + 1];
      let pairDiff: string | null = null;
      let prefixDiff: string | null = null;
      if (next) {
        const len = r.body.messages.length;
        const expected = next.body.messages[len];
        pairDiff = w.message
          ? diff(normalizeMessage(expected), normalizeMessage(w.message), { path: "message", labels: [`браузер (${d.id}, тело ${k + 2}, messages[${len}])`, "сборка ai"] })
          : `сборка ai не дала сообщения (HTTP ${w.status}${w.error ? `, ${w.error}` : ""})`;
        prefixDiff = diff(normalizeBody(r.body), normalizeBody({ ...next.body, messages: next.body.messages.slice(0, len) }),
          { path: "body", labels: [`тело ${k + 1}`, `тело ${k + 2} без последних ${next.body.messages.length - len} сообщений`] });
      }
      web.push({ dialog: d.id, k, sid: String(r.body.id ?? ""), status: w.status, errors: w.errors, error: w.error, text: rawText(w.message), hasNext: !!next, pairDiff, prefixDiff });
    }
    const sid = tg3SessionId(d.id);
    for (let k = 0; k < d.requests.length; k++) {
      const r = d.requests[k];
      const b = await send(() => srv.postRecorded(r, { headers: botHeaders(sid), body: { ...r.body, id: sid } }));
      const wm = webMsgs[k];
      const vsWeb = wm && b.message
        ? diff(normalizeMessage(wm), normalizeMessage(b.message), { path: "message", labels: ["веб", "бот"] })
        : `нет собранного сообщения: веб ${wm ? "есть" : "нет"}, бот ${b.message ? "есть" : `нет (HTTP ${b.status}${b.error ? `, ${b.error}` : ""})`}`;
      bot.push({ dialog: d.id, k, sid, status: b.status, errors: b.errors, error: b.error, text: rawText(b.message), vsWeb });
    }
  }
  return { web, bot, usage: usageGA() };
}

/* ═══════════════════════════ tg11: ключ бота ═══════════════════════════ */

export type KeyState = "test" | "unset" | "empty";
export interface Tg11Case {
  id: string; what: string; sid: string; key: KeyState; expect: 200 | 403; headers: Record<string, string>;
  status: number; error: string | null;
  umBefore: number; umAfter: number; bmBefore: number; bmAfter: number;
  logs: UsageGA[];
}
export interface Tg11Out { cases: Tg11Case[]; wrongKeySameLength: boolean }

/** Неверный ключ той же длины: отличается только последним символом (ловит и сравнение по префиксу) */
export const wrongKey = (k: string) => k.slice(0, -1) + (k.endsWith("6") ? "7" : "6");
/** Заголовки для показа в detail: значение ключа — только «тестовый» / «неверный той же длины» / «пустой» */
const showHeaders = (h: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k === "content-type") continue;
    out[k] = k !== "x-so-bot-key" ? v : v === TG_TEST.botKey ? "<тестовый ключ>" : v === "" ? "<пусто>" : v.length === TG_TEST.botKey.length ? "<неверный, той же длины>" : "<иной>";
  }
  return out;
};

async function tg11(): Promise<Tg11Out> {
  const srv = await loadServer();
  const base = loadDialog("d1").requests[0]; // «ОФЗ 26238»
  const setKey = (s: KeyState) => {
    if (s === "unset") delete process.env.SO_BOT_KEY;
    else process.env.SO_BOT_KEY = s === "empty" ? "" : TG_TEST.botKey;
  };
  const cases: Tg11Case[] = [];
  const ct = { "content-type": "application/json" };
  const one = async (id: string, what: string, sid: string, key: KeyState, expect: 200 | 403, headers: Record<string, string>, body?: ChatBody) => {
    setKey(key);
    const umBefore = srv.session.getSession(sid).userMessages;
    const bmBefore = srv.budget.budgetState().messages;
    const u0 = readUsage().length;
    let status = 0, error: string | null = null;
    try {
      const res = await srv.post(body ?? { ...base.body, id: sid }, headers);
      status = res.status;
      await res.text(); // дочитать поток: гейт и onEnd отработали до замера
    } catch (e) { error = errStr(e); }
    const umAfter = srv.session.getSession(sid).userMessages;
    const bmAfter = srv.budget.budgetState().messages;
    cases.push({ id, what, sid, key, expect, headers: showHeaders(headers), status, error, umBefore, umAfter, bmBefore, bmAfter, logs: usageGA(u0).filter((l) => l.chat === sid) });
  };
  const K = TG_TEST.botKey;
  const tg = "tg_x";
  await one("a", "id tg_x без заголовков канала и ключа", tg, "test", 403, { ...ct });
  // (b) и (d) — по два варианта: два условия из трёх и одно (только заголовок канала / только ключ) — оба → 403 (§4.3)
  await one("b1", "x-so-channel: telegram без ключа, id tg_x", tg, "test", 403, { ...ct, "x-so-chat": tg, "x-so-channel": "telegram" });
  const plain = "__LOCALID_tg11b2";
  await one("b2", "x-so-channel: telegram без ключа, id без tg_", plain, "test", 403, { ...ct, "x-so-chat": plain, "x-so-channel": "telegram" });
  await one("c", "неверный ключ той же длины", tg, "test", 403, botHeaders(tg, wrongKey(K)));
  const notTg = "__LOCALID_tg11d";
  await one("d1", "верный ключ и x-so-channel, id без tg_", notTg, "test", 403, botHeaders(notTg));
  const notTg2 = "__LOCALID_tg11d2";
  await one("d2", "верный ключ без x-so-channel, id без tg_", notTg2, "test", 403, { ...ct, "x-so-chat": notTg2, "x-so-bot-key": K });
  // (j) третий вариант «два условия из трёх»: id tg_ и верный ключ без x-so-channel → 403 (§4.3). Свой id, не tg_x: у реализации,
  // которая не требует x-so-channel, ответ 200 засчитал бы ход сессии tg_x и дал бы ложные «userMessages от прошлых подслучаев» в (g)–(i)
  const tgJ = "tg_tg11-case-j";
  await one("j", "верный ключ и id tg_, без x-so-channel", tgJ, "test", 403, { ...ct, "x-so-chat": tgJ, "x-so-bot-key": K });
  const okId = "tg_tg11-case-e";
  await one("e", "всё верно (id tg_…, x-so-channel: telegram, верный ключ)", okId, "test", 200, botHeaders(okId));
  const br = loadDialog("d3").requests[0];
  await one("f", "тело и заголовки браузера (d3, запрос 1)", String(br.body.id), "test", 200, { ...br.headers }, br.body);
  await one("g", "SO_BOT_KEY снят (delete process.env.SO_BOT_KEY), x-so-bot-key: \"\"", tg, "unset", 403, botHeaders(tg, ""));
  await one("h1", "SO_BOT_KEY=\"\", x-so-bot-key: \"\"", tg, "empty", 403, botHeaders(tg, ""));
  await one("h2", "SO_BOT_KEY=\"\", прежний тестовый ключ бота (выключатель §7)", tg, "empty", 403, botHeaders(tg));
  await one("i", "SO_BOT_KEY непуст, x-so-bot-key: \"\"", tg, "test", 403, botHeaders(tg, ""));
  const okId2 = "tg_tg11-case-e2";
  await one("e2", "повтор (e) после (g)/(h), SO_BOT_KEY снова тестовый", okId2, "test", 200, botHeaders(okId2));
  setKey("test");
  return { cases, wrongKeySameLength: wrongKey(K).length === K.length && wrongKey(K) !== K };
}

/* ═══════════════════════════ limits: TG.G1 + TG.12 (SO_MESSAGE_LIMIT=2) ═══════════════════════════ */

export interface Turn { status: number; text: string; errors: string[]; error: string | null }
export interface LimitsOut {
  messageLimit: number; dailyBudget: number; budgetExhausted: boolean; budgetSpent: number; budgetText: string;
  web: Turn[]; bot: Turn[]; budgetWeb: Turn; budgetBot: Turn; body: string;
}
const turnOf = (a: Asm): Turn => ({ status: a.status, text: rawText(a.message), errors: a.errors, error: a.error });

async function limits(): Promise<LimitsOut> {
  const srv = await loadServer();
  if (srv.session.MESSAGE_LIMIT !== 2)
    throw new Error(`дефект харнеса: MESSAGE_LIMIT=${srv.session.MESSAGE_LIMIT}, ожидалось 2 — SO_MESSAGE_LIMIT=2 не дошёл до session.ts`);
  const r = loadDialog("d3").requests[0]; // «Что такое дюрация?» — гейт отвечает термином, отчёт не собирается
  const three = async (sid: string, headers: Record<string, string>) => {
    const out: Turn[] = [];
    for (let i = 0; i < 3; i++) out.push(turnOf(await send(() => srv.post({ ...r.body, id: sid }, headers))));
    return out;
  };
  const web = await three("__LOCALID_limits-web", { "content-type": "application/json", "x-so-chat": "c_limits_web" });
  const bot = await three("tg_limits-bot-1", botHeaders("tg_limits-bot-1"));
  const before = srv.budget.budgetState();
  writeBudget({ day: srv.budget.mskDay(), spent: 2, messages: before.messages });
  const st = srv.budget.budgetState();
  if (!st.exhausted)
    throw new Error(`дефект харнеса: после записи budget.json со spent=2 бюджет не исчерпан (limit=${st.limit}, spent=${st.spent}) — SO_DAILY_BUDGET_USD или SO_USAGE_DIR не дошли до budget.ts`);
  const budgetWeb = turnOf(await send(() => srv.post({ ...r.body, id: "__LOCALID_limits-budget" }, { "content-type": "application/json", "x-so-chat": "c_limits_budget" })));
  const budgetBot = turnOf(await send(() => srv.post({ ...r.body, id: "tg_limits-bot-2" }, botHeaders("tg_limits-bot-2"))));
  return {
    messageLimit: srv.session.MESSAGE_LIMIT, dailyBudget: srv.budget.DAILY_BUDGET_USD, budgetExhausted: st.exhausted, budgetSpent: st.spent,
    budgetText: srv.budget.BUDGET_EXHAUSTED_TEXT, web, bot, budgetWeb, budgetBot, body: "d3, тело 1 («Что такое дюрация?»)",
  };
}

/* ═══════════════════════════ tg13: одна схема ввода ═══════════════════════════ */

type Field = keyof ReportInputs;
export interface Row { label: string; field: Field; param: "pos" | "k" | "promised" | "price"; part: "s" | "k" | "p" | "o"; v: number; valid: boolean }
const ISIN_ROLF = "RU000A10ASE2"; // РОЛЬФ 1Р07: биржевая цена есть — сумма, комиссия, «обещали»
const ISIN_NOPRICE = "RU000A105M67"; // ЧеркизБ1P6: нет биржевой цены — цена предложения (cherk1p6)
/** Таблица TG.13: NaN, pos 999, k 3,5, promised 101, price 0, 0,5 и 301 — отклоняются; валидные, включая границы схемы, — принимаются */
export const TG13_ROWS: Row[] = [
  { label: "pos NaN", field: "position_size", param: "pos", part: "s", v: NaN, valid: false },
  { label: "pos 999", field: "position_size", param: "pos", part: "s", v: 999, valid: false },
  { label: "k 3,5", field: "k_pct", param: "k", part: "k", v: 3.5, valid: false },
  { label: "promised 101", field: "promised_pct", param: "promised", part: "p", v: 101, valid: false },
  { label: "price 0", field: "offer_price_pct", param: "price", part: "o", v: 0, valid: false },
  { label: "price 0,5", field: "offer_price_pct", param: "price", part: "o", v: 0.5, valid: false },
  { label: "price 301", field: "offer_price_pct", param: "price", part: "o", v: 301, valid: false },
  { label: "pos 1000 (граница)", field: "position_size", param: "pos", part: "s", v: 1000, valid: true },
  { label: "pos 1 000 000", field: "position_size", param: "pos", part: "s", v: 1_000_000, valid: true },
  { label: "k 0,3", field: "k_pct", param: "k", part: "k", v: 0.3, valid: true },
  { label: "k 3 (граница)", field: "k_pct", param: "k", part: "k", v: 3, valid: true },
  { label: "promised 15", field: "promised_pct", param: "promised", part: "p", v: 15, valid: true },
  { label: "promised 100 (граница)", field: "promised_pct", param: "promised", part: "p", v: 100, valid: true },
  { label: "price 1 (граница)", field: "offer_price_pct", param: "price", part: "o", v: 1, valid: true },
  { label: "price 98,5", field: "offer_price_pct", param: "price", part: "o", v: 98.5, valid: true },
  { label: "price 300 (граница)", field: "offer_price_pct", param: "price", part: "o", v: 300, valid: true },
];
export const rowIsin = (r: Row) => (r.field === "offer_price_pct" ? ISIN_NOPRICE : ISIN_ROLF);
/** Значение в URL / payload / JSON: NaN — строкой "NaN" (JSON его не передаёт) */
const urlVal = (v: number) => (Number.isNaN(v) ? "NaN" : String(v));
const jsonVal = (v: number): unknown => (Number.isNaN(v) ? "NaN" : v);
/** Часть deep-link §4.6: _s<сумма>, _k/_p/_o — ×100 целым; NaN — буквально «NaN» (не целое → декодер должен отклонить) */
export const payloadOf = (r: Row) => `q${rowIsin(r)}_${r.part}${Number.isNaN(r.v) ? "NaN" : r.part === "s" ? String(r.v) : String(Math.round(r.v * 100))}`;

/** Вердикт потребителя: принят (значение дошло ровно), отклонён (как требует §4.2 для этого потребителя) или иное */
export interface Verdict13 { verdict: "accepted" | "rejected" | "other"; note: string }
export interface Row13 {
  row: number; schema: boolean | null; get: Verdict13; post: Verdict13; chat: Verdict13;
  /** страница /check (CheckPage, app/check/page.tsx): какой ввод дошёл до buildCached — пропс result элемента */
  check: Verdict13;
  initialOf: Verdict13 | null; decode: Verdict13 | null;
}
/**
 * TG.13, пределы цены (И4, решение владельца 20.10.2026): точка проверки на границах константы CONFIG.inputs.offerPricePct.
 * want — ожидание по константе (true — принять, false — отклонить; null — пустое поле: схема допускает null, форма — нет);
 * schema — offer_price_pct.safeParse(v).success (null — не сравнивается); ask — форма AskPrice: true — onSubmit вызван с тем же
 * числом, false — не вызван (сообщение формы, запроса нет), null — иное.
 */
export interface PriceEdge { label: string; want: boolean | null; schema: boolean | null; ask: boolean | null; field: string; note: string }
/**
 * TG.13, AskPrice следует за константой (ревью 20.10, F2): границы CONFIG.inputs.offerPricePct временно подменяются на месте
 * (Object.assign в тот же объект: псевдоним `const P = CONFIG.inputs.offerPricePct` на верхнем уровне законен, подмена объекта
 * целиком дала бы на нём ложный RED), blocks.tsx загружается заново (?query — свежий экземпляр модуля, поэтому законно и чтение
 * границ на верхнем уровне: `const { min, max } = CONFIG.inputs.offerPricePct`), и форма AskPrice проверяется у новых границ —
 * сужение и расширение. Свои границы мимо константы (помощник с литералами в другом модуле, `LIM = 3e2`, затенение `max`)
 * за подменой не идут. lim — подменённые границы; want — ожидание по ним; ask — как у PriceEdge.
 */
export interface PriceFollow { lim: { min: number; max: number }; label: string; v: number; want: boolean; ask: boolean | null; note: string }
export interface Tg13Out {
  contract: { ok: boolean; detail: string };
  toolsSame: boolean | null;
  toolsHasInputsSchema: boolean;
  entry: { ok: boolean; detail: string };
  rows: Row13[];
  price: { constant: { ok: boolean; detail: string }; ask: { ok: boolean; detail: string }; edges: PriceEdge[]; follow: PriceFollow[]; dense: PriceDense | null };
}
/** Шаг проверки у границ константы: точность формы AskPrice — два знака (поле заполняется fmtMax(·, 2)) */
export const PRICE_EPS = 0.01;
/**
 * TG.13, плотная сверка схемы с константой (ревью 20.10, раунд 2, R1r2-1). Форма AskPrice и схема реализованы раздельно, поэтому
 * уточнение схемы внутри [min, max] (multipleOf, step, int, refine, …) разошлось бы с формой: форма пропускает цену, сервер
 * отвечает 4xx. Схема — offer_price_pct.safeParse(v) и ReportInputsSchema.safeParse({ offer_price_pct: v }) — должна принимать
 * ⇔ min ≤ v ≤ max на фиксированных точках (до 0,001, плюс ±Infinity) и на PRICE_DENSE_N точках с seed PRICE_DENSE_SEED: 1–3 знака,
 * половина внутри [min, max], четверть в [min−50, min), четверть в (max, max+100]. Форма AskPrice на этих точках не прогоняется:
 * проба заполняет поле через fmtMax(·, 2), и трёхзначные значения округлились бы; связку «AskPrice ≡ константа» держат статика
 * TG.7 и подмена константы (PriceFollow). v — String(число): ±Infinity переживает JSON. field/obj — принято полем и объектом
 * (null — safeParse бросил).
 */
export interface PriceDenseMiss { v: string; want: boolean; field: boolean | null; obj: boolean | null }
export interface PriceDense { seed: number; n: number; inside: number; outside: number; fixed: number; miss: PriceDenseMiss[] }
export const PRICE_DENSE_SEED = 20261020;
export const PRICE_DENSE_N = 200;
type ZodLike = { safeParse(v: unknown): { success: boolean } };
type ReportRouteMod = { GET(r: Request): Promise<Response>; POST(r: Request): Promise<Response> };
type CheckPageMod = { default(p: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<unknown> };

/** Пропс result (конверт BuildResultT) в дереве React-элемента, который вернула CheckPage (обычно <CheckClient result=…/>) */
function findResult(el: unknown, depth = 0): BuildResultT | null {
  if (!el || typeof el !== "object" || depth > 8) return null;
  const props = (el as { props?: Record<string, unknown> }).props;
  if (!props) return null;
  const r = props.result as { kind?: unknown } | undefined;
  if (r && typeof r === "object" && typeof r.kind === "string") return r as BuildResultT;
  const ch = props.children;
  for (const c of Array.isArray(ch) ? ch : [ch]) {
    const f = findResult(c, depth + 1);
    if (f) return f;
  }
  return null;
}

async function reportVerdict(res: Response, field: Field, v: number): Promise<Verdict13> {
  const text = await res.text();
  let j: { kind?: string; msg?: string; report?: { inputs?: Record<string, unknown> } } | null = null;
  try { j = JSON.parse(text); } catch { /* не JSON */ }
  const got = j?.report?.inputs?.[field];
  if (res.status === 200 && j?.kind === "report" && got === v) return { verdict: "accepted", note: `HTTP 200 report, inputs.${field}=${String(got)}` };
  if (res.status >= 400 && res.status < 500 && j?.kind === "err") return { verdict: "rejected", note: `HTTP ${res.status} err «${String(j.msg ?? "").slice(0, 60)}»` };
  return { verdict: "other", note: `HTTP ${res.status} kind=${String(j?.kind)}${j?.kind === "report" ? `, inputs.${field}=${JSON.stringify(got ?? null)}` : ""}${j?.msg ? ` «${String(j.msg).slice(0, 60)}»` : ""}` };
}

type AskPriceFn = (p: { r: BondReportT; onSubmit?: (pricePct: number) => void; unavailableNote?: string }) => unknown;

/**
 * Форма AskPrice как в браузере, без DOM: компонент вызывается внутри пробы при renderToStaticMarkup (хуки — у пробы), поле
 * заполнено из r.inputs.offer_price_pct (fmtMax(·, 2) — как при пересборке отчёта по цене), обработчик onSubmit формы
 * вызывается после рендера. setState после рендера на сервере — no-op, поэтому наблюдаемо только «onSubmit вызван или нет».
 */
type AskProbe = (v: number | null) => { ask: boolean | null; field: string; note: string };
async function askPriceProbe(query?: string): Promise<{ ok: true; probe: AskProbe } | { ok: false; detail: string }> {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const g = globalThis as unknown as { React?: unknown };
  g.React ??= React; // packages/blocks транслируется классическим JSX (как в record-ssr.ts)
  const blocks = await tryImport<{ AskPrice: AskPriceFn }>(repoAbs("packages/blocks/src/blocks.tsx"), "P2", { need: ["AskPrice"], ...(query ? { query } : {}) });
  if (!blocks.ok) return { ok: false, detail: blocks.detail };
  const golden = repoAbs("packages/engine/golden/expected/cherk1p6.json");
  const res = JSON.parse(fs.readFileSync(golden, "utf8")) as BuildResultT;
  if (res.kind !== "report") return { ok: false, detail: `${path.relative(REPO_ROOT, golden)}: ожидался kind=report, получено ${res.kind}` };
  const base = res.report;
  const probe: AskProbe = (v) => {
    const r = { ...base, inputs: { ...base.inputs, offer_price_pct: v } } as BondReportT;
    const sent: number[] = [];
    let submit: unknown = null;
    const Probe = () => {
      const el = blocks.mod.AskPrice({ r, onSubmit: (n: number) => { sent.push(n); } }) as { props?: { onSubmit?: unknown } } | null;
      submit = el?.props?.onSubmit ?? null;
      return el as never;
    };
    let html: string;
    try { html = renderToStaticMarkup(React.createElement(Probe)); }
    catch (e) { return { ask: null, field: "?", note: `рендер AskPrice бросил: ${errStr(e)}` }; }
    const input = /<input\b[^>]*\bid="ask-price"[^>]*>/.exec(html)?.[0] ?? "";
    const field = `поле «${/\bvalue="([^"]*)"/.exec(input)?.[1] ?? "?"}»`;
    if (typeof submit !== "function") return { ask: null, field, note: `${field}: у формы AskPrice нет onSubmit` };
    try { (submit as (e: { preventDefault(): void }) => void)({ preventDefault() {} }); }
    catch (e) { return { ask: null, field, note: `${field}: submit бросил ${errStr(e)}` }; }
    if (!sent.length) return { ask: false, field, note: `${field} → отклонено, onSubmit не вызван` };
    if (sent.length === 1 && Object.is(sent[0], v)) return { ask: true, field, note: `${field} → onSubmit(${sent[0]})` };
    return { ask: null, field, note: `${field} → onSubmit(${sent.join(", ")}), ожидалось ${String(v)}` };
  };
  return { ok: true, probe };
}

/** mulberry32: детерминированный генератор на [0, 1) — точки плотной сверки одинаковы от прогона к прогону */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Плотная сверка схемы с константой (PriceDense): одна схема, без формы */
function priceDense(schema: ZodLike & { shape: Record<string, ZodLike> }, min: number, max: number): PriceDense {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const fixed = [...new Set([r3(min + 0.001), r3(max - 0.001), 1.37, 98.3, 98.555, 150, 150.123, 150.125, 299.999, Infinity, -Infinity])];
  const rnd = mulberry32(PRICE_DENSE_SEED);
  const gen: number[] = [];
  for (let i = 0; i < PRICE_DENSE_N; i++) {
    const q = 10 ** (1 + Math.floor(rnd() * 3)); // 1–3 знака после запятой
    const u = rnd();
    const x = i % 2 === 0 ? min + u * (max - min) : i % 4 === 1 ? min - 50 + u * 50 : max + u * 100;
    gen.push(Math.round(x * q) / q); // то же число, что Number("150.125") из ввода
  }
  const pts = [...new Set([...fixed, ...gen])];
  const miss: PriceDenseMiss[] = [];
  let inside = 0;
  for (const v of pts) {
    const want = v >= min && v <= max;
    if (want) inside++;
    let field: boolean | null = null, obj: boolean | null = null;
    try { field = schema.shape.offer_price_pct.safeParse(v).success; } catch { field = null; }
    try { obj = schema.safeParse({ offer_price_pct: v }).success; } catch { obj = null; }
    if (field !== want || obj !== want) miss.push({ v: String(v), want, field, obj });
  }
  return { seed: PRICE_DENSE_SEED, n: pts.length, inside, outside: pts.length - inside, fixed: fixed.length, miss };
}

/**
 * Пределы цены: константа из @so/engine/config, схема offer_price_pct и форма AskPrice на min−ε/min/max/max+ε, дробной точке внутри
 * (принята — только если onSubmit получил то же число: Math.round и прочие подмены значения → RED), «не число», пустое поле;
 * затем AskPrice при подменённой константе (PriceFollow)
 */
async function tg13Price(schema: (ZodLike & { shape: Record<string, ZodLike> }) | null): Promise<Tg13Out["price"]> {
  const cfg = (await import("@so/engine/config")) as unknown as { CONFIG: { inputs?: { offerPricePct?: { min?: unknown; max?: unknown } } } };
  const c = cfg.CONFIG.inputs?.offerPricePct;
  const min = c?.min, max = c?.max;
  const constOk = typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && min < max;
  const constant = constOk ? { ok: true, detail: `CONFIG.inputs.offerPricePct = { min: ${min}, max: ${max} }` }
    : { ok: false, detail: `в @so/engine/config нет CONFIG.inputs.offerPricePct с конечными min < max: ${JSON.stringify(c ?? null)}` };
  const ask = await askPriceProbe();
  const askInfo = ask.ok ? { ok: true, detail: "AskPrice из packages/blocks/src/blocks.tsx, отчёт golden cherk1p6" } : { ok: false, detail: ask.detail };
  if (!constOk) return { constant, ask: askInfo, edges: [], follow: [], dense: null };
  // плотная сверка схемы с константой — до её подмены ниже
  const dense = schema ? priceDense(schema, min, max) : null;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  /** Дробная точка строго внутри [lo, hi]: 98,5 (типичная цена), иначе середина с половиной */
  const inner = (lo: number, hi: number) => (lo < 98.5 && 98.5 < hi ? 98.5 : r2(Math.floor((lo + hi) / 2) + 0.5));
  const pts: { label: string; v: number | null; want: boolean | null }[] = [
    { label: `min−ε (${r2(min - PRICE_EPS)})`, v: r2(min - PRICE_EPS), want: false },
    { label: `min (${min})`, v: min, want: true },
    { label: `внутри (${inner(min, max)})`, v: inner(min, max), want: true },
    { label: `max (${max})`, v: max, want: true },
    { label: `max+ε (${r2(max + PRICE_EPS)})`, v: r2(max + PRICE_EPS), want: false },
    { label: "не число", v: NaN, want: false },
    { label: "пустое поле", v: null, want: null },
  ];
  const edges = pts.map((p): PriceEdge => {
    let sv: boolean | null = null;
    if (p.want !== null && schema) { try { sv = schema.shape.offer_price_pct.safeParse(p.v).success; } catch { sv = null; } }
    const a = ask.ok ? ask.probe(p.v) : { ask: null, field: "?", note: "AskPrice не загружен" };
    return { label: p.label, want: p.want, schema: sv, ask: a.ask, field: a.field, note: a.note };
  });
  // AskPrice следует за константой: сужение (свои границы шире константы — помощник 1..300 вместо неё) и расширение (свои
  // границы внутри константы — LIM = 300, затенённый max); на каждом наборе min−ε, min, точка внутри, max, max+ε
  const follow: PriceFollow[] = [];
  if (ask.ok) {
    const narrow = min + 1 < max - 50 ? { min: r2(min + 1), max: r2(max - 50) } : { min: r2(min + (max - min) / 4), max: r2(max - (max - min) / 4) };
    const wide = { min: r2(min - 0.5), max: r2(max + 100) };
    const box = cfg.CONFIG.inputs!.offerPricePct as { min: number; max: number };
    const saved = { ...box };
    try {
      for (const [i, lim] of [narrow, wide].entries()) {
        Object.assign(box, lim);
        const mid = lim === wide ? r2(Math.floor((max + lim.max) / 2) + 0.5) : inner(lim.min, lim.max); // у расширения — между старым и новым max
        const pts: [number, boolean][] = [[r2(lim.min - PRICE_EPS), false], [lim.min, true], [mid, true], [lim.max, true], [r2(lim.max + PRICE_EPS), false]];
        const fresh = await askPriceProbe(`tg13-follow=${i}`);
        for (const [v, want] of pts) {
          const a = fresh.ok ? fresh.probe(v) : { ask: null, note: `blocks.tsx заново не загрузился: ${fresh.detail}` };
          follow.push({ lim: { ...lim }, label: `{ min: ${lim.min}, max: ${lim.max} } ${v}`, v, want, ask: a.ask, note: a.note });
        }
      }
    } finally { Object.assign(box, saved); }
  }
  return { constant, ask: askInfo, edges, follow, dense };
}

async function tg13(): Promise<Tg13Out> {
  const srv = await loadServer();
  const contractLoad = await tryImport<{ ReportInputsSchema: ZodLike & { shape: Record<string, ZodLike> } }>(
    repoAbs("packages/engine/src/contract.ts"), 2, { need: ["ReportInputsSchema"] });
  const tools = (await import("../../lib/tools")) as unknown as Record<string, unknown>;
  const schema = contractLoad.ok ? contractLoad.mod.ReportInputsSchema : null;
  const entryLoad = await loadPresent("entry", ["initialOf", "decodeStartPayload"]);
  const entry = entryLoad.ok ? entryLoad.mod : null;
  const report = (await import("../../app/api/report/route")) as unknown as ReportRouteMod;
  const checkPage = (await import("../../app/check/page")) as unknown as CheckPageMod;
  const { CONFIG } = await import("@so/engine/config");
  const rows: Row13[] = [];
  for (let i = 0; i < TG13_ROWS.length; i++) {
    const r = TG13_ROWS[i];
    const isin = rowIsin(r);
    let schemaV: boolean | null = null;
    try { schemaV = schema ? schema.shape[r.field].safeParse(r.v).success : null; } catch { schemaV = null; }
    // /api/report GET и POST: принято — HTTP 200 report с inputs[field] === v; отклонено — {kind:"err"} 4xx (§4.2, R.7-web)
    let get: Verdict13, post: Verdict13;
    try { get = await reportVerdict(await report.GET(new Request(`http://127.0.0.1:3000/api/report?q=${isin}&${r.param}=${urlVal(r.v)}`)), r.field, r.v); }
    catch (e) { get = { verdict: "other", note: `исключение: ${errStr(e)}` }; }
    try {
      post = await reportVerdict(await report.POST(new Request("http://127.0.0.1:3000/api/report", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: isin, inputs: { [r.field]: jsonVal(r.v) } }),
      })), r.field, r.v);
    } catch (e) { post = { verdict: "other", note: `исключение: ${errStr(e)}` }; }
    // body.inputs /api/chat: принято — session.pendingInputs[field] === v; отклонено — HTTP 200 и поля в pendingInputs нет (невалидное
    // игнорируется, не 400). Реплика «посоветуй облигацию» — отказ шаблоном гейта, отчёт не собирается и pendingInputs не расходуется
    let chat: Verdict13;
    const sid = `__LOCALID_tg13-${i}`;
    try {
      const res = await srv.post({
        tools: {}, inputs: { [r.field]: jsonVal(r.v) }, id: sid, messages: [userMsg(`tg13-${i}`, "посоветуй облигацию")], trigger: "submit-message", metadata: {},
      }, { "content-type": "application/json", "x-so-chat": `c_tg13_${i}` });
      await res.text();
      const s = srv.session.getSession(sid);
      const pend = (s.pendingInputs ?? null) as Record<string, unknown> | null;
      const got = pend?.[r.field];
      chat = res.status === 200 && got === r.v ? { verdict: "accepted", note: `pendingInputs.${r.field}=${String(got)}` }
        : res.status === 200 && got === undefined && s.result == null ? { verdict: "rejected", note: `HTTP 200, pendingInputs=${JSON.stringify(pend)}` }
        : { verdict: "other", note: `HTTP ${res.status}, pendingInputs=${JSON.stringify(pend)}, result=${s.result?.kind ?? null}` };
    } catch (e) { chat = { verdict: "other", note: `исключение: ${errStr(e)}` }; }
    // /check: CheckPage вызывается как функция, ввод виден в пропсе result. Принято — inputs[field] === v (Object.is: NaN тоже
    // «принят»); отклонено — поле осталось по умолчанию (сумма — CONFIG.positionDefault, остальное — null): §4.2 «поле за полем,
    // невалидное игнорируется, как в initialOf»
    let check: Verdict13;
    try {
      const res = findResult(await checkPage.default({ searchParams: Promise.resolve({ q: isin, [r.param]: urlVal(r.v) }) }));
      const def = r.field === "position_size" ? CONFIG.positionDefault : null;
      const got = res?.kind === "report" ? (res.report.inputs as Record<string, unknown>)[r.field] : undefined;
      check = !res ? { verdict: "other", note: "в элементе CheckPage нет пропса result" }
        : res.kind !== "report" ? { verdict: "other", note: `result.kind=${res.kind}` }
        : Object.is(got, r.v) ? { verdict: "accepted", note: `report.inputs.${r.field}=${String(got)}` }
        : got === def ? { verdict: "rejected", note: `report.inputs.${r.field}=${String(got)} (по умолчанию)` }
        : { verdict: "other", note: `report.inputs.${r.field}=${String(got)}` };
    } catch (e) { check = { verdict: "other", note: `исключение: ${errStr(e)}` }; }
    // initialOf (/chat?q=…) и decodeStartPayload (deep-link → initialOf): принято — inputs[field] === v; отклонено — поля нет
    let init: Verdict13 | null = null, dec: Verdict13 | null = null;
    if (entry) {
      try {
        const io = entry.initialOf({ q: isin, [r.param]: urlVal(r.v) });
        const got = (io as { inputs?: Record<string, unknown> } | undefined)?.inputs?.[r.field];
        init = got === r.v ? { verdict: "accepted", note: `inputs.${r.field}=${String(got)}` }
          : io && (io as { q?: string }).q === isin && got === undefined ? { verdict: "rejected", note: `inputs=${JSON.stringify((io as { inputs?: unknown }).inputs)}` }
          : { verdict: "other", note: `initialOf → ${JSON.stringify(io ?? null)}` };
      } catch (e) { init = { verdict: "other", note: `исключение: ${errStr(e)}` }; }
      const payload = payloadOf(r);
      try {
        const p = entry.decodeStartPayload(payload);
        if (p == null) dec = { verdict: "rejected", note: `«${payload}» → null` };
        else {
          const io = entry.initialOf(p);
          const got = (io as { inputs?: Record<string, unknown> } | undefined)?.inputs?.[r.field];
          dec = got === r.v ? { verdict: "accepted", note: `«${payload}» → ${JSON.stringify(p)} → inputs.${r.field}=${String(got)}` }
            : io && (io as { q?: string }).q === isin && got === undefined ? { verdict: "rejected", note: `«${payload}» → ${JSON.stringify(p)} → поля нет` }
            : { verdict: "other", note: `«${payload}» → ${JSON.stringify(p)} → initialOf ${JSON.stringify(io ?? null)}` };
        }
      } catch (e) { dec = { verdict: "other", note: `«${payload}»: исключение ${errStr(e)}` }; }
    }
    rows.push({ row: i, schema: schemaV, get, post, chat, check, initialOf: init, decode: dec });
  }
  return {
    contract: { ok: contractLoad.ok, detail: contractLoad.ok ? "ReportInputsSchema экспортирован" : contractLoad.detail },
    toolsSame: schema ? tools.inputsSchema === schema : null,
    toolsHasInputsSchema: tools.inputsSchema !== undefined,
    entry: { ok: entryLoad.ok, detail: entryLoad.ok ? "есть" : entryLoad.detail },
    rows,
    price: await tg13Price(schema),
  };
}

/* ═══════════════════════════ tg14: «Главные red flags» = truth_score.top3 ═══════════════════════════ */

interface GoldenCase { name: string; query: string; inputs?: ReportInputs }
const GOLDEN = path.join(REPO_ROOT, "packages", "engine", "golden");
const goldenCases = (): GoldenCase[] => (JSON.parse(fs.readFileSync(path.join(GOLDEN, "cases.json"), "utf8")) as { cases: GoldenCase[] }).cases;
const goldenReport = (name: string): BondReportT => {
  const res = JSON.parse(fs.readFileSync(path.join(GOLDEN, "expected", `${name}.json`), "utf8")) as BuildResultT;
  if (res.kind !== "report") throw new Error(`golden ${name}: ожидался kind=report, получено ${res.kind}`);
  return res.report;
};
/** 10 golden, где текст гейта доходит до списка флагов, и 3 с ранним return (no_price / not_traded / no_coupon_rate) — §6, TG.14 (б) */
export const TG14_WITH = ["cherk1p7", "cherk2p1", "cherk2p2", "ofz26238", "ofz26243-name", "perpetual", "pkb-amort", "rolf", "structured", "veb"] as const;
export const TG14_WITHOUT = ["cherk1p6", "not_traded", "cherk2p6"] as const;
/** Перестановка top3 golden veb для TG.14 (в) */
export const TG14_PERM = [5, 12, 4] as const;

export interface GateCase {
  name: string; query: string; inputs: ReportInputs; handled: boolean; error: string | null; text: string;
  kind: string | null; status: string | null; top3: number[]; top3Titles: string[]; goldenTop3: number[];
}
export interface Tg14Out {
  cases: GateCase[];
  exportsFound: string[];
  unit: { fn: string; out: string | null; error: string | null; titles: string[]; natural: number[] } | null;
}
type GateMod = Server["gate"];
type Writer = Parameters<GateMod["runGate"]>[0];

async function tg14(): Promise<Tg14Out> {
  const srv = await loadServer();
  const byName = new Map(goldenCases().map((c) => [c.name, c]));
  const cases: GateCase[] = [];
  for (const name of [...TG14_WITH, ...TG14_WITHOUT]) {
    const c = byName.get(name);
    if (!c) throw new Error(`дефект харнеса: в golden/cases.json нет кейса ${name}`);
    const parts: Record<string, unknown>[] = [];
    const w = { write: (p: Record<string, unknown>) => { parts.push(p); }, merge: () => {}, onError: undefined } as unknown as Writer;
    // вводы кейса — как вводы /check (session.pendingInputs): гейт собирает отчёт с ними, как эталон
    const s = srv.session.getSession(`__LOCALID_tg14-${name}`);
    s.pendingInputs = c.inputs && Object.keys(c.inputs).length ? { ...c.inputs } : null;
    let handled = false, error: string | null = null;
    try { handled = (await srv.gate.runGate(w, s, c.query, null)).handled; } catch (e) { error = errStr(e); }
    const text = parts.filter((p) => p.type === "text-delta").map((p) => String(p.delta ?? "")).join("");
    const rep = s.result?.kind === "report" ? s.result.report : null;
    const top3 = rep?.truth_score.top3 ?? [];
    cases.push({
      name, query: c.query, inputs: c.inputs ?? {}, handled, error, text, kind: s.result?.kind ?? null, status: rep?.status.kind ?? null,
      top3, top3Titles: top3.map((id) => rep?.flags.find((f) => f.id === id)?.title ?? `<нет флага ${id}>`), goldenTop3: goldenReport(name).truth_score.top3,
    });
  }
  const g = srv.gate as unknown as Record<string, unknown>;
  const exportsFound = Object.keys(g).sort();
  const fnName = typeof g.topFlagsText === "function" ? "topFlagsText" : typeof g.reportText === "function" ? "reportText" : null;
  let unit: Tg14Out["unit"] = null;
  if (fnName) {
    const veb = goldenReport("veb");
    const natural = [...veb.truth_score.top3];
    const r = structuredClone(veb);
    r.truth_score.top3 = [...TG14_PERM];
    const titles = TG14_PERM.map((id) => r.flags.find((f) => f.id === id)?.title ?? `<нет флага ${id}>`);
    let out: string | null = null, error: string | null = null;
    try {
      const v = fnName === "topFlagsText" ? (g.topFlagsText as (x: BondReportT) => unknown)(r) : (g.reportText as (x: BuildResultT) => unknown)({ kind: "report", report: r });
      out = typeof v === "string" ? v : JSON.stringify(v);
    } catch (e) { error = errStr(e); }
    unit = { fn: fnName, out, error, titles, natural };
  }
  return { cases, exportsFound, unit };
}

/* ═══════════════════════════ health-version: TG.23 ═══════════════════════════ */

export interface HealthOut {
  appDir: string | null; before: string | null; after: string | null;
  local: { status: number; json: unknown; error: string | null };
  external: { status: number; json: unknown; error: string | null };
}

async function healthVersion(): Promise<HealthOut> {
  const dir = process.env.SO_APP_DIR ?? null;
  const vf = dir ? path.join(dir, "VERSION") : null;
  const before = vf && fs.existsSync(vf) ? fs.readFileSync(vf, "utf8") : null;
  const mod = await import("../../app/api/health/route");
  let after: string | null = null;
  if (vf && before != null) { fs.writeFileSync(vf, HEALTH_VERSION_B); after = HEALTH_VERSION_B; }
  const call = async (req?: Request) => {
    try {
      const res = await mod.GET(req);
      const t = await res.text();
      let json: unknown = t;
      try { json = JSON.parse(t); } catch { /* не JSON */ }
      return { status: res.status, json, error: null };
    } catch (e) { return { status: 0, json: null, error: errStr(e) }; }
  };
  const local = await call(new Request("http://127.0.0.1:3000/api/health"));
  const external = await call();
  return { appDir: dir, before, after, local, external };
}

/* ═══════════════════════════ g6: длинная история с отчётами ═══════════════════════════ */

export const G6_REPORTS = ["ofz26238", "rolf", "veb", "cherk1p7", "cherk2p2", "cherk2p1", "cherk2p6", "cherk1p6", "ofz26243-name", "structured"] as const;
export interface G6Out {
  status: number; errors: string[]; error: string | null; text: string;
  reports: number; messages: number; chars: number; bytes: number; textChars: number; toolChars: number[];
}

async function g6(): Promise<G6Out> {
  const srv = await loadServer();
  const byName = new Map(goldenCases().map((c) => [c.name, c]));
  const messages: unknown[] = [];
  const toolChars: number[] = [];
  let textChars = 0;
  for (const [i, name] of G6_REPORTS.entries()) {
    const c = byName.get(name);
    if (!c) throw new Error(`дефект харнеса: в golden/cases.json нет кейса ${name}`);
    const result = await srv.engine.buildCached(c.query, c.inputs ?? {}); // build + applyInputs на golden-снимках (SO_OFFLINE=1)
    if (result.kind !== "report") throw new Error(`дефект харнеса: golden ${name} («${c.query}») собрался как ${result.kind}, а не report`);
    const said = c.query;
    const answer = `Отчёт по ${result.report.security.shortname} собран — смотрите блоки выше.`;
    textChars += said.length + answer.length;
    const tool = { type: "tool-resolve_security", toolCallId: `g6_call_${i}`, state: "output-available", input: { query: said }, output: { query: said, result } };
    toolChars.push(JSON.stringify(tool.output).length);
    messages.push(userMsg(`g6u${i}`, said));
    messages.push({ id: `g6a${i}`, role: "assistant", parts: [tool, { type: "text", text: answer, state: "done" }] });
  }
  const last = "почему так мало?";
  textChars += last.length;
  messages.push(userMsg("g6u-last", last));
  const json = JSON.stringify({ tools: {}, id: "__LOCALID_auditG6", messages, trigger: "submit-message", metadata: {} });
  const a = await send(() => srv.post(json, { "content-type": "application/json", "x-so-chat": "c_audit_g6" }));
  return {
    status: a.status, errors: a.errors, error: a.error, text: rawText(a.message).slice(0, 200),
    reports: G6_REPORTS.length, messages: messages.length, chars: json.length, bytes: Buffer.byteLength(json, "utf8"), textChars, toolChars,
  };
}

/* ═══════════════════════════ вход ═══════════════════════════ */

const RUN: Record<string, () => Promise<unknown>> = {
  parity, tg11, limits, tg13, tg14, "health-version": healthVersion, g6,
};
/** Точка входа группы для scenarios.ts: неизвестное имя → undefined (родитель получит ERROR «неизвестный сценарий») */
export async function run(name: string): Promise<unknown> {
  const fn = RUN[name];
  return fn ? fn() : undefined;
}

