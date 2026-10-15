/**
 * WP-TG (apps/web + apps/bot + @so/present) — Telegram-бот на том же движке решений. План: docs/PLAN_telegram_bot_2026-10-14.md §6.
 * Каждая не-guard проверка утверждает ЖЕЛАЕМОЕ поведение (после шагов 2–6 плана) и до правки RED: бота, @so/present и серверных
 * изменений нет. Guard (TG.G1–TG.G6) — инварианты, GREEN уже сейчас. Модуль, которого ещё нет, — RED с detail
 * «нет модуля …; ожидаемо до шага N», а не ERROR: он грузится динамическим import по вычисляемому пути (apps/web/audit/tg/mods.ts),
 * сигнатуры §4 продублированы там структурными типами, поэтому typecheck @so/web от них не зависит.
 *
 * Как устроено.
 *  - Эталон паритета — РЕАЛЬНЫЕ тела браузера apps/web/audit/fixtures/dialogs/*.json (7 диалогов, 15 запросов assistant-ui,
 *    запись прокси 14.10 на d16c809). Бот сравнивается с ними, а не сам с собой: TG.4 (тела и заголовки), TG.5 (состояние сессии
 *    сервера). TG.G2 привязывает эталонный сборщик ответа (функции ai) к браузеру: ответ на запрос k ≡ сообщение ассистента в теле k+1.
 *  - Нормализация N (§4.5) — apps/web/audit/tg/normalize.ts; единственные допуски: body.id, значение x-so-chat, messages[].id,
 *    toolCallId (по порядку), built_at, diagnostics.snapshot_dir. Чувствительность компаратора доказывает TG.G4 (мутанты).
 *  - Сценарии с сервером — дочерний процесс apps/web/audit/tg/scenarios.ts (cwd = apps/web; SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0;
 *    ключи LLM и Jev сняты; свой временный SO_USAGE_DIR на сценарий; SO_USAGE_LOG=1; SO_BOT_KEY — тестовый; fetch бросает на любой
 *    URL). route.POST /api/chat, /api/report, страница /check и /api/health вызываются как функции. Бот получает fetch → route.POST.
 *  - Модульные проверки бота (очередь, повтор, политика Telegram, доступ и лимиты, сессия, рендер) — в процессе харнеса: createCore +
 *    фейковый Telegram (tg/fake-tg.ts) + заглушка сервера, отдающая настоящий поток ai (createUIMessageStreamResponse). На время
 *    этих проверок globalThis.fetch бросает (noNet): ядро, которое ходит мимо внедрённого fetch, краснеет без побочного эффекта.
 *  - И3 проверяется в обе стороны: строки VM есть в SSR и в сообщении Telegram (TG.6, TG.6-tg), и обратно — текст блоков чата и
 *    сообщения Telegram целиком покрыт строками VM (кроме замороженных подписей веб-контролов WEB_ONLY_CONTROLS); TG.7 сканирует
 *    замыкание относительных импортов блоков, а не четыре файла.
 *  - TG.14: второй прогон гейта с переставленным top3 (tg/top3-shim.ts в дочернем процессе misc) — иначе тавтология.
 *  - Статика — по AST TypeScript (импорты, литералы, JSX-текст; .ts и .js): комментарии в разбор не попадают.
 *  - Снимок SSR для TG.G5 — fixtures/tg/ssr_golden.json, снят с d16c809 флагом --record-tg-ssr; дальше меняет только оркестратор.
 * Сеть не используется нигде, платных API нет; baseline и golden харнес не пишет.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import type { BondReportT, BuildResultT } from "@so/engine/contract";
import { type Check, type Verdict, AUDIT_FIXTURES, REPO_ROOT, WEB_ROOT, fail, pass, readJson, readSrc } from "../lib";
import { callbackUpdate, lastUserText, loadDialogs, messageUpdate, testUser, type Dialog } from "../tg/actions";
import { apiError, fakeTelegram, scriptedRaw } from "../tg/fake-tg";
import * as M from "../tg/mods";
import { canon, compareBodies, compareHeaders, compareMessages, firstDiff, textOfMessage } from "../tg/normalize";
import {
  INPUT_CASES, MARK, SCENARIO_FILE, TEST_BUILD_SHA, TEST_DISK_SHA, TEST_KEY, TEST_SALT, TEST_TOKEN, WEB_URL,
  type BotOut, type InputsOut, type LimitsOut, type MiscOut, type ReplayOut,
} from "../tg/scenarios";

const show = (v: unknown) => JSON.stringify(v);
const cut = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const q = (s: unknown, n = 120) => `«${cut(String(s ?? "").replace(/\s+/g, " ").trim(), n)}»`;
const rel = (f: string) => path.relative(REPO_ROOT, f);
const errMsg = (e: unknown) => String(e instanceof Error ? `${e.name}: ${e.message}` : e).replace(/\s+/g, " ").slice(0, 240);
/** Без пробелов любого вида (в т.ч. неразрывных): сравнение текста, не зависящее от границ тегов и переносов */
const squash = (s: string) => s.replace(/[\s    ]+/g, "");
const decodeEntities = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, e: string) =>
    e === "amp" ? "&" : e === "lt" ? "<" : e === "gt" ? ">" : e === "quot" ? '"' : e === "apos" ? "'"
      : e[1] === "x" || e[1] === "X" ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(Number(e.slice(1))));
/** HTML Telegram → видимый текст: теги сняты, сущности раскодированы */
const plainOf = (h: string) => decodeEntities(h.replace(/<[^>]*>/g, ""));
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: не завершилось за ${ms} мс`)), ms); })]);
  } finally { if (t) clearTimeout(t); }
}
const STEP_NOTE = (n: string) => `ожидаемо до шага ${n}`;
/** Ждать условия (опрос каждые 5 мс) вместо фиксированной паузы; false — не дождались за ms */
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await settle(5);
  }
  return true;
}
/** Окно отрицательной проверки: за это время НЕ должно появиться лишнего POST (правильную реализацию не задевает) */
const GRACE_MS = 60;

/**
 * Обратное включение (И3): что в тексте hay НЕ покрыто ни одним вхождением строк cover. Сравнение без пробелов (squash), позиции
 * помечаются по всем вхождениям каждой строки (порядок строк и их перекрытия не важны). Возвращает непокрытые отрезки,
 * в которых есть буква или цифра: пунктуация и разделители («·», «—», «:», «%», «−») покрытия не требуют.
 */
function uncovered(hay: string, cover: string[]): string[] {
  const h = squash(hay);
  const mark = new Uint8Array(h.length);
  for (const s of new Set(cover.filter((x): x is string => typeof x === "string").map(squash).filter(Boolean))) {
    for (let i = h.indexOf(s); i >= 0; i = h.indexOf(s, i + 1)) mark.fill(1, i, i + s.length);
  }
  const runs: string[] = [];
  let cur = "";
  for (let i = 0; i < h.length; i++) {
    if (!mark[i]) cur += h[i];
    else if (cur) { runs.push(cur); cur = ""; }
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => /[\p{L}\p{N}]/u.test(r));
}

/**
 * Сеть в процессе харнеса на время модульных проверок бота (TG.6-tg, TG.8, TG.9, TG.16–TG.19, TG.21): globalThis.fetch бросает,
 * обращения записываются. Ядро, которое ходит мимо внедрённого fetch (на 127.0.0.1:3000 с живым next dev или на api.telegram.org),
 * не успевает сделать побочный эффект, а проверка краснеет с detail «ядро ходит в сеть мимо внедрённого fetch».
 */
async function noNet<T>(fn: () => Promise<T>): Promise<{ v: T; blocked: string[] }> {
  const real = globalThis.fetch;
  const blocked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    blocked.push(u);
    throw new Error(`аудит WP-TG: сеть запрещена (глобальный fetch ${u.slice(0, 100)})`);
  }) as typeof fetch;
  try { return { v: await fn(), blocked }; } finally { globalThis.fetch = real; }
}
const netRow = (blocked: string[]) =>
  `ядро ходит в сеть мимо внедрённого fetch (${blocked.length}): ${[...new Set(blocked)].slice(0, 3).map((u) => q(u, 60)).join("; ")}`;
/**
 * Каркас модульной проверки бота: тело пишет rows (нарушения) и notes (наблюдения) или возвращает готовый вердикт (нет модулей);
 * всё — под noNet, исключение тела — нарушение.
 */
async function botCheck(body: (rows: string[], notes: string[]) => Promise<Verdict | void>): Promise<Verdict> {
  const rows: string[] = [];
  const notes: string[] = [];
  const { v: early, blocked } = await noNet(async () => {
    try { return await body(rows, notes); } catch (e) { rows.push(`исключение: ${errMsg(e)}`); return undefined; }
  });
  if (blocked.length) rows.push(netRow(blocked));
  if (early && !blocked.length) return early;
  if (early && !early.pass) rows.unshift(early.detail);
  const detail = `${notes.join("; ")}${rows.length ? `${notes.length ? " | " : ""}НЕ ок: ${rows.join(" | ")}` : ""}`;
  return rows.length ? fail(detail) : pass(detail);
}
/** Готовая проверка под noNet: обращение к глобальному fetch — RED поверх её вердикта */
async function guarded(fn: () => Promise<Verdict>): Promise<Verdict> {
  const { v, blocked } = await noNet(fn);
  return blocked.length ? fail(`${v.detail} | ${netRow(blocked)}`) : v;
}

/* ═════════════ дочерний процесс: сценарии с сервером (tg/scenarios.ts) ═════════════ */

const tmpDirs: string[] = [];
process.on("exit", () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
interface Envelope<T> { scenario: string; blocked: string[]; out: T }
const memo = new Map<string, { ok: true; v: Envelope<unknown> } | { ok: false; err: Error }>();
const SCENARIO_ENV: Record<string, Record<string, string>> = {
  limits: { SO_MESSAGE_LIMIT: "2", SO_DAILY_BUDGET_USD: "1" },
  // TG.23: sha сборки — в проде его подставляет next build (next.config.ts env.SO_BUILD_SHA), здесь route.ts грузится без сборки
  misc: { SO_BUILD_SHA: TEST_BUILD_SHA },
};
function scenario<T>(name: "replay" | "bot" | "limits" | "inputs" | "misc"): Envelope<T> {
  const m = memo.get(name);
  if (m) { if (m.ok) return m.v as Envelope<T>; throw m.err; }
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `so-audit-tg-${name}-`));
    tmpDirs.push(dir);
    const env: NodeJS.ProcessEnv = {
      ...process.env, NODE_NO_WARNINGS: "1", SO_OFFLINE: "1", MOCK_LLM: "1", JEV_ENABLED: "0", SO_USAGE_DIR: dir, SO_USAGE_LOG: "1",
      SO_QUIET: "1", SO_BOT_KEY: TEST_KEY, SO_MESSAGE_LIMIT: "20", SO_DAILY_BUDGET_USD: "2", ...(SCENARIO_ENV[name] ?? {}),
    };
    for (const k of ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "LLM_PROVIDER", "JEV_PROVIDER", "JEV_THRESHOLD", "TYPESAFE_URL",
      "JEV_DECISIONS_URL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "SO_CHAT", "NODE_ENV", "TG_BOT_TOKEN", "SO_TG_SALT"]) delete env[k];
    const r = spawnSync(process.execPath, ["--import", "tsx", SCENARIO_FILE, "--scenario", name], {
      cwd: WEB_ROOT, env, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    const line = String(r.stdout ?? "").split("\n").reverse().find((l) => l.startsWith(MARK));
    if (r.status !== 0 || !line) {
      const tail = String(r.stderr ?? "").trim().split("\n").slice(-8).join(" | ");
      throw new Error(`сценарий WP-TG ${name}: exit=${r.status} signal=${r.signal ?? "-"}; stderr: ${tail || "(пусто)"}`);
    }
    const v = JSON.parse(line.slice(MARK.length)) as Envelope<T>;
    if (v.scenario !== name) throw new Error(`сценарий ${name}: пришёл результат «${v.scenario}»`);
    if (v.blocked.length) throw new Error(`сценарий ${name}: обращения в сеть заблокированы (${v.blocked.length}): ${v.blocked.slice(0, 3).join("; ")} — дефект харнеса или кода`);
    memo.set(name, { ok: true, v });
    return v;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    memo.set(name, { ok: false, err });
    throw err;
  }
}

/* ═════════════ статика по AST TypeScript ═════════════ */

interface Lit { file: string; line: number; kind: string; text: string }
interface ImportRec { file: string; line: number; spec: string; names: string[]; typeOnly: boolean; dynamic: boolean }
interface Named { file: string; line: number; text: string }
interface Scan { lits: Lit[]; idents: Named[]; props: Named[]; calls: Named[]; imports: ImportRec[] }
const kindOf = (file: string) =>
  /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.(m|c)?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
function scanFile(file: string): Scan {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kindOf(file));
  const out: Scan = { lits: [], idents: [], props: [], calls: [], imports: [] };
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const skip = new Set<ts.Node>();
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      skip.add(n.moduleSpecifier);
      const c = n.importClause;
      const names: string[] = [];
      let typeOnly = !!c?.isTypeOnly;
      if (c && !c.isTypeOnly) {
        if (c.name) names.push("default");
        const nb = c.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) names.push("*");
        else if (nb) for (const e of nb.elements) if (!e.isTypeOnly) names.push((e.propertyName ?? e.name).text);
        typeOnly = names.length === 0 && !!nb && ts.isNamedImports(nb) && nb.elements.length > 0;
      }
      if (!c) names.push("(побочный импорт)");
      out.imports.push({ file, line: lineOf(n), spec: n.moduleSpecifier.text, names, typeOnly, dynamic: false });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      skip.add(n.moduleSpecifier);
      const names = n.exportClause && ts.isNamedExports(n.exportClause)
        ? n.exportClause.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text) : ["*"];
      out.imports.push({ file, line: lineOf(n), spec: n.moduleSpecifier.text, names, typeOnly: n.isTypeOnly || names.length === 0, dynamic: false });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      skip.add(n.moduleReference.expression);
      out.imports.push({ file, line: lineOf(n), spec: n.moduleReference.expression.text, names: ["*"], typeOnly: n.isTypeOnly, dynamic: false });
    } else if (ts.isCallExpression(n)) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      if (isImport || isRequire) {
        const a = n.arguments[0];
        if (a && ts.isStringLiteralLike(a)) skip.add(a);
        out.imports.push({ file, line: lineOf(n), spec: a && ts.isStringLiteralLike(a) ? a.text : "<вычисляемый путь>", names: ["*"], typeOnly: false, dynamic: true });
      }
      if (ts.isIdentifier(n.expression)) out.calls.push({ file, line: lineOf(n), text: n.expression.text });
    } else if (ts.isImportTypeNode(n)) {
      skip.add(n.argument);
    }
    if (ts.isPropertyAccessExpression(n)) out.props.push({ file, line: lineOf(n), text: n.name.text });
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) out.props.push({ file, line: lineOf(n), text: n.argumentExpression.text });
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const key = n.propertyName ?? n.name;
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) out.props.push({ file, line: lineOf(n), text: key.text });
    }
    if (ts.isIdentifier(n)) out.idents.push({ file, line: lineOf(n), text: n.text });
    if (!skip.has(n)) {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.lits.push({ file, line: lineOf(n), kind: "строка", text: n.text });
      else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.lits.push({ file, line: lineOf(n), kind: "шаблон", text: n.text });
      else if (ts.isJsxText(n) && n.text.trim()) out.lits.push({ file, line: lineOf(n), kind: "JSX-текст", text: n.text.trim() });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const CYR = /[А-Яа-яЁё]/;
/** Исходники, которые разбирает scanFile: TS и JS всех видов (.d.ts — только типы, текста не несут) */
const CODE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const isCode = (f: string) => CODE_RE.test(f) && !/\.d\.(m|c)?ts$/.test(f);
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}
/** Исходники каталога (TS и JS) */
const tsFiles = (dir: string) => walk(dir).filter(isCode);
/** Прочие файлы каталога (JSON, текст, CSS…): через них тоже можно пронести литералы мимо разбора AST */
const otherFiles = (dir: string) => walk(dir).filter((f) => !isCode(f) && !/\.d\.(m|c)?ts$/.test(f));
/** Кириллица в не-коде: в CSS без комментариев (комментарии — не текст интерфейса) */
const rawCyr = (f: string) => {
  let s = fs.readFileSync(f, "utf8");
  if (/\.(css|scss)$/.test(f)) s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  const i = s.search(CYR);
  return i < 0 ? null : s.slice(Math.max(0, i - 10), i + 40);
};
const at = (x: { file: string; line: number }) => `${rel(x.file)}:${x.line}`;

/* ═════════════ входы: 16 golden, 3 живые фикстуры, синтетическая ошибка ═════════════ */

interface GoldenCase { name: string; query: string; inputs?: Record<string, number>; todayIso?: string }
const goldenCases = () => readJson<{ cases: GoldenCase[] }>("packages/engine/golden/cases.json").cases;
interface Sample { name: string; query: string; res: BuildResultT; src: "golden" | "live" | "synthetic" }
const ISS_DOWN = "Мосбиржа сейчас не отвечает — попробуйте через минуту."; // lib/engine.ts ISS_DOWN_MSG — синтетический err
const LIVE = ["live_ofz26244.json", "live_rolf_p26.json", "live_rolf_plain.json"];
function samples(): Sample[] {
  const out: Sample[] = goldenCases().map((c) => ({ name: c.name, query: c.query, res: readJson<BuildResultT>(`packages/engine/golden/expected/${c.name}.json`), src: "golden" as const }));
  for (const f of LIVE) {
    const res = JSON.parse(fs.readFileSync(path.join(AUDIT_FIXTURES, f), "utf8")) as BuildResultT;
    out.push({ name: f.replace(/\.json$/, ""), query: res.kind === "report" ? (res.report.security.isin ?? res.report.security.secid) : f, res, src: "live" });
  }
  out.push({ name: "err-iss", query: "RU000A10ASE2", res: { kind: "err", query: "RU000A10ASE2", msg: ISS_DOWN }, src: "synthetic" });
  return out;
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** Сообщение ассистента с одним инструментом отчёта, как его собирает ai из ответа /api/chat */
function toolMessage(s: { query: string; res: BuildResultT }, withText?: string): M.UIMsg {
  const tool = s.res.kind === "report" ? "build_bond_report" : "resolve_security";
  const parts: Array<Record<string, unknown>> = [
    { type: `tool-${tool}`, toolCallId: "call_audit_tg", state: "output-available", input: { query: s.query }, output: { query: s.query, result: s.res } },
  ];
  if (withText != null) parts.push({ type: "text", text: withText, state: "done" });
  return { id: "audit_tg_msg", role: "assistant", parts };
}

/* ═════════════ SSR блоков (TG.6, TG.G5) ═════════════ */

const SSR_SNAPSHOT = path.join(AUDIT_FIXTURES, "tg", "ssr_golden.json");
/** askPriceUnavailableNote чата (components/ToolUIs.tsx) — с ним ReportView рендерится в чате. В SSR не виден (только после отправки
 *  формы цены), поэтому в VM не входит: presentReport без опций (§4.1 плана) */
const CHAT_ASK_NOTE = "Напишите цену предложения в чате — пересчитаю.";
/** Текст SSR: теги сняты (вместо тега — пробел, у тега с aria-label — его значение), сущности раскодированы, ASCII-пробелы схлопнуты */
function ssrText(html: string): string {
  const s = html.replace(/<(?:"[^"]*"|'[^']*'|[^'">])*>/g, (tag) => {
    const m = tag.match(/\saria-label="([^"]*)"/);
    return m ? ` ${m[1]} ` : " ";
  });
  return decodeEntities(s).replace(/[ \t\n\r\f\v]+/g, " ").trim();
}
type View = "ReportView.compact" | "PickView.compact" | "NotFoundView.compact" | "ErrView.compact" | "ResultApp";
let ssrMemo: Promise<Record<string, string>> | null = null;
function ssrAll(): Promise<Record<string, string>> {
  ssrMemo ??= (async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const g = globalThis as unknown as { React?: unknown };
    g.React ??= React; // packages/blocks транслируется классическим JSX (как в wp-u-ui.ts)
    const blocks = await import("@so/blocks");
    const h = React.createElement as unknown as (t: unknown, p?: unknown, ...c: unknown[]) => import("react").ReactElement;
    const out: Record<string, string> = {};
    for (const s of samples()) {
      const r = s.res;
      const chat: [View, unknown, unknown] = r.kind === "report"
        ? ["ReportView.compact", blocks.ReportView, { report: r.report, compact: true, showInputs: false, askPriceUnavailableNote: CHAT_ASK_NOTE }]
        : r.kind === "pick" ? ["PickView.compact", blocks.PickView, { res: r, onPick: () => {}, compact: true }]
        : r.kind === "notfound" ? ["NotFoundView.compact", blocks.NotFoundView, { res: r, compact: true }]
        : ["ErrView.compact", blocks.ErrView, { res: r, compact: true }];
      out[`${s.name}|${chat[0]}`] = ssrText(renderToStaticMarkup(h(chat[1], chat[2])));
      out[`${s.name}|ResultApp`] = ssrText(renderToStaticMarkup(h(blocks.ResultApp, {
        result: r, homeHref: "/", hrefFor: (secid: string) => `/check?q=${encodeURIComponent(secid)}`, rebuild: async () => r,
      })));
    }
    return out;
  })();
  return ssrMemo;
}

/* ═════════════ HTML Telegram: проверка разметки и видимой длины (TG.8) ═════════════ */

const TG_TAGS = new Set(["b", "i", "code", "a"]);
const ENTITY_AT = /^&(amp|lt|gt|quot|#\d{1,7}|#x[0-9a-fA-F]{1,6});/;
function tgHtmlProblems(h: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  for (let i = 0; i < h.length;) {
    const c = h[i];
    if (c === "<") {
      const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z-]+="[^"<>]*")*)\s*>/.exec(h.slice(i));
      if (!m) { problems.push(`неэкранированный «<» (позиция ${i}: ${q(h.slice(i, i + 20), 24)})`); i++; continue; }
      const [all, close, tagRaw, attrs] = m;
      const tag = tagRaw.toLowerCase();
      if (!TG_TAGS.has(tag)) problems.push(`тег <${close}${tag}> вне b/i/code/a`);
      if (close) {
        if (attrs.trim()) problems.push(`атрибуты у </${tag}>`);
        const top = stack.pop();
        if (top !== tag) problems.push(`несбалансированный </${tag}> (открыт ${top ?? "ничего"})`);
      } else {
        if (tag === "a") { if (!/^\s+href="(https?:\/\/|tg:\/\/)[^"]*"$/.test(attrs)) problems.push(`<a> без href или с лишними атрибутами: ${q(attrs, 40)}`); }
        else if (attrs.trim()) problems.push(`атрибуты у <${tag}>`);
        stack.push(tag);
      }
      i += all.length;
      continue;
    }
    if (c === ">") { problems.push(`неэкранированный «>» (позиция ${i})`); i++; continue; }
    if (c === "&") {
      const m = ENTITY_AT.exec(h.slice(i));
      if (!m) { problems.push(`неэкранированный «&» (позиция ${i}: ${q(h.slice(i, i + 12), 16)})`); i++; continue; }
      i += m[0].length;
      continue;
    }
    i++;
  }
  if (stack.length) problems.push(`не закрыты теги ${stack.join(", ")}`);
  return problems;
}
/** Длина, как её считает Telegram: видимый текст после разбора сущностей, в единицах UTF-16 */
const tgVisibleLength = (h: string) => plainOf(h).length;

/* ═════════════ бот в процессе харнеса: заглушка сервера и стенд ядра ═════════════ */

type Step = "ok" | "refused" | "reset" | "500" | "break" | "hang";
const netError = (code: string) =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code} 127.0.0.1:3000`), { code, syscall: "connect", address: "127.0.0.1", port: 3000 }) });
async function sseReply(text: string): Promise<Response> {
  const ai = await import("ai");
  return ai.createUIMessageStreamResponse({
    stream: ai.createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "text-start", id: "t1" });
        writer.write({ type: "text-delta", id: "t1", delta: text });
        writer.write({ type: "text-end", id: "t1" });
      },
    }),
  });
}
function brokenSse(): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('data: {"type":"start"}\n\n'));
      c.enqueue(enc.encode('data: {"type":"text-start","id":"t1"}\n\n'));
      c.enqueue(enc.encode('data: {"type":"text-delta","id":"t1","delta":"начало ответа"}\n\n'));
      setTimeout(() => c.error(new Error("аудит: обрыв потока")), 5);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
}
interface StubPost { body: Record<string, unknown> & { id?: string; messages?: M.UIMsg[] }; headers: Record<string, string>; at: number }
const REPLY = "Ответ сервера (аудит WP-TG).";
function stubServer(o: { hold?: boolean; script?: Step[]; reply?: string } = {}) {
  const posts: StubPost[] = [];
  const waiters: Array<() => void> = [];
  const st = { inFlight: 0, maxInFlight: 0 };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${WEB_URL}/api/chat`)) throw new Error(`аудит: заглушка сервера — неожиданный URL ${url}`);
    const raw = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
    let body: StubPost["body"] = {};
    try { body = JSON.parse(raw) as StubPost["body"]; } catch { /* тело не JSON — останется {} */ }
    const hs = init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init?.headers as Record<string, string> | undefined) ?? {};
    const n = posts.length;
    posts.push({ body, headers: Object.fromEntries(Object.entries(hs).map(([k, v]) => [k.toLowerCase(), String(v)])), at: Date.now() });
    const step: Step = o.script?.[Math.min(n, (o.script?.length ?? 1) - 1)] ?? "ok";
    if (step === "refused") throw netError("ECONNREFUSED");
    if (step === "reset") throw netError("ECONNRESET");
    st.inFlight++;
    st.maxInFlight = Math.max(st.maxInFlight, st.inFlight);
    try {
      if (o.hold) await new Promise<void>((r) => waiters.push(r));
      if (step === "500") return new Response("Internal Server Error", { status: 500 });
      if (step === "break") return brokenSse();
      if (step === "hang") {
        return await new Promise<Response>((_, rej) => {
          const t = setTimeout(() => rej(new Error("аудит: заглушка ждала 10 с")), 10_000);
          t.unref?.();
          init?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("aborted"), { name: "AbortError" })); });
        });
      }
      return await sseReply(o.reply ?? REPLY);
    } finally { st.inFlight--; }
  }) as typeof fetch;
  const release = (n = Infinity) => { for (let i = 0; i < n && waiters.length; i++) waiters.shift()!(); };
  return { fetch: fetchFn, posts, st, release, waiting: () => waiters.length };
}
type Stub = ReturnType<typeof stubServer>;
const BASE_CFG: M.BotConfig = {
  webUrl: WEB_URL, botKey: TEST_KEY, salt: TEST_SALT, allow: "*", dailyTurns: 1000, concurrency: 4, perChatPending: 2,
  maxChats: 300, turnTimeoutMs: 90_000,
};
function rig(core: M.CoreMod, stub: Stub, over: Partial<M.BotConfig> = {}, t0 = Date.parse("2026-10-14T09:00:00.000Z")) {
  const tg = fakeTelegram();
  const clock = { t: t0 };
  const sleeps: number[] = [];
  const logs: string[] = [];
  const c = core.createCore({
    config: { ...BASE_CFG, ...over }, tg: tg.client, fetch: stub.fetch, now: () => clock.t,
    random: (n) => new Uint8Array(crypto.randomBytes(n)), sleep: async (ms) => { sleeps.push(ms); }, log: (r) => { logs.push(JSON.stringify(r)); },
  });
  return { c, tg, clock, sleeps, logs };
}
/** Отпускать удержанные ответы по одному, пока ядро не опустеет */
async function drain(stub: Stub, c: M.BotCore, maxMs = 5_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    stub.release(1);
    await settle(15);
    if (stub.waiting() === 0 && stub.st.inFlight === 0) break;
  }
  await within(c.idle(), maxMs, "core.idle()");
}
const sent = (tg: ReturnType<typeof fakeTelegram>, chatId: number, text?: string) =>
  tg.calls.filter((x) => x.method === "sendMessage" && x.chatId === chatId && (text == null || x.text === text));
/** Подпоследовательность паузы — в том порядке, как ожидается */
const hasSubseq = (xs: number[], want: number[]) => { let j = 0; for (const x of xs) if (x === want[j]) j++; return j === want.length; };

/* ═════════════ проверки: статика бота ═════════════ */

const BOT_SRC = path.join(M.BOT_DIR, "src");
const PRESENT_SRC = path.join(REPO_ROOT, "packages", "present", "src");
const AI_ALLOWED = new Set(["parseJsonEventStream", "uiMessageChunkSchema", "readUIMessageStream", "generateId"]);
const FORBID_IDENT = new Set(["streamText", "generateText", "convertToModelMessages", "streamObject", "generateObject"]);
const FORBID_ENV = /(ANTHROPIC_|OPENROUTER_|TYPESAFE_|JEV_|LLM_)/;
const FORBID_HOST = /openrouter|anthropic|typesafe/i;
const PII_PROPS = new Set(["username", "first_name", "last_name"]);
/** Сетевые встроенные модули: мимо внедрённого fetch ядро ходить не должно (с префиксом node: и без) */
const NET_BUILTIN = /^(node:)?(http|https|http2|net|tls|dgram|dns)(\/|$)/;

const TG1: Check = {
  id: "TG.1", wp: "TG", kind: "static",
  title: "И1: бот не принимает решений — граф импортов apps/bot (.ts и .js) только из белого списка (grammy и сетевые node:http/https/net/tls/dns лишь в main/telegram; из ai — parseJsonEventStream/uiMessageChunkSchema/readUIMessageStream/generateId и типы; @so/present/*; @so/engine/contract и /format; zod; node:*), нет streamText/generateText/convertToModelMessages/tool(, ключей LLM/Jev, хостов LLM, чтения username/first_name/last_name; @so/present не тянет решений",
  run(): Verdict {
    if (!fs.existsSync(BOT_SRC)) return fail(`нет каталога apps/bot/src; ${STEP_NOTE(M.STEP.bot)}`);
    const files = tsFiles(M.BOT_DIR);
    if (!files.length) return fail(`в apps/bot нет исходников .ts/.js; ${STEP_NOTE(M.STEP.bot)}`);
    const bad: string[] = [];
    const externals = new Set<string>();
    for (const f of files) {
      const s = scanFile(f);
      const base = path.basename(f);
      for (const im of s.imports) {
        const spec = im.spec;
        if (spec.startsWith(".")) {
          const target = path.resolve(path.dirname(f), spec);
          if (!target.startsWith(M.BOT_DIR + path.sep)) bad.push(`${at(im)}: относительный импорт за пределы apps/bot (${spec})`);
          continue;
        }
        externals.add(spec);
        if (spec === "<вычисляемый путь>") { bad.push(`${at(im)}: import() с вычисляемым путём — граф не проверяем`); continue; }
        if (NET_BUILTIN.test(spec)) {
          if (!["main.ts", "telegram.ts"].includes(base)) bad.push(`${at(im)}: сетевой модуль «${spec}» в ${base} — сеть только через внедрённые fetch и TgClient (§4.4); как grammy, допустим лишь в main.ts и telegram.ts`);
          continue;
        }
        if (spec.startsWith("node:") || spec === "zod" || /^@so\/present\/(protocol|entry|copy|report)$/.test(spec) || spec === "@so/engine/contract" || spec === "@so/engine/format") continue;
        if (spec === "grammy" || spec.startsWith("grammy/")) { if (!["main.ts", "telegram.ts"].includes(base)) bad.push(`${at(im)}: grammy импортирует ${base} (разрешено только main.ts и telegram.ts)`); continue; }
        if (spec === "ai") {
          if (im.typeOnly) continue;
          const extra = im.names.filter((n) => !AI_ALLOWED.has(n));
          if (extra.length) bad.push(`${at(im)}: из ai импортировано ${extra.join(", ")} (разрешены ${[...AI_ALLOWED].join(", ")} и типы)`);
          continue;
        }
        bad.push(`${at(im)}: запрещённый импорт «${spec}»${/^@\/|apps\/web/.test(spec) ? " (код сервера)" : /^@so\/engine($|\/inputs)/.test(spec) ? " (движок решений: build/applyInputs)" : /^@ai-sdk\/|^@openrouter\//.test(spec) ? " (провайдер LLM)" : /^(fs|path|crypto|http|https|os|url|child_process)$/.test(spec) ? " (встроенный модуль — только с префиксом node:)" : ""}`);
      }
      for (const id of s.idents) if (FORBID_IDENT.has(id.text)) bad.push(`${at(id)}: ${id.text}`);
      for (const c of s.calls) if (c.text === "tool") bad.push(`${at(c)}: tool(…) — определение инструмента модели`);
      for (const x of [...s.idents, ...s.props]) if (FORBID_ENV.test(x.text)) bad.push(`${at(x)}: имя ${x.text} (ключи LLM/Jev)`);
      for (const l of s.lits) {
        if (FORBID_ENV.test(l.text)) bad.push(`${at(l)}: строка ${q(l.text, 50)} (ключи LLM/Jev)`);
        if (FORBID_HOST.test(l.text)) bad.push(`${at(l)}: строка ${q(l.text, 50)} (хост LLM/Jev)`);
      }
      for (const p of s.props) if (PII_PROPS.has(p.text) && !(p.text === "username" && base === "main.ts"))
        bad.push(`${at(p)}: обращение к .${p.text} (данные пользователя Telegram; .username допустим только в main.ts — сверка getMe с TG_BOT_USERNAME)`);
    }
    // @so/present: чистый TS без React, Node и ai — иначе через него бот дотянется до решений
    const presentBad: string[] = [];
    for (const f of tsFiles(PRESENT_SRC)) {
      for (const im of scanFile(f).imports) {
        const spec = im.spec;
        if (spec.startsWith(".")) { if (!path.resolve(path.dirname(f), spec).startsWith(path.join(REPO_ROOT, "packages", "present") + path.sep)) presentBad.push(`${at(im)}: относительный импорт за пределы packages/present`); continue; }
        if (im.typeOnly && !/apps\/web|^@\//.test(spec)) continue;
        if (["@so/engine/contract", "@so/engine/format", "@so/engine/config", "zod"].includes(spec)) continue;
        presentBad.push(`${at(im)}: @so/present импортирует «${spec}» (разрешены @so/engine/contract|format|config и zod)`);
      }
    }
    const all = [...bad, ...presentBad];
    const detail = `apps/bot: ${files.length} файлов (${files.map((f) => path.relative(M.BOT_DIR, f)).join(", ")}); внешние импорты: ${[...externals].sort().join(", ") || "нет"}; ` +
      `@so/present: ${tsFiles(PRESENT_SRC).length} файлов | ` +
      (all.length ? `нарушений ${all.length}: ${all.slice(0, 12).join("; ")}${all.length > 12 ? "; …" : ""}` : "нарушений нет");
    return all.length ? fail(detail) : pass(detail);
  },
};

const TG2: Check = {
  id: "TG.2", wp: "TG", kind: "static",
  title: "В apps/bot нет кириллицы в строковых и шаблонных литералах исходников .ts/.js вне комментариев и в прочих файлах apps/bot/src (JSON, текст) — все тексты бота из @so/present/copy",
  run(): Verdict {
    if (!fs.existsSync(BOT_SRC)) return fail(`нет каталога apps/bot/src; ${STEP_NOTE(M.STEP.bot)}`);
    const files = tsFiles(BOT_SRC);
    const hits = files.flatMap((f) => scanFile(f).lits.filter((l) => CYR.test(l.text))).map((l) => `${at(l)} ${l.kind} ${q(l.text, 50)}`);
    const other = otherFiles(BOT_SRC).flatMap((f) => { const c = rawCyr(f); return c == null ? [] : [`${rel(f)} (не код) ${q(c, 50)}`]; });
    const all = [...hits, ...other];
    const detail = `${files.length} исходников apps/bot/src, прочих файлов ${otherFiles(BOT_SRC).length}; литералов и файлов с кириллицей ${all.length}` +
      (all.length ? `: ${all.slice(0, 10).join("; ")}${all.length > 10 ? "; …" : ""}` : "");
    return files.length && !all.length ? pass(detail) : fail(files.length ? detail : `в apps/bot/src нет .ts/.js; ${STEP_NOTE(M.STEP.bot)}`);
  },
};

/* ═════════════ И2/И5: паритет с браузером ═════════════ */

const TG3: Check = {
  id: "TG.3", wp: "TG", kind: "fixture",
  title: "И2: 7 диалогов браузера через route.POST как веб и как бот (id tg_…, x-so-channel: telegram, верный ключ) — ответы (сборка ai, N) равны; в usage.jsonl записи gate/answer несут channel web / telegram",
  run(): Verdict {
    const { out: o } = scenario<ReplayOut>("replay");
    const rows: string[] = [];
    let okResp = true, total = 0;
    o.web.forEach((w, i) => {
      const t = o.tg[i];
      w.reqs.forEach((r, k) => {
        total++;
        const b = t?.reqs[k];
        const st = b?.status;
        const cmp = r.msg && b?.msg ? compareMessages(b.msg, r.msg) : { equal: false, diff: `нет ответа (веб ${r.status}${r.error ? " " + r.error : ""}, бот ${st}${b?.error ? " " + b.error : ""})` };
        if (!cmp.equal || st !== 200) { okResp = false; rows.push(`${w.name} #${k}: бот status=${st}${cmp.diff ? `, ${cmp.diff}` : ""}`); }
      });
    });
    const recs = (ids: Set<string>) => o.usage.filter((x) => ids.has(String(x.chat)) && (x.step === "gate" || x.step === "answer"));
    const webRecs = recs(new Set(o.web.map((d) => d.sessionId)));
    const tgRecs = recs(new Set(o.tg.map((d) => d.sessionId)));
    const webOk = webRecs.filter((x) => x.channel === "web").length;
    const tgOk = tgRecs.filter((x) => x.channel === "telegram").length;
    const okLog = webRecs.length > 0 && tgRecs.length > 0 && webOk === webRecs.length && tgOk === tgRecs.length;
    const sample = (xs: typeof webRecs) => [...new Set(xs.map((x) => show(x.channel ?? null)))].join("/");
    const detail = `ответы веб ≡ бот после N: ${okResp ? `все ${total}` : `расхождений ${rows.length}/${total}: ${rows.slice(0, 4).join("; ")}`} | ` +
      `usage.jsonl: веб-прогон gate/answer с channel:"web" ${webOk}/${webRecs.length} (значения ${sample(webRecs) || "—"}), ` +
      `бот-прогон с channel:"telegram" ${tgOk}/${tgRecs.length} (значения ${sample(tgRecs) || "—"})` +
      (okLog ? "" : ` — поля channel в журнале нет или оно неверно; ${STEP_NOTE(M.STEP.server)} (route.ts: channel во всех log)`);
    return okResp && okLog ? pass(detail) : fail(detail);
  },
};

const TG4: Check = {
  id: "TG.4", wp: "TG", kind: "fixture",
  title: "И5: бот (createCore + фейковый Telegram + fetch → route.POST) на действиях 7 диалогов шлёт ровно 15 запросов; N(тело бота k) ≡ N(записанное тело браузера k); заголовки — браузерные + x-so-channel: telegram и x-so-bot-key (§4.5)",
  run(): Verdict {
    const { out: o } = scenario<BotOut>("bot");
    if (o.missing) return fail(o.missing);
    const dialogs = loadDialogs();
    const rows: string[] = [];
    let equal = 0, total = 0, botTotal = 0;
    o.dialogs.forEach((d, i) => {
      const dlg = dialogs[i];
      const from = d.acts[0]?.postFrom ?? 0, to = d.acts[d.acts.length - 1]?.postTo ?? from;
      const posts = o.posts.slice(from, to);
      botTotal += posts.length;
      const errs = d.acts.filter((a) => a.error).map((a) => `${a.action}: ${a.error}`);
      if (posts.length !== dlg.requests.length) rows.push(`${d.name}: бот послал ${posts.length} запросов, браузер ${dlg.requests.length}${errs.length ? ` (${errs.join("; ")})` : ""}`);
      dlg.requests.forEach((br, k) => {
        total++;
        const bp = posts[k];
        if (!bp) return;
        const b = compareBodies(bp.body, br.body);
        const h = compareHeaders(bp.headers, br.headers, { bodyId: (bp.body as { id?: unknown } | null)?.id, botKey: TEST_KEY });
        if (b.equal && h.equal && bp.status === 200) equal++;
        else rows.push(`${d.name} #${k}: ${b.equal ? "тело ≡" : `тело ≠ (${b.diff})`}; ${h.equal ? "заголовки ок" : `заголовки: ${h.problems.join(", ")}`}; status ${bp.status}`);
      });
    });
    const ok = equal === total && botTotal === total && total === 15;
    const detail = `тел браузера ${total} (ожид. 15), бот послал ${botTotal}; совпали после N с верными заголовками ${equal}/${total}` +
      (rows.length ? ` | ${rows.slice(0, 6).join(" | ")}` : "") + (o.entryMissing ? ` | ${o.entryMissing}` : "");
    return ok ? pass(detail) : fail(detail);
  },
};

const TG5: Check = {
  id: "TG.5", wp: "TG", kind: "fixture",
  title: "Состояние сервера после каждого диалога: у сессии бота query, result.kind, result.report.inputs, pendingInputs, userMessages равны сессии от повтора тел браузера",
  run(): Verdict {
    const { out: b } = scenario<BotOut>("bot");
    if (b.missing) return fail(b.missing);
    const { out: r } = scenario<ReplayOut>("replay");
    const rows = r.web.map((w, i) => {
      const bd = b.dialogs[i];
      const d = bd?.state ? firstDiff(bd.state, w.state) : "у бота нет разговора (peek → undefined)";
      return { name: w.name, ok: d == null, d, web: w.state, sid: bd?.peek?.sessionId };
    });
    const bad = rows.filter((x) => !x.ok);
    const detail = `${rows.length - bad.length}/${rows.length} диалогов совпали` +
      (bad.length ? ` | ${bad.map((x) => `${x.name} (сессия бота ${x.sid ?? "—"}): ${x.d}; веб ${show(x.web)}`).join(" | ")}` : ` | ${rows.map((x) => `${x.name}: ${show(x.web)}`).join("; ").slice(0, 600)}`);
    return bad.length ? fail(detail) : pass(detail);
  },
};

/* ═════════════ И3: один текст отчёта ═════════════ */

/**
 * Подписи веб-контролов в блоках чата, у которых в Telegram нет текстового аналога (роль играет сама кнопка или реплика),
 * — единственное, что в видах чата может прийти не из VM (из WEB @so/present/copy). Список заморожен: менять — решение
 * оркестратора с правкой §4.1 плана. Всё остальное, что видно в блоках чата, обязано прийти из VM (обратная проверка TG.6).
 *   «Проверить» — кнопка строки pick (в Telegram — кнопка кандидата с подписью из VM);
 *   «Посчитать» — отправка формы цены предложения (в Telegram цену пишут репликой);
 *   «Загрузить документ продавца» — неактивная кнопка notfound (в боте загрузки нет);
 *   «Войти и получить полный отчёт» — кнопка плашки (в Telegram — кнопка BOT.fullReport).
 */
const WEB_ONLY_CONTROLS = ["Проверить", "Посчитать", "Загрузить документ продавца", "Войти и получить полный отчёт"];
/** Виды чата, текст которых VM покрывает целиком (ResultApp — нет: шапка сайта app.tsx и формы ввода живут в WEB) */
const CHAT_VIEWS = new Set(["ReportView.compact", "PickView.compact", "NotFoundView.compact", "ErrView.compact"]);
const TG6: Check = {
  id: "TG.6", wp: "TG", kind: "unit",
  title: "И3 (сайт): для 16 golden, 3 живых фикстур и веток pick/notfound/err (1) каждая строка vmStrings(presentReport | presentBranch) есть в SSR ReportView compact (чат) и ResultApp (страница /check); (2) обратно — в SSR видов чата (ReportView/PickView/NotFoundView/ErrView compact) после вычета строк VM и замороженных подписей веб-контролов нет ни буквы, ни цифры: VM покрывает весь видимый текст блоков",
  async run(): Promise<Verdict> {
    const rep = await M.loadReport();
    if (!rep.ok) return fail(rep.why);
    const ssr = await ssrAll();
    const rows: string[] = [];
    let checked = 0, reverse = 0;
    for (const s of samples()) {
      const r = s.res;
      const views: Array<[string, string[]]> = [];
      try {
        if (r.kind === "report") {
          const vm = rep.mod.vmStrings(rep.mod.presentReport(r.report));
          views.push(["ReportView.compact", vm], ["ResultApp", vm]);
        } else {
          const vm = rep.mod.vmStrings(rep.mod.presentBranch(r));
          views.push([r.kind === "pick" ? "PickView.compact" : r.kind === "notfound" ? "NotFoundView.compact" : "ErrView.compact", vm], ["ResultApp", vm]);
        }
      } catch (e) { rows.push(`${s.name}: presentReport/presentBranch бросил ${errMsg(e)}`); continue; }
      for (const [view, strs] of views) {
        checked++;
        const text = ssr[`${s.name}|${view}`] ?? "";
        const hay = squash(text);
        const missing = strs.filter((x) => typeof x !== "string" || !hay.includes(squash(x)));
        if (!strs.length) rows.push(`${s.name} ${view}: vmStrings пуст`);
        else if (missing.length) rows.push(`${s.name} ${view}: нет в SSR ${missing.length}/${strs.length}: ${missing.slice(0, 3).map((x) => q(x, 50)).join(", ")}`);
        if (CHAT_VIEWS.has(view)) {
          reverse++;
          const rest = uncovered(text, [...strs, ...WEB_ONLY_CONTROLS]);
          if (rest.length) rows.push(`${s.name} ${view}: текст блока не из VM (${rest.length} отрезков): ${rest.slice(0, 4).map((x) => q(x, 40)).join(", ")}`);
        }
      }
    }
    const detail = `пар «вход × вид» ${checked}, из них с обратной проверкой (виды чата) ${reverse}; ` +
      (rows.length ? `расхождений ${rows.length}: ${rows.slice(0, 8).join(" | ")}` : "все строки VM есть в SSR, текст блоков чата целиком из VM");
    return rows.length ? fail(detail) : pass(detail);
  },
};

/** Видимый текст сообщений Telegram одной части ответа: HTML → текст, плюс подписи кнопок */
const opsText = (ops: M.TgOp[]) =>
  ops.map((o) => (o.html ? plainOf(o.text) : o.text) + " " + (o.keyboard?.inline_keyboard.flat().map((b) => b.text).join(" ") ?? "")).join(" ");

/** Синтетика §4.7: термин найден / не найден, выход инструмента {error} — в фикстурах браузера explain_term и {error} нет */
const TERM_OK = {
  found: true as const, id: "audit_term", title: "Дюрация <аудит> & «цена»",
  text: "Средний срок до выплат с учётом купонов: чем он больше, тем сильнее цена бумаги меняется вслед за ставками.",
};
const TERM_MISS = { found: false as const, query: "абракадабра", known: ["Дюрация", "Купон"] };
const TOOL_ERR = "Отчёт ещё не собран — сначала назови бумагу."; // tools.ts, set_inputs без отчёта
const SYN_PARTS = { term: 1, miss: 3, err: 4 } as const;
const synthMessage = (): M.UIMsg => ({
  id: "audit_tg_syn", role: "assistant", parts: [
    { type: "step-start" },
    { type: "tool-explain_term", toolCallId: "call_syn_t1", state: "output-available", input: { term: "дюрация" }, output: TERM_OK },
    { type: "text", text: "Коротко про термин — выше.", state: "done" },
    { type: "tool-explain_term", toolCallId: "call_syn_t2", state: "output-available", input: { term: "абракадабра" }, output: TERM_MISS },
    { type: "tool-set_inputs", toolCallId: "call_syn_t3", state: "output-available", input: { k_pct: 0.3 }, output: { error: TOOL_ERR } },
    { type: "text", text: "Сначала назовите бумагу — тогда пересчитаю.", state: "done" },
  ],
});

const TG6TG: Check = {
  id: "TG.6-tg", wp: "TG", kind: "unit",
  title: "И3 (Telegram): на тех же входах (1) каждая строка VM есть в сообщении renderTurn (теги сняты, сущности раскодированы; плюс подписи кнопок); (2) обратно — в сообщении нет букв и цифр сверх строк VM и подписей кнопок BOT.fullReport/BOT.openOnSite; термин found:true → <b>title</b> и текст и ничего сверх, found:false → ничего, {error} → текст ошибки и ничего сверх (§4.7)",
  run: () => botCheck(async (rows, notes) => {
    const mods = await M.loadAll({ report: M.loadReport(), render: M.loadRender(), copy: M.loadCopy() });
    if (!mods.ok) return fail(mods.why);
    const { report: rep, render, copy } = mods.mods;
    const labels = [copy.BOT.fullReport, copy.BOT.openOnSite];
    let checked = 0;
    for (const s of samples()) {
      try {
        const vm = s.res.kind === "report" ? rep.presentReport(s.res.report) : rep.presentBranch(s.res);
        const strs = rep.vmStrings(vm);
        const ops = render.renderTurn(toolMessage(s)).filter((o) => o.partIndex === 0);
        const text = opsText(ops);
        const hay = squash(text);
        checked++;
        const missing = strs.filter((x) => !hay.includes(squash(x)));
        if (!ops.length) { rows.push(`${s.name}: renderTurn не дал сообщений для части отчёта`); continue; }
        if (missing.length) rows.push(`${s.name}: нет в сообщении ${missing.length}/${strs.length}: ${missing.slice(0, 3).map((x) => q(x, 50)).join(", ")}`);
        const rest = uncovered(text, [...strs, ...labels]);
        if (rest.length) rows.push(`${s.name}: текст сообщения не из VM (${rest.length} отрезков): ${rest.slice(0, 4).map((x) => q(x, 40)).join(", ")}`);
      } catch (e) { rows.push(`${s.name}: исключение ${errMsg(e)}`); }
    }
    // термин и ошибка инструмента
    try {
      const ops = render.renderTurn(synthMessage());
      const of = (i: number) => ops.filter((o) => o.partIndex === i);
      const term = of(SYN_PARTS.term);
      const bold = term.filter((o) => o.html).flatMap((o) => [...o.text.matchAll(/<b>([\s\S]*?)<\/b>/g)].map((m) => plainOf(m[1])));
      const termText = opsText(term);
      if (!term.length) rows.push("термин found:true не отрисован");
      else {
        if (!bold.includes(TERM_OK.title)) rows.push(`термин found:true: нет <b>${q(TERM_OK.title, 40)}</b> (жирное: ${show(bold)})`);
        if (!squash(termText).includes(squash(TERM_OK.text))) rows.push("термин found:true: нет текста термина");
        const rest = uncovered(termText, [TERM_OK.title, TERM_OK.text]);
        if (rest.length) rows.push(`термин found:true: текст сверх title и text: ${rest.slice(0, 3).map((x) => q(x, 40)).join(", ")}`);
      }
      if (of(SYN_PARTS.miss).length) rows.push(`термин found:false отрисован: ${q(opsText(of(SYN_PARTS.miss)), 60)}`);
      const err = of(SYN_PARTS.err);
      const errText = opsText(err);
      if (!err.length || !squash(errText).includes(squash(TOOL_ERR))) rows.push(`выход инструмента {error}: ${err.length ? `нет текста ошибки в ${q(errText, 60)}` : "не отрисован"}`);
      else { const rest = uncovered(errText, [TOOL_ERR]); if (rest.length) rows.push(`выход {error}: текст сверх ошибки: ${rest.slice(0, 3).map((x) => q(x, 40)).join(", ")}`); }
      notes.push(`синтетика §4.7: термин ${term.length} сообщ., found:false ${of(SYN_PARTS.miss).length}, {error} ${err.length}`);
    } catch (e) { rows.push(`синтетика §4.7: renderTurn бросил ${errMsg(e)}`); }
    notes.unshift(`входов ${checked}`);
    if (!rows.length) notes.push("все строки VM есть в сообщениях Telegram, сверх VM текста нет");
  }),
};

const BLOCKS_DIR = path.join(REPO_ROOT, "packages", "blocks");
const BLOCK_FILES = ["blocks.tsx", "branches.tsx", "ReportView.tsx", "ui.tsx"].map((f) => path.join(BLOCKS_DIR, "src", f));
/** Относительный импорт → файл (как резолвит TS/бандлер: без расширения, .js → .ts, каталог → index) */
function resolveRel(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
  const cands = [base, ...exts.map((e) => base + e), ...exts.map((e) => path.join(base, "index" + e))];
  if (/\.(m|c)?jsx?$/.test(base)) cands.push(...[".ts", ".tsx", ".mts", ".cts"].map((e) => base.replace(/\.(m|c)?jsx?$/, "") + e));
  return cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}
const TG7: Check = {
  id: "TG.7", wp: "TG", kind: "static",
  title: "В packages/blocks/src/{blocks,branches,ReportView,ui}.tsx И во всём замыкании их относительных импортов (любой новый texts.ts, JSON, app.tsx, если его импортируют) нет кириллицы в литералах и JSX-тексте вне комментариев; импорты за пределы packages/blocks, самоимпорт @so/blocks и import() с вычисляемым путём — нарушение (все тексты блоков — из VM @so/present/report)",
  run(): Verdict {
    const seen = new Set<string>();
    const queue = [...BLOCK_FILES];
    const per: Array<{ f: string; hits: string[] }> = [];
    const bad: string[] = [];
    while (queue.length) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (!fs.existsSync(f)) { bad.push(`${rel(f)}: файла нет`); continue; }
      if (!isCode(f)) { const c = rawCyr(f); per.push({ f, hits: c == null ? [] : [`${rel(f)} (не код) ${q(c, 40)}`] }); continue; }
      const s = scanFile(f);
      per.push({ f, hits: s.lits.filter((l) => CYR.test(l.text)).map((l) => `${at(l)} ${l.kind} ${q(l.text, 40)}`) });
      for (const im of s.imports) {
        if (im.spec === "<вычисляемый путь>") { bad.push(`${at(im)}: import() с вычисляемым путём — замыкание не проверяемо`); continue; }
        if (/^@so\/blocks(\/|$)/.test(im.spec)) { bad.push(`${at(im)}: самоимпорт «${im.spec}» — замыкание идёт через index.ts и app.tsx`); continue; }
        if (!im.spec.startsWith(".")) continue;
        const t = resolveRel(f, im.spec);
        if (!t) { if (!/\.(css|scss)$/.test(im.spec)) bad.push(`${at(im)}: импорт «${im.spec}» не разрешён в файл`); continue; }
        if (!t.startsWith(BLOCKS_DIR + path.sep)) { bad.push(`${at(im)}: относительный импорт за пределы packages/blocks (${im.spec})`); continue; }
        queue.push(t);
      }
    }
    const total = per.reduce((a, x) => a + x.hits.length, 0);
    const detail = `файлов в замыкании ${per.length}: ` + per.map((x) => `${path.relative(path.join(BLOCKS_DIR, "src"), x.f)}: ${x.hits.length}`).join(", ") +
      (total ? ` | примеры: ${per.flatMap((x) => x.hits.slice(0, 2)).slice(0, 8).join("; ")}` : "") +
      (bad.length ? ` | импорты: ${bad.slice(0, 6).join("; ")}` : "") + (total || bad.length ? ` | ${STEP_NOTE(M.STEP.report)}` : "");
    return total || bad.length ? fail(`литералов с кириллицей ${total}, нарушений импорта ${bad.length}; ${detail}`) : pass(`кириллицы в литералах нет: ${detail}`);
  },
};

const INJ_SHORT = 'РОЛЬФ <b>&"1Р07</b>';
const INJ_QUERY = '<i>&"Черкизово</i>';
const TG8: Check = {
  id: "TG.8", wp: "TG", kind: "unit",
  title: "Ограничения Telegram на golden, живых фикстурах, инъекциях и синтетике §4.7 (термин found:true/false, {error}): видимая длина ≤ 4096 (и visibleLength бота совпадает с расчётом харнеса), HTML только b/i/code/a и сбалансирован, «<b>&\"» в shortname, запросе и названии термина экранированы, callback_data ≤ 64 байт, кнопок ≤ 100; длинный текст ассистента делится",
  run: () => guarded(async (): Promise<Verdict> => {
    const mods = await M.loadAll({ render: M.loadRender(), html: M.loadHtml() });
    if (!mods.ok) return fail(mods.why);
    const { render, html } = mods.mods;
    const inputs: Array<{ name: string; msg: M.UIMsg; inject?: string }> = samples().map((s) => ({ name: s.name, msg: toolMessage(s, "Отчёт собран — смотрите блоки выше.") }));
    const rolf = readJson<BuildResultT>("packages/engine/golden/expected/rolf.json");
    if (rolf.kind === "report") {
      const r = clone(rolf);
      if (r.kind === "report") r.report.security.shortname = INJ_SHORT;
      inputs.push({ name: "инъекция shortname", msg: toolMessage({ query: "RU000A10ASE2", res: r }), inject: INJ_SHORT });
    }
    const pick = readJson<BuildResultT>("packages/engine/golden/expected/pick-cherkizovo.json");
    if (pick.kind === "pick") inputs.push({ name: "инъекция запроса pick", msg: toolMessage({ query: INJ_QUERY, res: { ...clone(pick), query: INJ_QUERY } }), inject: INJ_QUERY });
    const long = Array.from({ length: 120 }, (_, i) => `Предложение номер ${i + 1} длинного ответа ассистента для проверки деления текста.`).join(" ");
    inputs.push({ name: "длинный текст ассистента", msg: { id: "m", role: "assistant", parts: [{ type: "text", text: long, state: "done" }] } });
    inputs.push({ name: "термин и {error} (§4.7)", msg: synthMessage(), inject: TERM_OK.title });
    const rows: string[] = [];
    let ops = 0, maxLen = 0;
    for (const x of inputs) {
      let out: M.TgOp[];
      try { out = render.renderTurn(x.msg); } catch (e) { rows.push(`${x.name}: renderTurn бросил ${errMsg(e)}`); continue; }
      if (!out.length) { rows.push(`${x.name}: нет сообщений`); continue; }
      for (const o of out) {
        ops++;
        if (o.html) {
          const p = tgHtmlProblems(o.text);
          if (p.length) rows.push(`${x.name}: ${p.slice(0, 2).join("; ")}`);
          const len = tgVisibleLength(o.text);
          maxLen = Math.max(maxLen, len);
          let botLen: number | string;
          try { botLen = html.visibleLength(o.text); } catch (e) { botLen = errMsg(e); }
          if (len > 4096) rows.push(`${x.name}: видимая длина ${len} > 4096`);
          if (botLen !== len) rows.push(`${x.name}: visibleLength бота ${show(botLen)} ≠ ${len}`);
        } else {
          maxLen = Math.max(maxLen, o.text.length);
          if (o.text.length > 4096) rows.push(`${x.name}: простой текст ${o.text.length} > 4096`);
        }
        const btns = o.keyboard?.inline_keyboard.flat() ?? [];
        if (btns.length > 100) rows.push(`${x.name}: кнопок ${btns.length} > 100`);
        for (const b of btns) {
          if (b.callback_data != null && (Buffer.byteLength(b.callback_data, "utf8") > 64 || !b.callback_data)) rows.push(`${x.name}: callback_data ${q(b.callback_data, 40)} — ${Buffer.byteLength(b.callback_data, "utf8")} байт`);
          if (b.callback_data == null && !(b.url && /^https?:\/\//.test(b.url))) rows.push(`${x.name}: кнопка ${q(b.text, 30)} без callback_data и без http(s)-url`);
        }
      }
      if (x.inject) {
        const plain = out.map((o) => (o.html ? plainOf(o.text) : o.text)).join("\n");
        if (!plain.includes(x.inject)) rows.push(`${x.name}: строка ${q(x.inject, 30)} не дошла до текста как есть (не экранирована или потеряна)`);
      }
    }
    const detail = `входов ${inputs.length}, сообщений ${ops}, макс. видимая длина ${maxLen}; ${rows.length ? `нарушений ${rows.length}: ${rows.slice(0, 8).join(" | ")}` : "нарушений нет"}`;
    return rows.length ? fail(detail) : pass(detail);
  }),
};

const TG9: Check = {
  id: "TG.9", wp: "TG", kind: "unit",
  title: "Порядок: renderTurn сохраняет порядок parts во всех сообщениях ассистента из фикстур и в синтетике §4.7 (термин found:true отрисован, found:false — нет, {error} — да, step-start — нет); в прогоне d1 первый ход = sendMessage(WAIT_REPORT) → editMessageText (тот же message_id, отчёт) → sendMessage (текст ответа) — поэтому «выше» в шаблонах гейта верно",
  run: () => guarded(async (): Promise<Verdict> => {
    const mods = await M.loadAll({ render: M.loadRender(), copy: M.loadCopy() });
    if (!mods.ok) return fail(mods.why);
    const { render, copy } = mods.mods;
    const rows: string[] = [];
    // (1) порядок частей на всех сообщениях ассистента, записанных браузером, и на синтетике (explain_term и {error} в фикстурах нет)
    const seen = new Set<string>();
    const all: Array<{ where: string; m: M.UIMsg }> = [];
    for (const d of loadDialogs()) for (const r of d.requests) for (const m of r.body.messages ?? []) {
      if (m.role !== "assistant" || seen.has(m.id)) continue;
      seen.add(m.id);
      all.push({ where: d.name, m });
    }
    all.push({ where: "синтетика §4.7", m: synthMessage() });
    const msgs = all.length;
    for (const { where, m } of all) {
      let ops: M.TgOp[];
      try { ops = render.renderTurn(m); } catch (e) { rows.push(`${where}/${m.id}: renderTurn бросил ${errMsg(e)}`); continue; }
      const idx = ops.map((o) => o.partIndex);
      if (idx.some((v, i) => i > 0 && v < idx[i - 1])) rows.push(`${where}: порядок partIndex ${show(idx)}`);
      m.parts.forEach((p, i) => {
        const type = String(p.type);
        const miss = type === "tool-explain_term" && (p.output as { found?: boolean } | undefined)?.found === false;
        const needs = (type === "text" && String(p.text ?? "").trim() !== "") || (type.startsWith("tool-") && p.state === "output-available" && !miss);
        if (needs && !idx.includes(i)) rows.push(`${where}: часть ${i} (${type}) не отрисована`);
        if (miss && idx.includes(i)) rows.push(`${where}: часть ${i} (explain_term found:false) отрисована — §4.7: ничего`);
        if (type === "step-start" && idx.includes(i)) rows.push(`${where}: step-start отрисован`);
      });
    }
    // (2) прогон d1: вызовы Telegram первого хода
    const { out: o } = scenario<BotOut>("bot");
    let runNote: string;
    if (o.missing) { rows.push(o.missing); runNote = "прогон бота невозможен"; }
    else {
      const d1 = o.dialogs.find((x) => x.name === "d1-main");
      const a = d1?.acts[0];
      const calls = a ? o.tgCalls.slice(a.tgFrom, a.tgTo).filter((c) => c.method !== "sendChatAction") : [];
      const dlg = loadDialogs().find((x) => x.name === "d1-main");
      const expectText = textOfMessage(dlg?.requests[1]?.body.messages?.[1]);
      const [c0, c1] = calls;
      const last = calls[calls.length - 1];
      const middle = calls.slice(2, -1);
      const ok = calls.length >= 3 && c0.method === "sendMessage" && c0.text === copy.WAIT_REPORT &&
        c1.method === "editMessageText" && c1.messageId === c0.messageId && (c1.html ? plainOf(c1.text ?? "") : c1.text ?? "").includes("РОЛЬФ 1Р07") &&
        last.method === "sendMessage" && !last.html && last.text === expectText && middle.every((c) => c.method === "sendMessage" && c.html);
      runNote = `d1, ход 1: ${calls.map((c) => `${c.method}(${c.messageId ?? ""}${c.text ? " " + q(c.html ? plainOf(c.text) : c.text, 40) : ""})`).join(" → ") || "вызовов нет"}`;
      if (!ok) rows.push(`ожидалось sendMessage(${q(copy.WAIT_REPORT, 40)}) → editMessageText(тот же id, отчёт РОЛЬФ 1Р07) → [продолжения отчёта] → sendMessage(${q(expectText, 50)}) без HTML`);
    }
    const detail = `сообщений ассистента (фикстуры и синтетика) ${msgs}; ${runNote}${rows.length ? ` | нарушений ${rows.length}: ${rows.slice(0, 6).join(" | ")}` : ""}`;
    return rows.length ? fail(detail) : pass(detail);
  }),
};

/* ═════════════ вход: deep-link и общий вход сайта ═════════════ */

const TG10: Check = {
  id: "TG.10", wp: "TG", kind: "unit",
  title: "Вход: initialOf(decode(encode(chatParams))) ≡ initialOf(chatParams) на всех golden-отчётах, payload ≤ 64 символов из [A-Za-z0-9_-]; pickMessage(кандидат 0 из d2) ≡ «Проверь RU000A1094F2»; firstText(initialOf(ссылка d6)) ≡ реплика d6 и inputs ≡ inputs тела; ссылка d7 (?m=) ≡ реплика d7",
  async run(): Promise<Verdict> {
    const e = await M.loadEntry();
    if (!e.ok) return fail(e.why);
    const E = e.mod;
    const rows: string[] = [];
    let n = 0;
    for (const c of goldenCases()) {
      const res = readJson<BuildResultT>(`packages/engine/golden/expected/${c.name}.json`);
      if (res.kind !== "report") continue;
      n++;
      try {
        const p = E.chatParams(res, c.query);
        if (!p) { rows.push(`${c.name}: chatParams → null`); continue; }
        const payload = E.encodeStartPayload(p);
        if (payload == null) { rows.push(`${c.name}: encodeStartPayload(${show(p)}) → null`); continue; }
        if (payload.length > 64 || !/^[A-Za-z0-9_-]+$/.test(payload)) rows.push(`${c.name}: payload ${q(payload, 70)} (${payload.length} симв.) вне формата`);
        const back = E.decodeStartPayload(payload);
        const a = E.initialOf(p), b = back ? E.initialOf(back) : undefined;
        const d = firstDiff(b ?? null, a ?? null);
        if (d) rows.push(`${c.name}: ${payload} → ${d}`);
      } catch (x) { rows.push(`${c.name}: исключение ${errMsg(x)}`); }
    }
    const dialogs = loadDialogs();
    const d2 = dialogs.find((d) => d.name === "d2-pick");
    const pickPart = d2?.requests[1]?.body.messages?.[1]?.parts.find((p) => p.type === "tool-resolve_security");
    const cand = (pickPart?.output as { result?: { candidates?: Array<{ isin: string | null; secid: string }> } } | undefined)?.result?.candidates?.[0];
    const want2 = d2 ? lastUserText(d2.requests[1]) : "";
    const got2 = cand ? E.pickMessage(cand) : null;
    if (got2 !== want2) rows.push(`d2: pickMessage(${show(cand ?? null)}) = ${q(got2)} ≠ ${q(want2)}`);
    const d6 = dialogs.find((d) => d.name === "d6-check-handoff");
    const u6 = new URL(d6!.actions[0].slice(5), "http://so.local");
    const p6: M.EntryParams = Object.fromEntries([...u6.searchParams.entries()]);
    const i6 = E.initialOf(p6);
    const want6 = d6 ? lastUserText(d6.requests[0]) : "";
    if (!i6 || E.firstText(i6) !== want6) rows.push(`d6: firstText(initialOf(${show(p6)})) = ${q(i6 ? E.firstText(i6) : null)} ≠ ${q(want6)}`);
    if (!i6 || canon(i6.inputs ?? null) !== canon(d6?.requests[0].body.inputs ?? null)) rows.push(`d6: inputs ${show(i6?.inputs ?? null)} ≠ тело браузера ${show(d6?.requests[0].body.inputs)}`);
    const d7 = dialogs.find((d) => d.name === "d7-m-link");
    const m7 = new URL(d7!.actions[0].slice(5), "http://so.local").searchParams.get("m") ?? "";
    const i7 = E.initialOf({ m: m7 });
    const want7 = d7 ? lastUserText(d7.requests[0]) : "";
    if (!i7 || E.firstText(i7) !== want7) rows.push(`d7: firstText(initialOf({m})) = ${q(i7 ? E.firstText(i7) : null)} ≠ ${q(want7)}`);
    const detail = `golden-отчётов ${n}; d2 «${got2}», d6 «${i6 ? E.firstText(i6) : "—"}», d7 «${i7 ? E.firstText(i7) : "—"}»` +
      (rows.length ? ` | нарушений ${rows.length}: ${rows.slice(0, 8).join(" | ")}` : "");
    return rows.length ? fail(detail) : pass(detail);
  },
};

/* ═════════════ сервер: ключ, канал, тексты, схема, top3, промпт ═════════════ */

/** Имя вызываемой функции: f(…) или x.f(…) */
const calleeName = (c: ts.CallExpression) =>
  ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : null;
const SECRET_OPERAND = /SO_BOT_KEY|botKey|bot-key|bot_key/i;
const EMPTYISH = /^(""|''|``|undefined|null|0)$/;
/**
 * Статика §4.3 (динамически не проверяемо): ключ сравнивается crypto.timingSafeEqual над SHA-256 обеих строк, а не «===».
 * Нарушение — нет вызова timingSafeEqual, нет createHash("sha256") или есть сравнение ===/!==/==/!= с операндом про ключ
 * (SO_BOT_KEY, botKey, x-so-bot-key), кроме проверки на пустоту ("" / undefined / null / 0).
 */
function channelStatic(): { rows: string[]; note: string } {
  const f = M.CHANNEL_FILE;
  if (!fs.existsSync(f)) return { rows: [`нет ${rel(f)} — сравнение ключа не проверить; ${STEP_NOTE(M.STEP.server)}`], note: "lib/channel.ts нет" };
  const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let tse = 0, sha = 0;
  const eqs: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name === "timingSafeEqual") tse++;
      const a0 = n.arguments[0];
      if (name === "createHash" && a0 && ts.isStringLiteralLike(a0) && /^sha-?256$/i.test(a0.text)) sha++;
    }
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) {
      const l = n.left.getText(sf), r = n.right.getText(sf);
      const hit = (SECRET_OPERAND.test(l) && !EMPTYISH.test(r.trim())) || (SECRET_OPERAND.test(r) && !EMPTYISH.test(l.trim()));
      if (hit) eqs.push(`строка ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${q(n.getText(sf), 60)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const rows: string[] = [];
  if (!tse) rows.push("lib/channel.ts: нет crypto.timingSafeEqual");
  if (!sha) rows.push("lib/channel.ts: нет createHash(\"sha256\") — сравнивать дайджесты обеих строк (длины равны всегда)");
  if (eqs.length) rows.push(`lib/channel.ts: прямое сравнение ключа ${eqs.slice(0, 3).join("; ")}`);
  return { rows, note: `lib/channel.ts: timingSafeEqual ${tse}, createHash("sha256") ${sha}, прямых сравнений ключа ${eqs.length}` };
}
const TG11: Check = {
  id: "TG.11", wp: "TG", kind: "fixture",
  title: "Ключ бота: 403 без побочных эффектов (userMessages 0, budget.messages без изменений) на tg_-id без заголовков, канал без ключа, неверный ключ той же длины, ключ без tg_-id, ключ без канала, пустой SO_BOT_KEY на сервере; всё верно → 200; тело браузера → 200 и channel:\"web\" в журнале; статика lib/channel.ts: crypto.timingSafeEqual над createHash(\"sha256\"), без прямого сравнения ключа (§4.3)",
  run(): Verdict {
    const cs = channelStatic();
    const { out: o } = scenario<LimitsOut>("limits");
    const rows = o.key.map((c) => {
      const ok = c.expect === 403
        ? c.status === 403 && c.userMessages === 0 && c.budgetDelta === 0
        : c.status === 200 && c.userMessages === 1 && (!c.name.startsWith("(f)") || (c.channels.length > 0 && c.channels.every((x) => x === "web")));
      return { c, ok };
    });
    const bad = rows.filter((x) => !x.ok);
    const fmt = ({ c }: (typeof rows)[number]) => `${c.name}: status ${c.status ?? `исключение (${c.error})`} (ожид. ${c.expect}), userMessages ${c.userMessages}, budget.messages +${c.budgetDelta}, channel в журнале ${show(c.channels)}`;
    const detail = `${rows.length - bad.length}/${rows.length} ок` + (bad.length ? ` | НЕ ок: ${bad.map(fmt).join(" | ")}` : ` | ${rows.map(fmt).join(" | ")}`) +
      ` | статика: ${cs.rows.length ? cs.rows.join("; ") : cs.note}` +
      (bad.length || cs.rows.length ? ` | ${STEP_NOTE(M.STEP.server)} (lib/channel.ts + route.ts до getSession)` : "");
    return bad.length || cs.rows.length ? fail(detail) : pass(detail);
  },
};

const NEW_RE = /\/new\b/;
const REFRESH_RE = /обновите страницу/i;
const HOME_RE = /откройте главную страницу/i;
function limitsSanity(o: LimitsOut) {
  if (o.messageLimit !== 2) throw new Error(`дефект харнеса: SO_MESSAGE_LIMIT в сценарии limits = ${o.messageLimit}, ожидалось 2`);
  if (!o.exhausted) throw new Error("дефект харнеса: бюджет в сценарии limits не исчерпан (budget.json не подхвачен)");
}
const TG12: Check = {
  id: "TG.12", wp: "TG", kind: "fixture",
  title: "Тексты отказа для Telegram: при SO_MESSAGE_LIMIT=2 третий ход бота получает limitText(\"telegram\") — с /new, без «Обновите страницу»; при исчерпанном бюджете — budgetExhaustedText(\"telegram\") без «откройте главную страницу»",
  run(): Verdict {
    const { out: o } = scenario<LimitsOut>("limits");
    limitsSanity(o);
    const lim = o.tgLimit[2], bud = o.tgBudget;
    const pre = o.tgLimit.slice(0, 2).every((x) => x.status === 200);
    const okLim = lim?.status === 200 && NEW_RE.test(lim.text) && !REFRESH_RE.test(lim.text) && (!o.copy.ok || lim.text === o.copy.limitTg);
    const okBud = bud.status === 200 && !HOME_RE.test(bud.text) && (!o.copy.ok || bud.text === o.copy.budgetTg);
    const detail = `третий ход бота (лимит ${o.messageLimit}): status ${lim?.status}, ${q(lim?.text)} — /new: ${NEW_RE.test(lim?.text ?? "")}, «Обновите страницу»: ${REFRESH_RE.test(lim?.text ?? "")}` +
      `${o.copy.ok ? `, ≡ limitText("telegram"): ${lim?.text === o.copy.limitTg}` : ""} | бюджет исчерпан: status ${bud.status}, ${q(bud.text)} — «откройте главную страницу»: ${HOME_RE.test(bud.text)}` +
      `${o.copy.ok ? `, ≡ budgetExhaustedText("telegram"): ${bud.text === o.copy.budgetTg}` : ""}${pre ? "" : " | ПРЕДУСЛОВИЕ: первые два хода не 200"}` +
      (o.copy.ok ? "" : ` | ${o.copy.why}`) + (okLim && okBud ? "" : ` | ${STEP_NOTE(M.STEP.server)}`);
    return okLim && okBud && pre && o.copy.ok ? pass(detail) : fail(detail);
  },
};

const CONSUMERS: Array<[string, string]> = [
  ["schema", "ReportInputsSchema"], ["reportGet", "/api/report GET"], ["reportPost", "/api/report POST"], ["chatInputs", "/api/chat body.inputs"],
  ["checkPage", "/check (страница)"], ["initialOf", "initialOf (/chat?q=)"], ["deepLink", "decodeStartPayload → initialOf"],
];
const TG13: Check = {
  id: "TG.13", wp: "TG", kind: "fixture",
  title: "И4: @so/engine/contract экспортирует ReportInputsSchema, tools.inputsSchema — тот же объект; одна таблица (NaN, pos 999, k 3,5, promised 101, price 0 и 301, плюс валидные) одинаково отклоняется/принимается в /api/report GET и POST, body.inputs /api/chat, /check, initialOf, decodeStartPayload; в check/page.tsx нет своего num() без схемы",
  run(): Verdict {
    const { out: o } = scenario<InputsOut>("inputs");
    const per = CONSUMERS.map(([k, label]) => {
      const wrong = o.rows.filter((r) => r.cells[k]?.v !== (r.valid ? "accept" : "reject"));
      return { k, label, wrong };
    });
    const pageSrc = readSrc("apps/web/app/check/page.tsx");
    const ownNum = /\b(const|function)\s+num\b/.test(pageSrc);
    const usesSchema = /ReportInputsSchema|inputsSchema|@so\/present\/entry/.test(pageSrc);
    const okStatic = !ownNum || usesSchema;
    const ok = o.contractHas && o.toolsSame === true && per.every((p) => p.wrong.length === 0) && okStatic;
    const cell = (r: InputsOut["rows"][number], k: string) => `${r.name}→${r.cells[k]?.v ?? "нет"}${r.cells[k]?.note ? ` (${cut(r.cells[k].note, 50)})` : ""}`;
    const detail = `contract.ReportInputsSchema: ${o.contractHas ? "есть" : `НЕТ (экспорты: ${o.contractKeys.join(", ")})`}; tools.inputsSchema тот же объект: ${show(o.toolsSame)} | ` +
      per.map((p) => `${p.label}: ${p.wrong.length ? `расходится ${p.wrong.length}/${o.rows.length} — ${p.wrong.slice(0, 3).map((r) => cell(r, p.k)).join("; ")}` : "ок"}`).join(" | ") +
      ` | check/page.tsx: свой num() ${ownNum}, схема ${usesSchema}` + (o.entryMissing ? ` | ${o.entryMissing}` : "");
    return ok ? pass(detail) : fail(detail);
  },
};

const TG14: Check = {
  id: "TG.14", wp: "TG", kind: "fixture",
  title: "«Главные red flags» гейта берутся из truth_score.top3: в gate.ts нет сортировки по баллам (AST: .sort/.toSorted с points) и есть обращение к top3; на golden-отчётах названия в тексте гейта ≡ названия top3 в том же порядке — и в синтетике, где top3 переставлен (top3-shim.ts) и отличается от сортировки по баллам",
  run(): Verdict {
    const gateFile = path.join(REPO_ROOT, "apps/web/lib/gate.ts");
    const sf = ts.createSourceFile(gateFile, fs.readFileSync(gateFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const sortLines: number[] = [];
    let usesTop3 = false;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ["sort", "toSorted"].includes(calleeName(n) ?? "") && /points/.test(n.getText(sf)))
        sortLines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
      if (ts.isPropertyAccessExpression(n) && n.name.text === "top3") usesTop3 = true;
      if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === "top3") usesTop3 = true;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const sorts = sortLines.length > 0;
    const { out: o } = scenario<MiscOut>("misc");
    if (o.permNote) throw new Error(o.permNote); // дефект харнеса (ERROR), не вердикт о коде
    const judge = (xs: MiscOut["top3"]) => xs.map((r) => {
      const want = r.top3.map((t) => t.toLowerCase());
      const ok = r.error ? false : r.gate == null ? (r.none ? want.length === 0 : true) : canon(r.gate) === canon(want);
      return { r, want, ok };
    });
    const rows = judge(o.top3), perm = judge(o.top3Perm);
    const bad = rows.filter((x) => !x.ok), badPerm = perm.filter((x) => !x.ok);
    const withFlags = rows.filter((x) => x.r.gate != null).length;
    const permDiff = perm.filter((x) => x.r.top3.length > 1 && x.r.top3.join("|") !== x.r.byPoints.join("|")).length;
    const fmtBad = (xs: typeof bad) => xs.map((x) => `${x.r.name}: гейт ${show(x.r.gate)} vs top3 ${show(x.want)}${x.r.error ? ` (${x.r.error})` : ""}`).join("; ");
    const detail = `gate.ts: сортировка по баллам ${sorts ? `да (строки ${sortLines.join(", ")})` : "нет"}, обращение к top3 ${usesTop3} | ` +
      `golden-отчётов ${rows.length}, с фразой «Главные red flags» ${withFlags}; расхождений с top3 ${bad.length}${bad.length ? `: ${fmtBad(bad)}` : ""} | ` +
      `синтетика (top3 переставлен, отличается от порядка по баллам в ${permDiff} кейсах): расхождений ${badPerm.length}${badPerm.length ? `: ${fmtBad(badPerm.slice(0, 4))}` : ""}` +
      (sorts || !usesTop3 || badPerm.length ? ` | ${STEP_NOTE(M.STEP.server)}` : "");
    return !sorts && usesTop3 && bad.length === 0 && badPerm.length === 0 ? pass(detail) : fail(detail);
  },
};

/** «Ниже»/«справа»/«слева» как место на экране (в Telegram порядок другой, на мобильном сайте «справа» неверно); «ниже биржевой» — сравнение, не место */
const POSITIONAL: Array<[string, RegExp]> = [
  ["справа", /справа/i], ["слева", /слева/i],
  ["… ниже (место)", /(в\s+блоке|блок[а-яё]*|в\s+списке|списк[а-яё]*|карточк[а-яё]*|показан[а-яё]*|смотрите|см\.)\s+ниже|ниже\s*[»,.;:)!?]|ниже$/im],
];
const positional = (s: string) => POSITIONAL.filter(([, re]) => re.test(s)).map(([n]) => n);
const TG15: Check = {
  id: "TG.15", wp: "TG", kind: "static",
  title: "Нейтральные слова: в SYSTEM_PROMPT нет «справа», «слева», «ниже» как места на экране; в telegram-текстах @so/present/copy нет «справа», «ниже», «обновите страницу»",
  async run(): Promise<Verdict> {
    const { SYSTEM_PROMPT } = await import("../../lib/prompt");
    const lines = SYSTEM_PROMPT.split("\n").map((l, i) => ({ n: i + 1, l, hit: positional(l) })).filter((x) => x.hit.length);
    const copy = await M.loadCopy();
    let copyNote: string;
    const copyBad: string[] = [];
    if (!copy.ok) copyNote = copy.why;
    else {
      const C = copy.mod;
      const texts: Array<[string, string]> = [
        ...Object.entries(C.BOT).flatMap(([k, v]): Array<[string, string]> => typeof v === "string" ? [[`BOT.${k}`, v]] : typeof v === "function" ? [[`BOT.${k}(…)`, String((v as (x: unknown) => unknown)(k === "dailyLimit" ? 60 : "AbCdEf123456"))]] : []),
        ["limitText(telegram, 20)", C.limitText("telegram", 20)], ["budgetExhaustedText(telegram)", C.budgetExhaustedText("telegram")],
        ["WAIT_REPORT", C.WAIT_REPORT], ["WAIT_TERM", C.WAIT_TERM], ["DISCLAIMER", C.DISCLAIMER],
      ];
      for (const [k, v] of texts) {
        const hit = [...positional(v), ...(REFRESH_RE.test(v) ? ["обновите страницу"] : [])];
        if (hit.length) copyBad.push(`${k}: ${hit.join(", ")} в ${q(v, 70)}`);
      }
      copyNote = `telegram-текстов copy ${texts.length}, с запрещёнными словами ${copyBad.length}${copyBad.length ? `: ${copyBad.join("; ")}` : ""}`;
    }
    const ok = lines.length === 0 && copy.ok && copyBad.length === 0;
    const detail = `SYSTEM_PROMPT (lib/prompt.ts): ${lines.length ? lines.map((x) => `строка ${x.n} [${x.hit.join(", ")}] ${q(x.l.match(/[^.]*(справа|слева|ниже)[^.]*/i)?.[0] ?? x.l, 110)}`).join("; ") : "место на экране не упоминается"} | ${copyNote}` +
      (ok ? "" : ` | ${STEP_NOTE(M.STEP.server)} (prompt.ts:11) и ${STEP_NOTE(M.STEP.present)} (copy)`);
    return ok ? pass(detail) : fail(detail);
  },
};

/* ═════════════ ядро бота: очередь, повтор, Telegram, доступ, сессия (в процессе харнеса) ═════════════ */

const TG16: Check = {
  id: "TG.16", wp: "TG", kind: "unit",
  title: "Очередь: повторный update_id → один POST; один чат — последовательно (второй POST после ответа на первый, с историей), разные чаты — параллельно; 6 чатов при concurrency 4 → в полёте ≤ 4; при ходе в полёте и 2 ожидающих 4-е сообщение чата → BOT.busy без POST; кнопка во время хода → answerCallbackQuery(BOT.busy) без POST",
  run: () => botCheck(async (rows, notes) => {
    const mods = await M.loadAll({ core: M.loadCore(), copy: M.loadCopy() });
    if (!mods.ok) return fail(mods.why);
    const { core, copy } = mods.mods;
    {
      // (1) дедуп
      {
        const s = stubServer(); const R = rig(core, s); const u = testUser(31);
        const upd = messageUpdate(u, "Проверь RU000A10ASE2");
        await within(R.c.handleUpdate(upd), 5_000, "handleUpdate");
        await within(R.c.handleUpdate(clone(upd)), 5_000, "handleUpdate (повтор)");
        await within(R.c.idle(), 5_000, "idle");
        notes.push(`дедуп: POST ${s.posts.length}`);
        if (s.posts.length !== 1) rows.push(`повторный update_id: POST ${s.posts.length} (ожид. 1)`);
      }
      // (2) один чат последовательно: дождаться первого POST, затем окно GRACE_MS — второго быть не должно
      {
        const s = stubServer({ hold: true }); const R = rig(core, s); const u = testUser(32);
        const p = [R.c.handleUpdate(messageUpdate(u, "Проверь RU000A10ASE2")), R.c.handleUpdate(messageUpdate(u, "вложу 2 млн"))];
        await until(() => s.posts.length >= 1, 5_000);
        await settle(GRACE_MS);
        const held = s.posts.length;
        await drain(s, R.c);
        await within(Promise.all(p), 5_000, "ходы одного чата");
        const second = s.posts[1]?.body.messages?.length ?? 0;
        notes.push(`один чат: в полёте ${held}, всего ${s.posts.length}, история второго запроса ${second}`);
        if (held !== 1 || s.posts.length !== 2 || second !== 3) rows.push(`один чат: пока первый ход не завершён, POST ${held} (ожид. 1); всего ${s.posts.length} (ожид. 2); сообщений во втором теле ${second} (ожид. 3: реплика, ответ, реплика)`);
      }
      // (3) разные чаты параллельно, concurrency 4: дождаться 4 одновременных POST (не дольше 2 с), затем окно — пятого быть не должно
      {
        const s = stubServer({ hold: true }); const R = rig(core, s, { concurrency: 4 });
        const p = Array.from({ length: 6 }, (_, i) => R.c.handleUpdate(messageUpdate(testUser(40 + i), `Проверь RU000A10ASE${i}`)));
        await until(() => s.posts.length >= 4, 2_000);
        await settle(GRACE_MS);
        const held = s.posts.length;
        await drain(s, R.c);
        await within(Promise.all(p), 5_000, "ходы 6 чатов");
        notes.push(`6 чатов: в полёте ${held}, макс. ${s.st.maxInFlight}, всего ${s.posts.length}`);
        if (held < 2 || held > 4 || s.st.maxInFlight > 4 || s.posts.length !== 6) rows.push(`6 чатов при concurrency 4: одновременно ${held} (ожид. 2…4, разные чаты параллельно), макс. ${s.st.maxInFlight} (≤ 4), всего POST ${s.posts.length} (ожид. 6)`);
      }
      // (4) переполнение очереди чата
      {
        const s = stubServer({ hold: true }); const R = rig(core, s, { perChatPending: 2 }); const u = testUser(50);
        const p = [1, 2, 3, 4].map((i) => R.c.handleUpdate(messageUpdate(u, `реплика ${i}`)));
        await until(() => s.posts.length >= 1 && sent(R.tg, u.chatId, copy.BOT.busy).length >= 1, 5_000);
        await settle(GRACE_MS);
        const busy = sent(R.tg, u.chatId, copy.BOT.busy).length;
        await drain(s, R.c);
        await within(Promise.all(p), 5_000, "ходы с переполнением");
        notes.push(`переполнение: busy ${busy}, POST ${s.posts.length}`);
        if (busy !== 1 || s.posts.length !== 3) rows.push(`ход в полёте + 2 ожидающих, 4-е сообщение: BOT.busy отправлен ${busy} раз (ожид. 1), POST ${s.posts.length} (ожид. 3)`);
      }
      // (5) кнопка во время хода
      {
        const s = stubServer({ hold: true }); const R = rig(core, s); const u = testUser(51);
        const p = R.c.handleUpdate(messageUpdate(u, "Черкизово"));
        await until(() => s.posts.length >= 1, 5_000);
        await within(R.c.handleUpdate(callbackUpdate(u, "sg:0", 1)), 3_000, "callback во время хода");
        const ans = R.tg.calls.filter((c) => c.method === "answerCallbackQuery");
        await drain(s, R.c);
        await within(p, 5_000, "ход");
        notes.push(`кнопка: answerCallbackQuery ${show(ans.map((a) => a.text))}, POST ${s.posts.length}`);
        if (!ans.some((a) => a.text === copy.BOT.busy) || s.posts.length !== 1) rows.push(`кнопка во время хода: answerCallbackQuery(BOT.busy) ${ans.some((a) => a.text === copy.BOT.busy)}, POST ${s.posts.length} (ожид. 1)`);
      }
    }
  }),
};

const TG17: Check = {
  id: "TG.17", wp: "TG", kind: "unit",
  title: "Повтор POST только при ECONNREFUSED: 2 отказа и ответ → 3 POST, ответ доставлен (паузы 2 и 8 с); отказ всегда → 4 POST (паузы 2/8/20 с), BOT.serviceRestarting, реплики в истории нет; HTTP 500, обрыв потока, таймаут, ECONNRESET → ровно 1 POST и BOT.turnFailed, реплика в истории остаётся",
  run: () => botCheck(async (rows, notes) => {
    const mods = await M.loadAll({ core: M.loadCore(), copy: M.loadCopy() });
    if (!mods.ok) return fail(mods.why);
    const { core, copy } = mods.mods;
    const say = "Проверь RU000A10ASE2";
    const inHistory = (c: M.BotCore, chatId: number) => (c.peek(chatId)?.messages ?? []).some((m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text === say));
    const run = async (name: string, script: Step[], over: Partial<M.BotConfig> = {}) => {
      const s = stubServer({ script }); const R = rig(core, s, over); const u = testUser(60 + rows.length + notes.length);
      try {
        await within(R.c.handleUpdate(messageUpdate(u, say)), 8_000, `${name}: handleUpdate`);
        await within(R.c.idle(), 8_000, `${name}: idle`);
      } catch (e) { rows.push(`${name}: ${errMsg(e)}`); }
      return { s, R, u };
    };
    try {
      {
        const { s, R, u } = await run("2×ECONNREFUSED → ответ", ["refused", "refused", "ok"]);
        const got = sent(R.tg, u.chatId).some((c) => (c.text ?? "").includes(REPLY));
        notes.push(`2 отказа: POST ${s.posts.length}, паузы ${show(R.sleeps.slice(0, 6))}, ответ доставлен ${got}`);
        if (s.posts.length !== 3 || !got || !hasSubseq(R.sleeps, [2000, 8000])) rows.push(`2×ECONNREFUSED → ответ: POST ${s.posts.length} (ожид. 3), ответ доставлен ${got}, паузы ${show(R.sleeps)} (ожид. 2000, 8000)`);
      }
      {
        const { s, R, u } = await run("ECONNREFUSED всегда", ["refused"]);
        const restarting = sent(R.tg, u.chatId, copy.BOT.serviceRestarting).length;
        const hist = inHistory(R.c, u.chatId);
        notes.push(`отказ всегда: POST ${s.posts.length}, паузы ${show(R.sleeps.slice(0, 6))}, serviceRestarting ${restarting}, реплика в истории ${hist}`);
        if (s.posts.length !== 4 || restarting !== 1 || hist || !hasSubseq(R.sleeps, [2000, 8000, 20000])) rows.push(`ECONNREFUSED всегда: POST ${s.posts.length} (ожид. 4), BOT.serviceRestarting ${restarting} (ожид. 1), реплика в истории ${hist} (ожид. нет), паузы ${show(R.sleeps)} (ожид. 2000, 8000, 20000)`);
      }
      for (const [name, script, over] of [
        ["HTTP 500", ["500"], {}], ["обрыв потока", ["break"], {}], ["таймаут", ["hang"], { turnTimeoutMs: 300 }], ["ECONNRESET", ["reset"], {}],
      ] as Array<[string, Step[], Partial<M.BotConfig>]>) {
        const { s, R, u } = await run(name, script, over);
        const failed = sent(R.tg, u.chatId, copy.BOT.turnFailed).length;
        const hist = inHistory(R.c, u.chatId);
        notes.push(`${name}: POST ${s.posts.length}, turnFailed ${failed}, реплика в истории ${hist}`);
        if (s.posts.length !== 1 || failed !== 1 || !hist) rows.push(`${name}: POST ${s.posts.length} (ожид. 1), BOT.turnFailed ${failed} (ожид. 1), реплика в истории ${hist} (ожид. да, как у AbstractChat)`);
      }
    } catch (e) { rows.push(`исключение: ${errMsg(e)}`); }
  }),
};

const OTHER_TOKEN = "987654321:AAFotherTOKENotherTOKENotherTOKEN6789"; // не в списке секретов — режется по шаблону bot<цифры>:…
const TG18: Check = {
  id: "TG.18", wp: "TG", kind: "unit",
  title: "Сбои Telegram (withTelegramPolicy): 429 retry_after 3 → пауза 3000 мс и повтор, не больше 3 повторов; 400 «can't parse entities» → тот же текст без HTML; ошибка с токеном → в журнале <redacted> (makeLogger режет секреты и шаблон bot<цифры>:…)",
  run: () => botCheck(async (rows, notes) => {
    const mods = await M.loadAll({ tgm: M.loadTelegram(), log: M.loadLog() });
    if (!mods.ok) return fail(mods.why);
    const { tgm, log } = mods.mods;
    const lines: string[] = [];
    const logger = log.makeLogger((l) => lines.push(l), [TEST_TOKEN, TEST_KEY]);
    const policy = (raw: ReturnType<typeof scriptedRaw>, sleeps: number[]) => tgm.withTelegramPolicy(raw.client, { sleep: async (ms) => { sleeps.push(ms); }, log: logger });
    const e429 = () => apiError({ error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } });
    try {
      {
        const raw = scriptedRaw([e429(), null]); const sl: number[] = [];
        await within(policy(raw, sl).sendMessage(1, "текст"), 3_000, "429 → повтор");
        notes.push(`429: вызовов ${raw.calls.length}, паузы ${show(sl)}`);
        if (raw.calls.length !== 2 || !sl.includes(3000)) rows.push(`429 retry_after 3: вызовов ${raw.calls.length} (ожид. 2), паузы ${show(sl)} (ожид. 3000)`);
      }
      {
        const raw = scriptedRaw([e429()]); const sl: number[] = [];
        let threw = false;
        try { await within(policy(raw, sl).sendMessage(1, "текст"), 3_000, "429 всегда"); } catch { threw = true; }
        notes.push(`429 всегда: вызовов ${raw.calls.length}, ошибка наверх ${threw}`);
        if (raw.calls.length > 4 || raw.calls.length < 2 || !threw) rows.push(`429 всегда: вызовов ${raw.calls.length} (ожид. 2…4 — не больше 3 повторов), ошибка наверх ${threw}`);
      }
      {
        const raw = scriptedRaw([apiError({ error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 0" }), null]); const sl: number[] = [];
        const htmlText = "<b>Отчёт</b> &amp; <i>РОЛЬФ</i> &lt;1Р07&gt;";
        await within(policy(raw, sl).sendMessage(1, htmlText, { html: true }), 3_000, "400 entities");
        const second = raw.calls[1];
        const want = "Отчёт & РОЛЬФ <1Р07>";
        notes.push(`400 entities: второй вызов html=${second?.html}, текст ${q(second?.text, 40)}`);
        if (!second || second.html || second.text !== want) rows.push(`400 «can't parse entities»: второй вызов ${second ? `html=${second.html}, ${q(second.text, 50)}` : "не сделан"} (ожид. без HTML: ${q(want)})`);
      }
      {
        const before = lines.length;
        const raw = scriptedRaw([apiError({ error_code: 403, description: `Forbidden: bot was blocked by the user (https://api.telegram.org/bot${TEST_TOKEN}/sendMessage)` },
          `Call to 'sendMessage' failed! https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`)]);
        try { await within(policy(raw, []).sendMessage(1, "текст"), 3_000, "403"); } catch { /* ошибка наверх допустима */ }
        const fresh = lines.slice(before);
        notes.push(`ошибка с токеном: строк журнала ${fresh.length}`);
        if (!fresh.length) rows.push("ошибка Telegram с токеном не записана в журнал");
        if (fresh.some((l) => l.includes(TEST_TOKEN))) rows.push("токен попал в журнал");
        if (fresh.length && !fresh.some((l) => l.includes("<redacted>"))) rows.push(`в журнале нет <redacted>: ${q(fresh.join(" "), 100)}`);
      }
      {
        const ls: string[] = [];
        log.makeLogger((l) => ls.push(l), [TEST_KEY])({ ev: "tg_error", err: `ключ ${TEST_KEY}; url https://api.telegram.org/bot${OTHER_TOKEN}/getUpdates` });
        const l = ls.join("\n");
        notes.push(`makeLogger: ${q(l, 80)}`);
        if (!ls.length || l.includes(TEST_KEY) || l.includes(OTHER_TOKEN) || l.includes(OTHER_TOKEN.split(":")[1]) || !l.includes("<redacted>")) rows.push(`makeLogger: секрет или токен по шаблону не вырезан: ${q(l, 120)}`);
      }
    } catch (e) { rows.push(`исключение: ${errMsg(e)}`); }
  }),
};

const TG19: Check = {
  id: "TG.19", wp: "TG", kind: "unit",
  title: "Доступ и лимиты: allow \"\" — никого, \"*\" — всех, список псевдонимов — только их, остальным BOT.notAllowed(код) без POST; dailyTurns=2 — третий ход за сутки МСК → BOT.dailyLimit без POST, после полуночи МСК снова идёт; group/supergroup — игнор; фото, голос, документ → BOT.onlyText без POST",
  run: () => botCheck(async (rows, notes) => {
    const mods = await M.loadAll({ core: M.loadCore(), copy: M.loadCopy(), ids: M.loadIds(), limits: M.loadLimits() });
    if (!mods.ok) return fail(mods.why);
    const { core, copy, ids, limits } = mods.mods;
    try {
      const cases: Array<[string, string, boolean]> = [["abc", "", false], ["abc", "*", true], ["abc", "abc,def", true], ["def", "abc,def", true], ["xyz", "abc,def", false]];
      const badAllow = cases.filter(([p, a, w]) => limits.isAllowed(p, a) !== w);
      if (badAllow.length) rows.push(`isAllowed: ${badAllow.map(([p, a, w]) => `(${p}, ${show(a)}) → ${!w} (ожид. ${w})`).join("; ")}`);
      {
        const a = testUser(70), b = testUser(71);
        const pa = ids.pseudonymOf(a.chatId, TEST_SALT), pb = ids.pseudonymOf(b.chatId, TEST_SALT);
        const s = stubServer(); const R = rig(core, s, { allow: pa });
        await within(R.c.handleUpdate(messageUpdate(a, "Проверь RU000A10ASE2")), 5_000, "allow a");
        await within(R.c.handleUpdate(messageUpdate(b, "Проверь RU000A10ASE2")), 5_000, "allow b");
        await within(R.c.idle(), 5_000, "idle");
        const refused = sent(R.tg, b.chatId, copy.BOT.notAllowed(pb)).length;
        notes.push(`allowlist: POST ${s.posts.length}, отказ с кодом ${refused}`);
        if (s.posts.length !== 1 || refused !== 1) rows.push(`allowlist [${pa}]: POST ${s.posts.length} (ожид. 1 — только разрешённый), BOT.notAllowed(${pb}) отправлен ${refused} (ожид. 1)`);
      }
      {
        let t = Date.parse("2026-10-14T20:50:00.000Z"); // 23:50 МСК
        const dl = new limits.DailyLimit(2, () => t);
        const r1 = [dl.take("p"), dl.take("p"), dl.take("p")];
        t = Date.parse("2026-10-14T21:00:30.000Z"); // 00:00:30 МСК 15.10 — те же сутки по UTC
        const r2 = dl.take("p");
        notes.push(`DailyLimit: ${show(r1)} → после полуночи МСК ${r2}`);
        if (canon(r1) !== canon([true, true, false]) || r2 !== true) rows.push(`DailyLimit(2): ${show(r1)} (ожид. [true,true,false]), после 00:00 МСК ${r2} (ожид. true — сутки по МСК, не по UTC)`);
      }
      {
        const u = testUser(72);
        const s = stubServer(); const R = rig(core, s, { dailyTurns: 2 }, Date.parse("2026-10-14T20:50:00.000Z"));
        for (const t of ["реплика 1", "реплика 2", "реплика 3"]) { await within(R.c.handleUpdate(messageUpdate(u, t)), 5_000, t); await within(R.c.idle(), 5_000, "idle"); }
        const limited = sent(R.tg, u.chatId, copy.BOT.dailyLimit(2)).length;
        const before = s.posts.length;
        R.clock.t = Date.parse("2026-10-14T21:00:30.000Z");
        await within(R.c.handleUpdate(messageUpdate(u, "реплика 4")), 5_000, "реплика 4"); await within(R.c.idle(), 5_000, "idle");
        notes.push(`dailyTurns=2: POST ${before} → после полуночи ${s.posts.length}, dailyLimit ${limited}`);
        if (before !== 2 || limited !== 1 || s.posts.length !== 3) rows.push(`dailyTurns=2: POST за сутки ${before} (ожид. 2), BOT.dailyLimit(2) ${limited} (ожид. 1), после 00:00 МСК POST ${s.posts.length} (ожид. 3)`);
      }
      {
        const u = testUser(73);
        const s = stubServer(); const R = rig(core, s);
        for (const type of ["group", "supergroup"]) await within(R.c.handleUpdate(messageUpdate(u, "Проверь RU000A10ASE2", { type })), 5_000, type);
        const media: Array<[string, Record<string, unknown>]> = [
          ["фото", { photo: [{ file_id: "audit_ph", file_unique_id: "u1", width: 90, height: 90 }] }],
          ["голос", { voice: { file_id: "audit_vo", file_unique_id: "u2", duration: 3 } }],
          ["документ", { document: { file_id: "audit_doc", file_unique_id: "u3", file_name: "prospect.pdf" } }],
        ];
        for (const [, extra] of media) await within(R.c.handleUpdate(messageUpdate(u, null, { extra })), 5_000, "медиа");
        await within(R.c.idle(), 5_000, "idle");
        const groupCalls = R.tg.calls.filter((c) => c.chatId === -u.chatId).length;
        const onlyText = sent(R.tg, u.chatId, copy.BOT.onlyText).length;
        notes.push(`группы: вызовов ${groupCalls}; медиа: onlyText ${onlyText}; POST ${s.posts.length}`);
        if (groupCalls || s.posts.length || onlyText !== 3) rows.push(`группы и медиа: вызовов Telegram в группах ${groupCalls} (ожид. 0), BOT.onlyText ${onlyText} (ожид. 3), POST ${s.posts.length} (ожид. 0)`);
      }
    } catch (e) { rows.push(`исключение: ${errMsg(e)}`); }
  }),
};

const TG20: Check = {
  id: "TG.20", wp: "TG", kind: "fixture",
  title: "Приватность (прогон TG.4 с журналами): в журнале бота и usage.jsonl нет chat_id, user_id, username и имени из апдейтов, токена, SO_BOT_KEY и соли; в журнале бота нет текстов реплик; chat бота в usage.jsonl начинается с tg_",
  run(): Verdict {
    const { out: o } = scenario<BotOut>("bot");
    if (o.missing) return fail(o.missing);
    const secrets: Array<[string, string]> = [["токен", TEST_TOKEN], ["SO_BOT_KEY", TEST_KEY], ["соль", TEST_SALT]];
    for (const d of o.dialogs) {
      secrets.push([`chat_id ${d.name}`, String(d.user.chatId)], [`username ${d.name}`, d.user.username], [`фамилия ${d.name}`, d.user.last_name]);
    }
    secrets.push(["имя", o.dialogs[0]?.user.first_name ?? "Аудитимя"]);
    const logText = o.logLines.join("\n");
    const usageText = o.usage.map((r) => JSON.stringify(r)).join("\n");
    const inLog = secrets.filter(([, v]) => logText.includes(v)).map(([k]) => k);
    const inUsage = secrets.filter(([, v]) => usageText.includes(v)).map(([k]) => k);
    const texts = loadDialogs().flatMap((d: Dialog) => d.requests.map(lastUserText)).filter((t) => t.length >= 4);
    const textsInLog = [...new Set(texts.filter((t) => logText.includes(t)))];
    // записи без поля chat (route.ts onError → log({ step: "error", … })) — не сессии; считаются отдельно, секреты в них проверены выше
    const withChat = o.usage.filter((r) => r.chat != null);
    const errRecs = o.usage.filter((r) => r.step === "error").length;
    const chats = [...new Set(withChat.map((r) => String(r.chat)))];
    const nonTg = chats.filter((c) => !c.startsWith("tg_"));
    const ok = !inLog.length && !inUsage.length && !textsInLog.length && o.logLines.length > 0 && chats.length > 0 && !nonTg.length;
    const detail = `журнал бота: строк ${o.logLines.length}${o.loggerFromBot ? " (makeLogger бота)" : " (makeLogger нет — сырые LogRec)"}, секреты/ПДн ${inLog.length ? inLog.join(", ") : "нет"}, тексты реплик ${textsInLog.length ? textsInLog.map((t) => q(t, 30)).join(", ") : "нет"} | ` +
      `usage.jsonl: записей ${o.usage.length} (без chat ${o.usage.length - withChat.length}, step:error ${errRecs}), секреты/ПДн ${inUsage.length ? inUsage.join(", ") : "нет"}, сессии ${chats.slice(0, 7).join(", ") || "—"}${nonTg.length ? ` — не tg_: ${nonTg.join(", ")}` : ""}` +
      (o.logLines.length ? "" : " | журнал бота пуст — нечего проверять (ядро должно писать LogRec)");
    return ok ? pass(detail) : fail(detail);
  },
};

const TG21: Check = {
  id: "TG.21", wp: "TG", kind: "unit",
  title: "Сессия: session.ts берёт TTL из SESSION_TTL_MS (и сессия сервера живёт ровно столько); история бота живёт SESSION_TTL_MS − BOT_TTL_MARGIN_MS (> 0); id tg_<12>_<8> с псевдонимом HMAC-SHA256; /new и новый экземпляр ядра с той же солью дают другой id; после TTL — новый id, пустая история, BOT.sessionExpired",
  async run(): Promise<Verdict> {
    const rows: string[] = [];
    const notes: string[] = [];
    // сервер: статика session.ts и динамика TTL (сценарий misc, часы подменены в отдельном процессе)
    const sess = readSrc("apps/web/lib/session.ts");
    const sscan = scanFile(path.join(REPO_ROOT, "apps/web/lib/session.ts"));
    const importsTtl = sscan.imports.some((i) => /^@so\/present\/protocol$/.test(i.spec) && i.names.includes("SESSION_TTL_MS"));
    const literal = /const\s+TTL_MS\s*=\s*60\s*\*\s*60_?000/.test(sess);
    notes.push(`session.ts: импорт SESSION_TTL_MS из @so/present/protocol ${importsTtl}, литерал TTL ${literal}`);
    if (!importsTtl || literal) rows.push(`session.ts не берёт TTL из SESSION_TTL_MS (литерал «60 * 60_000» ${literal}); ${STEP_NOTE(M.STEP.present)}`);
    const { out: misc } = scenario<MiscOut>("misc");
    if (misc.ttl.protoMissing) rows.push(misc.ttl.protoMissing);
    else {
      notes.push(`сессия сервера: TTL ${misc.ttl.ttl} мс, жива за 1 с до TTL ${misc.ttl.aliveBefore}, истекла через TTL+1 с ${misc.ttl.expiredAfter}`);
      if (!misc.ttl.aliveBefore || !misc.ttl.expiredAfter) rows.push("сессия сервера живёт не SESSION_TTL_MS");
    }
    // бот (под noNet: глобальный fetch бросает, обращение к нему — нарушение)
    const { blocked } = await noNet(async () => {
      const mods = await M.loadAll({ core: M.loadCore(), copy: M.loadCopy(), ids: M.loadIds(), proto: M.loadProtocol() });
      if (!mods.ok) rows.push(mods.why);
      else {
        const { core, copy, ids, proto } = mods.mods;
        try {
          const life = proto.SESSION_TTL_MS - proto.BOT_TTL_MARGIN_MS;
          if (!(life > 0)) rows.push(`SESSION_TTL_MS − BOT_TTL_MARGIN_MS = ${life} (ожид. > 0)`);
          const ID_RE = /^tg_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{8}$/;
          const u = testUser(80);
          const pseudo = ids.pseudonymOf(u.chatId, TEST_SALT);
          const hmac = crypto.createHmac("sha256", TEST_SALT).update(String(u.chatId)).digest("base64url").slice(0, 12);
          if (pseudo !== hmac) rows.push(`pseudonymOf ≠ base64url(HMAC-SHA256(соль, chat_id)).slice(0,12): ${pseudo} vs ${hmac}`);
          if (ids.pseudonymOf(u.chatId, TEST_SALT + "x") === pseudo) rows.push("pseudonymOf не зависит от соли");
          const sid0 = ids.newSessionId(pseudo, (n) => new Uint8Array(n).fill(7));
          if (!ID_RE.test(sid0) || !sid0.startsWith(`tg_${pseudo}_`)) rows.push(`newSessionId → ${sid0} (ожид. tg_${pseudo}_<8>)`);
          const s = stubServer();
          const t0 = Date.parse("2026-10-14T09:00:00.000Z");
          const R = rig(core, s, {}, t0);
          const turn = async (c: M.BotCore, text: string) => { await within(c.handleUpdate(messageUpdate(u, text)), 5_000, text); await within(c.idle(), 5_000, "idle"); };
          await turn(R.c, "реплика 1");
          R.clock.t += 60_000;
          await turn(R.c, "реплика 2");
          const [p1, p2] = s.posts;
          await turn(R.c, "/new");
          await turn(R.c, "реплика 3");
          const p3 = s.posts[s.posts.length - 1];
          const R2 = rig(core, s, {}, R.clock.t);
          await turn(R2.c, "реплика 4");
          const p4 = s.posts[s.posts.length - 1];
          R.clock.t += life + 1_000;
          const expiredBefore = sent(R.tg, u.chatId, copy.BOT.sessionExpired).length;
          await turn(R.c, "реплика 5");
          const p5 = s.posts[s.posts.length - 1];
          const expired = sent(R.tg, u.chatId, copy.BOT.sessionExpired).length - expiredBefore;
          const idsSeen = [p1, p2, p3, p4, p5].map((p) => String(p?.body.id ?? "—"));
          const lens = [p1, p2, p3, p4, p5].map((p) => p?.body.messages?.length ?? 0);
          notes.push(`id по ходам ${show(idsSeen)}, сообщений в телах ${show(lens)}, sessionExpired ${expired}`);
          if (!idsSeen.every((x) => ID_RE.test(x) && x.startsWith(`tg_${pseudo}_`))) rows.push(`id не в формате tg_${pseudo}_<8>: ${show(idsSeen)}`);
          if (idsSeen[0] !== idsSeen[1] || lens[1] !== 3) rows.push(`второй ход в той же сессии: id ${idsSeen[1]} (ожид. ${idsSeen[0]}), сообщений ${lens[1]} (ожид. 3)`);
          if (idsSeen[2] === idsSeen[1] || lens[2] !== 1) rows.push(`после /new: id ${idsSeen[2]} (ожид. новый), сообщений ${lens[2]} (ожид. 1)`);
          if (new Set([idsSeen[0], idsSeen[2], idsSeen[3]]).size !== 3) rows.push(`новый экземпляр ядра с той же солью: id ${idsSeen[3]} (ожид. отличный от ${idsSeen[0]} и ${idsSeen[2]})`);
          if (idsSeen[4] === idsSeen[2] || lens[4] !== 1 || expired !== 1) rows.push(`после ${life + 1_000} мс простоя: id ${idsSeen[4]} (ожид. новый), сообщений ${lens[4]} (ожид. 1), BOT.sessionExpired ${expired} (ожид. 1)`);
        } catch (e) { rows.push(`исключение: ${errMsg(e)}`); }
      }
    });
    if (blocked.length) rows.push(netRow(blocked));
    const detail = `${notes.join("; ")}${rows.length ? ` | НЕ ок: ${rows.join(" | ")}` : ""}`;
    return rows.length ? fail(detail) : pass(detail);
  },
};

/* ═════════════ версии и эксплуатация ═════════════ */

function aiCopies(): Array<{ dir: string; version: string }> {
  const found: Array<{ dir: string; version: string }> = [];
  const check = (nm: string) => {
    const p = path.join(nm, "ai", "package.json");
    if (fs.existsSync(p)) found.push({ dir: rel(path.dirname(p)), version: String((JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string }).version) });
  };
  const groups = ["apps", "packages", "tools"].flatMap((g) => {
    const d = path.join(REPO_ROOT, g);
    return fs.existsSync(d) ? fs.readdirSync(d).map((x) => path.join(d, x)) : [];
  });
  for (const r of [REPO_ROOT, ...groups]) {
    const nm = path.join(r, "node_modules");
    if (!fs.existsSync(nm)) continue;
    check(nm);
    for (const e of fs.readdirSync(nm)) {
      if (e.startsWith(".")) continue;
      if (e.startsWith("@")) { for (const s of fs.readdirSync(path.join(nm, e))) check(path.join(nm, e, s, "node_modules")); }
      else check(path.join(nm, e, "node_modules"));
    }
  }
  return found;
}
const TG22: Check = {
  id: "TG.22", wp: "TG", kind: "static",
  title: "Версии: в apps/bot/package.json точные \"ai\": как в apps/web (7.0.133) и \"grammy\": \"1.46.0\"; node_modules/ai — одна копия; в зависимостях бота нет @ai-sdk/* и @openrouter/*",
  run(): Verdict {
    const webAi = readJson<{ dependencies?: Record<string, string> }>("apps/web/package.json").dependencies?.ai ?? null;
    const copies = aiCopies();
    const copiesNote = `копий node_modules/ai ${copies.length}: ${copies.map((c) => `${c.dir}@${c.version}`).join(", ")}`;
    const pj = path.join(M.BOT_DIR, "package.json");
    if (!fs.existsSync(pj)) return fail(`нет apps/bot/package.json; ${STEP_NOTE(M.STEP.bot)} | apps/web: ai ${webAi}; ${copiesNote}`);
    const p = JSON.parse(fs.readFileSync(pj, "utf8")) as { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...(p.devDependencies ?? {}), ...(p.dependencies ?? {}) };
    const rows: string[] = [];
    if (deps.ai !== "7.0.133" || deps.ai !== webAi) rows.push(`ai ${show(deps.ai ?? null)} (ожид. точно "7.0.133", как apps/web ${show(webAi)})`);
    if (deps.grammy !== "1.46.0") rows.push(`grammy ${show(deps.grammy ?? null)} (ожид. точно "1.46.0")`);
    const banned = Object.keys(deps).filter((k) => /^@ai-sdk\/|^@openrouter\//.test(k));
    if (banned.length) rows.push(`запрещённые зависимости: ${banned.join(", ")}`);
    if (copies.length !== 1 || copies[0].version !== "7.0.133") rows.push(copiesNote);
    const detail = `${p.name ?? "?"}: ai ${show(deps.ai ?? null)}, grammy ${show(deps.grammy ?? null)}; ${copiesNote}${rows.length ? ` | НЕ ок: ${rows.join("; ")}` : ""}`;
    return rows.length ? fail(detail) : pass(detail);
  },
};

const codeLines = (s: string) => s.split("\n").map((l, i) => ({ n: i + 1, l })).filter((x) => !/^\s*#/.test(x.l));
/** Узлы AST файла, удовлетворяющие условию (комментарии в разбор не попадают) */
function astFind(file: string, pred: (n: ts.Node, sf: ts.SourceFile) => boolean): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kindOf(file));
  const out: Array<{ line: number; text: string }> = [];
  const visit = (n: ts.Node) => {
    if (pred(n, sf)) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf).replace(/\s+/g, " ").slice(0, 100) });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const callOf = (name: string) => (n: ts.Node) => ts.isCallExpression(n) && calleeName(n) === name;
/** process.env.NAME точечным доступом — только его Next подставляет при сборке (env в next.config) */
const envDot = (name: string) => (n: ts.Node, sf: ts.SourceFile) =>
  ts.isPropertyAccessExpression(n) && n.name.text === name && n.expression.getText(sf).replace(/\s+/g, "") === "process.env";
const firstLine = (xs: Array<{ line: number }>) => (xs.length ? Math.min(...xs.map((x) => x.line)) : null);
/** Ключ объекта (свойство или сокращённая запись) с данным именем */
const propName = (p: ts.ObjectLiteralElementLike) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null);
const HEALTH_FILE = path.join(REPO_ROOT, "apps/web/app/api/health/route.ts");
const NEXT_CONFIG = path.join(REPO_ROOT, "apps/web/next.config.ts");
const TG23: Check = {
  id: "TG.23", wp: "TG", kind: "static",
  title: "Эксплуатация (§7): юнит second-opinion-bot в setup.sh (User=ez, ConditionPathExists и EnvironmentFile=- на apps/bot/.env, MemoryMax=512M, NoNewPrivileges, PrivateTmp, ProtectSystem=strict, StateDirectory=second-opinion-bot, Restart=always + RestartPreventExitStatus=78, Wants= без Requires=, ReadWritePaths без «-» нет) и sudoers; deploy.sh: стоп бота < запись VERSION < npm ci < web:build < рестарт веба < /api/health < старт бота < heartbeat; версия сервера = sha сборки (next.config env.SO_BUILD_SHA, health читает process.env.SO_BUILD_SHA, а не файл VERSION), внешний /api/health — только {ok}; бот: readVersion/checkServerVersion, readVersion один раз в main.ts до bot.start, код выхода 78, STATE_DIRECTORY; heartbeat старше 120 с → exit(1)",
  async run(): Promise<Verdict> {
    const rows: string[] = [];
    const notes: string[] = [];
    // ── setup.sh: юнит бота ──
    const setup = readSrc("deploy/heidi/setup.sh");
    const unit = setup.match(/second-opinion-bot\.service[^\n]*<<\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\1\b/)?.[2] ?? null;
    if (!unit) rows.push(`setup.sh: нет юнита second-opinion-bot.service (блок tee … <<UNIT); ${STEP_NOTE(M.STEP.ops)}`);
    else {
      const need: Array<[string, RegExp]> = [
        ["User=ez", /^User=(ez|\$APP_USER|\$\{APP_USER\})\s*$/m],
        ["ConditionPathExists=…/apps/bot/.env", /^ConditionPathExists=\S*apps\/bot\/\.env\s*$/m],
        ["EnvironmentFile=-…/apps/bot/.env", /^EnvironmentFile=-\S*apps\/bot\/\.env\s*$/m],
        ["MemoryMax=512M", /^MemoryMax=512M\s*$/m], ["NoNewPrivileges=yes", /^NoNewPrivileges=(yes|true)\s*$/m], ["PrivateTmp=yes", /^PrivateTmp=(yes|true)\s*$/m],
        ["ProtectSystem=strict", /^ProtectSystem=strict\s*$/m], ["StateDirectory=second-opinion-bot", /^StateDirectory=second-opinion-bot\s*$/m],
        ["Wants=… second-opinion.service", /^Wants=.*\bsecond-opinion\.service/m], ["Restart=always", /^Restart=always\s*$/m],
        ["RestartPreventExitStatus=78", /^RestartPreventExitStatus=.*\b78\b/m],
      ];
      const miss = need.filter(([, re]) => !re.test(unit)).map(([n]) => n);
      if (miss.length) rows.push(`юнит бота: нет ${miss.join(", ")}`);
      if (/^Requires=/m.test(unit)) rows.push("юнит бота: есть Requires= (рестарт веба убьёт бота)");
      // путь в ReadWritePaths без «-», которого нет на диске, роняет юнит на шаге NAMESPACE (exit 226) — каталог даёт StateDirectory=
      const rwp = [...unit.matchAll(/^ReadWritePaths=(.*)$/gm)].flatMap((m) => m[1].trim().split(/\s+/)).filter((x) => x && !x.startsWith("-"));
      if (rwp.length) rows.push(`юнит бота: ReadWritePaths без «-» (${rwp.join(", ")}) — несуществующий каталог роняет юнит (NAMESPACE, exit 226); каталог состояния — StateDirectory=`);
      notes.push(`юнит бота: полей не хватает ${miss.length}, ReadWritePaths без «-» ${rwp.length}`);
    }
    const sudo = codeLines(setup).some((x) => /NOPASSWD:[^\n]*second-opinion-bot/.test(x.l));
    if (!sudo) rows.push("setup.sh: в sudoers нет команд для second-opinion-bot");
    // ── deploy.sh: порядок; VERSION (код на диске) пишется до сборки — next build запекает его в SO_BUILD_SHA ──
    const deploy = codeLines(readSrc("deploy/heidi/deploy.sh"));
    const find = (re: RegExp) => deploy.find((x) => re.test(x.l))?.n ?? null;
    const steps: Array<[string, number | null]> = [
      ["стоп бота", find(/systemctl\s+stop\s+second-opinion-bot\b/)],
      ["запись VERSION", find(/(>>?|\btee\s+(-a\s+)?)\s*["']?[^\s"';|&]*\bVERSION\b/)],
      ["npm ci", find(/\bnpm\s+ci\b/)], ["web:build", find(/web:build/)],
      ["рестарт веба", find(/systemctl\s+restart\s+second-opinion(?![-\w])/)], ["/api/health", find(/\/api\/health/)],
      ["старт бота", find(/systemctl\s+(start|restart)\s+second-opinion-bot\b/)], ["heartbeat", find(/heartbeat/)],
    ];
    const missing = steps.filter(([, n]) => n == null).map(([s]) => s);
    const nums = steps.map(([, n]) => n ?? -1);
    const ordered = !missing.length && nums.every((n, i) => i === 0 || n > nums[i - 1]);
    notes.push(`deploy.sh: ${steps.map(([s, n]) => `${s}@${n ?? "—"}`).join(" < ")}`);
    if (!ordered) rows.push(`deploy.sh: порядок шагов ${missing.length ? `нет «${missing.join("», «")}»` : "нарушен"}`);
    // «V=$(git --git-dir=… rev-parse --short HEAD)» и «echo "$V" > "$APP_DIR/VERSION"» могут стоять в разных строках
    if (!deploy.some((x) => /\bgit\b.*\brev-parse\b.*--short|\brev-parse\s+--short/.test(x.l))) rows.push("deploy.sh: нет git rev-parse --short (версия выкатки)");
    const oldState = deploy.filter((x) => /apps\/bot\/\.state/.test(x.l)).map((x) => x.n);
    if (oldState.length) rows.push(`deploy.sh: путь apps/bot/.state (строки ${oldState.join(", ")}) — под systemd heartbeat в /var/lib/second-opinion-bot (StateDirectory=)`);
    // ── версия сервера = sha сборки: next.config.ts env.SO_BUILD_SHA; health/route.ts — process.env.SO_BUILD_SHA, файл VERSION не читает ──
    const cfgHas = astFind(NEXT_CONFIG, (n) => ts.isPropertyAssignment(n) && propName(n) === "env" && ts.isObjectLiteralExpression(n.initializer)
      && n.initializer.properties.some((p) => propName(p) === "SO_BUILD_SHA")).length > 0;
    if (!cfgHas) rows.push(`next.config.ts: в env нет SO_BUILD_SHA (sha сборки запекается при next build из VERSION); ${STEP_NOTE(M.STEP.present)}`);
    const hEnv = astFind(HEALTH_FILE, envDot("SO_BUILD_SHA"));
    const hs = scanFile(HEALTH_FILE);
    const hFile = [
      ...hs.lits.filter((l) => /\bVERSION\b/.test(l.text)).map((l) => `${at(l)} строка ${q(l.text, 30)}`),
      ...hs.imports.filter((i) => /^(node:)?fs(\/promises)?$/.test(i.spec)).map((i) => `${at(i)} импорт ${i.spec}`),
      ...[...hs.calls, ...hs.props].filter((x) => /^(readFileSync|readFile|existsSync|statSync)$/.test(x.text)).map((x) => `${at(x)} ${x.text}`),
    ];
    notes.push(`health/route.ts: process.env.SO_BUILD_SHA ${hEnv.length}, чтение файла ${hFile.length}`);
    if (!hEnv.length) rows.push(`health/route.ts: нет process.env.SO_BUILD_SHA (точечный доступ — его подставляет next build); ${STEP_NOTE(M.STEP.server)}`);
    if (hFile.length) rows.push(`health/route.ts читает файл (${hFile.slice(0, 3).join("; ")}) — VERSION описывает код на диске, а не работающую сборку (§4.3)`);
    // ── /api/health и версия бота (сценарий misc: SO_BUILD_SHA = TEST_BUILD_SHA, временный VERSION бота = TEST_DISK_SHA) ──
    const { out: misc } = scenario<MiscOut>("misc");
    const h = misc.health;
    if (h.buildSha !== TEST_BUILD_SHA) throw new Error(`дефект харнеса: SO_BUILD_SHA сценария misc = ${show(h.buildSha)}, ожидалось ${show(TEST_BUILD_SHA)}`);
    const local = h.local as Record<string, unknown> | null;
    const extKeys = h.external && typeof h.external === "object" ? Object.keys(h.external as object) : [];
    notes.push(`/api/health локально version=${show(local?.version ?? null)} (ожид. sha сборки ${show(TEST_BUILD_SHA)}; VERSION в репо ${show(h.versionFile)}), снаружи ключи ${show(extKeys)}`);
    if (h.error) rows.push(`/api/health: ${h.error}`);
    if (local?.version !== TEST_BUILD_SHA) rows.push(`локальный /api/health: version=${show(local?.version ?? null)} (ожид. SO_BUILD_SHA процесса ${show(TEST_BUILD_SHA)}, а не содержимое VERSION или "dev")`);
    if (canon(extKeys) !== canon(["ok"])) rows.push(`внешний /api/health: ключи ${show(extKeys)} (ожид. только ok)`);
    const b = h.bot;
    if (b.missing) rows.push(b.missing);
    else {
      const fmtChk = (x: typeof b.same) => (x == null ? "не вызван" : typeof x === "string" ? x : show(x));
      notes.push(`бот: readVersion с VERSION ${show(b.withFile)}, без него ${show(b.noFile)}; checkServerVersion свой ${fmtChk(b.same)}, чужой ${fmtChk(b.other)}`);
      if (b.withFile !== TEST_DISK_SHA) rows.push(`readVersion(<каталог с VERSION ${show(TEST_DISK_SHA)}>) → ${show(b.withFile)}`);
      if (b.noFile !== "dev") rows.push(`readVersion(<каталог без VERSION>) → ${show(b.noFile)} (ожид. "dev")`);
      const same = b.same, other = b.other;
      if (!same || typeof same === "string" || same.ok !== true || same.server !== TEST_BUILD_SHA)
        rows.push(`checkServerVersion(свой sha ${show(TEST_BUILD_SHA)}) → ${fmtChk(same)} (ожид. {ok:true, server:${show(TEST_BUILD_SHA)}})`);
      if (!other || typeof other === "string" || other.ok !== false || other.server !== TEST_BUILD_SHA)
        rows.push(`checkServerVersion(чужой sha ${show(TEST_DISK_SHA)}) → ${fmtChk(other)} (ожид. {ok:false, server:${show(TEST_BUILD_SHA)}})`);
    }
    // ── main.ts: версия читается один раз до bot.start; код выхода 78; STATE_DIRECTORY ──
    const mainF = M.BOT_FILE("main");
    if (!fs.existsSync(mainF)) rows.push(`нет apps/bot/src/main.ts; ${STEP_NOTE(M.STEP.bot)}`);
    else {
      const rv = astFind(mainF, callOf("readVersion")), cv = astFind(mainF, callOf("checkServerVersion"));
      const st = astFind(mainF, (n, sf) => ts.isCallExpression(n) && calleeName(n) === "start" && /allowed_updates/.test(n.getText(sf)));
      const [lr, lc, ls] = [firstLine(rv), firstLine(cv), firstLine(st)];
      notes.push(`main.ts: readVersion@${lr ?? "—"} < checkServerVersion@${lc ?? "—"} < bot.start@${ls ?? "—"}`);
      if (lr == null || lc == null || ls == null || !(lr < lc && lc < ls)) rows.push("main.ts: нужен порядок readVersion < checkServerVersion < bot.start({ allowed_updates … }) — версия бота читается один раз при старте (§4.4)");
      const exit78 = astFind(mainF, (n) => ts.isNumericLiteral(n) && n.text === "78").length;
      if (!exit78) rows.push("main.ts: нет кода выхода 78 (несовпадение версии или username; юнит не перезапускает по RestartPreventExitStatus=78)");
      if (!/staleMs\s*:\s*(120_?000|120\s*\*\s*1_?000)/.test(fs.readFileSync(mainF, "utf8"))) rows.push("main.ts: staleMs heartbeat не 120 с");
    }
    if (fs.existsSync(BOT_SRC)) {
      const elsewhere = tsFiles(BOT_SRC).filter((f) => !/\/(main|version)\.ts$/.test(f)).flatMap((f) => astFind(f, callOf("readVersion")).map((x) => `${rel(f)}:${x.line}`));
      if (elsewhere.length) rows.push(`readVersion вызывается вне main.ts (${elsewhere.join(", ")}) — версия бота читается один раз при старте`);
      const stateEnv = tsFiles(BOT_SRC).some((f) => { const x = scanFile(f); return [...x.lits, ...x.props].some((y) => y.text === "STATE_DIRECTORY"); });
      if (!stateEnv) rows.push("apps/bot/src: нет STATE_DIRECTORY — каталог heartbeat под systemd задаёт StateDirectory= (§4.4, §7)");
    }
    // ── heartbeat ──
    const hb = await M.loadHeartbeat();
    if (!hb.ok) rows.push(hb.why);
    else {
      try {
        const T = 1_760_000_000_000;
        const mk = (mt: number | null) => {
          const exits: number[] = [], writes: string[] = [];
          const x = hb.mod.makeHeartbeat({ file: "/tmp/so-audit-heartbeat", staleMs: 120_000, now: () => T, exit: (c) => { exits.push(c); }, write: (f) => { writes.push(f); }, mtime: () => mt });
          return { x, exits, writes };
        };
        const stale = mk(T - 121_000); stale.x.check();
        const fresh = mk(T - 60_000); fresh.x.check(); fresh.x.beat();
        notes.push(`heartbeat: 121 с → exit ${show(stale.exits)}, 60 с → exit ${show(fresh.exits)}, beat → write ${fresh.writes.length}`);
        if (canon(stale.exits) !== canon([1]) || fresh.exits.length || !fresh.writes.length) rows.push("heartbeat: старше 120 с должен быть exit(1), моложе — без выхода, beat() пишет файл");
      } catch (e) { rows.push(`heartbeat: исключение ${errMsg(e)}`); }
    }
    const detail = `${notes.join("; ")}${rows.length ? ` | НЕ ок: ${rows.join(" | ")}` : ""}`;
    return rows.length ? fail(detail) : pass(detail);
  },
};

/* ═════════════ guard-проверки (GREEN уже сейчас) ═════════════ */

/** Тексты веба на 14.10 (route.ts:45 при лимите 2, budget.ts:63-65) — заморожены здесь */
const WEB_LIMIT_2 = "В этой сессии лимит 2 сообщений исчерпан. Обновите страницу, чтобы начать новую проверку.";
const WEB_BUDGET = "Дневной лимит тестового стенда на ответы ассистента исчерпан — он обновится в полночь по Москве. " +
  "Проверка бумаги без ассистента работает: откройте главную страницу и введите ISIN или название.";
const G1: Check = {
  id: "TG.G1", wp: "TG", kind: "fixture", guard: true,
  title: "Тексты веба при channel=web не меняются: запрос без канала получает текст лимита ≡ «В этой сессии лимит 2 сообщений исчерпан. Обновите страницу…», текст бюджета ≡ BUDGET_EXHAUSTED_TEXT на 14.10 (литералы заморожены)",
  run(): Verdict {
    const { out: o } = scenario<LimitsOut>("limits");
    limitsSanity(o);
    const lim = o.webLimit[2], bud = o.webBudget;
    const okL = lim?.status === 200 && lim.text === WEB_LIMIT_2;
    const okB = bud.status === 200 && bud.text === WEB_BUDGET;
    const detail = `третий ход веба: ${okL ? "≡" : `≠ (${firstDiff(lim?.text, WEB_LIMIT_2)})`} ${q(lim?.text, 90)}; бюджет: ${okB ? "≡" : `≠ (${firstDiff(bud.text, WEB_BUDGET)})`} ${q(bud.text, 90)}` +
      (o.copy.ok ? `; справочно copy: limitText("web",2) ≡ ${o.copy.limitWeb === WEB_LIMIT_2}, budgetExhaustedText("web") ≡ ${o.copy.budgetWeb === WEB_BUDGET}` : "");
    return okL && okB ? pass(detail) : fail(detail);
  },
};

const G2: Check = {
  id: "TG.G2", wp: "TG", kind: "fixture", guard: true,
  title: "Эталон воспроизводим: 15 тел браузера → 200; ответ на запрос k (сборка ai, N) ≡ сообщение ассистента в теле k+1 (8 пар); префикс истории тела k+1 ≡ тело k — эталонный сборщик привязан к настоящему браузеру",
  run(): Verdict {
    const { out: o } = scenario<ReplayOut>("replay");
    const dialogs = loadDialogs();
    const rows: string[] = [];
    let n200 = 0, total = 0, pairs = 0, pairsOk = 0;
    o.web.forEach((w, i) => {
      const d = dialogs[i];
      w.reqs.forEach((r, k) => {
        total++;
        if (r.status === 200 && r.msg) n200++; else rows.push(`${w.name} #${k}: status ${r.status}${r.error ? ` ${r.error}` : ""}`);
        const next = d.requests[k + 1];
        if (!next) return;
        pairs++;
        const prev = d.requests[k].body.messages ?? [];
        const nm = next.body.messages ?? [];
        const recorded = nm[prev.length];
        const prefix = firstDiff(nm.slice(0, prev.length), prev);
        const cmp = r.msg && recorded ? compareMessages(r.msg, recorded) : { equal: false, diff: "нет ответа или сообщения в теле k+1" };
        const shape = nm.length === prev.length + 2 && recorded?.role === "assistant" && nm[nm.length - 1]?.role === "user";
        if (cmp.equal && !prefix && shape) pairsOk++;
        else rows.push(`${w.name} ${k}→${k + 1}: ${cmp.equal ? "" : `ответ ≠ записанному (${cmp.diff}) `}${prefix ? `префикс истории ≠ (${prefix}) ` : ""}${shape ? "" : `форма тела k+1: ${nm.length} сообщ. (ожид. ${prev.length + 2})`}`);
      });
    });
    const ok = total === 15 && n200 === 15 && pairs === 8 && pairsOk === 8;
    const detail = `тел ${total}, ответов 200 ${n200}; пар k→k+1 ${pairs}, совпали ${pairsOk}` + (rows.length ? ` | ${rows.slice(0, 6).join(" | ")}` : "") +
      (ok ? "" : " | красная — фикстуры устарели (правка текстов гейта / MOCK-модели) или сборщик разошёлся с браузером; перезапись фикстур — только оркестратор");
    return ok ? pass(detail) : fail(detail);
  },
};

const G3_FILES = ["gate", "jev", "tools", "digest", "prompt", "glossary", "engine", "session", "model"].map((n) => path.join(REPO_ROOT, "apps", "web", "lib", `${n}.ts`));
const CH_RE = /channel|telegram|x-so-channel|x-so-bot-key/i;
const G3: Check = {
  id: "TG.G3", wp: "TG", kind: "static", guard: true,
  title: "Канал не попадает в решения: в lib/{gate,jev,tools,digest,prompt,glossary,engine,session,model}.ts нет channel, telegram, x-so-channel, x-so-bot-key (идентификаторы, свойства, строки; комментарии не считаются)",
  run(): Verdict {
    const hits: string[] = [];
    for (const f of G3_FILES) {
      if (!fs.existsSync(f)) { hits.push(`${rel(f)}: файла нет`); continue; }
      const s = scanFile(f);
      for (const x of [...s.idents, ...s.props, ...s.lits, ...s.imports.map((i) => ({ file: i.file, line: i.line, text: i.spec }))]) if (CH_RE.test(x.text)) hits.push(`${at(x)} ${q(x.text, 40)}`);
    }
    const detail = `${G3_FILES.length} файлов; упоминаний ${hits.length}${hits.length ? `: ${[...new Set(hits)].slice(0, 10).join("; ")}` : ""}`;
    return hits.length ? fail(detail) : pass(detail);
  },
};

const G4: Check = {
  id: "TG.G4", wp: "TG", kind: "unit", guard: true,
  title: "Компаратор паритета чувствителен: 6 мутантов тел браузера (HTML в истории, «Проверить» вместо «Проверь», снят inputs d6, снят metadata.custom, поле channel в теле, пропущено сообщение) → «не равно»; копия с другими id/toolCallId/built_at/snapshot_dir → «равно»; заголовки: лишний и недостающий → «не равно»",
  run(): Verdict {
    const dialogs = loadDialogs();
    const get = (name: string, k: number) => {
      const d = dialogs.find((x) => x.name === name);
      if (!d?.requests[k]) throw new Error(`нет запроса ${name} #${k} в фикстурах`);
      return clone(d.requests[k]);
    };
    const rows: Array<{ name: string; want: boolean; got: boolean; diff: string | null }> = [];
    const add = (name: string, a: unknown, b: unknown, want: boolean) => { const c = compareBodies(a, b); rows.push({ name, want, got: c.equal, diff: c.diff }); };
    // тождественная копия: все допуски N изменены
    {
      const base = get("d1-main", 3).body;
      const x = clone(base);
      x.id = "tg_auditAUDITaud_ZZZZZZZZ";
      const callMap = new Map<string, string>();
      for (const m of x.messages ?? []) {
        m.id = crypto.randomBytes(8).toString("hex");
        for (const p of m.parts) {
          if (typeof p.toolCallId === "string") { if (!callMap.has(p.toolCallId)) callMap.set(p.toolCallId, `call_${callMap.size}x`); p.toolCallId = callMap.get(p.toolCallId); }
          const rep = (p.output as { result?: { report?: { built_at?: string; diagnostics?: { snapshot_dir?: string | null } } } } | undefined)?.result?.report;
          if (rep) { rep.built_at = "2099-01-01T00:00:00.000Z"; if (rep.diagnostics && rep.diagnostics.snapshot_dir != null) rep.diagnostics.snapshot_dir = "/opt/other/machine"; }
        }
      }
      add("копия (другие id, toolCallId, built_at, snapshot_dir)", x, base, true);
    }
    {
      const base = get("d1-main", 1).body;
      const x = clone(base);
      const t = x.messages?.[1]?.parts.find((p) => p.type === "text");
      if (t) t.text = `<b>${String(t.text)}</b>`;
      add("HTML в истории (текст ассистента)", x, base, false);
    }
    {
      const base = get("d2-pick", 1).body;
      const x = clone(base);
      const last = x.messages?.[x.messages.length - 1]?.parts[0];
      if (last) last.text = String(last.text).replace(/^Проверь /, "Проверить ");
      add("«Проверить» вместо «Проверь»", x, base, false);
    }
    {
      const base = get("d6-check-handoff", 0).body;
      const x = clone(base);
      delete x.inputs;
      add("снят inputs в d6", x, base, false);
    }
    {
      const base = get("d1-main", 0).body;
      const x = clone(base);
      if (x.messages?.[0]) x.messages[0].metadata = {};
      add("снят metadata.custom", x, base, false);
    }
    {
      const base = get("d4-advice-offtopic", 0).body;
      add("поле channel в теле", { ...clone(base), channel: "telegram" }, base, false);
    }
    {
      const base = get("d5-repeat-reset", 2).body;
      const x = clone(base);
      x.messages?.splice(2, 1);
      add("пропущено сообщение", x, base, false);
    }
    // заголовки
    const br = get("d1-main", 0).headers;
    const id = "tg_auditAUDITaud_ZZZZZZZZ";
    const good = { "content-type": "application/json", "x-so-chat": id, "x-so-channel": "telegram", "x-so-bot-key": TEST_KEY };
    const hrows = [
      { name: "заголовки бота по §4.5", want: true, got: compareHeaders(good, br, { bodyId: id, botKey: TEST_KEY }).equal },
      { name: "лишний заголовок x-so-debug", want: false, got: compareHeaders({ ...good, "x-so-debug": "1" }, br, { bodyId: id, botKey: TEST_KEY }).equal },
      { name: "нет x-so-bot-key", want: false, got: compareHeaders({ "content-type": "application/json", "x-so-chat": id, "x-so-channel": "telegram" }, br, { bodyId: id, botKey: TEST_KEY }).equal },
    ];
    const all = [...rows, ...hrows.map((h) => ({ ...h, diff: null }))];
    const bad = all.filter((r) => r.got !== r.want);
    const detail = all.map((r) => `${r.name}: ${r.got ? "равно" : "не равно"}${r.got !== r.want ? " — ОЖИДАЛОСЬ " + (r.want ? "равно" : "не равно") : ""}${r.diff && !r.want ? ` (${cut(r.diff, 70)})` : ""}`).join("; ");
    return bad.length ? fail(detail) : pass(detail);
  },
};

const G5: Check = {
  id: "TG.G5", wp: "TG", kind: "fixture", guard: true,
  title: "SSR 16 golden неизменен: текст SSR (теги сняты, ASCII-пробелы схлопнуты, плюс aria-label) ReportView compact (чат), ResultApp (страница /check) и веток ≡ снимку fixtures/tg/ssr_golden.json, снятому с d16c809 (держит перенос литералов в VM на шаге 3)",
  async run(): Promise<Verdict> {
    const got = await ssrAll();
    if (process.argv.includes("--record-tg-ssr")) {
      fs.mkdirSync(path.dirname(SSR_SNAPSHOT), { recursive: true });
      const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
      fs.writeFileSync(SSR_SNAPSHOT, JSON.stringify({
        base: head, recorded: new Date().toISOString().slice(0, 10),
        note: "Снимок текста SSR блоков (WP-TG, TG.G5): 16 golden + 3 живые фикстуры + синтетический err; ReportView compact/ветки чата и ResultApp. Меняет только оркестратор после разбора диффа.",
        texts: got,
      }, null, 1) + "\n");
      return pass(`снимок записан: ${rel(SSR_SNAPSHOT)} (${Object.keys(got).length} текстов, база ${head})`);
    }
    if (!fs.existsSync(SSR_SNAPSHOT)) return fail(`нет снимка ${rel(SSR_SNAPSHOT)} — записать один раз с d16c809: npm run -s -w @so/web audit -- --only TG.G5 --record-tg-ssr`);
    const snap = JSON.parse(fs.readFileSync(SSR_SNAPSHOT, "utf8")) as { base?: string; texts: Record<string, string> };
    const keys = [...new Set([...Object.keys(snap.texts), ...Object.keys(got)])].sort();
    const bad: string[] = [];
    for (const k of keys) {
      const a = snap.texts[k], b = got[k];
      if (a === b) continue;
      if (a == null || b == null) { bad.push(`${k}: ${a == null ? "нет в снимке" : "не отрендерился"}`); continue; }
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      bad.push(`${k}: с позиции ${i} снимок ${q(a.slice(Math.max(0, i - 20), i + 40), 64)} ≠ сейчас ${q(b.slice(Math.max(0, i - 20), i + 40), 64)}`);
    }
    const detail = `текстов ${keys.length} (снимок с ${snap.base ?? "?"}), отличий ${bad.length}${bad.length ? `: ${bad.slice(0, 5).join(" | ")}` : ""}`;
    return bad.length ? fail(detail) : pass(detail);
  },
};

const G6: Check = {
  id: "TG.G6", wp: "TG", kind: "fixture", guard: true,
  title: "Пределы сервера пропускают историю: 15 тел браузера и синтетическая история (10 реплик + 10 отчётов + новая реплика) получают 200, а не 400/413 (держит будущие H.5 и S.2: предел считать по текстовым частям, а не по JSON отчётов)",
  run(): Verdict {
    const { out: o } = scenario<ReplayOut>("replay");
    const statuses = o.web.flatMap((w) => w.reqs.map((r) => r.status));
    const okReal = statuses.length === 15 && statuses.every((s) => s === 200);
    const s = o.synthetic;
    const okSyn = s.status === 200;
    const detail = `15 тел браузера: статусы ${show([...new Set(statuses)])}; синтетика: ${s.messages} сообщений, отчётов ${s.reports}, ${Math.round(s.bytes / 1024)} КБ JSON → status ${s.status}${s.error ? ` (${s.error})` : ""}`;
    return okReal && okSyn ? pass(detail) : fail(detail);
  },
};

export const checks: Check[] = [
  TG1, TG2, TG3, TG4, TG5, TG6, TG6TG, TG7, TG8, TG9, TG10, TG11, TG12, TG13, TG14, TG15, TG16, TG17, TG18, TG19, TG20, TG21, TG22, TG23,
  G1, G2, G3, G4, G5, G6,
];
