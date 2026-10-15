/**
 * WP-TG: SSR-рендер блоков отчёта и снимок apps/web/audit/fixtures/tg/ssr_golden.json (§6 «Снимок», TG.G5, TG.6).
 *
 * Входы `ssrInputs()`: 16 golden packages/engine/golden/expected/*.json (отчёты и ветки pick/notfound), 3 live-фикстуры
 * apps/web/audit/fixtures/live_*.json и 2 синтетические ветки err (в golden ветки err нет): тексты ошибок из кода сервера и движка.
 * Для каждого входа два рендера renderToStaticMarkup (react-dom/server), в процессе вызывающего:
 *   chat — как в чате (components/ToolUIs.tsx:35): отчёт `<ReportView report compact showInputs={false} askPriceUnavailableNote=…/>`,
 *          pick `<PickView res onPick compact/>` (ChatPick, ход не идёт — onPick задан), notfound/err `<NotFoundView|ErrView res compact/>`;
 *   page — страница /check: `<ResultApp result homeHref="/" hrefFor rebuild/>`, как в app/check/CheckClient.tsx, но без renderAfter
 *          (ссылка «Обсудить с ассистентом» — слот хоста CheckClient, а не ResultApp; CheckClient вне Next не рендерится: useRouter).
 * Снимок хранит ssrText (normalize.ts) каждого рендера.
 *
 * Запись (один раз, шаг 1; дальше снимок меняет только оркестратор после разбора диффа — по правилам golden):
 *   node --import tsx apps/web/audit/tg/record-ssr.ts --record-tg-ssr [--commit d16c809] [--date 2026-10-15]
 * Сверка без записи (печатает расхождения, exit 1 при расхождении):
 *   node --import tsx apps/web/audit/tg/record-ssr.ts --check
 * Обе команды печатают самопроверку §6: veb содержит «40 / 100», cherk2p2 — «+0,24% за период до колла».
 * Запускать из корня репозитория или из apps/web: пути считаются от этого файла.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import type { BuildResultT } from "@so/engine/contract";
import { AUDIT_FIXTURES, REPO_ROOT } from "../lib";
import { diff, ssrText } from "./normalize";

type BlocksMod = typeof import("@so/blocks");

/** Путь снимка */
export const SSR_SNAPSHOT = path.join(AUDIT_FIXTURES, "tg", "ssr_golden.json");
/** askPriceUnavailableNote чата (ToolUIs.tsx:35). В SSR не виден: показывается только после submit формы (blocks.tsx:111,128) */
export const CHAT_ASK_PRICE_NOTE = "Напишите цену предложения в чате — пересчитаю.";
/** ssrText-правило, записанное в снимок (для читателя JSON) */
export const SSR_RULE = "теги <…> → пробел; HTML-сущности раскодированы; \\s+ → один пробел, trim; затем значения aria-label с новой строки (normalize.ts ssrText)";

export interface SsrInput {
  /** имя входа: golden — имя кейса (veb, cherk2p2, …), live — имя файла без .json (live_ofz26244), синтетика — err-* */
  name: string;
  /** откуда вход (путь от корня репо или описание синтетики) */
  source: string;
  result: BuildResultT;
}

const GOLDEN_EXPECTED = path.join(REPO_ROOT, "packages", "engine", "golden", "expected");
const LIVE = ["live_ofz26244", "live_rolf_p26", "live_rolf_plain"] as const;
/** Синтетические ветки err: тексты — дословно из кода (в golden ветки err нет) */
const SYNTH_ERR: SsrInput[] = [
  { name: "err-iss", source: "синтетика: ISS_DOWN_MSG, apps/web/lib/engine.ts:74 (сбой Мосбиржи в buildCached)",
    result: { kind: "err", query: "RU000A1038V6", msg: "Мосбиржа сейчас не отвечает — попробуйте через минуту." } },
  { name: "err-url", source: "синтетика: packages/engine/src/recognize.ts:64-67 (ссылка без ISIN)",
    result: { kind: "err", query: "https://example.ru/bonds/abc", msg: "В ссылке нет ISIN. Подойдёт ссылка, в адресе которой есть ISIN (страница Мосбиржи или брокера), либо сам ISIN или название выпуска. Страницы сайтов мы пока не разбираем." } },
];

/** Все входы SSR: 16 golden (по имени файла), 3 live, 2 синтетические err — 21 вход, порядок стабильный */
export function ssrInputs(): SsrInput[] {
  const golden = fs.readdirSync(GOLDEN_EXPECTED).filter((f) => f.endsWith(".json")).sort().map((f) => ({
    name: f.replace(/\.json$/, ""),
    source: path.relative(REPO_ROOT, path.join(GOLDEN_EXPECTED, f)),
    result: JSON.parse(fs.readFileSync(path.join(GOLDEN_EXPECTED, f), "utf8")) as BuildResultT,
  }));
  const live = LIVE.map((n) => ({
    name: n, source: path.relative(REPO_ROOT, path.join(AUDIT_FIXTURES, `${n}.json`)),
    result: JSON.parse(fs.readFileSync(path.join(AUDIT_FIXTURES, `${n}.json`), "utf8")) as BuildResultT,
  }));
  return [...golden, ...live, ...SYNTH_ERR.map((s) => ({ ...s, result: JSON.parse(JSON.stringify(s.result)) as BuildResultT }))];
}

/* ═══════════════════════════ рендер ═══════════════════════════ */

type H = (type: unknown, props?: unknown, ...children: unknown[]) => ReactElement;
let rt: Promise<{ h: H; render: (el: ReactElement) => string; blocks: BlocksMod }> | null = null;
/** React + react-dom/server + @so/blocks; packages/blocks транслируется классическим JSX (tsconfig apps/web их не включает) —
 *  поэтому globalThis.React = React, как в wp-u-ui.ts */
function runtime() {
  return (rt ??= (async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const g = globalThis as unknown as { React?: unknown };
    g.React ??= React;
    const blocks = (await import("@so/blocks")) as BlocksMod;
    return { h: React.createElement as unknown as H, render: (el: ReactElement) => renderToStaticMarkup(el), blocks };
  })());
}

/** HTML compact-рендера как в чате (ToolUIs.tsx: ReportToolUI / ChatPick) */
export async function renderChatHtml(res: BuildResultT): Promise<string> {
  const { h, render, blocks: b } = await runtime();
  if (res.kind === "report")
    return render(h(b.ReportView, { report: res.report, compact: true, showInputs: false, askPriceUnavailableNote: CHAT_ASK_PRICE_NOTE }));
  if (res.kind === "pick") return render(h(b.PickView, { res, onPick: () => {}, compact: true }));
  if (res.kind === "notfound") return render(h(b.NotFoundView, { res, compact: true }));
  return render(h(b.ErrView, { res, compact: true }));
}

/** HTML страницы /check: ResultApp с пропсами CheckClient (без renderAfter, см. шапку) */
export async function renderPageHtml(res: BuildResultT): Promise<string> {
  const { h, render, blocks: b } = await runtime();
  return render(h(b.ResultApp, {
    result: res, homeHref: "/",
    hrefFor: (secid: string) => `/check?q=${encodeURIComponent(secid)}`,
    rebuild: async () => res,
  }));
}

/** Оба рендера одного входа: HTML и ssrText */
export async function renderSsr(res: BuildResultT): Promise<{ chatHtml: string; pageHtml: string; chat: string; page: string }> {
  const chatHtml = await renderChatHtml(res);
  const pageHtml = await renderPageHtml(res);
  return { chatHtml, pageHtml, chat: ssrText(chatHtml), page: ssrText(pageHtml) };
}

/* ═══════════════════════════ снимок ═══════════════════════════ */

export interface SsrEntry { source: string; kind: BuildResultT["kind"]; chat: string; page: string }
export interface SsrSnapshot {
  recorded: { commit: string; date: string; via: string; react: string; rule: string };
  entries: Record<string, SsrEntry>;
}

/** Текущий рендер всех входов в форме снимка (recorded — из параметров) */
export async function buildSnapshot(meta: { commit: string; date: string }): Promise<SsrSnapshot> {
  const React = await import("react");
  const entries: Record<string, SsrEntry> = {};
  for (const inp of ssrInputs()) {
    const r = await renderSsr(inp.result);
    entries[inp.name] = { source: inp.source, kind: inp.result.kind, chat: r.chat, page: r.page };
  }
  return {
    recorded: { commit: meta.commit, date: meta.date, via: "renderToStaticMarkup (react-dom/server), @so/blocks", react: React.version, rule: SSR_RULE },
    entries,
  };
}

/** Записанный снимок (null — файла нет) */
export function readSnapshot(): SsrSnapshot | null {
  return fs.existsSync(SSR_SNAPSHOT) ? (JSON.parse(fs.readFileSync(SSR_SNAPSHOT, "utf8")) as SsrSnapshot) : null;
}

/** Самопроверка §6: veb — «40 / 100», cherk2p2 — «+0,24% за период до колла» (в обоих рендерах) */
export function selfCheck(s: SsrSnapshot): { ok: boolean; lines: string[] } {
  const probes: [string, string][] = [["veb", "40 / 100"], ["cherk2p2", "+0,24% за период до колла"]];
  const lines: string[] = [];
  let ok = true;
  for (const [name, needle] of probes) {
    const e = s.entries[name];
    for (const view of ["chat", "page"] as const) {
      const has = !!e && e[view].includes(needle);
      ok &&= has;
      lines.push(`${has ? "ок " : "НЕТ"} ${name}.${view} содержит «${needle}»`);
    }
  }
  return { ok, lines };
}

/* ═══════════════════════════ CLI ═══════════════════════════ */

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const git = (args: string[]) => { try { return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim(); } catch { return "unknown"; } };
  if (argv.includes("--record-tg-ssr")) {
    const snap = await buildSnapshot({
      commit: opt("--commit") ?? git(["rev-parse", "--short", "HEAD"]),
      date: opt("--date") ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10),
    });
    fs.mkdirSync(path.dirname(SSR_SNAPSHOT), { recursive: true });
    fs.writeFileSync(SSR_SNAPSHOT, JSON.stringify(snap, null, 1) + "\n");
    const sc = selfCheck(snap);
    console.log(`записан ${path.relative(REPO_ROOT, SSR_SNAPSHOT)}: ${Object.keys(snap.entries).length} входов × 2 рендера, commit ${snap.recorded.commit}, React ${snap.recorded.react}`);
    console.log(sc.lines.join("\n"));
    return sc.ok ? 0 : 1;
  }
  if (argv.includes("--check")) {
    const saved = readSnapshot();
    if (!saved) { console.error(`нет снимка ${SSR_SNAPSHOT}`); return 2; }
    const now = await buildSnapshot(saved.recorded);
    const d = diff(saved.entries, now.entries, { path: "entries", labels: ["снимок", "сейчас"] });
    console.log(d ? `РАСХОЖДЕНИЕ: ${d}` : `снимок совпадает (${Object.keys(saved.entries).length} входов)`);
    console.log(selfCheck(now).lines.join("\n"));
    return d ? 1 : 0;
  }
  console.error("record-ssr: нужен --record-tg-ssr (записать снимок) или --check (сверить)");
  return 2;
}

const isMain = (() => {
  try { return fs.realpathSync(path.resolve(process.argv[1] ?? "")) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
