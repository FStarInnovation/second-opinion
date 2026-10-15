/**
 * WP-TG, группа «parity» (docs/PLAN_telegram_bot_2026-10-14.md §2 И5, §4.4, §4.5, §4.7, §6, §8): паритет бота и браузера.
 * TG.4, TG.5, TG.9, TG.20, TG.21 — RED до правки (утверждают желаемое), TG.G4 — guard (GREEN уже на d16c809).
 *
 * Всё, что запускает ядро бота или сервер, идёт в дочерних процессах сценариев (scenarios.ts → scen-parity.ts), окружение —
 * строго §6 «Как устроен»: SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0, ключи LLM/Jev сняты, временный SO_USAGE_DIR, SO_USAGE_LOG=1,
 * SO_BOT_KEY = TG_TEST.botKey, SO_DAILY_BUDGET_USD=2, SO_MESSAGE_LIMIT снят; внешний fetch бросает. Бот получает
 * `fetch = (url, init) => route.POST(new Request(url, init))`, каждый его запрос перехватывается обёрткой fetch.
 *   parity:dialogs — TG.4, TG.5, TG.9 (первый ход d1), TG.20 (один прогон на все четыре, мемоизирован);
 *   parity:tg9     — TG.9 (renderTurn на фикстурах, два рукописных SSE без route);
 *   parity:tg21    — TG.21 (TTL сессии сервера и сессии бота, часы через deps.now).
 * Сценарий упал исключением → RED с текстом ошибки; сценарий завис (таймаут) → RED; иной дефект харнеса (процесс не стартовал,
 * нет строки результата) → ERROR.
 *
 * Модулей бота, `@so/present/*` и `lib/channel.ts` ещё нет: грузятся только `tryImport` по вычисляемому пути в ребёнке;
 * нет модуля → RED с detail «нет модуля …; ожидаемо до шага N». TG.G4 и статическая часть TG.21 идут в процессе харнеса.
 *
 * `makeParityChecks({ root })` — те же проверки с модулями WP-TG из другого корня (самопроверка харнеса эталонными модулями вне
 * репозитория); в харнесе `checks = makeParityChecks()` — корень репозитория.
 */
import fs from "node:fs";
import path from "node:path";
import { type Check, type Verdict, REPO_ROOT, expect, fail, pass } from "../lib";
import { DIALOG_IDS, NAME_MARKERS, idRegex, loadDialog } from "./actions";
import { assembleUIMessage, brief, canonical, collapseWs, comparePair, diff, sseResponse, tgPlain, type WireRequest } from "./normalize";
import { scenario, scenarioNotes, TG_TEST, type ScenarioResult } from "./scenarios";
import {
  PARITY_ROOT_ENV, TG9_A, TG9_B, TG9_CALL, TG9_QUERY, TG21_CHAT, tg9Chunks, tg9ReportOutput,
  type CallJ, type DialogsOut, type Tg21Out, type Tg21Step, type Tg9Out,
} from "./scen-parity";
import type { ChatBody, DialogAction, DialogFixture, RecordedRequest, WireMessage } from "./types";

/* ═══════════════════════════ мелочи ═══════════════════════════ */

const q = (s: string | null | undefined, max = 120) => (s == null ? "—" : brief(s, max));
const list = (xs: readonly string[], n: number, sep = "; ") => (xs.length <= n ? xs.join(sep) : `${xs.slice(0, n).join(sep)}${sep}… ещё ${xs.length - n}`);
const isChatPost = (r: { method: string; url: string }) => {
  try { return r.method === "POST" && new URL(r.url).pathname === "/api/chat"; } catch { return false; }
};
const bodyOf = (raw: string): ChatBody | null => { try { return JSON.parse(raw) as ChatBody; } catch { return null; } };
const actionLabel = (a: DialogAction) => (a.kind === "type" ? `type «${a.text}»` : a.kind === "open" ? `open ${a.url}` : `pick:${a.index}`);
const DIALOG_SHAPE = () => DIALOG_IDS.map((id) => `${id} ${loadDialog(id).requests.length}`).join(", ");
/** Сводка вызовов Telegram (из CallJ) одной строкой для detail */
function callsSummary(calls: readonly CallJ[], max = 50): string {
  if (!calls.length) return "(вызовов нет)";
  const cut = (s: string | undefined) => { const t = (s ?? "").replace(/\s+/g, " "); return t.length > max ? t.slice(0, max - 1) + "…" : t; };
  return calls.map((c) => {
    const err = c.error ? ` ✗${c.error.slice(0, 40)}` : "";
    switch (c.method) {
      case "sendMessage": return `send#${c.messageId ?? "-"}(${c.html ? "html " : ""}«${cut(c.text)}»${c.keyboard ? ` +кнопок ${c.keyboard.inline_keyboard.flat().length}` : ""})${err}`;
      case "editMessageText": return `edit#${c.messageId}(${c.html ? "html " : ""}«${cut(c.text)}»)${err}`;
      case "answerCallbackQuery": return `answer(${c.text !== undefined ? `«${cut(c.text)}»` : ""})${err}`;
      case "sendChatAction": return `typing${err}`;
      default: return `${c.method}${err}`;
    }
  }).join(" → ");
}
/** Видимые вызовы: без typing и без упавших (как FakeTg.visibleCalls) */
const visible = (calls: readonly CallJ[]) => calls.filter((c) => !c.error && c.method !== "sendChatAction");
/**
 * Ход с инструментом отчёта (§4.7, TG.9): `send(before[0]) … → send(WAIT_REPORT) → edit того же message_id (html, отчёт с ISIN) →
 * [send(html) — продолжение отчёта, если splitHtml разрезал его по секциям] → send(final, простой текст)`, и больше ничего.
 * null — совпало; иначе — причина.
 */
function matchReportTurn(v: readonly CallJ[], o: { before: string[]; wait: string; isin: string; final: string }): string | null {
  let i = 0;
  const at = (n: number) => `вызов ${n + 1}`;
  for (const b of o.before) {
    const c = v[i];
    if (!c || c.method !== "sendMessage" || c.html || c.text !== b) return `${at(i)}: ожидался send(«${b.slice(0, 40)}») простым текстом, получен ${c ? callsSummary([c], 40) : "конец"}`;
    i++;
  }
  const w = v[i];
  if (!w || w.method !== "sendMessage" || w.text !== o.wait) return `${at(i)}: ожидалась заглушка send(«${o.wait}»), получен ${w ? callsSummary([w], 40) : "конец"}`;
  i++;
  const e = v[i];
  if (!e || e.method !== "editMessageText" || e.messageId !== w.messageId) return `${at(i)}: ожидалась правка заглушки edit#${w.messageId ?? "?"} в отчёт, получен ${e ? callsSummary([e], 40) : "конец"}`;
  if (!e.html) return `${at(i)}: отчёт ушёл без parse_mode HTML`;
  if (!tgPlain(e.text ?? "").includes(o.isin)) return `${at(i)}: в правке нет ISIN ${o.isin} — это не отчёт: «${tgPlain(e.text ?? "").slice(0, 80)}»`;
  i++;
  while (i < v.length - 1 && v[i].method === "sendMessage" && v[i].html) i++; // продолжение отчёта (splitHtml)
  const f = v[i];
  if (!f || f.method !== "sendMessage" || f.html || collapseWs(f.text ?? "") !== collapseWs(o.final)) return `${at(i)}: ожидался send(«${o.final.slice(0, 40)}…») простым текстом, получен ${f ? callsSummary([f], 40) : "конец"}`;
  i++;
  if (i !== v.length) return `лишние вызовы после текста: ${callsSummary(v.slice(i), 30)}`;
  return null;
}
/** uncaughtException ребёнка (исключение из таймера ядра) → проблема для detail */
const uncaughtIssue = (u: readonly string[] | undefined): string[] =>
  u?.length ? [`uncaughtException в процессе сценария (${u.length}): ${list(u.map((x) => x.slice(0, 160)), 2)}`] : [];

/** Исходник TS без комментариев (`//` и `/* *\/` → пробелы, строки и шаблоны не трогаются, переводы строк сохраняются) */
function stripComments(src: string): string {
  let out = "";
  const n = src.length;
  for (let i = 0; i < n;) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { let j = i; while (j < n && src[j] !== "\n") j++; out += " ".repeat(j - i); i = j; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (c === "\"" || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j++; else if (c !== "`" && src[j] === "\n") break; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
const lineAt = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

/** Длина наибольшей общей подстроки */
function lcsLen(a: string, b: string): number {
  let best = 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

/* ═══════════════════════════ TG.G4: мутанты пары (заголовки, тело) ═══════════════════════════ */

type Req = { headers: Record<string, string>; body: ChatBody };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const req = (dialog: string, k: number): RecordedRequest => loadDialog(dialog).requests[k];
const asWire = (r: Req): WireRequest => ({ headers: r.headers, body: r.body });

/** Переставить ключи объекта в обратном порядке (рекурсивно): порядок ключей не важен (§4.5) */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v == null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).reverse()) out[k] = reverseKeys((v as Record<string, unknown>)[k]);
  return out;
}
/**
 * «Бот-образная» копия запроса браузера: всё, что нормализация N вправе не замечать, заменено (§4.5): body.id и x-so-chat → tg_…,
 * messages[].id, toolCallId (последовательно), built_at, diagnostics.snapshot_dir; добавлены x-so-channel и x-so-bot-key; порядок
 * ключей обратный. Компаратор обязан считать её равной оригиналу — иначе TG.4 краснел бы на верной реализации.
 */
function botify(r: RecordedRequest): Req {
  const sid = "tg_AuditBotG4x";
  const body = clone(r.body);
  const tc = new Map<string, string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v == null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (k === "toolCallId" && typeof o[k] === "string") { const old = o[k] as string; if (!tc.has(old)) tc.set(old, `call_bot_${tc.size + 1}`); o[k] = tc.get(old); }
      else if (k === "built_at") o[k] = "2027-01-01T00:00:00.000Z";
      else if (k === "snapshot_dir") o[k] = "/opt/second-opinion/packages/engine/golden/snapshots/other";
      else walk(o[k]);
    }
  };
  walk(body);
  body.id = sid;
  body.messages.forEach((m, i) => { if ("id" in m) m.id = `bot-msg-${i + 1}`; });
  return {
    headers: { "x-so-bot-key": TG_TEST.botKey, "x-so-channel": "telegram", "x-so-chat": sid, "content-type": r.headers["content-type"] },
    body: reverseKeys(body) as ChatBody,
  };
}
const msgAt = (b: ChatBody, i: number): WireMessage => {
  const m = b.messages[i];
  if (!m) throw new Error(`дефект харнеса (TG.G4): нет messages[${i}]`);
  return m;
};
const partOf = (m: WireMessage, type: string) => {
  const p = m.parts.find((x) => x.type === type || (type === "tool-*" && x.type.startsWith("tool-")));
  if (!p) throw new Error(`дефект харнеса (TG.G4): нет части ${type}`);
  return p;
};

interface Mutant { n: string; title: string; dialog: string; k: number; where: RegExp; mutate(r: Req): void }
/** 12 мутантов §6 (TG.G4) + (12б) для toolCallId; `where` — где компаратор обязан увидеть расхождение */
export const G4_MUTANTS: Mutant[] = [
  { n: "1", title: "HTML вместо текста ассистента", dialog: "d1", k: 1, where: /messages\[1\]\.parts\[\d+\]\.text/,
    mutate: (r) => { const p = partOf(msgAt(r.body, 1), "text"); p.text = `<b>${String(p.text).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</b>`; } },
  { n: "2", title: "«Проверить» вместо «Проверь»", dialog: "d2", k: 1, where: /messages\[2\]\.parts\[0\]\.text/,
    mutate: (r) => { const p = partOf(msgAt(r.body, 2), "text"); p.text = String(p.text).replace(/^Проверь /, "Проверить "); } },
  { n: "3", title: "снят inputs в d6", dialog: "d6", k: 0, where: /body\.inputs/, mutate: (r) => { delete r.body.inputs; } },
  { n: "4", title: "снят metadata.custom", dialog: "d1", k: 0, where: /messages\[0\]\.metadata\.custom/,
    mutate: (r) => { delete (msgAt(r.body, 0).metadata as Record<string, unknown>).custom; } },
  { n: "5", title: "лишнее поле channel в теле", dialog: "d1", k: 0, where: /body\.channel/, mutate: (r) => { (r.body as Record<string, unknown>).channel = "telegram"; } },
  { n: "6", title: "пропущено сообщение", dialog: "d1", k: 2, where: /body\.messages: длина 5 \(браузер\) ≠ 4/, mutate: (r) => { r.body.messages.splice(1, 1); } },
  { n: "7", title: "у бота нет заголовка x-so-chat", dialog: "d1", k: 0, where: /headers\.x-so-chat/, mutate: (r) => { delete r.headers["x-so-chat"]; } },
  { n: "8", title: "у бота лишний заголовок x-so-foo", dialog: "d1", k: 0, where: /headers\.x-so-foo/, mutate: (r) => { r.headers["x-so-foo"] = "1"; } },
  { n: "9", title: "из parts ответа ассистента удалён step-start", dialog: "d2", k: 1, where: /messages\[1\]\.parts: длина 4 \(браузер\) ≠ 3/,
    mutate: (r) => { const m = msgAt(r.body, 1); const i = m.parts.findIndex((p) => p.type === "step-start"); if (i < 0) throw new Error("дефект харнеса (TG.G4): в d2 нет step-start"); m.parts.splice(i, 1); } },
  { n: "10", title: "у tool-* state «input-available» вместо «output-available»", dialog: "d1", k: 1, where: /messages\[1\]\.parts\[\d+\]\.state/,
    mutate: (r) => { partOf(msgAt(r.body, 1), "tool-*").state = "input-available"; } },
  { n: "11", title: "trigger «regenerate-message»", dialog: "d1", k: 0, where: /body\.trigger/, mutate: (r) => { r.body.trigger = "regenerate-message"; } },
  { n: "12", title: "у сообщения пользователя нет ключа id", dialog: "d1", k: 1, where: /messages\[0\]\.id/, mutate: (r) => { delete msgAt(r.body, 0).id; } },
  { n: "12б", title: "у tool-части нет ключа toolCallId", dialog: "d1", k: 1, where: /messages\[1\]\.parts\[\d+\]\.toolCallId/,
    mutate: (r) => { delete (partOf(msgAt(r.body, 1), "tool-*") as Record<string, unknown>).toolCallId; } },
];

/* ═══════════════════════════ TG.20: поиск запрещённого ═══════════════════════════ */

interface Forbidden { ids: number[]; pseudonyms: string[]; texts: string[] }
interface Hit { kind: string; what: string }
/** Что запрещено в строке журнала: id как отдельное число, маркеры имён (подстрокой, без учёта регистра), токен, ключ, соль,
 *  псевдонимы; texts — тексты реплик (подстрокой; только для журнала бота) */
function hits(line: string, f: Forbidden, withTexts: boolean): Hit[] {
  const out: Hit[] = [];
  for (const id of f.ids) if (idRegex(id).test(line)) out.push({ kind: "chat_id/user_id", what: String(id) });
  const low = line.toLowerCase();
  for (const [k, v] of Object.entries(NAME_MARKERS)) if (low.includes(v.toLowerCase())) out.push({ kind: `маркер ${k}`, what: v });
  if (line.includes(TG_TEST.token)) out.push({ kind: "токен бота", what: "<токен>" });
  if (line.includes(TG_TEST.botKey)) out.push({ kind: "SO_BOT_KEY", what: "<ключ>" });
  if (line.includes(TG_TEST.salt)) out.push({ kind: "соль SO_TG_SALT", what: "<соль>" });
  for (const p of f.pseudonyms) if (p && line.includes(p)) out.push({ kind: "псевдоним pseudonymOf", what: p });
  if (withTexts) for (const t of f.texts) if (t.length >= 3 && line.includes(t)) out.push({ kind: "текст реплики", what: t });
  return out;
}
/** Самопроверка поиска (§6, TG.20: «хотя бы раз харнес убеждается, что поиск находит маркер в строке, куда он подставлен
 *  намеренно»): в настоящую строку журнала подставляется каждое запрещённое значение — поиск обязан его найти; id внутри
 *  более длинного числа — не находить. Сбой — дефект харнеса (исключение → ERROR). */
function selfTestSearch(sample: string, f: Forbidden): string {
  const base = sample.trim() || `{"chat":"tg_AAAAAAAAAAAA","step":"gate","text":"x"}`;
  const inject = (v: string) => { try { const o = JSON.parse(base) as Record<string, unknown>; o.text = `${String(o.text ?? "")} ${v}`; return JSON.stringify(o); } catch { return `${base} ${v}`; } };
  const probes: { v: string; kind: string; texts: boolean }[] = [
    { v: String(f.ids[0]), kind: "chat_id/user_id", texts: false },
    ...Object.entries(NAME_MARKERS).map(([k, v]) => ({ v, kind: `маркер ${k}`, texts: false })),
    { v: TG_TEST.token, kind: "токен бота", texts: false }, { v: TG_TEST.botKey, kind: "SO_BOT_KEY", texts: false }, { v: TG_TEST.salt, kind: "соль SO_TG_SALT", texts: false },
    ...(f.pseudonyms[0] ? [{ v: f.pseudonyms[0], kind: "псевдоним pseudonymOf", texts: false }] : []),
    ...(f.texts[0] ? [{ v: f.texts[0], kind: "текст реплики", texts: true }] : []),
  ];
  for (const p of probes) {
    const line = inject(p.v);
    if (!hits(line, f, p.texts).some((h) => h.kind === p.kind)) throw new Error(`дефект харнеса (TG.20): поиск не нашёл подставленное значение (${p.kind}) в строке ${line.slice(0, 160)}`);
  }
  const id = String(f.ids[0]);
  for (const near of [`1${id}`, `${id}2`, `${id}05`])
    if (hits(inject(near), { ids: f.ids, pseudonyms: [], texts: [] }, false).some((h) => h.kind === "chat_id/user_id" && h.what === id))
      throw new Error(`дефект харнеса (TG.20): id ${id} найден внутри числа ${near}`);
  return `самопроверка поиска: в строку журнала подставлены id, ${Object.keys(NAME_MARKERS).length} маркера, токен, ключ, соль${f.pseudonyms[0] ? ", псевдоним" : ""}${f.texts[0] ? ", текст реплики" : ""} — всё найдено; id внутри длинного числа не находится`;
}

/* ═══════════════════════════ проверки ═══════════════════════════ */

export interface ParityOpts {
  /** корень, от которого грузятся модули WP-TG (apps/bot/src, packages/present/src, apps/web/lib/session.ts); по умолчанию — репозиторий */
  root?: string;
  /** добавочное окружение сценариев (только самопроверка) */
  env?: Record<string, string | undefined>;
}

export function makeParityChecks(o: ParityOpts = {}): Check[] {
  const root = o.root ?? REPO_ROOT;
  const scenEnv: Record<string, string | undefined> = { ...(o.env ?? {}), [PARITY_ROOT_ENV]: root === REPO_ROOT ? undefined : root };
  const TIMEOUT: Record<string, number> = { dialogs: 150_000, tg9: 90_000, tg21: 90_000 };

  /** Сценарий parity:<name>: упал исключением или завис → готовый RED; иной дефект харнеса → исключение (ERROR) */
  function sc<T>(name: string): { ok: true; r: ScenarioResult<T> & { ok: true } } | { ok: false; v: Verdict } {
    let r: ScenarioResult<T>;
    try {
      r = scenario<T>(`parity:${name}`, { env: scenEnv, timeoutMs: TIMEOUT[name] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ETIMEDOUT|timed out|SIGTERM/.test(msg))
        return { ok: false, v: fail(`сценарий parity:${name} не завершился за ${TIMEOUT[name] / 1000} с — ядро бота зависло (handleUpdate/idle не разрешились?): ${msg.slice(0, 300)}`) };
      throw e;
    }
    if (!r.ok) return { ok: false, v: fail(`сценарий parity:${name} упал: ${r.error}${r.stderr ? ` | stderr: ${r.stderr.slice(0, 300)}` : ""}${scenarioNotes(r)}`) };
    return { ok: true, r };
  }
  const noBot = (missing: string, want: string) => fail(`бота нет — ${missing}. Ожидается (${want})`);

  /* ───── TG.4 ───── */
  const TG4: Check = {
    id: "TG.4", wp: "TG", kind: "fixture",
    title: "И5: бот (createCore + фейковый Telegram + fetch → route.POST) на действиях 7 диалогов шлёт ровно 15 запросов, каждый ≡ телу браузера после N; заголовки — браузерные + x-so-channel, x-so-bot-key (§4.5)",
    run(): Verdict {
      const s = sc<DialogsOut>("dialogs");
      if (!s.ok) return s.v;
      const out = s.r.out;
      if (out.missing) return noBot(out.missing, `ядро на действиях 7 диалогов шлёт ровно 15 POST /api/chat, N(тело бота k) ≡ N(тело браузера k), заголовки по §4.5; ${DIALOG_SHAPE()}`);
      const problems: string[] = [];
      const chat = out.requests.filter(isChatPost);
      const other = out.requests.filter((r) => !isChatPost(r));
      if (other.length) problems.push(`лишние обращения бота через fetch (${other.length}): ${list(other.map((r) => `${r.method} ${r.url}`), 3)} — ядро ходит только в POST ${TG_TEST.webUrl}/api/chat`);
      problems.push(...uncaughtIssue(out.uncaught));
      if (s.r.blocked.length) problems.push(`ядро ходило во внешнюю сеть мимо внедрённого fetch (${s.r.blocked.length}): ${list(s.r.blocked.map((u) => u.slice(0, 90)), 3)} (§4.4: «core.ts ходит в сеть только через внедрённые fetch и TgClient»)`);
      let equal = 0;
      for (const run of out.runs) {
        const d = loadDialog(run.dialog);
        if (!run.playOk) problems.push(`${run.dialog}: прогон действий остановился — ${run.playDetail}`);
        const mine = chat.filter((r) => r.dialog === run.dialog);
        for (let a = 0; a < d.actions.length; a++) {
          const B = d.requests.filter((r) => r.action === a);
          const T = mine.filter((r) => r.step === a);
          const st = run.steps.find((x) => x.action === a);
          const act = actionLabel(d.actions[a]);
          if (B.length !== T.length) {
            const tgNote = st ? `; Telegram на это действие: ${callsSummary(out.calls.slice(st.callsFrom, st.callsTo))}` : "; до этого действия прогон не дошёл";
            problems.push(`${run.dialog}, действие ${a} (${act}): браузер отправил ${B.length} запрос(ов), бот — ${T.length}${tgNote}`);
          }
          for (let i = 0; i < Math.min(B.length, T.length); i++) {
            const b = B[i], t = T[i];
            const k = d.requests.indexOf(b) + 1;
            const cmp = comparePair({ headers: b.headers, body: b.body }, { headers: t.headers, body: t.rawBody });
            const own: string[] = [];
            const tb = bodyOf(t.rawBody);
            if (t.headers["x-so-channel"] !== "telegram") own.push(`x-so-channel ${q(t.headers["x-so-channel"])}, ожидалось «telegram»`);
            if (t.headers["x-so-bot-key"] !== TG_TEST.botKey) own.push(`x-so-bot-key ${t.headers["x-so-bot-key"] == null ? "нет" : "≠ ключу из config.botKey"}`);
            if (tb && t.headers["x-so-chat"] !== tb.id) own.push(`x-so-chat ${q(t.headers["x-so-chat"])} ≠ body.id ${q(tb.id == null ? null : String(tb.id))} (§4.4: x-so-chat = id сессии)`);
            if (t.status !== 200) own.push(`ответ сервера HTTP ${t.status}${t.error ? ` (${t.error})` : ""}`);
            if (cmp.equal && !own.length) equal++;
            else problems.push(`${run.dialog} тело ${k} (${act}): ${[...cmp.headerDiffs, ...(cmp.bodyDiff ? [cmp.bodyDiff] : []), ...own].join("; ")}`);
          }
        }
      }
      if (chat.length !== 15) problems.unshift(`бот отправил ${chat.length} запрос(ов) в /api/chat, ожидалось ровно 15 (${DIALOG_SHAPE()}; по диалогам у бота: ${DIALOG_IDS.map((id) => `${id} ${chat.filter((r) => r.dialog === id).length}`).join(", ")})`);
      const summary = `запросов бота в /api/chat: ${chat.length} (эталон 15: ${DIALOG_SHAPE()}); равны телам браузера после N (§4.5: body.id, x-so-chat, messages[].id, toolCallId, built_at, snapshot_dir) с проверкой заголовков: ${equal}/15; ` +
        `заголовки бота — content-type и x-so-chat (= body.id) как у браузера, сверх них только x-so-channel: telegram и x-so-bot-key (тестовый ключ); прогон ${out.ms} мс`;
      return expect(problems.length === 0, `${problems.length ? `${list(problems, 6, " || ")} || ` : ""}${summary}${scenarioNotes(s.r)}`);
    },
  };

  /* ───── TG.5 ───── */
  const TG5: Check = {
    id: "TG.5", wp: "TG", kind: "fixture",
    title: "Состояние сервера после каждого диалога: у сессии бота query, result.kind, result.report.inputs, pendingInputs, userMessages ≡ сессии повтора тел браузера",
    run(): Verdict {
      const s = sc<DialogsOut>("dialogs");
      if (!s.ok) return s.v;
      const out = s.r.out;
      if (out.missing) return noBot(out.missing, "после каждого из 7 диалогов серверная сессия бота (tg_…) по query, result.kind, result.report.inputs, pendingInputs, userMessages равна сессии повтора 15 тел браузера");
      const problems: string[] = [...uncaughtIssue(out.uncaught)];
      const shown: string[] = [];
      for (const run of out.runs) {
        const bad = run.browserStatus.filter((x) => x !== 200);
        if (bad.length) problems.push(`${run.dialog}: повтор тел браузера дал HTTP ${run.browserStatus.join("/")} — эталон состояния неверен`);
        if (!run.botSid || !run.bot) {
          problems.push(`${run.dialog}: у бота нет серверной сессии (peek(${run.chatId}) ${run.peekError ? `бросил: ${run.peekError}` : "пуст"}, POST /api/chat не было)`);
          continue;
        }
        const d = diff(run.browser, run.bot, { path: `${run.dialog}.session`, labels: ["браузер", "бот"] });
        if (d) problems.push(`${d} (сессия бота ${run.botSid}, браузера ${run.browserSid})`);
        shown.push(`${run.dialog}: query ${q(run.bot.query, 40)}, ${run.bot.resultKind ?? "нет результата"}, inputs ${canonical(run.bot.reportInputs)}, pending ${canonical(run.bot.pendingInputs)}, реплик ${run.bot.userMessages}`);
      }
      return expect(problems.length === 0, `${problems.length ? `${list(problems, 6, " || ")} || ` : ""}сессии бота: ${list(shown, 7)}${scenarioNotes(s.r)}`);
    },
  };

  /* ───── TG.9 ───── */
  const TG9: Check = {
    id: "TG.9", wp: "TG", kind: "unit",
    title: "Порядок: renderTurn держит порядок parts; d1 — sendMessage(WAIT_REPORT) → editMessageText (тот же message_id, отчёт) → sendMessage(текст); текст модели до инструмента уходит до заглушки и не повторяется (SSE OpenRouter и Anthropic)",
    async run(): Promise<Verdict> {
      // самопроверка рукописного SSE: проходит uiMessageChunkSchema и собирается ai в нужные parts (дефект → ERROR)
      const output = tg9ReportOutput();
      const sseIsin = (output as { result?: { report?: { security?: { isin?: string } } } }).result?.report?.security?.isin ?? "RU000A1038V6";
      for (const variant of ["openrouter", "anthropic"] as const) {
        const chunks = tg9Chunks(variant, output);
        const a = await assembleUIMessage(sseResponse(chunks));
        const types = (a.message?.parts ?? []).map((p) => p.type).join(",");
        const want = "step-start,text,tool-resolve_security,step-start,text";
        const tool = a.message?.parts.find((p) => p.type === "tool-resolve_security") as { state?: string } | undefined;
        if (a.errors.length || a.chunks.length !== chunks.length || types !== want || tool?.state !== "output-available" || collapseWs(a.message?.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("|") ?? "") !== `${TG9_A}|${TG9_B}`)
          throw new Error(`дефект харнеса (TG.9): рукописный SSE «${variant}» не прошёл uiMessageChunkSchema/сборку ai: ошибок ${a.errors.length} (${a.errors[0] ?? ""}), чанков ${a.chunks.length}/${chunks.length}, parts ${types}`);
      }
      const t = sc<Tg9Out>("tg9");
      if (!t.ok) return t.v;
      const o = t.r.out;
      if (o.missing) return noBot(o.missing, "renderTurn сохраняет порядок parts; d1: send(WAIT_REPORT) → edit того же message_id в отчёт → send(текст); рукописный SSE: send(«A») → send(WAIT_REPORT) → edit(отчёт) → send(«B»)");
      const problems: string[] = [...uncaughtIssue(o.uncaught)];
      const W = o.waitReport;

      // (1) renderTurn на сообщениях ассистента фикстур
      let opsTotal = 0;
      for (const r of o.render) {
        const where = `renderTurn(${r.dialog}, ассистент ${r.messageId.slice(0, 14)})`;
        if (r.error || !r.ops) { problems.push(`${where} бросил: ${r.error}`); continue; }
        opsTotal += r.ops.length;
        let prev = -1;
        const issues: string[] = [];
        r.ops.forEach((op, j) => {
          if (op.partIndex < prev) issues.push(`операция ${j} (partIndex ${op.partIndex}) после partIndex ${prev} — порядок parts нарушен`);
          prev = Math.max(prev, op.partIndex);
          const p = r.parts[op.partIndex];
          if (!p) issues.push(`операция ${j}: partIndex ${op.partIndex} вне parts (их ${r.parts.length})`);
          else if (p.type === "step-start") issues.push(`операция ${j} на step-start (partIndex ${op.partIndex}) — step-start пропускается`);
          if (!op.text.trim()) issues.push(`операция ${j}: пустой текст`);
        });
        r.parts.forEach((p, i) => {
          const mine = r.ops!.filter((op) => op.partIndex === i);
          if (p.type === "text" && (p.text ?? "").trim()) {
            if (!mine.length) issues.push(`text-часть ${i} («${(p.text ?? "").slice(0, 40)}…») не отрисована`);
            else if (mine.some((op) => op.html)) issues.push(`text-часть ${i} ушла с html — текст ассистента идёт простым текстом (§4.7)`);
            else if (collapseWs(mine.map((op) => op.text).join(" ")) !== collapseWs(p.text ?? "")) issues.push(`text-часть ${i}: в операциях «${mine.map((op) => op.text).join(" ").slice(0, 60)}» ≠ тексту части «${(p.text ?? "").slice(0, 60)}»`);
          } else if (p.type.startsWith("tool-") && p.state === "output-available") {
            if (p.type === "tool-explain_term" && p.found === false) { if (mine.length) issues.push(`explain found:false (часть ${i}) дал ${mine.length} операций — должно быть ничего`); }
            else if (!mine.length) issues.push(`${p.type} (часть ${i}) не отрисован`);
            else if (mine.some((op) => op.toolCallId != null && op.toolCallId !== p.toolCallId)) issues.push(`${p.type} (часть ${i}): toolCallId операции ${q(mine.find((op) => op.toolCallId !== p.toolCallId)?.toolCallId)} ≠ ${q(p.toolCallId)}`);
          }
        });
        if (issues.length) problems.push(`${where}: ${list(issues, 3)} | parts: ${r.parts.map((p) => p.type).join(",")} | partIndex операций: ${r.ops.map((op) => op.partIndex).join(",")}`);
      }

      // (2) первый ход d1 через route
      const d1Note: string[] = [];
      const dl = sc<DialogsOut>("dialogs");
      if (!dl.ok) problems.push(`прогон d1: ${dl.v.detail}`);
      else if (dl.r.out.missing) problems.push(`прогон d1: ${dl.r.out.missing}`);
      else {
        const run = dl.r.out.runs.find((x) => x.dialog === "d1");
        const st = run?.steps.find((x) => x.action === 0);
        const d1 = loadDialog("d1");
        const asst = d1.requests[1].body.messages[1];
        const text = asst.parts.filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join(" ");
        const isin = (asst.parts[0]?.output as { result?: { report?: { security?: { isin?: string } } } } | undefined)?.result?.report?.security?.isin ?? "RU000A1038V6";
        if (!run || !st) problems.push(`прогон d1: первого хода нет${run?.playDetail ? ` (${run.playDetail})` : ""}`);
        else {
          const all = dl.r.out.calls.slice(st.callsFrom, st.callsTo);
          const v = visible(all);
          const why = matchReportTurn(v, { before: [], wait: W, isin, final: text });
          if (why) problems.push(`d1, первый ход («ОФЗ 26238», гейт: tool-input-available → tool-output-available → текст): ожидалось send(«${W}») → edit того же message_id (html, отчёт с ${isin}) → send(«${text.slice(0, 40)}…», простой текст); ${why}; получено: ${callsSummary(v)}`);
          else d1Note.push(`d1: ${callsSummary(v, 30)}`);
        }
      }

      // (3) рукописный SSE без route
      const sseNote: string[] = [];
      for (const r of o.sse) {
        const v = visible(r.calls);
        const label = r.variant === "openrouter" ? "SSE OpenRouter (text-end после tool-input-available)" : "SSE Anthropic (text-end до tool-input-start)";
        const why = r.posts !== 1 ? `POST ${r.posts}, ожидался 1` : r.error ? `ошибка ${r.error}` : matchReportTurn(v, { before: [TG9_A], wait: W, isin: sseIsin, final: TG9_B });
        if (why) {
          const again = v.filter((c) => c.text === TG9_A).length;
          problems.push(`${label}: ожидалось send(«A») → send(«${W}») → edit того же message_id (отчёт) → send(«B»), «A» один раз; ${why}${again > 1 ? `; «A» отправлен ${again} раза` : ""}; получено: ${callsSummary(v, 40)}`);
        } else sseNote.push(`${r.variant}: ${callsSummary(v, 20)}`);
      }
      const summary = `renderTurn: ${o.render.length} сообщений ассистента фикстур, ${opsTotal} операций; ${[...d1Note, ...sseNote].join(" | ")}; «A» = «${TG9_A}», «B» = «${TG9_B}», инструмент ${TG9_CALL} (${TG9_QUERY})`;
      return expect(problems.length === 0, `${problems.length ? `${list(problems, 6, " || ")} || ` : ""}${summary}${scenarioNotes(t.r)}`);
    },
  };

  /* ───── TG.20 ───── */
  const TG20: Check = {
    id: "TG.20", wp: "TG", kind: "fixture",
    title: "Приватность: в журнале бота и usage.jsonl нет chat_id/user_id, маркеров имён, токена, SO_BOT_KEY, соли и pseudonymOf; в журнале бота нет реплик и pseudo в записях хода; chat у бота в usage.jsonl — tg_…",
    run(): Verdict {
      const s = sc<DialogsOut>("dialogs");
      if (!s.ok) return s.v;
      const out = s.r.out;
      if (out.missing) return noBot(out.missing, "прогон TG.4 с сырыми апдейтами (username/first_name/last_name-маркеры, chat.id = from.id = 7000000100+k): в журнале бота и usage.jsonl нет id, маркеров, токена, ключа, соли, псевдонима; в журнале бота нет реплик, в записях хода нет pseudo; chat у бота — tg_…");
      const u = out.updates;
      // маркеры и chat.id = from.id ставит харнес (UpdateFactory): иначе тест не проверял бы ничего — дефект харнеса
      if (u.withMarkers !== u.total || u.chatEqFrom !== u.total)
        throw new Error(`дефект харнеса (TG.20): апдейтов ${u.total}, с маркерами имён ${u.withMarkers}, chat.id = from.id ${u.chatEqFrom}`);
      const incomplete = u.total < 15 ? [`прогон неполон: ядро получило ${u.total} апдейт(ов) из 15 (диалог остановился — см. TG.4: ${list(out.runs.filter((r) => !r.playOk).map((r) => String(r.playDetail).slice(0, 160)), 2)}); приватность проверена только на них`] : [];
      const pseudonyms = [...new Set(out.pseudonyms.flatMap((p) => [p.mod, p.formula]).filter((x): x is string => !!x))];
      const payloads = out.userTexts.flatMap((tx) => (tx.startsWith("/start ") ? [tx.slice(7).trim()] : []));
      const f: Forbidden = { ids: u.chatIds, pseudonyms, texts: [...out.userTexts, ...payloads] };
      const usageLines = out.usageBot.split("\n").filter(Boolean);
      const selfNote = selfTestSearch(usageLines[0] ?? "", f);

      const problems: string[] = [...incomplete, ...uncaughtIssue(out.uncaught)];
      const scan = (label: string, lines: readonly string[], withTexts: boolean) => {
        const found: string[] = [];
        lines.forEach((l, i) => { for (const h of hits(l, f, withTexts)) found.push(`${h.kind} ${h.what} в строке ${i + 1}: ${brief(l, 140)}`); });
        if (found.length) problems.push(`${label}: ${list([...new Set(found)], 3)}`);
      };
      scan("журнал бота (LogRec)", out.log.recs, true);
      if (out.log.lines) scan("журнал бота (строки makeLogger)", out.log.lines, true);
      else problems.push(`строки журнала бота не проверить — ${out.log.logMissing ?? "makeLogger не загрузился"}`);
      scan("console/stdout/stderr во время ходов бота", out.log.console, true);
      scan("usage.jsonl", usageLines, false);
      if (out.idsMissing) problems.push(`pseudonymOf из apps/bot/src/ids.ts не загрузился (${out.idsMissing}) — искался только псевдоним по формуле §4.4`);

      const withPseudo = out.log.recs.filter((r) => { try { const o = JSON.parse(r) as Record<string, unknown>; return o.pseudo !== undefined && !/notallowed|not_allowed|dailylimit|daily_limit/i.test(String(o.ev)); } catch { return false; } });
      if (withPseudo.length) problems.push(`pseudo в записях хода (${withPseudo.length}; в этом прогоне отказов нет, allow "*"): ${list(withPseudo.map((r) => brief(r, 100)), 2)}`);

      const recs = usageLines.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
      const withChat = recs.filter((r) => "chat" in r);
      const notTg = withChat.filter((r) => !String(r.chat).startsWith("tg_"));
      if (!withChat.length) problems.push("в usage.jsonl нет записей ходов бота (поле chat) — прогон пуст");
      if (notTg.length) problems.push(`поле chat в usage.jsonl у бота не начинается с tg_ (${notTg.length} из ${withChat.length}): ${list([...new Set(notTg.map((r) => String(r.chat)))], 3)}`);

      const summary = `апдейтов ${u.total} (все с маркерами ${Object.values(NAME_MARKERS).join("/")}, chat.id = from.id; id ${u.chatIds[0]}…${u.chatIds[u.chatIds.length - 1]}); ` +
        `просмотрено: LogRec ${out.log.recs.length}, строк makeLogger ${out.log.lines?.length ?? "—"}, console/stdout/stderr ${out.log.console.length}, usage.jsonl ${usageLines.length} (сессии ${list([...new Set(withChat.map((r) => String(r.chat)))], 3, ", ")}); ` +
        `искались: ${u.chatIds.length} id отдельным числом, маркеры, токен, SO_BOT_KEY, соль, ${pseudonyms.length} псевдонимов, ${f.texts.length} текстов реплик (журнал бота: LogRec, строки makeLogger, вывод в консоль; не usage.jsonl); ${selfNote}`;
      return expect(problems.length === 0, `${problems.length ? `${list(problems, 6, " || ")} || ` : ""}${summary}${scenarioNotes(s.r)}`);
    },
  };

  /* ───── TG.21 ───── */
  const TG21: Check = {
    id: "TG.21", wp: "TG", kind: "unit",
    title: "Сессия: session.ts берёт TTL из SESSION_TTL_MS; id бота /^tg_[A-Za-z0-9_-]{12}$/ без псевдонима и общих частей; /new и новое ядро — другой id; после SESSION_TTL_MS − BOT_TTL_MARGIN_MS простоя — новый id, пустая история, BOT.sessionExpired",
    run(): Verdict {
      const problems: string[] = [];
      const notes: string[] = [];

      // (а) статически: session.ts импортирует SESSION_TTL_MS из @so/present/protocol и не держит TTL литералом
      const rel = "apps/web/lib/session.ts";
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) problems.push(`нет ${rel}`);
      else {
        const code = stripComments(fs.readFileSync(abs, "utf8"));
        const imp = [...code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']\s*;?/g)].find((m) => /\bSESSION_TTL_MS\b/.test(m[2]));
        const local = imp ? (imp[2].match(/\bSESSION_TTL_MS\b(?:\s+as\s+([A-Za-z_$][\w$]*))?/)?.[1] ?? "SESSION_TTL_MS") : null;
        const fromOk = !!imp && !imp[1] && !/\btype\s+SESSION_TTL_MS\b/.test(imp[2]) && (imp[3] === "@so/present/protocol" || /(^|\/)present\/src\/protocol(\.ts)?$/.test(imp[3]));
        const rest = imp ? code.replace(imp[0], "") : code;
        const uses = local ? (rest.match(new RegExp(`(?<![\\w$])${local.replace(/\$/g, "\\$")}(?![\\w$])`, "g")) ?? []).length : 0;
        const lit = /\b60\s*\*\s*60_?000\b|\b3_?600_?000\b|\b60\s*\*\s*60\s*\*\s*1_?000\b/.exec(code);
        const sIssues: string[] = [];
        if (!imp) sIssues.push("SESSION_TTL_MS из @so/present/protocol не импортируется");
        else if (!fromOk) sIssues.push(`SESSION_TTL_MS импортируется не как значение из @so/present/protocol: «${imp[0].trim().slice(0, 100)}»`);
        else if (!uses) sIssues.push(`SESSION_TTL_MS импортирован, но не используется`);
        if (lit) sIssues.push(`TTL — литерал (строка ${lineAt(code, lit.index)}: «${code.split("\n")[lineAt(code, lit.index) - 1].trim().slice(0, 80)}»)`);
        if (sIssues.length) problems.push(`${rel}: ${sIssues.join("; ")} (§4.3: «session.ts: TTL берётся из SESSION_TTL_MS»; ожидаемо до шага 2)`);
        else notes.push(`${rel}: TTL = ${local} из ${imp![3]}`);
      }

      const t = sc<Tg21Out>("tg21");
      if (!t.ok) return fail(`${problems.length ? problems.join(" || ") + " || " : ""}${t.v.detail}`);
      const o = t.r.out;
      // (б) поведение session.ts: подмена Date.now
      const ses = o.session;
      if ("ttl" in ses) {
        if (!ses.keptBefore || !ses.goneAfter) problems.push(`${rel}: сессия ${ses.keptBefore ? "" : "вытеснена при простое SESSION_TTL_MS − 1 с"}${!ses.keptBefore && !ses.goneAfter ? " и " : ""}${ses.goneAfter ? "" : "жива при простое SESSION_TTL_MS + 1 с"} (SESSION_TTL_MS = ${ses.ttl} мс)`);
        else notes.push(`сессия сервера жива при простое SESSION_TTL_MS − 1 с и вытеснена после SESSION_TTL_MS + 1 с (${ses.ttl / 60_000} мин)`);
      } else if ("error" in ses) problems.push(`${rel}: проба TTL бросила: ${ses.error}`);
      else notes.push(`проба TTL session.ts пропущена: ${ses.skipped}`);

      if (o.missing) {
        problems.push(`бота нет — ${o.missing}`);
        return fail(`${problems.join(" || ")}. Ожидается: id сессии бота tg_<12> (/^tg_[A-Za-z0-9_-]{12}$/), /new и новое ядро с той же солью — другой id, у двух сессий одного chat_id нет pseudonymOf(chatId, salt) и общей подстроки ≥ 4; простой > SESSION_TTL_MS − BOT_TTL_MARGIN_MS (часы deps.now) → новый id, пустая история, BOT.sessionExpired${notes.length ? ` | ${notes.join("; ")}` : ""}`);
      }
      problems.push(...uncaughtIssue(o.uncaught));
      const life = o.ttl - o.margin;
      if (!(life > 0) || !(o.margin > 0)) problems.push(`SESSION_TTL_MS − BOT_TTL_MARGIN_MS = ${o.ttl} − ${o.margin} = ${life}: история бота должна жить меньше сессии сервера и больше 0`);

      const by = (label: string) => o.steps.find((x) => x.label === label);
      const ID = /^tg_[A-Za-z0-9_-]{12}$/;
      const expired = (st: Tg21Step) => st.calls.some((c) => c.method === "sendMessage" && !c.error && c.text === o.sessionExpired);
      const one = (st: Tg21Step | undefined, label: string): { sid: string | null; messages: number } | null => {
        if (!st) { problems.push(`шаг «${label}» не выполнен`); return null; }
        if (st.error) problems.push(`шаг «${label}» («${st.text}»): ${st.error}`);
        if (st.posts.length !== 1) { problems.push(`шаг «${label}» («${st.text}»): POST ${st.posts.length}, ожидался 1; Telegram: ${callsSummary(st.calls, 40)}`); return null; }
        const p = st.posts[0];
        if (p.xChat !== p.sid) problems.push(`шаг «${label}»: x-so-chat ${q(p.xChat)} ≠ body.id ${q(p.sid)}`);
        if (st.peek && st.peek.sessionId !== p.sid) problems.push(`шаг «${label}»: peek().sessionId ${q(st.peek.sessionId)} ≠ body.id ${q(p.sid)}`);
        return { sid: p.sid, messages: p.messages };
      };
      const ids: { label: string; sid: string }[] = [];
      const s1 = one(by("first"), "первая реплика");
      if (s1?.sid) ids.push({ label: "первая сессия", sid: s1.sid });
      if (s1 && s1.messages !== 1) problems.push(`первая реплика: в теле ${s1.messages} сообщений, ожидалось 1`);
      const sb = one(by("beforeTtl"), `простой SESSION_TTL_MS − BOT_TTL_MARGIN_MS − 1 с`);
      if (sb && s1?.sid && sb.sid !== s1.sid) problems.push(`простой на 1 с меньше ${life / 60_000} мин: id сменился (${q(s1.sid)} → ${q(sb.sid)}) — история бота должна жить SESSION_TTL_MS − BOT_TTL_MARGIN_MS`);
      if (sb && sb.messages !== 3) problems.push(`простой меньше срока: в теле ${sb.messages} сообщений, ожидалось 3 (история сохранена)`);
      if (by("beforeTtl") && expired(by("beforeTtl")!)) problems.push(`BOT.sessionExpired до истечения срока`);
      const after = by("afterTtl");
      let s2: string | null = null;
      if (!after) problems.push("шаг «после TTL» не выполнен");
      else {
        if (after.error) problems.push(`после TTL: ${after.error}`);
        if (!expired(after)) problems.push(`после простоя SESSION_TTL_MS − BOT_TTL_MARGIN_MS + 1 с (${life / 60_000} мин 1 с) нет BOT.sessionExpired («${o.sessionExpired.slice(0, 60)}»); Telegram: ${callsSummary(after.calls, 40)}`);
        if (after.posts.length === 1) {
          s2 = after.posts[0].sid;
          if (after.posts[0].messages !== 1) problems.push(`после TTL: в теле ${after.posts[0].messages} сообщений — история не пуста (ожидалось 1: только новая реплика)`);
          if (after.posts[0].xChat !== s2) problems.push(`после TTL: x-so-chat ${q(after.posts[0].xChat)} ≠ body.id ${q(s2)}`);
        } else if (after.posts.length === 0) {
          s2 = after.peek?.sessionId ?? null;
          if (!after.peek || after.peek.messages !== 0) problems.push(`после TTL: POST не было, а peek ${after.peek ? `показывает ${after.peek.messages} сообщений` : "пуст"} — ожидалась новая пустая история`);
        } else problems.push(`после TTL: POST ${after.posts.length}, ожидался не больше 1`);
        if (s2 && s1?.sid && s2 === s1.sid) problems.push(`после TTL id не сменился (${q(s2)})`);
        if (s2) ids.push({ label: "после TTL", sid: s2 });
      }
      const nw = by("new");
      if (nw?.error) problems.push(`/new: ${nw.error}`);
      const s3 = one(by("afterNew"), "реплика после /new");
      if (s3?.sid) ids.push({ label: "после /new", sid: s3.sid });
      if (s3 && s3.messages !== 1) problems.push(`после /new: в теле ${s3.messages} сообщений, ожидалось 1`);
      const s4 = one(by("newCore"), "новое ядро с той же солью");
      if (s4?.sid) ids.push({ label: "новое ядро", sid: s4.sid });

      for (const x of ids) if (!ID.test(x.sid)) problems.push(`id «${x.label}» ${q(x.sid)} не в формате /^tg_[A-Za-z0-9_-]{12}$/`);
      const pseudos = [...new Set([o.pseudo.mod, o.pseudo.formula].filter((x): x is string => !!x))];
      for (const x of ids) for (const p of pseudos) if (x.sid.includes(p)) problems.push(`id «${x.label}» ${q(x.sid)} содержит pseudonymOf(${TG21_CHAT}, salt) = ${p}`);
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i].sid.replace(/^tg_/, ""), b = ids[j].sid.replace(/^tg_/, "");
          if (a === b) problems.push(`«${ids[i].label}» и «${ids[j].label}»: один и тот же id ${q(ids[i].sid)}`);
          else { const n = lcsLen(a, b); if (n >= 4) problems.push(`«${ids[i].label}» ${ids[i].sid} и «${ids[j].label}» ${ids[j].sid}: общая подстрока длиной ${n} (≥ 4) кроме tg_`); }
        }
      if (ids.length < 4 && !problems.length) problems.push(`получено ${ids.length} id из 4 ожидаемых`);
      const summary = `${notes.join("; ")}; история бота живёт ${life / 60_000} мин (SESSION_TTL_MS ${o.ttl / 60_000} − запас ${o.margin / 60_000}); id одного chat_id ${TG21_CHAT}: ${ids.map((x) => `${x.label} ${x.sid}`).join(", ")}; pseudonymOf = ${pseudos[0] ?? "—"}${pseudos[1] && pseudos[1] !== pseudos[0] ? ` (формула §4.4: ${pseudos[1]})` : ""}`;
      return expect(problems.length === 0, `${problems.length ? `${list(problems, 6, " || ")} || ` : ""}${summary}${scenarioNotes(t.r)}`);
    },
  };

  /* ───── TG.G4 ───── */
  const G4: Check = {
    id: "TG.G4", wp: "TG", kind: "unit", guard: true,
    title: "Компаратор паритета чувствителен: 12 мутантов пары (заголовки, тело) на реальных фикстурах дают «не равно» по месту мутации; тождественная и «бот-образная» копии — «равно»",
    run(): Verdict {
      const problems: string[] = [];
      const fixtures: DialogFixture[] = DIALOG_IDS.map((id) => loadDialog(id));
      // тождественные копии всех 15 тел и «бот-образные» копии (допуски N) — «равно»
      let same = 0, botLike = 0;
      for (const d of fixtures)
        d.requests.forEach((r, k) => {
          const id = comparePair({ headers: r.headers, body: r.body }, { headers: clone(r.headers), body: clone(r.body) });
          if (id.equal) same++; else problems.push(`${d.id} тело ${k + 1}: тождественная копия дала «не равно»: ${id.diff}`);
          const bl = comparePair({ headers: r.headers, body: r.body }, asWire(botify(r)));
          if (bl.equal) botLike++; else problems.push(`${d.id} тело ${k + 1}: «бот-образная» копия (другие id, toolCallId, built_at, snapshot_dir, порядок ключей, x-so-channel/x-so-bot-key) дала «не равно» — N строже §4.5: ${bl.diff}`);
          // сырой JSON-текст тела (как шлёт бот) — то же
          const raw = comparePair({ headers: r.headers, body: r.body }, { headers: botify(r).headers, body: JSON.stringify(botify(r).body) });
          if (!raw.equal) problems.push(`${d.id} тело ${k + 1}: «бот-образная» копия сырым JSON дала «не равно»: ${raw.diff}`);
        });
      const caught: string[] = [];
      for (const m of G4_MUTANTS) {
        const orig = req(m.dialog, m.k);
        const before = canonical(orig);
        const mut = botify(orig);
        m.mutate(mut);
        if (canonical(orig) !== before) throw new Error(`дефект харнеса (TG.G4): мутант ${m.n} изменил исходную фикстуру`);
        const r = comparePair({ headers: orig.headers, body: orig.body }, asWire(mut));
        if (r.equal) problems.push(`мутант (${m.n}) «${m.title}» (${m.dialog}, тело ${m.k + 1}) дал «равно»`);
        else if (!m.where.test(r.diff ?? "")) problems.push(`мутант (${m.n}) «${m.title}»: «не равно», но первое расхождение не по месту мутации (ожидалось ${m.where}): ${r.diff}`);
        else caught.push(`(${m.n}) ${r.diff!.split(":")[0]}`);
      }
      const summary = `тождественная копия «равно» ${same}/15, «бот-образная» копия «равно» ${botLike}/15; мутантов «не равно» по месту мутации ${caught.length}/${G4_MUTANTS.length}: ${caught.join("; ")}`;
      return problems.length ? fail(`${list(problems, 6, " || ")} || ${summary}`) : pass(summary);
    },
  };

  return [TG4, TG5, TG9, TG20, TG21, G4];
}

export const checks: Check[] = makeParityChecks();
