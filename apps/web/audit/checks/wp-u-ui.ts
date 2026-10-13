/**
 * WP-U (apps/web, UI и маршруты): находки разбора диалогов 12.10.2026 (docs/DIALOGS_REVIEW_2026-10-12.md).
 * Каждая проверка утверждает ЖЕЛАЕМОЕ поведение: RED — дефект есть сейчас, GREEN — поведение уже правильное.
 *
 *  U.12 unit     выбор выпуска в чате: ReportToolUI (components/ToolUIs.tsx) рендерится через react-dom/server на реальном
 *                pick (офлайн-сборка golden-снимка pick-cherkizovo) — нет ссылок /check?q=… и «Новая проверка» на главную,
 *                кнопки «Проверить» активны (PickView ставит disabled={!onPick}: активная кнопка = передан onPick).
 *  U.13 fixture  заголовки POST /api/chat (route.ts как функция, NODE_ENV=production, фиктивные ключи провайдеров,
 *                Jev-мок out_of_scope 1.0 — гейт закрывает реплику шаблоном, модель не вызывается).
 *  U.14 fixture  GET /api/health (как функция, Jev-мок): нет имени модели и бюджета.
 *  U.15 live     то же на проде, один GET /api/health.
 *  U.16 live     кэш отчётов общий для /check и /api/report на проде: built_at второго запроса = built_at первого.
 *  U.17 static   explain_term на LLM-пути: промпт требует пересказ найденной статьи И карточка рисуется на любом пути.
 *  U.18 static   Markdown: текст модели — простой <p>{text}</p>, а промпт разметку не запрещает.
 *  U.19 fixture  ответ ассистента попадает в журнал usage.jsonl (POST /api/chat, MOCK-модель, реплика уходит в модель).
 *  U.20 static   /check переживает сбой ISS: error.tsx (app/check или выше) либо обработка исключения buildCached;
 *                плюс динамика — CheckPage() вызывается как функция при ISS → HTTP 502 (дополнение к R.6 / R.6-web).
 *
 * Приёмы — как в wp-h.ts: серверные модули (route.ts, health, check/page.tsx тянут lib/engine.ts с `import "server-only"`)
 * грузятся динамически после resolve-хука, подменяющего "server-only" пустым модулем; budget.ts / usage-log.ts фиксируют
 * каталог .usage при ПЕРВОМ импорте — SO_USAGE_DIR указывает на временный каталог до первого импорта, а перед записью
 * журнала (U.19) проверяется, что usage-log реально пишет во временный каталог, а не в apps/web/.usage разработчика.
 * Сеть: Jev — только мок через globalThis.fetch; заглушка бросает на ЛЮБОЙ URL, кроме адресов Jev из lib/jev.ts
 * (ответы на них — мок, наружу ничего не уходит). Live (U.15, U.16) — только GET к mkt-second-opinion.ru и iss.moex.com.
 * React-рендер: файлы вне apps/web (packages/blocks) tsx транслирует классическим JSX (React.createElement) — tsconfig
 * apps/web их не включает, — поэтому перед рендером globalThis.React = React (в Next автоматический runtime, разницы нет).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import type { ReactElement } from "react";
import type { BuildResultT } from "@so/engine/contract";
import { type Check, type Verdict, pass, fail, readSrc, readJson, REPO_ROOT, WEB_ROOT } from "../lib";

type RouteMod = typeof import("../../app/api/chat/route");
type HealthMod = typeof import("../../app/api/health/route");
type UsageMod = typeof import("../../lib/usage-log");
type ToolUIsMod = typeof import("../../components/ToolUIs");

const show = (v: unknown) => JSON.stringify(v);
const cut = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/* ───── окружение: временно переопределить env / fetch и вернуть обратно ───── */
async function withEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const urlOf = (input: unknown) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? input);

/* ───── временный каталог .usage (один на процесс) ───── */
let usageDirPath: string | null = null;
function usageDir(): string {
  if (usageDirPath) return usageDirPath;
  usageDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "so-audit-u-usage-"));
  const dir = usageDirPath;
  process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/* ───── серверные модули: хук "server-only" → пустой модуль ───── */
let hooked = false;
function ensureHook() {
  if (hooked) return;
  const hook = `export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
  return next(specifier, context);
}`;
  register("data:text/javascript," + encodeURIComponent(hook));
  hooked = true;
}
/** SO_DAILY_BUDGET_USD фиксируется budget.ts при импорте — явно 2 $, чтобы бюджет разработчика не был «исчерпан» */
const SERVER_ENV = () => ({ SO_USAGE_DIR: usageDir(), SO_USAGE_LOG: "0", SO_QUIET: "1", SO_DAILY_BUDGET_USD: "2" });
async function loadChat(): Promise<{ route: RouteMod; usage: UsageMod }> {
  ensureHook();
  return withEnv(SERVER_ENV(), async () => {
    await import("../../lib/budget");
    const usage = await import("../../lib/usage-log");
    const route = await import("../../app/api/chat/route");
    return { route, usage };
  });
}
async function loadHealth(): Promise<HealthMod> {
  ensureHook();
  return withEnv(SERVER_ENV(), async () => { await import("../../lib/budget"); return import("../../app/api/health/route"); });
}
/** Журнал должен быть во временном каталоге: иначе запись ушла бы в apps/web/.usage разработчика */
function assertTmpUsage(usage: UsageMod): string {
  const file = usage.usageFile();
  const dir = path.dirname(file);
  const real = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
  const tmp = fs.realpathSync(os.tmpdir());
  if (!real.startsWith(tmp) && !dir.startsWith(os.tmpdir()))
    throw new Error(`дефект харнеса: usage-log.ts пишет в ${file}, а не во временный каталог — модуль импортирован раньше без SO_USAGE_DIR; запись отменена`);
  return file;
}

/* ───── строгий мок Jev: отвечает только на адреса Jev из lib/jev.ts, на любой другой URL бросает ───── */
const JEV_URLS = () => [
  process.env.TYPESAFE_URL ?? "https://api.typesafe.ai/v1/systemone",
  process.env.JEV_DECISIONS_URL ?? "https://openrouter.ai/api/alpha/decisions",
];
function strictJev(intent: string, kindAnswer = "check_security") {
  const seen: string[] = [];
  const unexpected: string[] = [];
  const urls = JEV_URLS();
  const choice = (c: string) => ({ type: "choice", choice: c, confidence: 1, probabilities: { [c]: 1 } });
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = urlOf(input);
    if (!urls.includes(url)) {
      unexpected.push(cut(url, 90));
      throw new Error(`аудит: сеть запрещена (fetch ${cut(url, 80)})`);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, unknown> };
    const q = body.questions ?? {};
    const answers: Record<string, unknown> = {};
    if (q.intent) answers.intent = choice(intent);
    if (q.mentions_security) answers.mentions_security = { type: "noul", noul: 0 };
    if (q.kind) answers.kind = choice(kindAnswer);
    seen.push(Object.keys(q).join("+") || "?");
    return new Response(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: 100, output_tokens: 0, cost: 0.0000042 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, seen, unexpected };
}

/* ───── «как на проде»: фиктивные ключи провайдеров (уходят только в заглушку fetch), NODE_ENV=production ───── */
const PROD_VARIANTS: Array<{ name: string; env: Record<string, string | undefined> }> = [
  {
    name: "anthropic+typesafe",
    env: { NODE_ENV: "production", MOCK_LLM: undefined, LLM_PROVIDER: undefined, JEV_ENABLED: undefined,
      ANTHROPIC_API_KEY: "audit-dummy", OPENROUTER_API_KEY: undefined, TYPESAFE_API_KEY: "audit-dummy", JEV_PROVIDER: "typesafe" },
  },
  {
    name: "openrouter",
    env: { NODE_ENV: "production", MOCK_LLM: undefined, LLM_PROVIDER: undefined, JEV_ENABLED: undefined,
      ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "audit-dummy", TYPESAFE_API_KEY: undefined, JEV_PROVIDER: undefined },
  },
];
const PROVIDER_RE = /anthropic|typesafe|openrouter/i;
const MODEL_RE = /haiku|claude|sonnet|opus|gpt/i;

/* ───── поток UI-сообщений: части и текст ───── */
function sseParts(body: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m || m[1] === "[DONE]") continue;
    try { out.push(JSON.parse(m[1]) as Record<string, unknown>); } catch { /* не JSON — пропускаем */ }
  }
  return out;
}
const sseText = (parts: Array<Record<string, unknown>>) =>
  parts.filter((p) => p.type === "text-delta").map((p) => String(p.delta ?? "")).join("");
const userMsg = (text: string) => ({ id: "m1", role: "user", parts: [{ type: "text", text }] });
const rid = () => Math.random().toString(36).slice(2, 8);
async function postChat(route: RouteMod, body: unknown): Promise<{ status: number; headers: Array<[string, string]>; body: string }> {
  const res = await route.POST(new Request("http://localhost/api/chat", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const text = await res.text(); // тело до конца — execute() потока завершён
  return { status: res.status, headers: [...res.headers.entries()], body: text };
}

/* ───── обход JSON: пути и листья ───── */
function leaves(o: unknown, p = "$"): Array<{ path: string; value: unknown }> {
  if (Array.isArray(o)) return o.flatMap((v, i) => leaves(v, `${p}[${i}]`));
  if (o && typeof o === "object") return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${p}.${k}`));
  return [{ path: p, value: o }];
}
/** /api/health: что раскрыто — имя модели (ключ model или значение с haiku/claude/sonnet/gpt) и бюджет (ключи budget / *spent* / *limit*) */
function healthExposure(json: unknown) {
  const ls = leaves(json);
  const key = (p: string) => p.replace(/^\$\.?/, "");
  const model = ls.filter((l) => /(^|\.)model(\.|\[|$)/i.test(key(l.path)) || (typeof l.value === "string" && MODEL_RE.test(l.value)));
  const budget = ls.filter((l) => /(^|\.)(budget|[a-z_]*spent[a-z_]*|[a-z_]*limit[a-z_]*)(\.|\[|$)/i.test(key(l.path)));
  const providers = ls.filter((l) => typeof l.value === "string" && PROVIDER_RE.test(l.value));
  const fmt = (xs: typeof ls) => (xs.length ? xs.map((l) => `${key(l.path)}=${show(l.value)}`).join(", ") : "нет");
  return {
    keys: ls.map((l) => key(l.path)).join(", "),
    model, budget,
    line: `модель: ${fmt(model)}; бюджет: ${fmt(budget)}; справочно, провайдеры: ${fmt(providers)}`,
  };
}

/* ───── статика: вырезать комментарии с учётом строк (как stripComments в wp-h.ts) ───── */
function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? src.length : j + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
const lineOf = (src: string, re: RegExp) => {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => re.test(l));
  return i < 0 ? null : { n: i + 1, text: oneLine(lines[i]) };
};

/* ───── React: рендер компонента инструмента так, как в чате (внутри AssistantRuntimeProvider) ───── */
type AnyProps = Record<string, unknown>;
type H = (type: unknown, props?: unknown, ...children: unknown[]) => ReactElement;
async function renderTool(Comp: unknown, props: AnyProps): Promise<{ html: string | null; mode: string; error?: string }> {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const g = globalThis as unknown as { React?: unknown };
  g.React ??= React; // packages/blocks транслируется классическим JSX — см. шапку
  const h = React.createElement as unknown as H;
  const errors: string[] = [];
  // 1) внутри провайдера рантайма assistant-ui: если правка возьмёт useAui()/useThreadRuntime() для onPick — рендер не упадёт
  try {
    const aui = await import("@assistant-ui/react");
    const adapter = { async run() { return { content: [] }; } } as unknown as Parameters<typeof aui.useLocalRuntime>[0];
    const Wrap = ({ children }: { children?: unknown }) => h(aui.AssistantRuntimeProvider, { runtime: aui.useLocalRuntime(adapter) }, children);
    return { html: renderToStaticMarkup(h(Wrap, null, h(Comp, props))), mode: "в AssistantRuntimeProvider" };
  } catch (e) { errors.push(`с провайдером: ${cut(String(e), 160)}`); }
  // 2) без провайдера
  try {
    return { html: renderToStaticMarkup(h(Comp, props)), mode: "без провайдера", error: errors.join("; ") };
  } catch (e) { errors.push(`без провайдера: ${cut(String(e), 160)}`); }
  return { html: null, mode: "не отрендерился", error: errors.join("; ") };
}
/** Поиск элемента компонента в дереве React-элементов (без рендера) — чтобы показать фактические пропсы */
function findElement(node: unknown, type: unknown, depth = 0): { props: AnyProps } | null {
  if (!node || depth > 30) return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findElement(n, type, depth + 1); if (f) return f; } return null; }
  if (typeof node !== "object") return null;
  const el = node as { type?: unknown; props?: AnyProps };
  if (el.type === type && el.props) return { props: el.props };
  return el.props ? findElement(el.props.children, type, depth + 1) : null;
}
const toolProps = (toolName: string, toolCallId: string, args: unknown, result: unknown): AnyProps => ({
  type: "tool-call", toolCallId, toolName, args, argsText: JSON.stringify(args), result,
  status: { type: "complete" }, isError: false, addResult: () => {}, resume: () => {},
});

/* ───── офлайн pick: golden-снимок pick-cherkizovo через build() движка ───── */
async function pickCherkizovo(): Promise<Extract<BuildResultT, { kind: "pick" }>> {
  const { build } = await import("@so/engine");
  const meta = readJson<{ todayIso: string; cases: Array<{ name: string; query: string; inputs?: Record<string, number>; todayIso?: string }> }>(
    "packages/engine/golden/cases.json");
  const c = meta.cases.find((x) => x.name === "pick-cherkizovo");
  if (!c) throw new Error("golden-кейс pick-cherkizovo не найден в cases.json");
  const res = await build(c.query, c.inputs ?? {}, {
    fromSnapshotDir: path.join(REPO_ROOT, "packages", "engine", "golden", "snapshots", "pick-cherkizovo"),
    todayIso: c.todayIso ?? meta.todayIso,
  });
  if (res.kind !== "pick") throw new Error(`снимок pick-cherkizovo дал kind=${res.kind}, ожидался pick`);
  return res;
}

/* ═══════════════ проверки ═══════════════ */

const U12: Check = {
  id: "U.12", wp: "U", kind: "unit",
  title: "Выбор выпуска в чате остаётся в чате: в разметке ReportToolUI на pick нет ссылок /check?q=… и «Новая проверка» на главную, кнопки «Проверить» активны (onPick)",
  async run(): Promise<Verdict> {
    const pick = await pickCherkizovo();
    const ui = (await import("../../components/ToolUIs")) as ToolUIsMod;
    const blocks = await import("@so/blocks");
    const props = toolProps("resolve_security", "toolu_audit_u12", { query: pick.query }, { query: pick.query, result: pick });
    const r = await renderTool(ui.ReportToolUI, props);
    if (r.html == null) throw new Error(`ReportToolUI не рендерится вне Next: ${r.error}`);
    const html = r.html;
    const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
      href: m[1].match(/\bhref="([^"]*)"/)?.[1] ?? null, text: oneLine(unescapeHtml(m[2].replace(/<[^>]+>/g, ""))),
    }));
    const checkLinks = anchors.filter((a) => a.href != null && /\/check\?q=/.test(a.href));
    const homeLinks = anchors.filter((a) => /Новая проверка/.test(a.text) || a.href === "/" || a.href === "./" || a.href === "");
    const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
      .map((m) => ({ disabled: /\bdisabled\b/.test(m[1]), text: oneLine(m[2].replace(/<[^>]+>/g, "")) }))
      .filter((b) => /Проверить/.test(b.text));
    const enabled = buttons.filter((b) => !b.disabled);
    // Фактические пропсы PickView — если ReportToolUI вызывается как функция (без хуков); иначе видно только по разметке
    let propsNote: string;
    try {
      const el = (ui.ReportToolUI as unknown as (p: AnyProps) => unknown)(props);
      const pv = findElement(el, blocks.PickView);
      if (!pv) propsNote = "PickView в дереве ReportToolUI не найден (правка могла заменить компонент)";
      else {
        const hrefFor = pv.props.hrefFor as ((s: string) => string | null) | undefined;
        const sample = pick.candidates[0]?.secid ?? "?";
        propsNote = `пропсы PickView из ReportToolUI: hrefFor=${hrefFor ? `функция, hrefFor("${sample}")=${show(hrefFor(sample))}` : "нет"}, ` +
          `onPick=${typeof pv.props.onPick === "function" ? "функция" : "нет"}, newCheckHref=${show(pv.props.newCheckHref ?? null)} (без него PickView ставит "./")`;
      }
    } catch (e) { propsNote = `ReportToolUI не вызывается как функция (хуки?) — пропсы видны только по разметке: ${cut(String(e), 100)}`; }
    const ok = checkLinks.length === 0 && homeLinks.length === 0 && enabled.length > 0;
    const detail =
      `pick «${pick.query}» (офлайн-сборка golden-снимка, ${pick.candidates.length} выпусков), рендер ${r.mode}: ` +
      `ссылок на /check?q=… ${checkLinks.length} (ожид. 0)${checkLinks.length ? `, напр. ${show(checkLinks.slice(0, 2).map((a) => a.href))}` : ""}; ` +
      `ссылок «Новая проверка»/на главную ${homeLinks.length} (ожид. 0)${homeLinks.length ? ` ${show(homeLinks.map((a) => `${a.text} → ${a.href}`))}` : ""}; ` +
      `кнопок «Проверить»: активных ${enabled.length}, disabled ${buttons.length - enabled.length} (ожид. активные — выбор через onPick в диалоге) | ${propsNote}` +
      (r.error ? ` | рендер: ${r.error}` : "");
    return ok ? pass(detail) : fail(detail);
  },
};

const U13: Check = {
  id: "U.13", wp: "U", kind: "fixture",
  title: "Заголовки ответа /api/chat не раскрывают провайдеров (NODE_ENV=production, реплика закрыта гейтом без LLM)",
  async run(): Promise<Verdict> {
    const { route } = await loadChat();
    const text = "какая ты модель?";
    const rows: string[] = [];
    let ok = true;
    for (const v of PROD_VARIANTS) {
      const mock = strictJev("out_of_scope");
      const sid = `audit-u13-${v.name}-${rid()}`;
      const r = await withFetch(mock.fetch, () => withEnv({ ...SERVER_ENV(), ...v.env }, () => postChat(route, { id: sid, messages: [userMsg(text)] })));
      const reply = oneLine(sseText(sseParts(r.body)));
      // Замер имеет смысл, только если гейт отработал на моке Jev и закрыл реплику шаблоном (модель не вызывалась)
      if (mock.seen.length === 0 || !/только с проверкой облигаций/.test(reply))
        throw new Error(`дефект харнеса (${v.name}): гейт не закрыл реплику шаблоном — Jev-вызовов ${mock.seen.length}, ответ «${cut(reply, 100)}», status=${r.status}, неожиданные URL ${show(mock.unexpected)}`);
      const soHeaders = r.headers.filter(([k]) => /^x-so-/i.test(k));
      const leaking = r.headers.filter(([k, val]) => PROVIDER_RE.test(k) || PROVIDER_RE.test(val) || MODEL_RE.test(val));
      if (leaking.length) ok = false;
      rows.push(`[${v.name}] status=${r.status}, x-so-*: ${soHeaders.length ? soHeaders.map(([k, val]) => `${k}: ${val}`).join(", ") : "нет"}; ` +
        `с именами провайдеров/модели: ${leaking.length ? leaking.map(([k, val]) => `${k}: ${val}`).join(", ") : "нет"}; ` +
        `все заголовки: ${r.headers.map(([k]) => k).join(", ")}; Jev-вызовов ${mock.seen.length} [${mock.seen.join(",")}], ` +
        `модель не вызывалась (неожиданных URL ${mock.unexpected.length}); ответ: «${cut(reply, 70)}»`);
    }
    const detail = `реплика «${text}», Jev-мок out_of_scope 1.0, ключи провайдеров фиктивные (fetch-заглушка) | ${rows.join(" | ")} | ` +
      `ожид.: нет x-so-mode/x-so-jev или в них нет anthropic/typesafe/openrouter`;
    return ok ? pass(detail) : fail(detail);
  },
};

const U14: Check = {
  id: "U.14", wp: "U", kind: "fixture",
  title: "/api/health наружу не раскрывает модель и бюджет (GET() как функция, Jev-мок)",
  async run(): Promise<Verdict> {
    const health = await loadHealth();
    const rows: string[] = [];
    let ok = true;
    for (const v of PROD_VARIANTS) {
      const mock = strictJev("check_security", "check_security");
      const res = await withFetch(mock.fetch, () => withEnv({ ...SERVER_ENV(), ...v.env }, () => health.GET()));
      const raw = await res.text();
      let json: unknown = null;
      try { json = JSON.parse(raw); } catch { /* не JSON */ }
      if (json == null) { rows.push(`[${v.name}] status=${res.status}, не JSON: «${cut(raw, 80)}» — модели и бюджета нет`); continue; }
      const ex = healthExposure(json);
      if (ex.model.length || ex.budget.length) ok = false;
      rows.push(`[${v.name}] status=${res.status}, ключи: ${ex.keys}; ${ex.line}; Jev-вызовов ${mock.seen.length}, неожиданных URL ${mock.unexpected.length}`);
    }
    const detail = `${rows.join(" | ")} | ожид.: нет поля model и подстрок haiku/claude/sonnet/gpt, нет budget/spent/limit`;
    return ok ? pass(detail) : fail(detail);
  },
};

const PROD = "https://mkt-second-opinion.ru";
/** GET с замером времени; сетевой сбой (нет ответа) — повтор до `tries` раз, в ошибке URL и причина (undici: connect timeout 10 с) */
async function timedGet(url: string, tries = 1): Promise<{ status: number; ms: number; text: string; attempts: number }> {
  let last: unknown;
  for (let i = 1; i <= tries; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "user-agent": "so-audit-wp-u/1 (harness)" } });
      const text = await r.text();
      return { status: r.status, ms: Date.now() - t0, text, attempts: i };
    } catch (e) { last = e; }
  }
  const e = last as { message?: string; cause?: { code?: string; message?: string } };
  throw new Error(`GET ${cut(url, 110)}: ${e?.message ?? String(last)}${e?.cause ? ` (${e.cause.code ?? ""} ${e.cause.message ?? ""})` : ""}, попыток ${tries}`);
}

const U15: Check = {
  id: "U.15", wp: "U", kind: "live",
  title: "Прод: GET /api/health не раскрывает модель и бюджет (один запрос)",
  async run(): Promise<Verdict> {
    const r = await timedGet(`${PROD}/api/health`);
    let json: unknown = null;
    try { json = JSON.parse(r.text); } catch { /* не JSON */ }
    if (json == null || r.status >= 400)
      return pass(`GET ${PROD}/api/health → status=${r.status} за ${r.ms} мс, ${json == null ? "не JSON" : "ошибка"}: «${cut(oneLine(r.text), 100)}» — модель и бюджет не отданы`);
    const ex = healthExposure(json);
    const detail = `GET ${PROD}/api/health → status=${r.status} за ${r.ms} мс; ключи: ${ex.keys}; ${ex.line} | ожид.: нет model/haiku/claude/gpt и budget/spent/limit`;
    return ex.model.length || ex.budget.length ? fail(detail) : pass(detail);
  },
};

/** built_at отчёта из HTML /check: проп result клиентского CheckClient сериализуется в RSC-payload (self.__next_f.push) */
const builtAtHtml = (html: string) => [...new Set([...html.matchAll(/built_at\\*"\s*:\s*\\*"(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/g)].map((m) => m[1]))];
const builtAtJson = (txt: string): string | null => {
  try { return (JSON.parse(txt) as { report?: { built_at?: string } }).report?.built_at ?? null; } catch { return null; }
};
const EXCLUDE = new Set(["RU000A10ASE2", "RU000A1038V6", "RU000A0JS4Z7", "RU000A105M67", "RU000A10AST0"]);
const CHERK = /^RU000A(1094F2|10G6Z1|10B4V0|10FUU3|10C5F9)$/; // выпуски Черкизово из golden pick — не брать

const U16: Check = {
  id: "U.16", wp: "U", kind: "live",
  title: "Прод: кэш отчётов общий для /check и /api/report — второй запрос того же q получает отчёт первого (тот же built_at)",
  async run(): Promise<Verdict> {
    // Кандидаты: TQCB с ISS без примеров главной и Черкизово, в случайном порядке — вряд ли запрашивались последние 15 минут
    const iss = await timedGet("https://iss.moex.com/iss/engines/stock/markets/bonds/boards/TQCB/securities.json?iss.only=securities&securities.columns=SECID,ISIN&iss.meta=off", 3);
    const data = (JSON.parse(iss.text) as { securities?: { data?: unknown[][] } }).securities?.data ?? [];
    const pool = data.map((row) => String(row[1] ?? "")).filter((s) => /^RU[0-9A-Z]{10}$/.test(s) && !EXCLUDE.has(s) && !CHERK.test(s));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    if (pool.length < 2) throw new Error(`ISS TQCB: кандидатов ${pool.length} (status ${iss.status})`);

    type Hit = { what: string; status: number; ms: number; built: string | null; extra: string };
    const page = async (q: string): Promise<Hit> => {
      const r = await timedGet(`${PROD}/check?q=${encodeURIComponent(q)}`, 2);
      const b = builtAtHtml(r.text);
      return { what: "/check", status: r.status, ms: r.ms, built: b[0] ?? null,
        extra: (b.length > 1 ? ` (в HTML несколько built_at: ${b.join(", ")})` : "") + (r.attempts > 1 ? ` (попытка ${r.attempts})` : "") };
    };
    const api = async (q: string): Promise<Hit> => {
      const r = await timedGet(`${PROD}/api/report?q=${encodeURIComponent(q)}`, 2);
      let kind: string;
      try { kind = String((JSON.parse(r.text) as { kind?: string }).kind); } catch { kind = "не JSON"; }
      return { what: "/api/report", status: r.status, ms: r.ms, built: builtAtJson(r.text),
        extra: (kind === "report" ? "" : ` (kind=${kind})`) + (r.attempts > 1 ? ` (попытка ${r.attempts})` : "") };
    };
    const fmtHit = (x: Hit) => `${x.what} status=${x.status} ${x.ms} мс built_at=${x.built ?? "—"}${x.extra}`;
    const used: string[] = [];
    const skipped: string[] = [];
    type Pair = { label: string; q: string; a: Hit; b: Hit; same: boolean };
    const pair = async (label: string, first: (q: string) => Promise<Hit>, second: (q: string) => Promise<Hit>): Promise<Pair> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const q = pool.find((s) => !used.includes(s));
        if (!q) break;
        used.push(q);
        const a = await first(q);
        if (!a.built) { skipped.push(`${q}: ${fmtHit(a)}`); continue; } // не отчёт (или built_at не найден) — другой выпуск
        const b = await second(q);
        return { label, q, a, b, same: b.built != null && b.built === a.built };
      }
      throw new Error(`${label}: не удалось получить отчёт с built_at; пропущены ${skipped.join("; ")}`);
    };
    const X = await pair("X: /check → /api/report", page, api);
    const Y = await pair("Y: /api/report → /check", api, page);
    // Контроль (в вердикт не входит): повтор второго запроса в ТОМ ЖЕ маршруте — внутри одного маршрута кэш должен сработать;
    // так видно, что тест способен показать «тот же built_at», и RED относится именно к обмену между /check и /api/report
    const cX = await api(X.q);
    const cY = await page(Y.q);
    const ctl = (label: string, prev: Hit, again: Hit) =>
      `${label}: ${fmtHit(again)} → ${again.built != null && again.built === prev.built ? "тот же built_at (кэш маршрута работает)" : "ДРУГОЙ built_at (кэша нет даже внутри маршрута)"}`;
    const row = (p: Pair) =>
      `${p.label}, q=${p.q}: 1) ${fmtHit(p.a)}; 2) ${fmtHit(p.b)} → ${p.same ? "ТОТ ЖЕ built_at (кэш общий)" : "built_at РАЗНЫЕ — второй запрос собрал отчёт заново"}`;
    const detail = `${row(X)} | ${row(Y)} | контроль: ${ctl(`повтор /api/report q=${X.q}`, X.b, cX)}; ${ctl(`повтор /check q=${Y.q}`, Y.b, cY)}` +
      `${skipped.length ? ` | пропущены (не отчёт): ${skipped.join("; ")}` : ""} | ` +
      `ключ кэша lib/engine.ts — q.trim().toLowerCase()+"|"+price, TTL 15 мин; q во всех запросах одинаковый; applyInputs built_at не меняет (structuredClone)`;
    return X.same && Y.same ? pass(detail) : fail(detail);
  },
};

const U17: Check = {
  id: "U.17", wp: "U", kind: "static",
  title: "explain_term на LLM-пути без дубля: промпт не требует пересказа найденной статьи, или карточка не рисуется на LLM-пути",
  async run(): Promise<Verdict> {
    const { SYSTEM_PROMPT } = await import("../../lib/prompt");
    const rule = SYSTEM_PROMPT.split("\n").filter((l) => /explain_term/.test(l));
    // Требование пересказа: повелительное «перескажи/изложи/повтори» без «не» и не в оговорке про ненайденный термин
    const NOT_FOUND = /не найден|не нашл|не нашел|не нашёл|found:\s*false|нет в глоссари/i;
    const clauses = rule.flatMap((l) => l.split(/[;.]|\s—\s|, если|\(если/));
    const retell = clauses.filter((c) => /(^|[^а-яё])(перескажи(те)?|изложи(те)?|повтори(те)?)([^а-яё]|$)/i.test(c)
      && !/(^|[^а-яё])не\s+(перескаж|излож|повтор)/i.test(c) && !NOT_FOUND.test(c));
    const promptRequires = retell.length > 0;
    // UI: одна и та же карточка на пути гейта (toolCallId gate_…) и на LLM-пути (toolu_… / call_…)?
    const ui = (await import("../../components/ToolUIs")) as ToolUIsMod;
    const { GLOSSARY } = await import("../../lib/glossary");
    const t = GLOSSARY.find((g) => g.id === "nkd") ?? GLOSSARY[0];
    const result = { found: true, id: t.id, title: t.title, text: t.text };
    const probe = t.text.slice(0, 40);
    const render = async (callId: string) => {
      const r = await renderTool(ui.ExplainToolUI, toolProps("explain_term", callId, { term: "что такое НКД" }, result));
      return { card: r.html != null && unescapeHtml(r.html).includes(probe), html: r.html, error: r.error };
    };
    const llm = await render("toolu_audit_u17");
    const gate = await render("gate_audit_u17");
    if (llm.html == null) throw new Error(`ExplainToolUI не рендерится: ${llm.error}`);
    const at = lineOf(readSrc("apps/web/lib/prompt.ts"), /explain_term/);
    const map = lineOf(readSrc("apps/web/components/ToolUIs.tsx"), /explain_term:\s*ExplainToolUI/);
    const ok = !promptRequires || !llm.card;
    const detail =
      `промпт (apps/web/lib/prompt.ts:${at?.n ?? "?"}): «${cut(oneLine(rule.join(" ")), 220)}» → требует пересказ найденной статьи: ${promptRequires}` +
      `${retell.length ? ` (${show(retell.map((c) => cut(oneLine(c), 80)))})` : ""}; ` +
      `UI (ToolUIs.tsx${map ? `:${map.n} «${map.text}»` : ""}): ExplainToolUI с found:true «${t.title}» — карточка с текстом статьи ` +
      `на LLM-пути (toolCallId toolu_…): ${llm.card}, на пути гейта (gate_…): ${gate.card} | ` +
      `ожид.: промпт не требует пересказа при found:true ИЛИ карточка не рисуется на LLM-пути; сейчас на LLM-пути: ` +
      `${llm.card && promptRequires ? "карточка + обязательный пересказ модели (дубль)" : "без дубля"}`;
    return ok ? pass(detail) : fail(detail);
  },
};

const U18: Check = {
  id: "U.18", wp: "U", kind: "static",
  title: "Markdown: текст модели рендерится как Markdown, либо промпт явно запрещает разметку",
  async run(): Promise<Verdict> {
    const rel = "apps/web/components/Thread.tsx";
    const raw = readSrc(rel);
    const src = stripComments(raw);
    const MD_IMPORT = /from\s+["'](@assistant-ui\/react-markdown|react-markdown|marked|markdown-it|micromark|remark[^"']*|mdast[^"']*)["']/;
    const mdImport = src.match(MD_IMPORT)?.[1] ?? null;
    const mdUse = /MarkdownText|MarkdownTextPrimitive|ReactMarkdown|dangerouslySetInnerHTML/.test(src);
    // локальные модули, импортированные в Thread.tsx, тоже смотрим (вдруг Text вынесут в свой файл)
    const localImports = [...src.matchAll(/from\s+["']\.\/([^"']+)["']/g)].map((m) => m[1]);
    const viaLocal = localImports.filter((f) => {
      const p = ["", ".tsx", ".ts"].map((ext) => path.join(WEB_ROOT, "components", f + ext)).find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
      return p ? MD_IMPORT.test(stripComments(fs.readFileSync(p, "utf8"))) : false;
    });
    const rendersMd = mdImport != null || mdUse || viaLocal.length > 0;
    const textPart = lineOf(raw, /const\s+TextPart\b/);
    const partsUse = lineOf(raw, /Text:\s*TextPart/);
    const { SYSTEM_PROMPT } = await import("../../lib/prompt");
    const FORBID = /(без|не\s+(используй|применяй|пиши|ставь|оформляй)|запрещ[а-яё]*|нельзя)[^.\n]{0,60}(markdown|маркдаун|разметк|форматировани|звёздоч|звездоч|\*\*|заголов|маркирован)|(простым|обычным|плоским)\s+текстом|plain text/i;
    const forbid = SYSTEM_PROMPT.match(FORBID)?.[0] ?? null;
    const style = SYSTEM_PROMPT.match(/[^.\n]*без эмодзи[^.\n]*/)?.[0] ?? null;
    const deps = Object.keys(readJson<{ dependencies?: Record<string, string> }>("apps/web/package.json").dependencies ?? {}).filter((k) => /markdown/i.test(k));
    const ok = rendersMd || forbid != null;
    const detail =
      `${rel}${textPart ? `:${textPart.n} «${cut(textPart.text, 110)}»` : ""}${partsUse ? `, у ассистента (строка ${partsUse.n}) «${cut(partsUse.text, 60)}»` : ""}; ` +
      `Markdown-рендер: импорт ${mdImport ?? "нет"}, компоненты Markdown/innerHTML ${mdUse}, через локальные модули ${viaLocal.length ? viaLocal.join(",") : "нет"}; ` +
      `markdown-пакеты в зависимостях apps/web: ${deps.length ? `${deps.join(", ")} (${rendersMd ? "используется" : "объявлен, но в Thread не используется"})` : "нет"}; ` +
      `промпт (lib/prompt.ts) запрещает разметку: ${forbid ? `«${forbid}»` : "нет"}${style ? ` (о стиле только «${cut(oneLine(style), 90)}»)` : ""} | ` +
      `ожид.: Markdown рендерится ИЛИ промпт запрещает разметку`;
    return ok ? pass(detail) : fail(detail);
  },
};

const U19: Check = {
  id: "U.19", wp: "U", kind: "fixture",
  title: "Ответ ассистента попадает в журнал: после POST /api/chat (MOCK-модель, реплика уходит в модель) в usage.jsonl есть текст ответа",
  async run(): Promise<Verdict> {
    const { route, usage } = await loadChat();
    const file = assertTmpUsage(usage);
    const { findTerm } = await import("../../lib/glossary");
    // термин вне глоссария: гейт (Jev-мок explain_term 1.0) не находит статью и отдаёт реплику модели
    const text = ["Что такое контанго?", "Что такое бэквордация?", "Что такое ковенант?"].find((s) => findTerm(s) == null);
    if (!text) throw new Error("все пробные термины нашлись в глоссарии — гейт закроет реплику без модели, нужен другой термин");
    const mock = strictJev("explain_term");
    const sid = `audit-u19-${rid()}`;
    const env = {
      ...SERVER_ENV(), SO_USAGE_LOG: "1",
      MOCK_LLM: undefined, LLM_PROVIDER: undefined, OPENROUTER_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
      JEV_ENABLED: undefined, TYPESAFE_API_KEY: "audit-dummy", JEV_PROVIDER: "typesafe",
    };
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8").length : 0;
    const r = await withFetch(mock.fetch, () => withEnv(env, async () => {
      const { provider } = await import("../../lib/model");
      const prov = provider();
      if (prov !== "mock") throw new Error(`дефект харнеса: provider()=${prov}, ожидался mock (LLM-ключи сняты)`);
      const out = await postChat(route, { id: sid, messages: [userMsg(text)] });
      await new Promise((res) => setTimeout(res, 50)); // onFinish-колбэки после конца потока
      return out;
    }));
    const parts = sseParts(r.body);
    const answer = oneLine(sseText(parts));
    const tools = parts.filter((p) => p.type === "tool-input-available").map((p) => String(p.toolName));
    const added = fs.existsSync(file) ? fs.readFileSync(file, "utf8").slice(before) : "";
    // все записи, дописанные за этот POST (журнал временный и пишется последовательно), — и с полем chat, и без него
    const fresh = added.split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((x): x is Record<string, unknown> => x != null);
    const recs = fresh.filter((x) => x.chat === sid);
    const llm = recs.filter((x) => x.step === "llm");
    if (!answer || llm.length === 0)
      throw new Error(`дефект харнеса: реплика не дошла до модели — status=${r.status}, ответ «${cut(answer, 80)}», записей llm ${llm.length}, Jev-вызовов ${mock.seen.length}, неожиданные URL ${show(mock.unexpected)}`);
    const probe = answer.slice(0, 25);
    const holder = fresh.flatMap((x) => leaves(x).map((l) => ({ ...l, step: String(x.step) })))
      .find((l) => typeof l.value === "string" && oneLine(l.value).includes(probe));
    const other = fresh.length - recs.length;
    const detail =
      `реплика «${text}» (Jev-мок explain_term 1.0, статьи нет → MOCK-модель; инструменты: ${tools.join(",") || "нет"}); ` +
      `ответ ассистента: «${cut(answer, 90)}»; новых записей журнала ${fresh.length} (по сессии ${recs.length}${other ? `, без chat этой сессии ${other}` : ""}): ` +
      fresh.map((x) => `${String(x.step)}{${Object.keys(x).join(",")}}`).join("; ") +
      `; текст ответа (начало «${probe}») в журнале: ${holder ? `да, запись ${holder.step}, поле ${holder.path}` : "НЕТ"} | ожид.: в usage.jsonl есть хотя бы начало ответа ассистента`;
    return holder ? pass(detail) : fail(detail);
  },
};

const U20: Check = {
  id: "U.20", wp: "U", kind: "static",
  title: "Страница /check переживает сбой ISS: error.tsx (app/check или выше) или обработка исключения buildCached — не голый 500",
  async run(): Promise<Verdict> {
    // Статика: граница ошибок Next для сегмента /check (app/check/error.*, app/error.*, app/global-error.*)
    const appDir = path.join(WEB_ROOT, "app");
    const candidates = ["check/error", "error", "global-error"].flatMap((b) => ["tsx", "ts", "jsx", "js"].map((e) => `${b}.${e}`));
    const boundaries = candidates.filter((f) => fs.existsSync(path.join(appDir, f)));
    const pageRaw = readSrc("apps/web/app/check/page.tsx");
    const pageSrc = stripComments(pageRaw);
    const staticCatch = /\btry\s*\{[\s\S]*buildCached[\s\S]*\}\s*catch\b|buildCached\([^)]*\)[\s\S]{0,200}?\.catch\(/.test(pageSrc);
    const call = lineOf(pageRaw, /await buildCached\(/);
    // Динамика: CheckPage() как функция, ISS отвечает 502 на всё (fetch-заглушка; чужие URL — исключение)
    let dyn: string;
    let dynHandled: boolean | null = null;
    ensureHook();
    const mod = await withEnv({ ...SERVER_ENV(), SO_OFFLINE: undefined }, async () => ({
      page: await import("../../app/check/page"), engine: await import("../../lib/engine"),
    }));
    if (mod.engine.isOffline()) dyn = "пропущена: lib/engine.ts загружен с SO_OFFLINE=1 (ISS не вызывается)";
    else {
      let calls = 0;
      const iss502 = (async (input: unknown) => {
        const url = urlOf(input);
        if (!url.startsWith("https://iss.moex.com/")) throw new Error(`аудит: сеть запрещена (fetch ${cut(url, 80)})`);
        calls++;
        return new Response("Bad Gateway", { status: 502 });
      }) as typeof fetch;
      const q = `RU000AU${Math.random().toString(36).slice(2, 7).toUpperCase().padEnd(5, "0")}`; // уникальный ISIN-формат — мимо кэша
      const t0 = Date.now();
      const out = await withFetch(iss502, async () => {
        try {
          const el = (await mod.page.default({ searchParams: Promise.resolve({ q }) })) as unknown as { props?: { result?: BuildResultT } };
          return { ok: true as const, res: el?.props?.result };
        } catch (e) { return { ok: false as const, err: e }; }
      });
      const ms = Date.now() - t0;
      if (calls === 0) dyn = `неинформативна: к ISS не обращались (кэш?), q=${q}`;
      else if (out.ok) {
        dynHandled = true;
        const res = out.res;
        dyn = `CheckPage(q=${q}) при ISS→502 (${calls} запр., ${ms} мс) вернула страницу: result.kind=${res?.kind}${res?.kind === "err" ? `, msg «${cut(res.msg, 80)}»` : ""}`;
      } else {
        dynHandled = false;
        const e = out.err as { name?: string; message?: string; constructor?: { name?: string } };
        dyn = `CheckPage(q=${q}) при ISS→502 (${calls} запр., ${ms} мс) БРОСИЛА ${e?.constructor?.name ?? e?.name}: «${cut(String(e?.message ?? e), 110)}» — без error.tsx Next отдаёт 500`;
      }
    }
    const ok = boundaries.length > 0 || dynHandled === true || (dynHandled === null && staticCatch);
    const detail =
      `границы ошибок в apps/web/app: ${boundaries.length ? boundaries.join(", ") : "нет (искал check/error, error, global-error .tsx/.ts/.jsx/.js)"}; ` +
      `page.tsx${call ? `:${call.n} «${cut(call.text, 70)}»` : ""} — try/catch или .catch вокруг buildCached: ${staticCatch}; динамика: ${dyn} | ` +
      `см. также R.6 (движок: build() при HTTP 500/403/TypeError ISS → {kind:"err"}) и R.6-web (buildCached → {kind:"err"} без записи сбоя в кэш): ` +
      `когда они станут GREEN, страница получит err-конверт и динамика здесь тоже станет GREEN | ожид.: error.tsx или страница не бросает при сбое ISS`;
    return ok ? pass(detail) : fail(detail);
  },
};

export const checks: Check[] = [U12, U13, U14, U15, U16, U17, U18, U19, U20];
