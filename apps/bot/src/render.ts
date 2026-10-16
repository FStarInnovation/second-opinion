/**
 * Рендер ответа ассистента в сообщения Telegram (план WP-TG §4.4, §4.7, инвариант И3). Чистые функции.
 * Все тексты отчёта и веток — из view-model @so/present/report (presentReport, presentBranch); тексты бота — из @so/present/copy.
 * Здесь только раскладка: порядок, теги b/i/code, разделители (пробел, перевод строки, «:», «·», «—»), кнопки.
 *
 *  - renderTurn: части сообщения строго по порядку parts; step-start пропускается; текст ассистента — простой текст (длиннее
 *    4096 — по предложениям); инструмент отчёта — HTML отчёта или ветки (длинный — частями по секциям, кнопки — у последней
 *    части); {error} — текст ошибки; explain_term found:true — <b>title</b> и текст, found:false — ничего.
 *  - renderReport: шапка (dataTime курсивом, kicker, <b>name</b> <code>ISIN</code>), секции VM, плашка; кнопки «Полный отчёт —
 *    после входа» (кабинет, если есть плашка) и «Открыть на сайте» (/check?… из chatParams, если задан siteUrl).
 *  - renderBranch: pick — текст VM, список кандидатов и по кнопке на кандидата (pk:<ISIN ?? SECID>); notfound/err — текст VM.
 */
import type { UIMessage } from "ai";
import type { BuildResultT } from "@so/engine/contract";
import { BOT } from "@so/present/copy";
import { chatParams, type EntryParams } from "@so/present/entry";
import { TOOL_NAMES, type ExplainResult } from "@so/present/protocol";
import { presentBranch, presentReport, type BranchVM, type ReportVM, type SectionVM } from "@so/present/report";
import { escapeHtml as esc, splitHtml, TG_MAX } from "./html";
import type { InlineKeyboard } from "./telegram";

export type TgOp = { partIndex: number; toolCallId?: string; text: string; html: boolean; keyboard?: InlineKeyboard };

/** Инструменты отчёта (как ReportToolUI сайта): выход {query, result} или {error}; на время сборки — заглушка WAIT_REPORT */
export const REPORT_TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES.filter((n) => n !== "explain_term"));
/** Префиксы callback_data: выбор выпуска и подсказка /start */
export const CB_PICK = "pk:";
export const CB_SUGGEST = "sg:";
/** Предел callback_data в байтах (Bot API) */
const CB_MAX_BYTES = 64;

/** Имя инструмента части сообщения: tool-<имя> или dynamic-tool; иначе null */
export function toolNameOf(p: { type: string }): string | null {
  if (p.type.startsWith("tool-")) return p.type.slice("tool-".length);
  if (p.type === "dynamic-tool") { const n = (p as { toolName?: unknown }).toolName; return typeof n === "string" ? n : null; }
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (s: string | null | undefined): s is string => typeof s === "string" && s.trim() !== "";

/* ═══════════════════════════ простой текст ═══════════════════════════ */

/** Простой текст на сообщения ≤ max: по предложениям (и переводам строк), длинное предложение — по словам, слово — посимвольно */
export function plainChunks(text: string, max: number = TG_MAX): string[] {
  const t = String(text).trim();
  if (t.length <= max) return t ? [t] : [];
  const pieces = t.match(/[^.!?…\n]*(?:[.!?…]+|\n+|$)\s*/g)?.filter((s) => s !== "") ?? [t];
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  const add = (s: string) => {
    if ((cur + s).length <= max) { cur += s; return; }
    push();
    if (s.length <= max) { cur = s; return; }
    for (const w of s.split(/(?<=\s)/)) {
      if ((cur + w).length <= max) { cur += w; continue; }
      push();
      // по max единиц UTF-16, суррогатная пара не разрезается; не последняя часть уходит сразу, последняя — в cur
      for (let i = 0; i < w.length;) {
        let end = Math.min(i + max, w.length);
        if (end < w.length && end - i > 1) { const c = w.charCodeAt(end - 1); if (c >= 0xd800 && c <= 0xdbff) end--; }
        const part = w.slice(i, end);
        if (end < w.length) out.push(part); else cur = part;
        i = end;
      }
    }
  };
  for (const s of pieces) add(s);
  push();
  return out;
}

/* ═══════════════════════════ отчёт ═══════════════════════════ */

/** Адрес /check с параметрами входа (тот же контракт, что ссылка с сайта: q, promised, pos, k, price) */
function checkHref(siteUrl: string, p: EntryParams): string {
  const sp = new URLSearchParams();
  for (const k of ["q", "promised", "pos", "k", "price"] as const) { const v = p[k]; if (v != null && v !== "") sp.set(k, v); }
  return `${siteUrl.replace(/\/+$/, "")}/check?${sp.toString()}`;
}

/** Строки секции VM в Telegram-HTML. cardTitle — заголовок текущей карточки (у продолжения карточки свой title пуст) */
function sectionHtml(s: SectionVM, cardTitle: string): string {
  const out: string[] = [];
  if (nonEmpty(s.title)) out.push(`<b>${esc(s.title)}</b>`);
  if (nonEmpty(s.subtitle)) out.push(`<i>${esc(s.subtitle)}</i>`);
  if (nonEmpty(s.big)) out.push(`<b>${esc(s.big)}</b>`);
  // бары доходности — до вывода (как на сайте); подпись баров не повторяет заголовок карточки
  if (s.bars?.length) {
    if (nonEmpty(s.barsCaption) && s.barsCaption.trim() !== cardTitle.trim()) out.push(`<i>${esc(s.barsCaption)}</i>`);
    for (const b of s.bars) out.push(`${esc(b.label)}: <b>${esc(b.value)}</b>`);
  } else if (nonEmpty(s.barsCaption) && s.barsCaption.trim() !== cardTitle.trim()) out.push(`<i>${esc(s.barsCaption)}</i>`);
  const lines = s.lines.filter(nonEmpty);
  const items = (s.items ?? []).map((it) =>
    `· <b>${esc(it.title)}</b>${nonEmpty(it.badge) ? ` ${esc(it.badge)}` : ""}${nonEmpty(it.text) ? `\n${esc(it.text)}` : ""}`);
  if (s.id === "flags_score" && items.length) {
    // форма строк flags_score (шапка report.ts): [градация, «Главные red flags», «Ещё N — в полном отчёте»?] — пункты после второй
    const [grade, head, ...rest] = lines;
    if (grade) out.push(esc(grade));
    if (head) out.push(`<b>${esc(head)}</b>`);
    out.push(...items);
    out.push(...rest.map(esc));
  } else {
    out.push(...lines.map(esc));
    out.push(...items);
  }
  return out.join("\n");
}

/** Отчёт: HTML и клавиатура (кабинет; сайт — если задан siteUrl и есть параметры входа) */
export function renderReport(vm: ReportVM, o: { siteUrl?: string; cabinetHref?: string; params?: EntryParams } = {}): { html: string; keyboard?: InlineKeyboard } {
  const head = [
    nonEmpty(vm.dataTime) ? `<i>${esc(vm.dataTime)}</i>` : null,
    nonEmpty(vm.kicker) ? esc(vm.kicker) : null,
    `<b>${esc(vm.name)}</b>${nonEmpty(vm.isin) ? ` <code>${esc(vm.isin)}</code>` : ""}`,
  ].filter((x): x is string => x != null);
  const blocks: string[] = [head.join("\n")];
  let cardTitle = "";
  for (const s of vm.sections) {
    const continues = !nonEmpty(s.title) && blocks.length > 1;
    if (nonEmpty(s.title)) cardTitle = s.title;
    const h = sectionHtml(s, cardTitle);
    if (!h.trim()) continue;
    if (continues) blocks[blocks.length - 1] += `\n${h}`; // продолжение карточки — без пустой строки
    else blocks.push(h);
  }
  if (vm.plaque) blocks.push([`<b>${esc(vm.plaque.title)}</b>`, ...vm.plaque.items.filter(nonEmpty).map((x) => `· ${esc(x)}`)].join("\n"));
  const rows: InlineKeyboard["inline_keyboard"] = [];
  if (vm.plaque && nonEmpty(o.cabinetHref)) rows.push([{ text: BOT.fullReport, url: o.cabinetHref }]);
  if (nonEmpty(o.siteUrl) && o.params && nonEmpty(o.params.q)) rows.push([{ text: BOT.openOnSite, url: checkHref(o.siteUrl, o.params) }]);
  return { html: blocks.join("\n\n"), ...(rows.length ? { keyboard: { inline_keyboard: rows } } : {}) };
}

/* ═══════════════════════════ ветки ═══════════════════════════ */

/** Ветка: pick — текст, список кандидатов (выпуск, ISIN/SECID, рег. номер, торги) и кнопки выбора; notfound/err — текст */
export function renderBranch(vm: BranchVM): { html: string; keyboard?: InlineKeyboard } {
  const L: string[] = [`<b>${esc(vm.title)}</b>`, ...vm.lines.filter(nonEmpty).map(esc)];
  if (vm.kind !== "pick") return { html: L.join("\n") };
  const rows: InlineKeyboard["inline_keyboard"] = [];
  const list = vm.options.map((op) => `· <b>${esc(op.label)}</b> <code>${esc(op.sub)}</code> · ${esc(op.reg)} · ${esc(op.trading)}`);
  for (const op of vm.options) {
    const data = CB_PICK + op.sub;
    if (Buffer.byteLength(data, "utf8") > CB_MAX_BYTES || rows.length >= 100) continue;
    rows.push([{ text: `${op.label} · ${op.sub}`, callback_data: data }]);
  }
  return { html: [L.join("\n"), list.join("\n")].filter((x) => x.trim()).join("\n\n"), ...(rows.length ? { keyboard: { inline_keyboard: rows } } : {}) };
}

/* ═══════════════════════════ ход ═══════════════════════════ */

/** HTML на сообщения (≤ 4096 видимых): клавиатура — у последнего */
function htmlOps(partIndex: number, toolCallId: string, r: { html: string; keyboard?: InlineKeyboard }): TgOp[] {
  const chunks = splitHtml(r.html, TG_MAX);
  return chunks.map((text, k) => ({
    partIndex, toolCallId, text, html: true, ...(k === chunks.length - 1 && r.keyboard ? { keyboard: r.keyboard } : {}),
  }));
}

/** Выход инструмента отчёта → сообщения; не тот формат — ничего */
function reportToolOps(partIndex: number, toolCallId: string, out: unknown, o: { siteUrl?: string; cabinetHref?: string }): TgOp[] {
  if (!isObj(out)) return [];
  if (typeof out.error === "string") return plainChunks(out.error).map((text) => ({ partIndex, toolCallId, text, html: false }));
  const res = out.result as BuildResultT | undefined;
  if (!isObj(res) || typeof res.kind !== "string") return [];
  const query = typeof out.query === "string" ? out.query : "";
  if (res.kind === "report") {
    const params = chatParams(res, query) ?? undefined;
    return htmlOps(partIndex, toolCallId, renderReport(presentReport(res.report), { siteUrl: o.siteUrl, cabinetHref: o.cabinetHref, params }));
  }
  return htmlOps(partIndex, toolCallId, renderBranch(presentBranch(res)));
}

/** Сообщение ассистента → операции Telegram в порядке parts */
export function renderTurn(m: UIMessage, o: { siteUrl?: string; cabinetHref?: string } = {}): TgOp[] {
  const ops: TgOp[] = [];
  (m?.parts ?? []).forEach((p, i) => {
    if (p.type === "step-start") return;
    if (p.type === "text") {
      for (const text of plainChunks((p as { text?: string }).text ?? "")) ops.push({ partIndex: i, text, html: false });
      return;
    }
    const name = toolNameOf(p);
    if (!name) return;
    const tp = p as { toolCallId?: unknown; state?: unknown; output?: unknown };
    if (tp.state !== "output-available" || typeof tp.toolCallId !== "string") return;
    try {
      if (name === "explain_term") {
        const x = tp.output as ExplainResult | undefined;
        if (isObj(x) && x.found === true && nonEmpty(x.title))
          ops.push(...htmlOps(i, tp.toolCallId, { html: `<b>${esc(x.title)}</b>${nonEmpty(x.text) ? `\n${esc(x.text)}` : ""}` }));
        return;
      }
      if (REPORT_TOOLS.has(name)) ops.push(...reportToolOps(i, tp.toolCallId, tp.output, o));
    } catch {
      /* выход инструмента не той формы — часть не рисуется, остальные идут */
    }
  });
  return ops;
}
