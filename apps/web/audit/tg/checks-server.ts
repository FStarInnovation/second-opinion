/**
 * WP-TG, группа «server» (docs/PLAN_telegram_bot_2026-10-14.md §4.2, §4.3, §4.4, §6, §7): TG.3, TG.11, TG.12, TG.13, TG.14, TG.23
 * (RED до правки — утверждают желаемое) и guard TG.G1, TG.G2, TG.G6 (GREEN уже на d16c809).
 *
 * Всё, что трогает сервер, идёт в дочерних процессах сценариев (scenarios.ts → scen-server.ts), окружение — строго §6 «Как
 * устроен»: SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0, ключи LLM/Jev сняты, временный SO_USAGE_DIR на каждый процесс, SO_USAGE_LOG=1,
 * SO_BOT_KEY = TG_TEST.botKey, SO_DAILY_BUDGET_USD=2, SO_MESSAGE_LIMIT снят; внешний fetch бросает. Отдельные процессы: limits
 * (SO_MESSAGE_LIMIT=2, свой каталог с budget.json — TG.12 и TG.G1) и health-version (свой SO_APP_DIR — TG.23).
 * Сценарий упал исключением → RED с текстом ошибки; таймаут сценария (60 с) или «цикл событий опустел, промис не разрешился»
 * → RED; дефект харнеса (процесс не стартовал, нет строки результата) → ERROR. Юнит-части TG.23 (heartbeat, loadConfig,
 * makeLogger) выполняют код бота в процессе харнеса под guardRun (tg/guard.ts) и с подменой process.exit.
 *
 * Модулей WP-TG ещё нет (`@so/present/*`, `apps/bot/src/*`, `lib/channel.ts`): грузятся только `tryImport` по вычисляемому пути,
 * нет модуля → RED с detail «нет модуля …; ожидаемо до шага N». Статические части читают исходники без комментариев.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Check, type Verdict, expect, fail, readSrc } from "../lib";
import { guardRun } from "./guard";
import { brief } from "./normalize";
import { blank, blankTraps, commands, ShParseError, shFunctions, tokenize, wordLit, wordText, type Piece, type Word } from "./sh";
import { scenario, scenarioNotes, TG_TEST, type ScenarioResult } from "./scenarios";
import {
  G6_REPORTS, HEALTH_VERSION_A, HEALTH_VERSION_B, TG13_ROWS, TG14_PERM, TG14_WITH, TG14_WITHOUT, payloadOf,
  type G6Out, type HealthOut, type LimitsOut, type ParityOut, type Row13, type Tg11Out, type Tg13Out, type Tg14Out, type Verdict13,
} from "./scen-server";
import { loadBot, loadPresent } from "./types";

/* ═══════════════════════════ замороженные литералы (TG.G1, сняты с d16c809) ═══════════════════════════ */

/** route.ts:45 при SO_MESSAGE_LIMIT=2 (`В этой сессии лимит ${MESSAGE_LIMIT} сообщений исчерпан. …`) */
export const FROZEN_LIMIT_WEB_2 = "В этой сессии лимит 2 сообщений исчерпан. Обновите страницу, чтобы начать новую проверку.";
/** budget.ts:63-65 BUDGET_EXHAUSTED_TEXT на 14.10 */
export const FROZEN_BUDGET_WEB =
  "Дневной лимит тестового стенда на ответы ассистента исчерпан — он обновится в полночь по Москве. " +
  "Проверка бумаги без ассистента работает: откройте главную страницу и введите ISIN или название.";

/* ═══════════════════════════ мелочи ═══════════════════════════ */

const q = (s: string | null | undefined, max = 140) => (s == null ? "—" : brief(s, max));
const uniq = <T>(xs: T[]) => [...new Set(xs)];
/** Таймаут сценариев server:* (сейчас они идут 0,5–1,1 с; мемоизация — один таймаут на сценарий, а не на каждую проверку) */
const SERVER_TIMEOUT_MS = 60_000;
/**
 * Сценарий упал исключением или завис (таймаут процесса; цикл событий опустел, а промис сценария не разрешился) → готовый RED;
 * «дефект харнеса» внутри сценария (окружение не дошло, нет golden-кейса) и прочие сбои запуска → ERROR
 */
function run<T>(name: string, env?: Record<string, string | undefined>): { ok: true; r: ScenarioResult<T> & { ok: true } } | { ok: false; v: Verdict } {
  let r: ScenarioResult<T>;
  try {
    r = scenario<T>(name, { ...(env ? { env } : {}), timeoutMs: SERVER_TIMEOUT_MS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ETIMEDOUT|timed out|SIGTERM/.test(msg))
      return { ok: false, v: fail(`сценарий ${name} не завершился за ${SERVER_TIMEOUT_MS / 1000} с — маршрут завис (route.POST / channelOf / health не разрешились?): ${msg.slice(0, 300)}`) };
    throw e; // прочие дефекты харнеса — по-прежнему ERROR
  }
  if (!r.ok && r.error.includes("дефект харнеса")) throw new Error(`сценарий ${name}: ${r.error}`);
  if (!r.ok) return { ok: false, v: fail(`сценарий ${name} упал: ${r.error}${r.stderr ? ` | stderr: ${r.stderr.slice(0, 300)}` : ""}${scenarioNotes(r)}`) };
  return { ok: true, r };
}
const LIMITS_ENV = { SO_MESSAGE_LIMIT: "2" } as const;

/**
 * Исходник TS без комментариев (// и /* *\/ заменяются пробелами, строки и шаблоны не трогаются; номера строк сохраняются).
 * Не распознаёт regex-литералы с кавычками внутри — в проверяемых файлах (gate.ts, check/page.tsx) это не мешает.
 */
export function stripTs(src: string): string {
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
/** Сбалансированный аргумент вызова: src[open] === "(" → текст до парной ")" */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}
/** Shell без строк-комментариев (`# …` в начале строки); номера строк сохраняются */
const stripSh = (src: string) => src.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l)).join("\n");

/* ═══════════════════════════ TG.3 ═══════════════════════════ */

const TG3: Check = {
  id: "TG.3", wp: "TG", kind: "fixture",
  title: "И2: 7 диалогов браузера дважды через route.POST — как веб и как бот (id tg_…, x-so-channel: telegram, верный ключ): ответы равны после N; в usage.jsonl у gate/answer channel «web» и «telegram»",
  run(): Verdict {
    const s = run<ParityOut>("server:parity");
    if (!s.ok) return s.v;
    const o = s.r.out;
    const problems: string[] = [];
    const bad = [...o.web.map((x) => ({ ...x, side: "веб" })), ...o.bot.map((x) => ({ ...x, side: "бот" }))]
      .filter((x) => x.status !== 200 || x.error || x.errors.length);
    if (bad.length) problems.push(`не 200 или ошибка сборки (${bad.length}): ${bad.slice(0, 4).map((x) => `${x.side} ${x.dialog}#${x.k + 1} HTTP ${x.status}${x.error ? ` ${x.error}` : ""}${x.errors.length ? ` ${x.errors[0]}` : ""}`).join("; ")}`);
    const neq = o.bot.filter((b) => b.vsWeb !== null);
    if (neq.length) problems.push(`ответ бота ≠ ответу веба после N (${neq.length}/${o.bot.length}): ${neq.slice(0, 3).map((b) => `${b.dialog}#${b.k + 1}: ${b.vsWeb}`).join(" | ")}`);
    // журнал: у каждой сессии по записи gate и answer на запрос, channel — по прогону
    const logIssues: string[] = [];
    const sessions = [
      ...uniq(o.web.map((w) => w.sid)).map((sid) => ({ sid, want: "web", n: o.web.filter((w) => w.sid === sid).length })),
      ...uniq(o.bot.map((b) => b.sid)).map((sid) => ({ sid, want: "telegram", n: o.bot.filter((b) => b.sid === sid).length })),
    ];
    let noField = 0, total = 0;
    for (const x of sessions) {
      for (const step of ["gate", "answer"]) {
        const recs = o.usage.filter((u) => u.chat === x.sid && u.step === step);
        total += recs.length;
        noField += recs.filter((u) => !u.hasChannel).length;
        if (recs.length !== x.n) logIssues.push(`${x.sid}: записей ${step} ${recs.length}, ожидалось ${x.n}`);
        const wrong = recs.filter((u) => u.hasChannel && u.channel !== x.want);
        if (wrong.length) logIssues.push(`${x.sid} ${step}: channel ${uniq(wrong.map((u) => JSON.stringify(u.channel))).join("/")} вместо «${x.want}»`);
      }
    }
    const webRecs = o.usage.filter((u) => o.web.some((w) => w.sid === u.chat)).length;
    const botRecs = o.usage.filter((u) => o.bot.some((b) => b.sid === u.chat)).length;
    if (noField) logIssues.unshift(`поля channel в журнале нет: ${noField} из ${total} записей gate/answer без channel (веб-прогон ${webRecs} записей — ожидалось channel:"web", бот-прогон ${botRecs} — ожидалось "telegram")`);
    if (logIssues.length) problems.push(`usage.jsonl: ${logIssues.slice(0, 6).join("; ")}`);
    const ok = problems.length === 0;
    const summary = `веб: ${o.web.length} тел эталона (сессии ${uniq(o.web.map((w) => w.sid)).join(", ")}); бот: те же тела с id ${uniq(o.bot.map((b) => b.sid)).join(", ")}, ` +
      `заголовки x-so-chat = id, x-so-channel: telegram, x-so-bot-key = тестовый ключ; ответов, равных после N: ${o.bot.length - neq.length}/${o.bot.length}`;
    return expect(ok, `${ok ? "" : problems.join(" || ") + " || "}${summary}${scenarioNotes(s.r)}`);
  },
};

/* ═══════════════════════════ TG.11 ═══════════════════════════ */

const TG11: Check = {
  id: "TG.11", wp: "TG", kind: "fixture",
  title: "Ключ бота: route.POST → 403 на (a) tg_x без заголовков, (b) канал без ключа, (c) неверный ключ той же длины, (d) ключ без tg_-id, (j) верный ключ и tg_-id без x-so-channel, (g)–(i) пустой SO_BOT_KEY / пустой заголовок — без счёта реплики и budget.messages; (e) всё верно и (f) браузер → 200, у браузера channel «web»; (e) снова 200 после (g)/(h)",
  run(): Verdict {
    const s = run<Tg11Out>("server:tg11");
    if (!s.ok) return s.v;
    const o = s.r.out;
    if (!o.wrongKeySameLength) throw new Error("дефект харнеса: неверный ключ (c) не той же длины или совпал с тестовым");
    const keyNote = (k: string) => (k === "unset" ? "SO_BOT_KEY снят" : k === "empty" ? "SO_BOT_KEY=\"\"" : "SO_BOT_KEY тестовый");
    const rows = o.cases.map((c) => {
      const counted = c.umAfter !== c.umBefore || c.bmAfter !== c.bmBefore;
      const issues: string[] = [];
      if (c.error) issues.push(`исключение ${c.error}`);
      if (c.status !== c.expect) issues.push(`HTTP ${c.status}, ожидалось ${c.expect}`);
      if (c.expect === 403 && counted) issues.push(`ход засчитан: userMessages ${c.umBefore}→${c.umAfter} (ожидалось 0), budget.messages ${c.bmBefore}→${c.bmAfter}`);
      else if (c.expect === 403 && c.umAfter !== 0) issues.push(`у сессии ${c.sid} userMessages=${c.umAfter} от прошлых подслучаев (ожидалось 0)`);
      if (c.id === "f") {
        const steps = ["gate", "answer"].map((st) => ({ st, l: c.logs.find((x) => x.step === st) }));
        for (const { st, l } of steps)
          if (!l) issues.push(`в usage.jsonl нет записи ${st}`);
          else if (l.channel !== "web") issues.push(`запись ${st}: channel ${l.hasChannel ? JSON.stringify(l.channel) : "— поля нет"} (ожидалось "web")`);
      }
      return { c, issues };
    });
    const badRows = rows.filter((r) => r.issues.length);
    const fmt = ({ c, issues }: (typeof rows)[number]) =>
      `(${c.id}) ${c.what} [${keyNote(c.key)}; id ${c.sid}; заголовки ${JSON.stringify(c.headers)}]: ${issues.length ? issues.join("; ") : `HTTP ${c.status} — ок`}`;
    const detail = (badRows.length ? `не по §4.3 (${badRows.length}/${rows.length}): ${badRows.map(fmt).join(" | ")} || ` : "") +
      `все подслучаи: ${rows.map((r) => `(${r.c.id}) HTTP ${r.c.status}/${r.c.expect}${r.issues.length ? " ✗" : " ✓"}`).join(", ")}; ` +
      `тело — d1, запрос 1 («ОФЗ 26238») с подменённым id; userMessages — сессии этого id, budget.messages — budget.json процесса` + scenarioNotes(s.r);
    return expect(badRows.length === 0, detail);
  },
};

/* ═══════════════════════════ TG.12 ═══════════════════════════ */

const TG12: Check = {
  id: "TG.12", wp: "TG", kind: "fixture",
  title: "Тексты отказа для Telegram: при SO_MESSAGE_LIMIT=2 третий ход бота получает limitText(\"telegram\", 2) — есть /new, нет «Обновите страницу»; бюджет исчерпан → budgetExhaustedText(\"telegram\") — нет «откройте главную страницу»",
  async run(): Promise<Verdict> {
    const s = run<LimitsOut>("server:limits", LIMITS_ENV);
    if (!s.ok) return s.v;
    const o = s.r.out;
    const copy = await loadPresent("copy", ["limitText", "budgetExhaustedText"]);
    const issues: string[] = [];
    const [b1, b2, b3] = o.bot;
    if (b1.status !== 200 || b2.status !== 200 || b1.text === b3.text) issues.push(`ходы 1–2 бота не обычные: HTTP ${b1.status}/${b2.status}, тексты ${q(b1.text, 60)} / ${q(b2.text, 60)}`);
    const lim = b3.text, bud = o.budgetBot.text;
    const limLow = lim.toLowerCase(), budLow = bud.toLowerCase();
    if (b3.status !== 200) issues.push(`3-й ход бота: HTTP ${b3.status}`);
    if (!lim.includes("/new")) issues.push(`3-й ход бота: в тексте лимита нет «/new»`);
    if (limLow.includes("обновите страницу")) issues.push(`3-й ход бота: в тексте лимита есть «Обновите страницу» — это веб-текст`);
    if (o.budgetBot.status !== 200) issues.push(`ход бота при исчерпанном бюджете: HTTP ${o.budgetBot.status}`);
    if (budLow.includes("откройте главную страницу")) issues.push(`бюджет исчерпан: в тексте бота есть «откройте главную страницу» — это веб-текст`);
    let expLim: string | null = null, expBud: string | null = null;
    if (!copy.ok) issues.push(`эталон текстов: ${copy.detail}`);
    else {
      try { expLim = copy.mod.limitText("telegram", 2); expBud = copy.mod.budgetExhaustedText("telegram"); }
      catch (e) { issues.push(`copy.limitText/budgetExhaustedText бросили: ${String(e).slice(0, 160)}`); }
      if (expLim != null && lim !== expLim) issues.push(`3-й ход бота ≠ limitText("telegram", 2) = ${q(expLim)}`);
      if (expBud != null && bud !== expBud) issues.push(`бюджет: текст бота ≠ budgetExhaustedText("telegram") = ${q(expBud)}`);
    }
    const isWeb = lim === FROZEN_LIMIT_WEB_2 || bud === FROZEN_BUDGET_WEB;
    const detail = `${isWeb ? `сервер отдаёт боту веб-тексты (route.ts:45, budget.ts:63-65 — каналу «telegram» свой текст не выбран) || ` : ""}` +
      `${issues.length ? issues.join("; ") + " || " : ""}` +
      `бот (id tg_limits-bot-1, x-so-channel: telegram, верный ключ), SO_MESSAGE_LIMIT=${o.messageLimit}: ход 3 → HTTP ${b3.status} ${q(lim, 200)}; ` +
      `бюджет исчерпан (budget.json spent=${o.budgetSpent} ≥ ${o.dailyBudget}$ за сегодня МСК), новая сессия tg_limits-bot-2 → HTTP ${o.budgetBot.status} ${q(bud, 220)}; тело — ${o.body}` + scenarioNotes(s.r);
    return expect(issues.length === 0, detail);
  },
};

/* ═══════════════════════════ TG.13 ═══════════════════════════ */

type Consumer = "get" | "post" | "chat" | "check" | "initialOf" | "decode";
const CONSUMERS: { key: Consumer; label: string }[] = [
  { key: "get", label: "/api/report GET" }, { key: "post", label: "/api/report POST" }, { key: "chat", label: "body.inputs /api/chat" },
  { key: "check", label: "/check (CheckPage)" }, { key: "initialOf", label: "initialOf" }, { key: "decode", label: "decodeStartPayload → initialOf" },
];
/** check/page.tsx: свой num() без схемы (§4.2: «поле за полем, невалидное игнорируется, как в initialOf») */
function checkPageStatic(): { ok: boolean; detail: string } {
  const rel = "apps/web/app/check/page.tsx";
  const src = stripTs(readSrc(rel));
  const numDef = src.match(/\b(?:const|let|var|function)\s+num\b/);
  const schema = src.match(/\b(ReportInputsSchema|inputsSchema|initialOf)\b/);
  const numLine = numDef ? `свой num() (стр. ${lineAt(src, numDef.index ?? 0)})` : "своего num() нет";
  if (schema) return { ok: true, detail: `${rel}: ${numLine}, схема есть (${schema[1]}, стр. ${lineAt(src, schema.index ?? 0)})` };
  return { ok: false, detail: `${rel}: ${numLine}, ни ReportInputsSchema, ни inputsSchema, ни initialOf — числа идут в buildCached без схемы` };
}

const TG13: Check = {
  id: "TG.13", wp: "TG", kind: "fixture",
  title: "И4: @so/engine/contract экспортирует ReportInputsSchema, tools.inputsSchema — тот же объект; NaN, pos 999, k 3,5, promised 101, price 0 / 0,5 / 301 одинаково отклоняются, а валидные (с границами) принимаются в /api/report GET и POST, body.inputs /api/chat, /check, initialOf, decodeStartPayload; в check/page.tsx нет своего num() без схемы",
  run(): Verdict {
    const s = run<Tg13Out>("server:tg13");
    if (!s.ok) return s.v;
    const o = s.r.out;
    const parts: string[] = [];
    let ok = true;
    // 1. схема в contract и тождество с tools.inputsSchema
    if (!o.contract.ok) { ok = false; parts.push(`схемы в contract нет: ${o.contract.detail}`); }
    else parts.push("contract.ReportInputsSchema есть");
    if (o.toolsSame !== true) {
      ok = false;
      parts.push(o.toolsSame === null ? "tools.inputsSchema — не с чем сравнить" : `tools.inputsSchema ${o.toolsHasInputsSchema ? "— другой объект, не contract.ReportInputsSchema" : "не экспортирован"}`);
    } else parts.push("tools.inputsSchema === ReportInputsSchema");
    // 2. таблица
    const want = (r: (typeof TG13_ROWS)[number]): Verdict13["verdict"] => (r.valid ? "accepted" : "rejected");
    const schemaBad = o.rows.filter((x) => x.schema !== null && x.schema !== TG13_ROWS[x.row].valid);
    if (schemaBad.length) { ok = false; parts.push(`таблица расходится со схемой: ${schemaBad.map((x) => `${TG13_ROWS[x.row].label} → схема ${x.schema ? "принимает" : "отклоняет"}`).join(", ")}`); }
    for (const c of CONSUMERS) {
      if ((c.key === "initialOf" || c.key === "decode") && !o.entry.ok) continue;
      const rows = o.rows.map((x) => ({ x, v: x[c.key as keyof Row13] as Verdict13 | null }));
      const mism = rows.filter(({ x, v }) => !v || v.verdict !== want(TG13_ROWS[x.row]));
      if (!mism.length) { parts.push(`${c.label}: ${rows.length}/${rows.length} по схеме`); continue; }
      ok = false;
      parts.push(`${c.label}: ${mism.length}/${rows.length} не по схеме — ` + mism.map(({ x, v }) => {
        const r = TG13_ROWS[x.row];
        const w = r.valid ? "должно приниматься" : "должно отклоняться";
        return `${r.label}${c.key === "decode" ? ` («${payloadOf(r)}»)` : ""} ${w}: ${v ? v.note : "нет результата"}`;
      }).join("; "));
    }
    if (!o.entry.ok) { ok = false; parts.push(`initialOf и decodeStartPayload: ${o.entry.detail}`); }
    // 3. статика check/page.tsx
    const st = checkPageStatic();
    if (!st.ok) ok = false;
    parts.push(st.detail);
    const legend = `принято: /api/report — HTTP 200 report с report.inputs[поле] = значению; /api/chat — session.pendingInputs[поле] = значению; /check — report.inputs[поле] = значению; ` +
      `initialOf/decode — inputs[поле] = значению. Отклонено: /api/report — {kind:"err"} HTTP 4xx (§4.2, R.7-web); /api/chat — HTTP 200, поля в pendingInputs нет; /check — поле по умолчанию; ` +
      `initialOf — поля нет; decode — null или поля нет. NaN в JSON — строкой "NaN"; цена — на бумаге без биржевой цены RU000A105M67, остальное — RU000A10ASE2`;
    return expect(ok, `${parts.join(" || ")} || ${legend}${scenarioNotes(s.r)}`);
  },
};

/* ═══════════════════════════ TG.14 ═══════════════════════════ */

function gateStatic(): { sortOk: boolean; top3Ok: boolean; detail: string } {
  const rel = "apps/web/lib/gate.ts";
  const src = stripTs(readSrc(rel));
  const sorts: string[] = [];
  for (const m of src.matchAll(/\.\s*(sort|toSorted)\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const args = callArgs(src, open);
    if (/\bpoints\b/.test(args)) sorts.push(`стр. ${lineAt(src, m.index ?? 0)}: .${m[1]}(${args.replace(/\s+/g, " ").trim().slice(0, 60)})`);
  }
  const top3 = src.match(/\btruth_score\s*\??\.\s*top3\b/);
  return {
    sortOk: sorts.length === 0, top3Ok: !!top3,
    detail: `(а) ${rel}: ${sorts.length ? `флаги сортируются по points сами — ${sorts.join("; ")}` : "сортировки по points нет"}; ` +
      `${top3 ? `обращение к truth_score.top3 есть (стр. ${lineAt(src, top3.index ?? 0)})` : "обращения к truth_score.top3 нет"}`,
  };
}
const flagsPhrase = (titles: string[]) => `Главные red flags: ${titles.map((t) => t.toLowerCase()).join(", ")}.`;

const TG14: Check = {
  id: "TG.14", wp: "TG", kind: "fixture",
  title: "«Главные red flags» гейта = truth_score.top3: (а) в gate.ts нет своей сортировки флагов по points и есть truth_score.top3; (б) на 10 golden фраза ≡ названиям top3 по порядку, у 3 ранних return её нет; (в) экспортируемая reportText/topFlagsText на veb с top3 [5,12,4] даёт их в этом порядке",
  run(): Verdict {
    const st = gateStatic();
    const s = run<Tg14Out>("server:tg14");
    if (!s.ok) return s.v;
    const o = s.r.out;
    // (б)
    const bIssues: string[] = [];
    for (const c of o.cases) {
      const withList = (TG14_WITH as readonly string[]).includes(c.name);
      if (c.error || !c.handled || c.kind !== "report") { bIssues.push(`${c.name} («${c.query}»): гейт ${c.error ? `бросил ${c.error}` : `handled=${c.handled}, result=${c.kind}`}`); continue; }
      if (withList) {
        const want = flagsPhrase(c.top3Titles);
        if (!c.top3.length) bIssues.push(`${c.name}: top3 пуст — кейс не годится для (б)`);
        else if (!c.text.toLowerCase().includes(want.toLowerCase())) bIssues.push(`${c.name}: ожидалась фраза ${q(want)} (top3 ${JSON.stringify(c.top3)}), текст гейта ${q(c.text.slice(c.text.indexOf("Главные") >= 0 ? c.text.indexOf("Главные") : 0), 160)}`);
      } else if (c.text.includes("Главные red flags")) bIssues.push(`${c.name} (${c.status}): фразы «Главные red flags» быть не должно (ранний return), текст ${q(c.text)}`);
    }
    const drift = o.cases.filter((c) => JSON.stringify(c.top3) !== JSON.stringify(c.goldenTop3));
    const bOk = bIssues.length === 0;
    const bDetail = `(б) ${bOk ? `${TG14_WITH.length}/${TG14_WITH.length} golden: фраза = top3; ${TG14_WITHOUT.length}/${TG14_WITHOUT.length} ранних return без фразы` : `не так: ${bIssues.join(" | ")}`}` +
      `${drift.length ? `; top3 отчёта гейта ≠ golden у ${drift.map((c) => `${c.name} ${JSON.stringify(c.top3)}≠${JSON.stringify(c.goldenTop3)}`).join(", ")}` : ""} (вводы кейса — как вводы /check)`;
    // (в)
    let cOk = false, cDetail: string;
    if (!o.unit) cDetail = `(в) в gate.ts нет экспортируемой функции текста отчёта (reportText или topFlagsText) — экспорты: ${o.exportsFound.join(", ") || "—"}`;
    else {
      const want = `: ${o.unit.titles.map((t) => t.toLowerCase()).join(", ")}.`;
      if (JSON.stringify(o.unit.natural) === JSON.stringify(TG14_PERM)) throw new Error(`дефект харнеса: у golden veb top3 уже ${JSON.stringify(TG14_PERM)} — перестановка ничего не различает`);
      cOk = !o.unit.error && o.unit.out != null && o.unit.out.toLowerCase().includes(want.toLowerCase());
      cDetail = `(в) ${o.unit.fn}(veb с top3 ${JSON.stringify(TG14_PERM)}, естественный ${JSON.stringify(o.unit.natural)}): ` +
        `${o.unit.error ? `бросила ${o.unit.error}` : q(o.unit.out, 260)}; ожидалось «…${want}»${cOk ? " — есть" : " — НЕТ"}`;
    }
    const ok = st.sortOk && st.top3Ok && bOk && cOk;
    return expect(ok, `${st.detail} || ${bDetail} || ${cDetail}${scenarioNotes(s.r)}`);
  },
};

/* ═══════════════════════════ TG.23 ═══════════════════════════ */

const SETUP = "deploy/heidi/setup.sh";
const DEPLOY = "deploy/heidi/deploy.sh";

function setupStatic(): { ok: boolean; detail: string } {
  const src = stripSh(readSrc(SETUP));
  const issues: string[] = [];
  const m = src.match(/tee\s+\/etc\/systemd\/system\/second-opinion-bot\.service[^\n]*<<-?\s*(['"]?)(\w+)\1[^\n]*\n/);
  if (!m) return { ok: false, detail: `${SETUP}: нет юнита second-opinion-bot (tee /etc/systemd/system/second-opinion-bot.service <<…)` };
  if (m[1]) issues.push(`heredoc юнита в кавычках (<<${m[1]}${m[2]}${m[1]}) — $APP_USER/$APP_DIR не подставятся; нужен unquoted, как у юнита веба`);
  const start = (m.index ?? 0) + m[0].length;
  const endRe = new RegExp(`^\\s*${m[2]}\\s*$`, "m");
  const rest = src.slice(start);
  const e = rest.search(endRe);
  const body = e < 0 ? rest : rest.slice(0, e);
  const has = (re: RegExp) => re.test(body);
  if (!has(/^\s*User=\$\{?APP_USER\}?\s*$/m)) issues.push("нет User=$APP_USER");
  if (!has(/\$\{?APP_DIR\}?\/apps\/bot/)) issues.push("нет путей $APP_DIR/apps/bot");
  for (const [k, re] of [["NoNewPrivileges=yes", /^\s*NoNewPrivileges=yes\s*$/m], ["PrivateTmp=yes", /^\s*PrivateTmp=yes\s*$/m], ["ProtectSystem=strict", /^\s*ProtectSystem=strict\s*$/m], ["MemoryMax=", /^\s*MemoryMax=\S+/m]] as const)
    if (!has(re)) issues.push(`нет ${k}`);
  const cond = body.match(/^\s*ConditionPathExists=(\S+)\s*$/m);
  if (!cond || cond[1].startsWith("!") || !/apps\/bot\/package\.json$/.test(cond[1])) issues.push(`ConditionPathExists=…/apps/bot/package.json ${cond ? `не тот: ${cond[1]}` : "нет"}`);
  const rw = body.match(/^\s*ReadWritePaths=(\S+)\s*$/m);
  if (!rw) issues.push("нет ReadWritePaths=");
  else if (rw[1].startsWith("-")) issues.push(`ReadWritePaths=${rw[1]} с префиксом «-» (скрыл бы ошибку, §7)`);
  else if (!/apps\/bot\/\.state\/?$/.test(rw[1])) issues.push(`ReadWritePaths=${rw[1]} — не apps/bot/.state`);
  if (!has(/^\s*Wants=\S/m)) issues.push("нет Wants=");
  if (has(/^\s*Requires=/m)) issues.push("есть Requires= (рестарт веба убьёт бота, §7)");
  const sudo = src.split("\n").filter((l) => l.includes("NOPASSWD")).join("\n");
  const verbs = ["restart", "start", "stop", "status"].filter((v) => !new RegExp(`systemctl ${v} second-opinion-bot(?![\\w-])`).test(sudo));
  if (verbs.length) issues.push(`в строке sudoers нет ${verbs.map((v) => `systemctl ${v} second-opinion-bot`).join(", ")}`);
  if (!/(mkdir|install\s+-d)[^\n]*apps\/bot\/\.state/.test(src)) issues.push("не создаётся каталог apps/bot/.state (mkdir/install -d)");
  return { ok: issues.length === 0, detail: `${SETUP}: ${issues.length ? issues.join("; ") : "юнит second-opinion-bot (unquoted heredoc, харденинг, ConditionPathExists, ReadWritePaths без «-», Wants без Requires), sudoers и apps/bot/.state — ок"}` };
}

/* ── deploy.sh: порядок шагов по выполнению, а не по тексту ── */

/**
 * Ключ шага в порядке выполнения. path — смещения по цепочке вызовов: [позиция в основном потоке (сам шаг или вызов внешней
 * функции), позиция вызова следующей функции в теле внешней, …, позиция шага в теле самой внутренней функции]. Сравнение
 * лексикографическое: два шага в одной функции на любой глубине различаются последним смещением.
 * via — цепочка функций (пусто — шаг в основном потоке); line — строка самого шага; callLine — строка вызова из основного потока.
 */
interface StepKey { path: number[]; via: string[]; line: number; callLine: number }
const keyCmp = (a: StepKey, b: StepKey) => {
  for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
  return a.path.length - b.path.length;
};
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const where = (k: StepKey) => (k.via.length ? `стр. ${k.line}, через ${k.via.join(" → ")}, вызов стр. ${k.callLine}` : `стр. ${k.line}`);
const stepAt = (name: string, k: StepKey) => (k.via.length ? `${name} (${where(k)})` : `${name} ${where(k)}`);

/**
 * Модель потока deploy.sh: основной поток = текст без определений функций и без команд trap (заменены пробелами, смещения и
 * номера строк сохраняются). Шаг внутри функции f выполняется там, где f вызвана из основного потока (до 3 уровней вызовов
 * функция → функция, ключ — полный путь смещений, см. StepKey); шаг в trap и в невызванной функции в порядок не входит.
 */
function deployFlow(src: string) {
  const { text: noTraps, traps } = blankTraps(src);
  const fns = shFunctions(noTraps);
  let main = noTraps;
  for (const f of fns) main = blank(main, f.start, f.end);
  /** Вызовы функции name как команды (после начала строки, ; & | ( ! { ` $( или then/do/else/elif/if/while/until) */
  const callsIn = (text: string, name: string): number[] => {
    const re = new RegExp(`(?:^|[;&|(!{\`]|\\$\\(|\\b(?:then|do|else|elif|if|while|until)[ \\t])[ \\t]*(${escRe(name)})(?=[ \\t;&|)<>]|$)`, "gm");
    return [...text.matchAll(re)].map((m) => (m.index ?? 0) + m[0].length - m[1].length);
  };
  /** Места выполнения тела функции name: путь смещений до вызова name включительно и цепочка функций */
  const sites = (name: string, depth = 0): { path: number[]; via: string[] }[] => {
    if (depth > 3) return [];
    const out = callsIn(main, name).map((idx) => ({ path: [idx], via: [name] }));
    for (const h of fns) if (h.name !== name)
      for (const o of callsIn(h.body, name)) for (const s of sites(h.name, depth + 1)) out.push({ path: [...s.path, o], via: [...s.via, name] });
    return out;
  };
  /** Все выполнения текста в позиции pos исходника (по порядку выполнения); пусто — trap или невызванная функция */
  const keysAt = (pos: number): StepKey[] => {
    if (traps.some((t) => pos >= t.start && pos < t.end)) return [];
    const f = fns.find((h) => pos >= h.bodyStart && pos < h.end);
    if (!f) return [{ path: [pos], via: [], line: lineAt(src, pos), callLine: lineAt(src, pos) }];
    return sites(f.name).map((s) => ({ path: [...s.path, pos - f.bodyStart], via: s.via, line: lineAt(src, pos), callLine: lineAt(src, s.path[0]) })).sort(keyCmp);
  };
  /** Все места выполнения шага re по порядку выполнения */
  const keysOf = (re: RegExp): StepKey[] => {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const out: StepKey[] = [...main.matchAll(g)].map((m) => ({ path: [m.index ?? 0], via: [] as string[], line: lineAt(src, m.index ?? 0), callLine: lineAt(src, m.index ?? 0) }));
    for (const f of fns) for (const m of f.body.matchAll(g)) {
      const line = lineAt(src, f.bodyStart + (m.index ?? 0));
      for (const s of sites(f.name)) out.push({ path: [...s.path, m.index ?? 0], via: s.via, line, callLine: lineAt(src, s.path[0]) });
    }
    return out.sort(keyCmp);
  };
  return { main, fns, traps, keysOf, keysAt };
}

/* ── deploy.sh: шаблон «getMe ok» ── */

/** Режим grep: -F — подстрока, -E — расширенный regexp (egrep, -E, -P, rg), BRE — базовый (grep без флагов) */
export interface DeployPattern {
  /** слово-шаблон: куски (литералы и подстановки) */
  pieces: Piece[];
  /** исходный текст слова (для detail) */
  word: string;
  cmd: string; flags: string[]; mode: "-F" | "-E" | "BRE"; i: boolean; x: boolean; w: boolean;
  /** инверсия: -v (grep, rg), -L (только grep), --invert-match, --files-without-match — успех означает, что строки НЕТ */
  inv: boolean;
  line: number; via: string | null;
  /** смещение слова-шаблона во внешнем тексте deploy.sh (для grep внутри $(…) / bash -c "…" — смещение внешнего слова) */
  start: number;
}

/** Флаги grep/egrep/fgrep/rg → режим сравнения (поздний флаг режима перекрывает ранний, как у grep) и инверсия */
function grepMode(cmd: string, flags: string[]): Pick<DeployPattern, "mode" | "i" | "x" | "w" | "inv"> {
  const base = cmd.split("/").pop() ?? cmd;
  let mode: DeployPattern["mode"] = base === "fgrep" ? "-F" : base === "egrep" || base === "rg" ? "-E" : "BRE";
  let i = false, x = false, w = false, inv = false;
  for (const f of flags) {
    if (f.startsWith("--")) {
      if (f === "--fixed-strings") mode = "-F";
      else if (f === "--extended-regexp" || f === "--perl-regexp") mode = "-E";
      else if (f === "--basic-regexp") mode = "BRE";
      else if (f === "--ignore-case") i = true;
      else if (f === "--line-regexp") x = true;
      else if (f === "--word-regexp") w = true;
      else if (f === "--invert-match" || f === "--files-without-match") inv = true;
      continue;
    }
    for (const ch of f.slice(1)) {
      if (ch === "F") mode = "-F";
      else if (ch === "E" || ch === "P") mode = "-E";
      else if (ch === "G") mode = "BRE";
      else if (ch === "i") i = true;
      else if (ch === "x") x = true;
      else if (ch === "w") w = true;
      else if (ch === "v" || (ch === "L" && base !== "rg")) inv = true; // у rg -L — следовать по симлинкам
      else if (ch === "s" && base === "rg") i = false;
    }
  }
  return { mode, i, x, w, inv };
}

const GREP_CMDS = new Set(["grep", "egrep", "fgrep", "rg"]);
const hasGetMe = (w: Word) => wordText(w).includes("getMe ok");
/** Слово — ровно одна переменная ($NAME, ${NAME}, "$NAME") → её имя */
const singleVar = (w: Word): string | null => {
  const ps = w.pieces.filter((p) => !(p.k === "lit" && p.s === ""));
  if (ps.length !== 1 || ps[0].k !== "var") return null;
  const m = ps[0].raw.match(/^\$\{?([A-Za-z_]\w*)\}?$/);
  return m ? m[1] : null;
};

/**
 * Шаблоны «getMe ok …» в deploy.sh: слово-аргумент grep/egrep/fgrep/rg с «getMe ok» (или переменная, которой присвоено такое
 * слово) — по одному на команду. Слова с «getMe ok», которые не шаблон grep, разбираются как скрипт: $(…) и строки
 * `bash -c "…"` (до 3 уровней); у найденного там шаблона line/start — внешнего слова.
 * @returns все шаблоны в порядке текста и причина, если текст не разобран
 */
function findGetMe(src: string, depth = 0, via: string | null = null, lineOf: (i: number) => number = (i) => lineAt(src, i),
  startOf: (i: number) => number = (i) => i): { patterns: DeployPattern[]; why: string | null } {
  let toks;
  try { toks = tokenize(src); } catch (e) { return { patterns: [], why: e instanceof ShParseError ? e.message : String(e) }; }
  const cmds = commands(toks);
  // присваивания NAME=<слово с getMe ok>
  const assigned = new Map<string, { pieces: Piece[]; word: string }>();
  for (const c of cmds) for (const w of c) {
    const first = w.pieces[0];
    const m = first?.k === "lit" ? first.s.match(/^([A-Za-z_]\w*)=/) : null;
    if (m && hasGetMe(w)) assigned.set(m[1], { pieces: [{ k: "lit", s: (first as { s: string }).s.slice(m[0].length) }, ...w.pieces.slice(1)], word: src.slice(w.start, w.end) });
  }
  const out: DeployPattern[] = [];
  const used = new Set<Word>();
  for (const c of cmds) {
    for (let g = 0; g < c.length; g++) {
      const name = wordLit(c[g]);
      if (!name || !GREP_CMDS.has(name.split("/").pop() ?? "")) continue;
      const args = c.slice(g + 1);
      const k = args.findIndex((w) => hasGetMe(w) || (singleVar(w) != null && assigned.has(singleVar(w)!)));
      if (k < 0) continue;
      const flags = args.slice(0, k).map(wordText).filter((f) => f.startsWith("-") && f !== "-" && f !== "--" && f !== "-e");
      const w = args[k];
      used.add(w);
      const v = hasGetMe(w) ? null : singleVar(w);
      const a = v ? assigned.get(v) ?? null : null;
      out.push({ pieces: a ? a.pieces : w.pieces, word: a ? `${a.word} (через $${v})` : src.slice(w.start, w.end), cmd: name, flags, ...grepMode(name, flags), line: lineOf(w.start), via, start: startOf(w.start) });
      break;
    }
  }
  // прочие слова с «getMe ok»: заглянуть в $(…) и в строки-аргументы (bash -c "…")
  if (depth < 3) for (const c of cmds) for (const w of c) {
    if (!hasGetMe(w) || used.has(w)) continue;
    let inCmd = false;
    for (const p of w.pieces) if (p.k === "cmd" && p.raw.includes("getMe ok")) {
      inCmd = true;
      const inner = p.raw.startsWith("`") ? p.raw.slice(1, -1) : p.raw.slice(2, -1);
      out.push(...findGetMe(inner, depth + 1, via ?? "$(…)", () => lineOf(w.start), () => startOf(w.start)).patterns);
    }
    const text = wordText(w);
    if (!inCmd && /\s/.test(text)) // строка с пробелами — возможно, скрипт (bash -c "…"): разобрать её текст
      out.push(...findGetMe(text, depth + 1, via ?? "строка-аргумент (bash -c …)", () => lineOf(w.start), () => startOf(w.start)).patterns);
  }
  return { patterns: out, why: null };
}

/** Шаблон с подставленной версией: литералы как есть, каждая $VAR, ${VAR}, $(…) → version */
const renderPattern = (p: DeployPattern, version: string) => p.pieces.map((x) => (x.k === "lit" ? x.s : version)).join("");
/** BRE (GNU) → RegExp JS: | + ? ( ) { } без «\» — литералы, с «\» — операторы */
function breToJs(p: string): string {
  let out = "";
  for (let j = 0; j < p.length; j++) {
    const c = p[j];
    if (c === "\\" && j + 1 < p.length) { const n = p[j + 1]; out += "|+?(){}".includes(n) ? n : `\\${n}`; j++; continue; }
    out += "|+?(){}".includes(c) ? `\\${c}` : c;
  }
  return out;
}
/** Находит ли шаблон deploy.sh строку журнала (как grep с этими флагами; версия подставлена во все переменные и $(…)) */
export function matchesDeployPattern(p: DeployPattern, line: string, version: string): { ok: boolean; note: string | null } {
  const pat = renderPattern(p, version);
  if (p.mode === "-F") {
    const l = p.i ? line.toLowerCase() : line, s = p.i ? pat.toLowerCase() : pat;
    if (p.x) return { ok: l === s, note: null };
    if (p.w) return { ok: new RegExp(`(?<!\\w)${escRe(s)}(?!\\w)`).test(l), note: null };
    return { ok: l.includes(s), note: null };
  }
  const body = p.mode === "BRE" ? breToJs(pat) : pat;
  try {
    const re = new RegExp(p.x ? `^(?:${body})$` : p.w ? `(?<!\\w)(?:${body})(?!\\w)` : body, p.i ? "i" : "");
    return { ok: re.test(line), note: null };
  } catch (e) { return { ok: false, note: `шаблон не компилируется как regexp: ${String(e).slice(0, 120)}` }; }
}
const patternShow = (p: DeployPattern, version: string) =>
  `стр. ${p.line}${p.via ? ` (${p.via})` : ""}: ${p.cmd} ${p.flags.join(" ")}${p.flags.length ? " " : ""}${q(p.word, 90)} → ${q(renderPattern(p, version), 90)}, режим ${p.mode}${p.i ? " -i" : ""}${p.x ? " -x" : ""}${p.w ? " -w" : ""}${p.inv ? ", с инверсией" : ""}`;

/** Строка журнала по формату §4.4: makeLogger({ev:"getMe ok", version:"abc1234"}) */
const LOG_OK = "getMe ok version=abc1234";
/** Неверные строки журнала (формат не по §4.4 или чужая версия): шаблон deploy.sh их находить не должен */
const LOG_WRONG = ["getMe okversion=abc1234", `{"ev":"getMe ok","version":"abc1234"}`, "getMe ok version=abc1235"];

/**
 * Годится ли шаблон getMe для §7 п. 7 («найти в журнале строку getMe ok version=<sha>», формат — §4.4): без инверсии; с версией
 * abc1234 находит «getMe ok version=abc1234», а с версией def5678 — уже нет (версия закреплена подстановкой); строк не по
 * формату §4.4 не находит. @returns причины, почему не годится (пусто — годится)
 */
function patternIssues(p: DeployPattern): string[] {
  const out: string[] = [];
  if (p.inv) out.push(`grep с инверсией (-v/-L/--invert-match/--files-without-match: ${p.flags.join(" ")}) — успех означает, что строки НЕТ, шаблон не подтверждает строку «getMe ok version=…»; нераспознанная форма`);
  const own = matchesDeployPattern(p, LOG_OK, "abc1234");
  if (!own.ok) out.push(`при версии abc1234 не находит строку формата §4.4 ${q(LOG_OK)}${own.note ? ` (${own.note})` : ""}`);
  else if (matchesDeployPattern(p, LOG_OK, "def5678").ok)
    out.push(`не закрепляет версию: при версии def5678 тоже находит ${q(LOG_OK)} (нужна подстановка версии сразу после «version=» — $SHA, \${VAR} или $(…), без .* и без вписанного sha)`);
  const wrong = LOG_WRONG.filter((l) => matchesDeployPattern(p, l, "abc1234").ok);
  if (wrong.length) out.push(`при версии abc1234 находит строки не по формату §4.4: ${wrong.map((l) => q(l)).join(", ")} — с таким шаблоном makeLogger неверного формата тоже прошёл бы`);
  return out;
}

const DEPLOY_STEPS: [string, RegExp][] = [
  ["стоп бота", /systemctl\s+stop\s+second-opinion-bot(?![\w-])/],
  ["npm ci", /\bnpm\s+ci\b/],
  ["web:build", /\bweb:build\b/],
  ["рестарт веба", /systemctl\s+restart\s+second-opinion(?![\w-])/],
  ["/api/health", /\/api\/health/],
  ["создание apps/bot/.state", /(install\s+-d|mkdir)[^\n]*apps\/bot\/\.state/],
  ["старт бота", /systemctl\s+(?:re)?start\s+second-opinion-bot(?![\w-])/],
];
const RESTART_WEB = DEPLOY_STEPS[3][1];
const START_BOT = DEPLOY_STEPS[DEPLOY_STEPS.length - 1][1];

/**
 * Запись файла VERSION: «>», «>>», «>|», tee [-a] или mv/cp в …/VERSION, в VERSION (после cd) или в переменную, которой
 * присвоен путь …/VERSION (VERSION_FILE="$APP_DIR/VERSION"; … > "$VERSION_FILE")
 */
function versionWriteRe(src: string): RegExp {
  const vars = [...src.matchAll(/(?:^|[\s;&|(])(?:(?:export|local|readonly|declare)\s+(?:-\w+\s+)?)?([A-Za-z_]\w*)=["']?[^\s"'|;&]*\/VERSION["']?(?=[\s;&|)]|$)/gm)].map((m) => m[1]);
  const target = [`(?:[^\\s"'|;&<>]*\\/)?VERSION\\b(?!_)`, ...uniq(vars).map((v) => `\\$\\{?${escRe(v)}\\}?(?!\\w)`)].join("|");
  return new RegExp(`(?:>{1,2}\\|?|\\btee(?:[ \\t]+-a)?|\\b(?:mv|cp)[ \\t]+(?:-\\w+[ \\t]+)*[^\\s-]\\S*(?=[ \\t]))[ \\t]*["']?(?:${target})`);
}

export interface DeployVerdict {
  ok: boolean; detail: string;
  /** шаблон getMe, который deploy.sh применяет (лучший из найденных: после старта бота, годный); null — не найден */
  pattern: DeployPattern | null;
  /** почему этот шаблон не годится (patternIssues); пусто — годится */
  patternBad: string[];
}

export function deployStatic(raw: string = readSrc(DEPLOY)): DeployVerdict {
  const src = stripSh(raw);
  const issues: string[] = [];
  const at: string[] = [];
  let flow: ReturnType<typeof deployFlow> | null = null;
  try { flow = deployFlow(src); } catch (e) { issues.push(`deploy.sh не разобран (функции/trap): ${e instanceof Error ? e.message : String(e)}`); }
  const verRe = versionWriteRe(src);
  let startK: StepKey | undefined;
  if (flow) {
    // первое выполнение каждого шага; порядок строго возрастающий (лишний ранний старт бота в основном потоке тоже нарушает порядок)
    let prev: StepKey | null = null, prevName = "";
    for (const [name, re] of DEPLOY_STEPS) {
      const k = flow.keysOf(re)[0];
      if (!k) { issues.push(`нет шага «${name}»${re.test(src) ? " в основном потоке (есть только в невызванной функции или trap)" : ""}`); continue; }
      at.push(stepAt(name, k));
      if (prev && keyCmp(k, prev) <= 0) issues.push(`«${stepAt(name, k)}» не после «${stepAt(prevName, prev)}»`);
      if (!prev || keyCmp(k, prev) > 0) { prev = k; prevName = name; }
    }
    startK = flow.keysOf(START_BOT)[0];
    const hb = startK ? flow.keysOf(/heartbeat/).find((k) => keyCmp(k, startK!) > 0) : undefined;
    if (!hb) issues.push("нет проверки heartbeat после старта бота");
    else at.push(stepAt("heartbeat", hb));
    for (const t of flow.traps)
      if (START_BOT.test(t.text) || flow.fns.some((f) => START_BOT.test(f.body) && new RegExp(`(?:^|[\\s'";])${escRe(f.name)}(?=[\\s'";]|$)`).test(t.text)))
        at.push(`старт бота в trap стр. ${lineAt(src, t.start)} — вне основного потока, в порядке не учитывается`);
    // VERSION: пишется в основном потоке и до рестарта веба (§4.3: health читает VERSION один раз при старте; §7 п. 2)
    const ver = flow.keysOf(verRe)[0];
    const restartK = flow.keysOf(RESTART_WEB)[0];
    if (!ver) issues.push(verRe.test(src) ? "нет записи VERSION (> $APP_DIR/VERSION) в основном потоке (есть только в невызванной функции/trap)" : "deploy.sh не пишет VERSION (> $APP_DIR/VERSION)");
    else {
      at.push(stepAt("запись VERSION", ver));
      if (restartK && keyCmp(ver, restartK) >= 0)
        issues.push(`запись VERSION (${where(ver)}) не до рестарта веба (${where(restartK)}) — §4.3, §7 п. 2: health читает VERSION один раз при старте, сверка версий бота и сервера ничего не проверит`);
    }
  } else if (!verRe.test(src)) issues.push("deploy.sh не пишет VERSION (> $APP_DIR/VERSION)");
  // шаблон getMe ok: из найденных — выполняемый после старта бота и годный (§7 п. 7), иначе лучший из оставшихся
  const found = findGetMe(src);
  let pattern: DeployPattern | null = null, patternBad: string[] = [];
  if (!found.patterns.length) {
    const ln = src.split("\n").findIndex((l) => l.includes("getMe ok"));
    issues.push(ln < 0 ? "нет поиска строки «getMe ok version=…» в журнале бота"
      : `шаблон getMe ok в deploy.sh не распознан (стр. ${ln + 1}: ${q(src.split("\n")[ln].trim(), 100)}${found.why ? `; ${found.why}` : ""}); ожидалась форма grep -q "getMe ok version=$SHA" (переменная, \${VAR} или $(…) допустимы)`);
  } else {
    const cands = found.patterns.map((p, n) => {
      const bad = patternIssues(p);
      const ks = flow ? flow.keysAt(p.start) : [];
      const after = startK ? ks.find((k) => keyCmp(k, startK!) > 0) : undefined;
      // 0 — после старта и годный; 1 — после старта, но не годный; 2 — выполняется, но не после старта; 3 — не выполняется
      const rank = !flow || after ? (bad.length ? 1 : 0) : ks.length ? 2 : 3;
      return { p, bad, k: after ?? ks[0], rank, n };
    }).sort((a, b) => a.rank - b.rank || (a.k && b.k ? keyCmp(a.k, b.k) : a.n - b.n));
    const best = cands[0];
    pattern = best.p; patternBad = best.bad;
    if (flow) {
      if (!best.k) issues.push(`поиск getMe ok есть только в невызванной функции/trap (${patternShow(best.p, "abc1234")}) — в основном потоке deploy.sh строку не ищет (§7 п. 7)`);
      else {
        at.push(stepAt("поиск getMe ok", best.k));
        if (startK && keyCmp(best.k, startK) <= 0) issues.push(`поиск getMe ok (${where(best.k)}) не после старта бота (${where(startK)}) — §7 п. 7: строку ищут в журнале после старта`);
      }
    }
    if (best.bad.length) issues.push(`шаблон getMe в deploy.sh не годится (§7 п. 7, формат строки — §4.4): ${patternShow(best.p, "abc1234")}; ${best.bad.join("; ")}`);
  }
  return {
    ok: issues.length === 0, pattern, patternBad,
    detail: `${DEPLOY}: ${issues.length ? issues.join("; ") : "порядок, VERSION и шаблон getMe ок"}${at.length ? ` (${at.join(", ")})` : ""}`,
  };
}

/* ── самопроверка разбора deploy.sh на строках в памяти (не на deploy/*): дефект разбора → ERROR, а не ложный вердикт ── */

const SELF_TAIL = `
test -f "$APP_DIR/apps/bot/.state/heartbeat"`;
/** Корректные варианты deploy.sh (разные стили): ok и шаблон находит «getMe ok version=abc1234» */
export const DEPLOY_GOOD: Record<string, string> = {
  A: `set -euo pipefail
sudo systemctl stop second-opinion-bot || true
npm ci --no-audit
npm run web:build
git rev-parse --short HEAD > "$APP_DIR/VERSION"
sudo systemctl restart second-opinion
curl -fsS http://127.0.0.1:3000/api/health
install -d -m 700 "$APP_DIR/apps/bot/.state"
sudo systemctl start second-opinion-bot
SHA=$(cat "$APP_DIR/VERSION")
for i in $(seq 1 30); do journalctl -u second-opinion-bot -n 50 --no-pager | grep -q "getMe ok version=$SHA" && break; sleep 1; done${SELF_TAIL}`,
  // функции-помощники в начале файла (порядок по вызовам), ${VAR}, -F
  B: `health() { curl -fsS http://127.0.0.1:3000/api/health; }
start_bot() {
  sudo systemctl start second-opinion-bot
  check_heartbeat
}
check_heartbeat() { test -f "$APP_DIR/apps/bot/.state/heartbeat"; }
sudo systemctl stop second-opinion-bot
npm ci
npm run web:build
VERSION=$(git rev-parse --short HEAD); echo "$VERSION" > "$APP_DIR/VERSION"
sudo systemctl restart second-opinion
health
mkdir -p "$APP_DIR/apps/bot/.state"
start_bot
journalctl -u second-opinion-bot -o cat | grep -qF "getMe ok version=\${VERSION}"`,
  // trap со стартом бота в начале (не основной поток), шаблон с $(cat "…") внутри "…" и -F
  C: `trap 'sudo systemctl start second-opinion-bot' ERR
sudo systemctl stop second-opinion-bot
npm ci
npm run web:build
git rev-parse --short HEAD >"$APP_DIR/VERSION"
sudo systemctl restart second-opinion
curl -fsS http://127.0.0.1:3000/api/health && echo
install -d "$APP_DIR/apps/bot/.state"
sudo systemctl restart second-opinion-bot
sleep 5
journalctl -u second-opinion-bot -n 20 | grep -qF "getMe ok version=$(cat "$APP_DIR/VERSION")"${SELF_TAIL}`,
  // function name { … }, -E и $(git rev-parse --short HEAD), heartbeat через функцию
  D: `function stop_bot { sudo systemctl stop second-opinion-bot || true; }
function wait_hb() {
  for i in 1 2 3; do [ -f "$APP_DIR/apps/bot/.state/heartbeat" ] && return 0; sleep 10; done; return 1
}
stop_bot
npm ci && npm run web:build
git rev-parse --short HEAD > $APP_DIR/VERSION
sudo systemctl restart second-opinion
curl -fsS http://127.0.0.1:3000/api/health
mkdir -p $APP_DIR/apps/bot/.state
sudo systemctl start second-opinion-bot
journalctl -u second-opinion-bot --since "-1min" | grep -E "getMe ok version=$(git rev-parse --short HEAD)"
wait_hb`,
  // '…' и "$SHA" встык — одно слово; продолжение строки «\»
  F: `sudo systemctl stop second-opinion-bot
npm ci
npm run web:build
SHA=$(git rev-parse --short HEAD)
printf '%s\\n' "$SHA" > "$APP_DIR/VERSION"
sudo systemctl restart second-opinion
curl -fsS http://127.0.0.1:3000/api/health
install -d "$APP_DIR/apps/bot/.state"
sudo systemctl start second-opinion-bot
journalctl -u second-opinion-bot -n 50 --no-pager \\
  | grep -q 'getMe ok version='"$SHA"${SELF_TAIL}`,
  // шаблон в переменной
  G: `sudo systemctl stop second-opinion-bot
npm ci
npm run web:build
SHA=$(git rev-parse --short HEAD); echo "$SHA" > "$APP_DIR/VERSION"
sudo systemctl restart second-opinion
curl -fsS http://127.0.0.1:3000/api/health
install -d "$APP_DIR/apps/bot/.state"
sudo systemctl start second-opinion-bot
PAT="getMe ok version=$SHA"
journalctl -u second-opinion-bot -o cat | grep -qF -- "$PAT"${SELF_TAIL}`,
  // grep внутри bash -c "…" с экранированными кавычками
  H: `sudo systemctl stop second-opinion-bot
npm ci
npm run web:build
SHA=$(git rev-parse --short HEAD); echo "$SHA" > "$APP_DIR/VERSION"
sudo systemctl restart second-opinion
curl -fsS http://127.0.0.1:3000/api/health
install -d "$APP_DIR/apps/bot/.state"
sudo systemctl start second-opinion-bot
timeout 60 bash -c "until journalctl -u second-opinion-bot -o cat | grep -q \\"getMe ok version=$SHA\\"; do sleep 2; done"${SELF_TAIL}`,
  // обёртка main() { …; }; main "$@": по два шага подряд во внутренних функциях (глубина 2), heartbeat там же после старта
  I: `stop_bot() { sudo systemctl stop second-opinion-bot || true; }
build() {
  npm ci --no-audit
  npm run web:build
}
restart_web() {
  sudo systemctl restart second-opinion
  curl -fsS http://127.0.0.1:3000/api/health
}
start_bot() {
  install -d -m 700 "$APP_DIR/apps/bot/.state"
  sudo systemctl start second-opinion-bot
  for i in $(seq 1 70); do [ "$APP_DIR/apps/bot/.state/heartbeat" -nt "$APP_DIR/VERSION" ] && break; sleep 1; done
  journalctl -u second-opinion-bot -o cat | grep -q "getMe ok version=$SHA"
}
main() {
  stop_bot
  git rev-parse --short HEAD > "$APP_DIR/VERSION"; SHA=$(cat "$APP_DIR/VERSION")
  build
  restart_web
  start_bot
}
main "$@"`,
  // §7 п. 7 «если есть apps/bot/.env и SO_TG≠0»: deploy_bot → bot_up → wait_hb (глубина 3), VERSION через переменную и tee;
  // в echo-подсказке после старта — ослабленный grep 'getMe ok' (кандидат хуже настоящего шаблона, не выбирается)
  J: `VERSION_FILE="$APP_DIR/VERSION"
wait_hb() {
  for i in $(seq 1 70); do [ "$APP_DIR/apps/bot/.state/heartbeat" -nt "$VERSION_FILE" ] && return 0; sleep 1; done
  return 1
}
bot_up() {
  install -d -m 700 "$APP_DIR/apps/bot/.state"
  sudo systemctl start second-opinion-bot
  wait_hb
  journalctl -u second-opinion-bot -o cat --no-pager | grep -qF "getMe ok version=$SHA"
}
deploy_bot() {
  if [ -f "$APP_DIR/apps/bot/.env" ] && ! grep -q '^SO_TG=0' "$APP_DIR/apps/bot/.env"; then bot_up; fi
}
sudo systemctl stop second-opinion-bot || true
SHA=$(git rev-parse --short HEAD); echo "$SHA" | tee "$VERSION_FILE" >/dev/null
npm ci
npm run web:build
sudo systemctl restart second-opinion
curl -fsS http://127.0.0.1:3000/api/health | grep -q "\\"version\\":\\"$SHA\\""
deploy_bot
echo "подсказка, не проверка: journalctl -u second-opinion-bot | grep 'getMe ok'"`,
};
/** Отрицательные варианты: { скрипт, чего ждём } */
type BadWant = "order" | "heartbeat" | "nomatch" | "unparsed" | "version" | "getme" | "unpinned";
const SWAP_STATE_I = ['  install -d -m 700 "$APP_DIR/apps/bot/.state"\n  sudo systemctl start second-opinion-bot', '  sudo systemctl start second-opinion-bot\n  install -d -m 700 "$APP_DIR/apps/bot/.state"'] as const;
const VERSION_A = 'git rev-parse --short HEAD > "$APP_DIR/VERSION"\n';
const GREP_A = `grep -q "getMe ok version=$SHA"`;
export const DEPLOY_BAD: { name: string; src: string; want: BadWant }[] = [
  { name: "E: настоящий старт бота в основном потоке до стопа", want: "order", src: DEPLOY_GOOD.A.replace("sudo systemctl stop second-opinion-bot || true", "sudo systemctl start second-opinion-bot\nsudo systemctl stop second-opinion-bot || true") },
  { name: "I: старт бота раньше install -d внутри start_bot под main()", want: "order", src: DEPLOY_GOOD.I.replace(SWAP_STATE_I[0], SWAP_STATE_I[1]) },
  { name: "J: старт бота раньше install -d внутри bot_up (deploy_bot → bot_up)", want: "order", src: DEPLOY_GOOD.J.replace(SWAP_STATE_I[0], SWAP_STATE_I[1]) },
  { name: "J: ожидание heartbeat внутри bot_up только до старта бота", want: "heartbeat", src: DEPLOY_GOOD.J.replace("  sudo systemctl start second-opinion-bot\n  wait_hb", "  wait_hb\n  sudo systemctl start second-opinion-bot") },
  { name: "BRE без флагов: «|» — литерал, не «или»", want: "nomatch", src: DEPLOY_GOOD.A.replace(GREP_A, `grep -q "getMe ok|zzz"`) },
  { name: "незакрытая $( в шаблоне", want: "unparsed", src: DEPLOY_GOOD.A.replace(GREP_A, `grep -q "getMe ok version=$(cat x"`) },
  { name: "VERSION пишется после рестарта веба", want: "version", src: DEPLOY_GOOD.A.replace(VERSION_A, "").replace("sudo systemctl restart second-opinion\n", `sudo systemctl restart second-opinion\n${VERSION_A}`) },
  { name: "VERSION пишется после старта бота (в конце)", want: "version", src: DEPLOY_GOOD.A.replace(VERSION_A, "") + `\n${VERSION_A}` },
  { name: "VERSION пишется только в невызванной функции", want: "version", src: DEPLOY_GOOD.A.replace(VERSION_A, `write_version() { ${VERSION_A.trim()}; }\n`) },
  { name: "поиск getMe до старта бота", want: "getme", src: DEPLOY_GOOD.A.replace("sudo systemctl start second-opinion-bot\n", "").replace(/(for i in .*done)/, "$1\nsudo systemctl start second-opinion-bot") },
  { name: "поиск getMe только в невызванной never(){…}", want: "getme", src: DEPLOY_GOOD.A.replace(/for i in .*done/, `never() { journalctl -u second-opinion-bot | ${GREP_A}; }`) },
  { name: "шаблон без версии: grep -q \"getMe ok\"", want: "unpinned", src: DEPLOY_GOOD.A.replace(GREP_A, `grep -q "getMe ok"`) },
  { name: "шаблон с .* вместо версии", want: "unpinned", src: DEPLOY_GOOD.A.replace(GREP_A, `grep -qE "getMe ok version=.*"`) },
  { name: "версия вписана в шаблон", want: "unpinned", src: DEPLOY_GOOD.A.replace(GREP_A, `grep -q "getMe ok version=abc1234"`) },
  { name: "grep -v (инверсия)", want: "unpinned", src: DEPLOY_GOOD.A.replace(GREP_A, `grep -qv "getMe ok version=$SHA"`) },
];
/** Чем должен объясняться RED у отрицательного варианта (в detail) */
const BAD_WHY: Record<BadWant, RegExp> = {
  order: /«старт бота[^»]*» не после|не после «старт бота/,
  heartbeat: /нет проверки heartbeat после старта бота/,
  nomatch: /не находит строку формата §4\.4/,
  unparsed: /не распознан/,
  version: /запись VERSION \([^)]*\) не до рестарта веба|нет записи VERSION[^;]*в основном потоке/,
  getme: /поиск getMe ok \([^)]*\) не после старта бота|поиск getMe ok есть только в невызванной функции/,
  unpinned: /не закрепляет версию|с инверсией/,
};

/**
 * Вердикт части makeLogger TG.23 по строкам, отданным makeLogger в sink (как grep — построчно). Шаблон deploy.sh годный →
 * его находка (буквально TG.23); шаблона ещё нет (до шага 6) → сверка с форматом §4.4 «getMe ok version=abc1234»; шаблон
 * с инверсией → сверка невозможна (✗); шаблон не годный (не закрепляет версию и т. п.) → находка шаблона И формат §4.4.
 */
export function loggerVerdict(sinkLines: string[], pattern: DeployPattern | null, patternBad: string[]): { ok: boolean; detail: string } {
  const lines = sinkLines.join("\n").split(/\r?\n/).filter((l) => l !== "");
  const head = `makeLogger({ev:"getMe ok",version:"abc1234"}) → ${lines.length === 1 ? q(lines[0]) : `${lines.length} строк${lines.length ? `: ${lines.map((l) => q(l, 80)).join(" | ")}` : ""}`}`;
  const canon = lines.length === 1 && lines[0] === LOG_OK;
  const canonNote = `формат §4.4 ${q(LOG_OK)} (одна строка): ${canon ? "совпадает" : "НЕ совпадает"}`;
  if (!pattern) return { ok: canon, detail: `${head}; шаблона в deploy.sh ещё нет (шаг 6) — сверено с ${canonNote}` };
  const hits = lines.map((l) => matchesDeployPattern(pattern, l, "abc1234"));
  const found = hits.some((h) => h.ok);
  const note = hits.find((h) => h.note)?.note;
  const how = `шаблон deploy.sh ${patternShow(pattern, "abc1234")} ${found ? "находит" : "НЕ находит"} эту строку${note ? ` (${note})` : ""}`;
  if (pattern.inv) return { ok: false, detail: `${head}; ${how}, но grep с инверсией — сверка с шаблоном deploy.sh невозможна; ${canonNote}` };
  if (patternBad.length) return { ok: found && canon, detail: `${head}; ${how}, но шаблон не годится (${patternBad.join("; ")}) — дополнительно сверено с ${canonNote}` };
  return { ok: found, detail: `${head}; ${how}` };
}

export function deploySelfCheck(): string[] {
  const bad: string[] = [];
  for (const [name, src] of Object.entries(DEPLOY_GOOD)) {
    const r = deployStatic(src);
    if (!r.ok) bad.push(`вариант ${name}: ожидался ok, получено: ${r.detail}`);
    if (!r.pattern) { bad.push(`вариант ${name}: шаблон не извлечён`); continue; }
    if (!matchesDeployPattern(r.pattern, LOG_OK, "abc1234").ok) bad.push(`вариант ${name}: шаблон ${patternShow(r.pattern, "abc1234")} не находит ${q(LOG_OK)}`);
    for (const l of LOG_WRONG) if (matchesDeployPattern(r.pattern, l, "abc1234").ok) bad.push(`вариант ${name}: шаблон находит неверную строку ${q(l)}`);
    if (!loggerVerdict([LOG_OK], r.pattern, r.patternBad).ok) bad.push(`вариант ${name}: loggerVerdict отклоняет ${q(LOG_OK)}`);
    for (const l of LOG_WRONG) if (loggerVerdict([l], r.pattern, r.patternBad).ok) bad.push(`вариант ${name}: loggerVerdict принимает ${q(l)}`);
  }
  for (const b of DEPLOY_BAD) {
    const r = deployStatic(b.src);
    if (b.src === DEPLOY_GOOD.A || b.src === DEPLOY_GOOD.I || b.src === DEPLOY_GOOD.J) { bad.push(`${b.name}: замена не сработала — вариант совпал с корректным`); continue; }
    if (r.ok) bad.push(`${b.name}: ожидался RED, получено ok (${r.detail})`);
    if (!BAD_WHY[b.want].test(r.detail)) bad.push(`${b.name}: в detail нет причины /${BAD_WHY[b.want].source}/: ${r.detail}`);
    if (b.want === "nomatch" && (!r.pattern || matchesDeployPattern(r.pattern, LOG_OK, "abc1234").ok)) bad.push(`${b.name}: шаблон ${r.pattern ? patternShow(r.pattern, "abc1234") : "—"} находит ${q(LOG_OK)}`);
    if (b.want === "unparsed" && r.pattern) bad.push(`${b.name}: ожидалось «не распознан», а шаблон извлечён: ${patternShow(r.pattern, "abc1234")}`);
    if (b.want === "unpinned" && r.pattern && loggerVerdict(["getMe ok version: abc1234"], r.pattern, r.patternBad).ok) bad.push(`${b.name}: loggerVerdict принимает «getMe ok version: abc1234» при негодном шаблоне`);
  }
  // часть makeLogger без шаблона (до шага 6): только формат §4.4
  if (!loggerVerdict([LOG_OK], null, []).ok || !loggerVerdict([LOG_OK + "\n"], null, []).ok) bad.push(`loggerVerdict без шаблона отклоняет ${q(LOG_OK)}`);
  for (const l of [...LOG_WRONG, "getMe ok version: abc1234", "getMe ok pseudo=x version=abc1234", `${LOG_OK} extra`])
    if (loggerVerdict([l], null, []).ok) bad.push(`loggerVerdict без шаблона принимает ${q(l)}`);
  if (loggerVerdict([LOG_OK, LOG_OK], null, []).ok) bad.push("loggerVerdict без шаблона принимает две строки на одну запись");
  return bad;
}

async function withProcessEnv<T>(over: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

async function configUnit(): Promise<{ ok: boolean; detail: string }> {
  const m = await loadBot("config");
  if (!m.ok) return { ok: false, detail: `loadConfig: ${m.detail}` };
  // ровно переменные apps/bot/.env из §7 (на проде других нет) + TG_API_ROOT кейса
  const base: Record<string, string | undefined> = {
    TG_BOT_TOKEN: TG_TEST.token, TG_BOT_USERNAME: TG_TEST.botHandle, SO_TG_SALT: TG_TEST.salt, SO_BOT_KEY: TG_TEST.botKey,
    SO_TG_ALLOW: "*", SO_TG_DAILY: "60", SO_TG_CONCURRENCY: "4", SO_TG: "1",
  };
  const secretTail = TG_TEST.token.split(":")[1];
  const issues: string[] = [];
  const tryLoad = (env: Record<string, string | undefined>) =>
    withProcessEnv({ NODE_ENV: env.NODE_ENV }, () => { try { return { cfg: m.mod.loadConfig(env), err: null as string | null }; } catch (e) { return { cfg: null, err: e instanceof Error ? e.message : String(e) }; } });
  const leak = (err: string, value?: string) =>
    [err.includes(TG_TEST.token) || err.includes(secretTail) ? "токен" : "", value && err.includes(value) ? "значение TG_API_ROOT" : ""].filter(Boolean).join(" и ");
  const ok1 = await tryLoad({ ...base, TG_API_ROOT: "http://127.0.0.1:8081" });
  const root = ok1.cfg?.apiRoot?.replace(/\/$/, "");
  if (ok1.err) issues.push(`TG_API_ROOT=http://127.0.0.1:8081 отклонён: «${ok1.err.slice(0, 120)}»`);
  else if (root !== "http://127.0.0.1:8081") issues.push(`TG_API_ROOT=http://127.0.0.1:8081 → apiRoot=${JSON.stringify(ok1.cfg?.apiRoot)}`);
  // без явного порта (§4.4 «явный порт») — тоже отказ
  for (const v of ["https://evil.example", "http://10.0.0.1:1", "http://user@127.0.0.1:1", "http://127.0.0.1", "http://localhost"]) {
    const r = await tryLoad({ ...base, TG_API_ROOT: v });
    if (!r.err) issues.push(`TG_API_ROOT=${v} принят (apiRoot=${JSON.stringify(r.cfg?.apiRoot)})`);
    else { const l = leak(r.err, v); if (l) issues.push(`TG_API_ROOT=${v}: в тексте ошибки ${l}`); }
  }
  const pr = await tryLoad({ ...base, NODE_ENV: "production", TG_API_ROOT: "http://127.0.0.1:8081" });
  if (!pr.err) issues.push("NODE_ENV=production и TG_API_ROOT заданы — ошибки нет");
  else { const l = leak(pr.err); if (l) issues.push(`NODE_ENV=production: в тексте ошибки ${l}`); }
  return { ok: issues.length === 0, detail: `loadConfig: ${issues.length ? issues.join("; ") : "127.0.0.1:8081 принят; evil.example, 10.0.0.1, user@ отклонены; без порта отклонён (127.0.0.1, localhost); production + TG_API_ROOT → ошибка; токена в ошибках нет"}` };
}

async function heartbeatUnit(): Promise<{ ok: boolean; detail: string }> {
  const m = await loadBot("heartbeat");
  if (!m.ok) return { ok: false, detail: `heartbeat: ${m.detail}` };
  let now = 1_760_500_000_000;
  let mt: number | null = null;
  const writes: string[] = [], exits: number[] = [];
  // настоящий временный каталог: makeHeartbeat, который пишет сам мимо внедрённого write, пишет сюда, а не в /audit
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "so-audit-tg23-hb-"));
  const file = path.join(dir, "heartbeat");
  try {
    const hb = m.mod.makeHeartbeat({ file, staleMs: 120_000, now: () => now, exit: (c) => { exits.push(c); }, write: (f) => { writes.push(f); mt = now; }, mtime: () => mt });
    hb.beat();
    now += 60_000; hb.check();
    const after60 = exits.length;
    now += 61_000; hb.check();
    const after121 = [...exits];
    const okBeat = writes.length >= 1 && writes[0] === file;
    const ok = okBeat && after60 === 0 && after121.length === 1 && after121[0] === 1;
    return { ok, detail: `heartbeat: beat() → write ${JSON.stringify(writes.map((w) => (w === file ? "<file>" : w)))} (<file> — переданный file); через 60 с check() → exit ${after60 ? "вызван" : "нет"}; через 121 с → exit(${after121.join(",") || "не вызван"}) (ожидалось exit(1))` };
  } catch (e) { return { ok: false, detail: `heartbeat: бросил ${String(e).slice(0, 160)}` }; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

async function loggerUnit(deploy: DeployVerdict): Promise<{ ok: boolean; detail: string }> {
  const m = await loadBot("log");
  if (!m.ok) return { ok: false, detail: `makeLogger: ${m.detail}` };
  const lines: string[] = [];
  try {
    const log = m.mod.makeLogger((l) => { lines.push(l); }, [TG_TEST.token, TG_TEST.botKey, TG_TEST.salt]);
    log({ ev: "getMe ok", version: "abc1234" });
  } catch (e) { return { ok: false, detail: `makeLogger: бросил ${String(e).slice(0, 160)}` }; }
  return loggerVerdict(lines, deploy.pattern, deploy.patternBad);
}

/** Юнит-часть TG.23 под guardRun: исключение, unhandledRejection, таймер, глобальный fetch, process.exit → часть не выполнена, с текстом */
async function guardedPart(id: string, exitHint: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<{ ok: boolean; detail: string }> {
  const g = await guardRun(id, () => fn(), { exitHint });
  const base = g.ok ? g.v : { ok: false, detail: `${id}: исключение ${String(g.error instanceof Error ? `${g.error.name}: ${g.error.message}` : g.error).slice(0, 200)}` };
  const bad = g.rest.filter((i) => !i.ok);
  return bad.length ? { ok: false, detail: `${base.detail}; ${bad.map((i) => `✗ ${i.name}: ${i.text}`).join("; ")}` } : base;
}

function healthPart(): { ok: boolean; detail: string; notes: string } {
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "so-audit-tg23-app-"));
  const dirA = mk(), dirDev = mk();
  try {
    fs.writeFileSync(path.join(dirA, "VERSION"), HEALTH_VERSION_A); // без "\n": буквально TG.23 (срез перевода строки в плане не записан)
    const a = run<HealthOut>("server:health-version", { SO_APP_DIR: dirA });
    const b = run<HealthOut>("server:health-version", { SO_APP_DIR: dirDev });
    if (!a.ok) return { ok: false, detail: a.v.detail, notes: "" };
    if (!b.ok) return { ok: false, detail: b.v.detail, notes: "" };
    const A = a.r.out, B = b.r.out;
    if (A.before == null || A.after !== HEALTH_VERSION_B) throw new Error(`дефект харнеса: VERSION в SO_APP_DIR не подготовлен (before=${JSON.stringify(A.before)}, after=${JSON.stringify(A.after)})`);
    const ver = (x: HealthOut) => (x.local.json && typeof x.local.json === "object" ? (x.local.json as Record<string, unknown>).version : undefined);
    const extOnlyOk = (x: HealthOut) => JSON.stringify(x.external.json) === JSON.stringify({ ok: true });
    const issues: string[] = [];
    if (A.local.error || A.local.status !== 200) issues.push(`локальный GET: ${A.local.error ?? `HTTP ${A.local.status}`}`);
    if (ver(A) !== HEALTH_VERSION_A)
      issues.push(`локальный /api/health: version=${JSON.stringify(ver(A) ?? null)} (VERSION=«${HEALTH_VERSION_A}» до импорта, «${HEALTH_VERSION_B}» после — ожидалось "${HEALTH_VERSION_A}": §4.3 — содержимое <SO_APP_DIR>/VERSION, читается один раз при загрузке модуля, внутри GET файл не читается)${ver(A) === HEALTH_VERSION_B ? " — файл читается внутри GET" : ""}`);
    if (!extOnlyOk(A) || !extOnlyOk(B)) issues.push(`внешний GET() отдаёт ${JSON.stringify(A.external.json)} — ожидалось только {ok:true}`);
    if (ver(B) !== "dev") issues.push(`без файла VERSION: version=${JSON.stringify(ver(B) ?? null)}, ожидалось "dev"`);
    return {
      ok: issues.length === 0,
      detail: `health (SO_APP_DIR, дочерние процессы): ${issues.length ? issues.join("; ") : `version "${HEALTH_VERSION_A}" (после перезаписи на "${HEALTH_VERSION_B}"), без файла "dev", внешний — {ok:true}`}; ключи локального ответа: ${Object.keys((A.local.json as object) ?? {}).join(",")}`,
      notes: scenarioNotes(a.r) + scenarioNotes(b.r),
    };
  } finally {
    for (const d of [dirA, dirDev]) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const TG23: Check = {
  id: "TG.23", wp: "TG", kind: "static",
  title: "Эксплуатация §7: юнит second-opinion-bot в setup.sh (харденинг, ConditionPathExists, ReadWritePaths без «-», Wants без Requires, sudoers, .state); порядок deploy.sh и VERSION; локальный /api/health отдаёт version (читается при загрузке), внешний — {ok}; heartbeat > 120 с → exit(1); loadConfig и TG_API_ROOT; makeLogger «getMe ok version=…» находит шаблон deploy.sh",
  async run(): Promise<Verdict> {
    const selfBad = deploySelfCheck();
    if (selfBad.length) throw new Error(`дефект харнеса (TG.23, самопроверка разбора deploy.sh на строках в памяти): ${selfBad.slice(0, 4).join(" | ")}`);
    const setup = setupStatic();
    const deploy = deployStatic();
    const health = healthPart();
    // код бота в процессе харнеса — под защитой guard.ts и с заглушкой process.exit (бросает с подсказкой, что ожидалось)
    const hb = await guardedPart("TG.23 makeHeartbeat", "ожидался внедрённый exit (makeHeartbeat), а не process.exit", heartbeatUnit);
    const cfg = await guardedPart("TG.23 loadConfig", "ожидался throw (loadConfig), а не process.exit", configUnit);
    const lg = await guardedPart("TG.23 makeLogger", "makeLogger процесс не завершает", () => loggerUnit(deploy));
    const all = [setup, deploy, health, hb, cfg, lg];
    const ok = all.every((p) => p.ok);
    const mark = (p: { ok: boolean }) => (p.ok ? "✓" : "✗");
    return expect(ok, all.map((p) => `${mark(p)} ${p.detail}`).join(" || ") + health.notes);
  },
};

/* ═══════════════════════════ TG.G1 ═══════════════════════════ */

const TGG1: Check = {
  id: "TG.G1", wp: "TG", kind: "fixture", guard: true,
  title: "Тексты веба при channel=web не меняются: запрос без канала при SO_MESSAGE_LIMIT=2 получает «В этой сессии лимит 2 сообщений исчерпан. Обновите страницу…», при исчерпанном бюджете — BUDGET_EXHAUSTED_TEXT на 14.10 (литералы заморожены)",
  run(): Verdict {
    const s = run<LimitsOut>("server:limits", LIMITS_ENV);
    if (!s.ok) return s.v;
    const o = s.r.out;
    const [w1, w2, w3] = o.web;
    const issues: string[] = [];
    if (w1.status !== 200 || w2.status !== 200 || w1.text === FROZEN_LIMIT_WEB_2 || w2.text === FROZEN_LIMIT_WEB_2) issues.push(`ходы 1–2 не обычные: HTTP ${w1.status}/${w2.status}, ${q(w1.text, 60)} / ${q(w2.text, 60)}`);
    if (w3.status !== 200 || w3.text !== FROZEN_LIMIT_WEB_2) issues.push(`3-й ход веба: HTTP ${w3.status} ${q(w3.text, 200)} ≠ ${q(FROZEN_LIMIT_WEB_2, 200)}`);
    if (o.budgetWeb.status !== 200 || o.budgetWeb.text !== FROZEN_BUDGET_WEB) issues.push(`бюджет исчерпан: HTTP ${o.budgetWeb.status} ${q(o.budgetWeb.text, 240)} ≠ ${q(FROZEN_BUDGET_WEB, 240)}`);
    const detail = `${issues.length ? issues.join("; ") + " || " : ""}веб (id __LOCALID_limits-web, без x-so-channel), SO_MESSAGE_LIMIT=${o.messageLimit}: ход 3 → ${q(w3.text, 120)}; ` +
      `бюджет (spent=${o.budgetSpent} ≥ ${o.dailyBudget}$) → ${q(o.budgetWeb.text, 120)}${o.budgetText !== FROZEN_BUDGET_WEB ? `; budget.BUDGET_EXHAUSTED_TEXT сейчас ${q(o.budgetText, 120)}` : ""}` + scenarioNotes(s.r);
    return expect(issues.length === 0, detail);
  },
};

/* ═══════════════════════════ TG.G2 ═══════════════════════════ */

const TGG2: Check = {
  id: "TG.G2", wp: "TG", kind: "fixture", guard: true,
  title: "Эталон воспроизводим: 15 тел браузера → 200; ответ на запрос k, собранный ai, ≡ N(сообщение ассистента в теле k+1) — 8 пар; тело k+1 без новых сообщений ≡ телу k",
  run(): Verdict {
    const s = run<ParityOut>("server:parity");
    if (!s.ok) return s.v;
    const w = s.r.out.web;
    const issues: string[] = [];
    const bad = w.filter((x) => x.status !== 200 || x.error || x.errors.length);
    if (w.length !== 15) issues.push(`тел эталона ${w.length}, ожидалось 15`);
    if (bad.length) issues.push(`не 200 / ошибка сборки (${bad.length}): ${bad.map((x) => `${x.dialog}#${x.k + 1} HTTP ${x.status}${x.error ? ` ${x.error}` : ""}${x.errors.length ? ` ${x.errors[0]}` : ""}`).join("; ")}`);
    const pairs = w.filter((x) => x.hasNext);
    if (pairs.length !== 8) issues.push(`пар k → k+1 ${pairs.length}, ожидалось 8`);
    const pd = pairs.filter((x) => x.pairDiff !== null);
    if (pd.length) issues.push(`ответ ≠ сообщению ассистента в следующем теле (${pd.length}/${pairs.length}): ${pd.map((x) => `${x.dialog}#${x.k + 1}: ${x.pairDiff}`).join(" | ")}`);
    const px = pairs.filter((x) => x.prefixDiff !== null);
    if (px.length) issues.push(`префикс истории (${px.length}/${pairs.length}): ${px.map((x) => `${x.dialog}#${x.k + 1}: ${x.prefixDiff}`).join(" | ")}`);
    const detail = issues.length
      ? `${issues.join(" || ")} — если правка гейта или MOCK-модели намеренная, фикстуры перезаписывает только оркестратор (§10)`
      : `15/15 → 200; ${pairs.length - pd.length}/${pairs.length} пар «ответ k ≡ N(ассистент в теле k+1)»; ${pairs.length - px.length}/${pairs.length} префиксов истории совпали`;
    return expect(issues.length === 0, detail + scenarioNotes(s.r));
  },
};

/* ═══════════════════════════ TG.G6 ═══════════════════════════ */

const TGG6: Check = {
  id: "TG.G6", wp: "TG", kind: "fixture", guard: true,
  title: "Пределы сервера пропускают историю: 15 тел браузера и синтетическая история из 20 сообщений с 10 golden-отчётами (build/applyInputs) не получают 400/413",
  run(): Verdict {
    const p = run<ParityOut>("server:parity");
    if (!p.ok) return p.v;
    const g = run<G6Out>("server:g6");
    if (!g.ok) return g.v;
    const web = p.r.out.web, o = g.r.out;
    const issues: string[] = [];
    const bad = web.filter((x) => x.status !== 200 || x.error);
    if (bad.length) issues.push(`тела браузера: ${bad.map((x) => `${x.dialog}#${x.k + 1} HTTP ${x.status}${x.error ? ` ${x.error}` : ""}`).join("; ")}`);
    if (o.status !== 200 || o.error) issues.push(`синтетическая история: HTTP ${o.status}${o.status === 400 || o.status === 413 ? " — предел сервера режет историю с отчётами" : ""}${o.error ? ` ${o.error}` : ""}`);
    const detail = `${issues.length ? issues.join("; ") + " || " : ""}15 тел браузера: ${web.length - bad.length}/${web.length} → 200; ` +
      `синтетика: ${o.messages - 1} сообщений истории (${o.reports} ответов ассистента с отчётами ${G6_REPORTS.join(", ")}) + новая реплика → HTTP ${o.status}; ` +
      `тело ${o.chars} символов, ${o.bytes} байт UTF-8; текстовых частей ${o.textChars} символов; tool-выход {query,result} ${Math.min(...o.toolChars)}–${Math.max(...o.toolChars)} символов` +
      scenarioNotes(p.r) + scenarioNotes(g.r);
    return expect(issues.length === 0, detail);
  },
};

export const checks: Check[] = [TG3, TG11, TG12, TG13, TG14, TG23, TGG1, TGG2, TGG6];

