/**
 * WP-D — гейт расхождения `controlFailPp` (docs/AUDIT_PLAN_2026-10-09.md, раздел WP-D; аудит п. D / R2-01).
 * Каждая проверка утверждает ЖЕЛАЕМОЕ поведение; до правки — RED.
 *
 * Желаемое: при control_diff_pp > CONFIG.controlFailPp движок гасит всё ПРОИЗВОДНОЕ ОТ СОБСТВЕННОГО расчёта
 * (k_grid, fees_tax.pre/post, панель fees, worst.call), оставляет биржевую доходность главной и выставляет
 * ОБА сигнала: поле yield.control_failed === true И фразу «не сошёлся» в yield.line. Не производное от own
 * (панель worst с rates/default) остаётся. На нормальных бумагах (Δ ≤ порога) гейт молчит — это guard D.4.
 * D.2 (digest) живёт в веб-модуле apps/web/audit/checks/wp-d.ts.
 */
import { CONFIG } from "../../config";
import { assembleReport } from "../../report";
import type { BondReportT } from "../../contract";
import type { BondFacts } from "../../iss/facts";
import { buildFixture, facts, fmt, readSrc, reportOf, type Check, type Verdict } from "../lib";

/* ───── локальные помощники (lib не трогаем) ───── */
interface Item { ok: boolean; text: string }
const it = (ok: boolean, text: string): Item => ({ ok, text });
const render = (items: Item[]) => items.map((i) => `${i.ok ? "✓" : "✗"} ${i.text}`).join("; ");
const verdict = (sections: [string, Item[]][]): Verdict => ({
  pass: sections.every(([, items]) => items.every((i) => i.ok)),
  detail: sections
    .map(([name, items]) => `[${name}: ${items.filter((i) => !i.ok).length} из ${items.length} не выполнено] ${render(items)}`)
    .join(" || "),
});

/** Поле yield.control_failed появится в контракте после правки — читаем динамически, без зависимости от типа.
 *  Отчёт проходит BondReport.parse(), поэтому поле, добавленное в report.ts, но не в zod-схему, здесь будет undefined — и это RED. */
const controlFailed = (r: BondReportT): unknown => (r.yield as unknown as Record<string, unknown>).control_failed;
/** Текстовый сигнал гейта — ТОЛЬКО фраза о несхождении (план: «наш расчёт по графику выплат не сошёлся с биржевым…»).
 *  Слово «биржевая» сигналом не считается: оно легитимно в обычных строках доходности. Регулярное выражение одно для обеих сторон. */
const LINE_SIGNAL = /не сошёл|не сошл/i;
const lineSignal = (r: BondReportT) => LINE_SIGNAL.test(r.yield.line ?? "");
const ids = (r: BondReportT) => r.worst.map((w) => w.id).join(",");
const has = (r: BondReportT, id: string) => r.worst.some((w) => w.id === id);
const grid0 = (r: BondReportT) => (r.fees_tax.k_grid[0] ? `k=0 → ${fmt(r.fees_tax.k_grid[0][1])}/${fmt(r.fees_tax.k_grid[0][2])}` : "пусто");

/** Утверждения о СРАБОТАВШЕМ гейте (Δ > controlFailPp): биржа остаётся, производное от own гаснет, не производное остаётся, оба сигнала видны.
 *  Экспортирован для внешней сухой прогонки (смоделированный отчёт «после правки» → все утверждения выполнимы одновременно). */
export function gateFiredItems(r: BondReportT, bondHasCall: boolean): Item[] {
  const y = r.yield, ft = r.fees_tax, d = y.control_diff_pp;
  return [
    it(d != null && d > CONFIG.controlFailPp,
      `предусловие: control_diff_pp=${fmt(d)} > controlFailPp=${CONFIG.controlFailPp} (own_control ${fmt(y.own_control_pct)} vs биржа ${fmt(y.exchange.pct)}, datetype=${y.exchange.datetype})`),
    it(r.status.kind === "ok", `status.kind=«${r.status.kind}» остаётся ok (биржевая доходность валидна)`),
    it(y.exchange.pct != null && y.main_pct === y.exchange.pct,
      `main_pct=${fmt(y.main_pct)} == exchange.pct=${fmt(y.exchange.pct)} — главной остаётся биржевая`),
    it(y.values.length === 1 && y.exchange.pct != null && y.values[0]?.pct === y.exchange.pct,
      `values=[${y.values.map((v) => v.pct).join(",")}] — показывается только биржевое число`),
    // производное от own гаснет
    it(ft.k_grid.length === 0, `k_grid.length=${ft.k_grid.length}, ожидалось 0 (сейчас ${grid0(r)})`),
    it(ft.pre_tax_pct == null && ft.post_tax_pct == null,
      `fees_tax.pre_tax_pct/post_tax_pct=${fmt(ft.pre_tax_pct)}/${fmt(ft.post_tax_pct)}, ожидалось null/null`),
    it(!r.panels.includes("fees"), `panels без «fees» (сейчас: ${r.panels.join(",")})`),
    it(r.panels.includes("yield"), `panels содержит «yield»`),
    it(!has(r, "call"),
      `worst без «call»${bondHasCall ? " (бумага с коллом — элемент производен от own)" : ""} (сейчас: ${ids(r) || "пусто"})`),
    // НЕ производное от own остаётся: панель worst (валидатор REGISTRY.worst при status ok требует 1–6 элементов) и сценарии rates/default
    it(r.panels.includes("worst") && r.worst.length >= 1,
      `панель «worst» и не-own сценарии остаются: panels${r.panels.includes("worst") ? " содержит" : " БЕЗ"} «worst», worst.length=${r.worst.length} (≥1)`),
    it(has(r, "rates") && has(r, "default"),
      `worst сохраняет «rates» и «default» — они не производны от own (дюрация ISS, позиция) (сейчас: ${ids(r) || "пусто"})`),
    // ОБА сигнала обязательны (план: новое поле + текст в строке)
    it(controlFailed(r) === true,
      `yield.control_failed === true (сейчас ${String(controlFailed(r))}${controlFailed(r) === undefined ? " — поля нет в отчёте после BondReport.parse(): не добавлено в report.ts и/или в zod-схему contract.ts" : ""})`),
    it(lineSignal(r),
      `yield.line содержит «не сошёлся» (line=«${y.line ?? "null"}»)`),
    it(r.diagnostics.warnings.some((w) => /контроль/i.test(w)),
      `diagnostics.warnings содержит «контроль:» для digest (${r.diagnostics.warnings.length} предупреждений)`),
  ];
}

/** Утверждения о МОЛЧАЩЕМ гейте (Δ ≤ controlFailPp): всё производное от own на месте, сигналов нет */
function gateQuietItems(r: BondReportT, expectCallItem: boolean): Item[] {
  const y = r.yield, ft = r.fees_tax, d = y.control_diff_pp;
  const items = [
    it(d != null && d <= CONFIG.controlFailPp,
      `предусловие: control_diff_pp=${fmt(d)} ≤ controlFailPp=${CONFIG.controlFailPp} (own_control ${fmt(y.own_control_pct)} vs биржа ${fmt(y.exchange.pct)})`),
    it(r.status.kind === "ok", `status.kind=«${r.status.kind}»`),
    it(y.main_pct != null, `main_pct=${fmt(y.main_pct)} задана`),
    it(ft.k_grid.length === CONFIG.kGrid.length, `k_grid.length=${ft.k_grid.length} == CONFIG.kGrid.length=${CONFIG.kGrid.length} (${grid0(r)})`),
    it(ft.pre_tax_pct != null && ft.post_tax_pct != null, `fees_tax.pre/post=${fmt(ft.pre_tax_pct)}/${fmt(ft.post_tax_pct)} заданы`),
    it(r.panels.includes("fees") && r.panels.includes("worst"), `panels содержит «fees» и «worst» (${r.panels.join(",")})`),
    it(r.worst.length >= 1 && has(r, "rates") && has(r, "default"), `worst непуст и содержит «rates», «default» (${ids(r) || "пусто"})`),
    it(controlFailed(r) !== true, `yield.control_failed=${String(controlFailed(r))} (не true)`),
    it(!lineSignal(r), `yield.line без фразы «не сошёлся» («${(y.line ?? "null").slice(0, 60)}…»)`),
  ];
  if (expectCallItem) items.push(it(has(r, "call"), `worst содержит «call» — колл-сценарий не вырезан (${ids(r)})`));
  return items;
}

/** Синтетика с принудительным расхождением: фикс 12% по номиналу (own ≈ 12,3%), а «биржа» отдаёт 30% → Δ ≈ 17,7 п.п. */
const divergent = (over: Partial<BondFacts> = {}): BondFacts =>
  facts({ moexY: 30, moexYPrice: 100, moexYDatetype: "MATDATE", ...over });
const withCall: Partial<BondFacts> = { offerKind: "call", offerDateIso: "2027-10-09", offerPrice: 100 };

/* ───── D.3: статический анализ валидатора ───── */

/** Убирает строчные (двойной слэш) и блочные комментарии, сохраняя переводы строк (номера строк не сдвигаются) и содержимое строковых литералов. */
function stripComments(src: string): string {
  let out = "";
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        out += src[i]; i++;
      }
      out += src[i] ?? ""; i++;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Делит строку (уже без комментариев) на код (строковые литералы выжжены до пустых кавычек) и склейку содержимого литералов. */
function splitCodeStrings(line: string): { code: string; strings: string } {
  let code = "", strings = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; code += q + q; i++;
      while (i < line.length && line[i] !== q) {
        if (line[i] === "\\") { strings += line[i] + (line[i + 1] ?? ""); i += 2; continue; }
        strings += line[i]; i++;
      }
      strings += " ";
      i++;
      continue;
    }
    code += c; i++;
  }
  return { code, strings };
}

/** Обособленное число 5 (5, 5.0) или 0,5 (0.5, 0,5, 0.50) — не часть идентификатора и не часть другого числа. */
const LIT_FAIL = /(?<![\w.$,])5(?:[.,]0+)?(?![\w.,]\d|\w)/;
const LIT_WARN = /(?<![\w.$,])0[.,]5(?:0+)?(?![\w]|\.\d)/;
/** «Поднятая константа»: const/let/var с control/fail/warn в имени, которой присвоен ЛИТЕРАЛ порога; и ключ объекта fail/warn/control: <литерал>.
 *  Деструктуризацию из CONFIG и константу, инициализированную выражением от CONFIG, не ловит — и не должна. */
const HOISTED_CONST = /\b(?:const|let|var)\s+\w*(?:fail|warn|control)\w*\s*(?::[^=;]*)?=\s*(?:5(?:[.,]0+)?|0[.,]5(?:0+)?)(?!\d)/i;
const HOISTED_KEY = /\b(?:fail|warn|control)\w*\s*:\s*(?:5(?:[.,]0+)?|0[.,]5(?:0+)?)(?!\d)/i;

/** Модуль конфигурации движка: workspace-путь «@so/engine/config» или относительный путь к …/engine/src/config.
 *  Корень «@so/engine» CONFIG не экспортирует (build.ts), поэтому им не считается. */
const CONFIG_MODULE = String.raw`["'](?:@so\/engine\/config|\.{1,2}\/(?:[^"'\n]*\/)?engine\/src\/config(?:\.[jt]s)?)["']`;
/** Все runtime-импорты из модуля конфигурации (операторы `import <clause> from "<module>"`; `import type …` на рантайме пуст и не считается). */
const IMPORT_STMT = new RegExp(String.raw`^[ \t]*import\s+(?!type\b)([^;]*?)\s+from\s+${CONFIG_MODULE}`, "gm");
const ID = String.raw`[\w$]+`;
const escId = (s: string) => s.replace(/\$/g, "\\$");
const altOf = (bs: ConfigBinding[]) => bs.map((b) => `(?:${b.base})`).join("|");

/** Локальная привязка объекта CONFIG: `label` — для detail, `base` — фрагмент регулярного выражения, дающий сам объект. */
interface ConfigBinding { label: string; base: string }

/** Собирает привязки по ВСЕМ импортам из модуля конфигурации: `{ CONFIG }`, `{ CONFIG as X }`, `* as ns` (→ ns.CONFIG).
 *  Инлайн-модификатор `type CONFIG` и дефолт-импорт (у config.ts его нет) привязкой не считаются. */
function importBindings(src: string): ConfigBinding[] {
  const out: ConfigBinding[] = [];
  for (const m of src.matchAll(IMPORT_STMT)) {
    const clause = m[1].trim();
    const ns = new RegExp(String.raw`^\*\s+as\s+(${ID})$`).exec(clause);
    if (ns) { out.push({ label: `${ns[1]}.CONFIG (import * as ${ns[1]})`, base: String.raw`(?<![\w$.])${escId(ns[1])}\s*\.\s*CONFIG\b` }); continue; }
    const braces = /\{([^}]*)\}/.exec(clause);
    if (!braces) continue;
    for (const spec of braces[1].split(",")) {
      const s = new RegExp(String.raw`^(type\s+)?(${ID})(?:\s+as\s+(${ID}))?$`).exec(spec.trim());
      if (!s || s[1] || s[2] !== "CONFIG") continue;
      const local = s[3] ?? "CONFIG";
      out.push({ label: local === "CONFIG" ? "CONFIG" : `${local} (import { CONFIG as ${local} })`, base: String.raw`(?<![\w$.])${escId(local)}\b` });
    }
  }
  return out;
}

/** Одноступенчатая переприсвойка объекта целиком: `const cfg = CONFIG;` / `const cfg = ns.CONFIG;` — тоже привязка (глубже одного шага не следуем). */
function aliasBindings(codeAll: string, primary: ConfigBinding[]): ConfigBinding[] {
  if (primary.length === 0) return [];
  const re = new RegExp(String.raw`\b(?:const|let|var)\s+(${ID})\s*(?::[^=;]*)?=\s*(?:${altOf(primary)})\s*(?:;|$)`, "gm");
  return [...codeAll.matchAll(re)].map((m) => ({ label: `${m[1]} (const ${m[1]} = …CONFIG)`, base: String.raw`(?<![\w$.])${escId(m[1])}\b` }));
}

type Field = "controlFailPp" | "controlWarnPp";
interface FieldRef { ok: boolean; how: string }
/** Строка исходника: n — номер, l — без комментариев, code — ещё и без содержимого строковых литералов */
interface SrcLine { n: number; l: string; code: string }
/** Распознанное выражение порога; raw=true — проверять по строке с литералами (скобочный доступ X["f"] в code выжжен до X[""]) */
interface ThresholdExpr { re: RegExp; raw?: boolean }

/** Читает ли код поле CONFIG.<field> через ЛЮБУЮ привязку: доступ к полю (X.f, X?.f, X["f"]) где-либо в коде или деструктуризация
 *  `const { f [: local] } = X` с реальным использованием local вне самой деструктуризации. Проверяется по коду с выжженными
 *  строковыми литералами — упоминание в тексте сообщения чтением не считается. Это НЕ анализ потока данных: куда значение
 *  попадает дальше, не отслеживается (за литералами в самом правиле следят отдельные утверждения). В `how` дополнительно
 *  (информационно) перечислены строки правила control, где порог виден через распознанное выражение, включая одноступенчатую
 *  константу `const T = …X.f…` (тернарник/env-override). */
function fieldRef(field: Field, bindings: ConfigBinding[], src: string, codeAll: string, ctl: SrcLine[]): FieldRef {
  if (bindings.length === 0) return { ok: false, how: "нет привязки импорта CONFIG" };
  const alt = altOf(bindings);
  const member = new RegExp(String.raw`(?:${alt})\s*\??\.\s*${field}\b`);
  const bracket = new RegExp(String.raw`(?:${alt})\s*\[\s*["'\x60]${field}["'\x60]\s*\]`);
  const destr = new RegExp(String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:${alt})(?![\w$.\[])`, "g");
  const codeNoDecl = codeAll.replace(destr, " ");
  const forms: string[] = [];
  const exprs: ThresholdExpr[] = [];
  if (member.test(codeAll)) { forms.push(`доступ к полю ${field}`); exprs.push({ re: member }); }
  if (bracket.test(src)) { forms.push(`доступ X["${field}"]`); exprs.push({ re: bracket, raw: true }); }
  for (const m of codeAll.matchAll(destr)) {
    for (const spec of m[1].split(",")) {
      const s = new RegExp(String.raw`^(${ID})(?:\s*:\s*(${ID}))?(?:\s*=[^,]*)?$`).exec(spec.trim());
      if (!s || s[1] !== field) continue;
      const local = s[2] ?? field;
      const use = new RegExp(String.raw`(?<![\w$.])${escId(local)}\b`);
      if (use.test(codeNoDecl)) { forms.push(`деструктуризация → ${local}`); exprs.push({ re: use }); }
      else forms.push(`деструктуризация → ${local} (объявлена, но не используется — не засчитана)`);
    }
  }
  const ok = exprs.length > 0;
  // информационно: одноступенчатые константы от распознанных выражений (const FAIL_PP = Number(process.env.X ?? CFG.controlFailPp))
  const srcAlt = exprs.map((e) => `(?:${e.re.source})`).join("|") || "(?!)";
  const aliasRe = new RegExp(String.raw`\b(?:const|let|var)\s+(${ID})\s*(?::[^=;]*)?=[^;]*?(?:${srcAlt})`, "g");
  const aliasSrc = exprs.some((e) => e.raw) ? src : codeAll;
  for (const m of aliasSrc.matchAll(aliasRe)) exprs.push({ re: new RegExp(String.raw`(?<![\w$.])${escId(m[1])}\b`) });
  const ctlRef = ctl.filter((x) => exprs.some((e) => e.re.test(e.raw ? x.l : x.code))).map((x) => x.n);
  const where = !ok ? "" : ctlRef.length ? `; в строках правила control: ${ctlRef.join(",")}` : "; в строках правила control порог виден через выражение, которое анализатор не отслеживает (алиас глубже одного шага?) — литералы в правиле проверяются отдельно";
  return { ok, how: (forms.join(", ") || "ни доступа к полю, ни деструктуризации") + where };
}

interface RulesAnalysis {
  items: Item[];
  ctlLines: number[];
  bindings: string[];
  usesFail: boolean; usesWarn: boolean; importsConfig: boolean;
  failHow: string; warnHow: string;
  failLitCode: string[]; warnLitCode: string[]; msgLit: string[]; hoisted: string[];
}

/** Анализ исходника правил: все признаки — ТОЛЬКО по коду без комментариев; литералы — отдельно в коде и в текстах сообщений.
 *  Экспортирован для внешней сухой прогонки (патченная копия rules.ts → ожидаем все утверждения выполненными). */
export function analyzeRules(rawSrc: string, label: string): RulesAnalysis {
  const src = stripComments(rawSrc);
  const lines = src.split("\n").map((l, i) => ({ n: i + 1, l, ...splitCodeStrings(l) }));
  const codeAll = lines.map((x) => x.code).join("\n");
  // строки правила control: обращение к control_diff_pp или имя правила "control" в литерале
  const ctl = lines.filter(({ l }) => /control_diff_pp|["'`]control["'`]/.test(l));
  const show = (x: { n: number; l: string }) => `${x.n}: ${x.l.trim().slice(0, 110)}`;
  const failLitCode = ctl.filter((x) => LIT_FAIL.test(x.code)).map(show);
  const warnLitCode = ctl.filter((x) => LIT_WARN.test(x.code)).map(show);
  const msgLit = ctl.filter((x) => LIT_FAIL.test(x.strings) || LIT_WARN.test(x.strings)).map(show);
  const hoisted = lines.filter((x) => HOISTED_CONST.test(x.code) || HOISTED_KEY.test(x.code)).map(show);
  const imports = importBindings(src);
  const bindings = [...imports, ...aliasBindings(codeAll, imports)];
  const importsConfig = imports.length > 0;
  const fail = fieldRef("controlFailPp", bindings, src, codeAll, ctl);
  const warn = fieldRef("controlWarnPp", bindings, src, codeAll, ctl);
  const items: Item[] = [
    it(ctl.length > 0, `правило control найдено в ${label}: строки ${ctl.map((x) => x.n).join(",") || "—"}`),
    it(importsConfig, `есть runtime-импорт CONFIG из модуля конфигурации движка («@so/engine/config» или относительный путь к engine/src/config; не type-only, не в комментарии): ${importsConfig ? `да — ${bindings.map((b) => b.label).join(", ")}` : "нет"}`),
    it(fail.ok, `код (без комментариев и строк) читает controlFailPp (=${CONFIG.controlFailPp}) через привязку CONFIG: ${fail.ok ? "да" : "нет"} — ${fail.how}`),
    it(warn.ok, `код (без комментариев и строк) читает controlWarnPp (=${CONFIG.controlWarnPp}) через привязку CONFIG: ${warn.ok ? "да" : "нет"} — ${warn.how}`),
    it(failLitCode.length === 0, `нет литерала 5 в коде правила control${failLitCode.length ? ` — есть: ${failLitCode.join(" | ")}` : ""}`),
    it(warnLitCode.length === 0, `нет литерала 0,5 в коде правила control${warnLitCode.length ? ` — есть: ${warnLitCode.join(" | ")}` : ""}`),
    it(msgLit.length === 0, `тексты сообщений правила control печатают порог из CONFIG, а не литерал 5 / 0,5${msgLit.length ? ` — есть: ${msgLit.join(" | ")}` : ""}`),
    it(hoisted.length === 0, `нет «поднятой» константы/ключа с fail|warn|control в имени = 5 / 0,5 (одна величина — одно значение)${hoisted.length ? ` — есть: ${hoisted.join(" | ")}` : ""}`),
  ];
  return {
    items, ctlLines: ctl.map((x) => x.n), bindings: bindings.map((b) => b.label),
    usesFail: fail.ok, usesWarn: warn.ok, importsConfig, failHow: fail.how, warnHow: warn.how,
    failLitCode, warnLitCode, msgLit, hoisted,
  };
}

/** Что анализатор умеет и не умеет — печатается в detail D.3 (план, «Харнес: соглашения»: static-проверка обязана описывать свои границы). */
const ANALYZER_LIMITS =
  "это не анализ потока данных: «чтение порога» = доступ к полю / деструктуризация ГДЕ-ЛИБО в коде + отсутствие литералов 5 / 0,5 в строках правила control " +
  "(строки с control_diff_pp или литералом \"control\") и в «поднятых» константах с fail|warn|control в имени. Комментарии // и /* */ сняты с учётом строковых литералов. " +
  "ПРИНИМАЕТСЯ: `import { CONFIG }`, `import { CONFIG as X }`, `import * as ns` (ns.CONFIG), спецификатор «@so/engine/config» или относительный путь к …/engine/src/config; " +
  "переприсвойка объекта в один шаг (const cfg = CONFIG); доступ X.f, X?.f, X[\"f\"]; деструктуризация `const { f [: local] } = X` (local должен использоваться); " +
  "любая обёртка поверх доступа к полю — константа, тернарник, env-override, объект (const T = { fail: X.f } → T.fail): проходит, а где именно правило берёт порог, detail показывает лишь информационно. " +
  "НЕ РАСПОЗНАЁТ (ложный RED при корректной правке): require() и динамический import(); косвенный импорт через третий модуль (реэкспорт CONFIG, обёртка thresholds.ts); переприсвойка объекта глубже одного шага. " +
  "НЕ ЛОВИТ (ложный GREEN при умышленном обходе): литерал под нейтральным именем (const LIMIT = 5 → d > LIMIT) при декоративном чтении CONFIG в другом месте; литерал-fallback вне строк правила control (`?? 5`); " +
  "вложенные шаблонные строки и регулярные выражения с кавычками ломают разметку строк.";

/** Самопроверка анализатора на эталонах (обязаны проходить все утверждения) и известных обходах (обязаны распознаваться) —
 *  чтобы D.3 нельзя было пройти ослаблением регулярных выражений и чтобы эквивалентные формы правки не давали ложный RED. */
const GOOD_RULES = [
  `import type { BondReportT } from "@so/engine/contract";`,
  `import { CONFIG } from "@so/engine/config";`,
  `const d = r.yield.control_diff_pp;`,
  `if (d != null && d > CONFIG.controlFailPp) fail("control", \`расхождение \${d} п.п. > \${CONFIG.controlFailPp} — похоже на ошибку данных\`);`,
  `else if (d != null && d > CONFIG.controlWarnPp) out.push({ rule: "control", msg: \`расхождение \${d} п.п. > \${CONFIG.controlWarnPp}\`, level: "warn" });`,
].join("\n");
const GOOD_DESTRUCT = [
  `import type { BondReportT } from "@so/engine/contract";`,
  `import { CONFIG, gradeOf } from "@so/engine/config";`,
  `const { controlFailPp, controlWarnPp } = CONFIG;`,
  `const d = r.yield.control_diff_pp;`,
  `if (d != null && d > controlFailPp) fail("control", \`расхождение \${d} п.п. > \${controlFailPp} — похоже на ошибку данных\`);`,
  `else if (d != null && d > controlWarnPp) out.push({ rule: "control", msg: \`расхождение \${d} п.п. > \${controlWarnPp}\`, level: "warn" });`,
].join("\n");
const GOOD_ALIAS = [
  `import { CONFIG as CFG } from "@so/engine/config";`,
  `const d = r.yield.control_diff_pp;`,
  `if (d != null && d > CFG.controlFailPp) fail("control", \`расхождение \${d} п.п. > \${CFG.controlFailPp}\`);`,
  `else if (d != null && d > CFG.controlWarnPp) out.push({ rule: "control", msg: \`> \${CFG.controlWarnPp}\`, level: "warn" });`,
].join("\n");
const GOOD_NS_ENV = [
  `import * as cfg from "@so/engine/config";`,
  `const FAIL_PP = Number(process.env.CONTROL_FAIL_PP ?? cfg.CONFIG.controlFailPp);`,
  `const { controlWarnPp: WARN_PP } = cfg.CONFIG;`,
  `const d = r.yield.control_diff_pp;`,
  `if (d != null && d > FAIL_PP) fail("control", \`расхождение \${d} п.п. > \${FAIL_PP}\`);`,
  `else if (d != null && d > WARN_PP) out.push({ rule: "control", msg: \`> \${WARN_PP}\`, level: "warn" });`,
].join("\n");
const GOOD_REASSIGN = [
  `import { CONFIG } from "@so/engine/config";`,
  `const cfg = CONFIG;`,
  `const d = r.yield.control_diff_pp;`,
  `if (d != null && d > cfg.controlFailPp) fail("control", \`расхождение \${d} п.п. > \${cfg.controlFailPp}\`);`,
  `else if (d != null && d > cfg.controlWarnPp) out.push({ rule: "control", msg: \`> \${cfg.controlWarnPp}\`, level: "warn" });`,
].join("\n");
const BYPASS_HOISTED = [
  `import { CONFIG } from "@so/engine/config";`,
  `const FAIL_PP = 5; // same as CONFIG.controlFailPp / controlWarnPp`,
  `const WARN_PP: number = 0.5;`,
  `const d = r.yield.control_diff_pp;`,
  `if (d != null && d > FAIL_PP) fail("control", \`расхождение \${d} п.п. > 5\`);`,
  `else if (d != null && d > WARN_PP) out.push({ rule: "control", msg: \`> 0,5\`, level: "warn" });`,
].join("\n");
const BYPASS_COMMENT = [
  `import type { BondReportT } from "@so/engine/contract";`,
  `/* читаем CONFIG.controlFailPp и CONFIG.controlWarnPp из @so/engine/config */`,
  `// import { CONFIG } from "@so/engine/config";`,
  `const d = r.yield.control_diff_pp;`,
  `if (d != null && d > 5) fail("control", "расхождение > 5"); // CONFIG`,
  `else if (d != null && d > 0.5) out.push({ rule: "control", msg: "> 0,5", level: "warn" });`,
].join("\n");
const BYPASS_OBJECT = [
  `import { CONFIG } from "@so/engine/config";`,
  `const CONTROL = { fail: 5, warn: 0.5 };`,
  `const d = r.yield.control_diff_pp;`,
  `if (d != null && d > CONTROL.fail) fail("control", \`> \${CONTROL.fail}\`);`,
  `else if (d != null && d > CONTROL.warn) out.push({ rule: "control", msg: \`> \${CONTROL.warn}\`, level: "warn" });`,
].join("\n");
const BYPASS_STRING = [
  `import { CONFIG } from "@so/engine/config";`,
  `const d = r.yield.control_diff_pp;`,
  `if (d != null && d > 5) fail("control", "расхождение > 5 — см. CONFIG.controlFailPp");`,
  `else if (d != null && d > 0.5) out.push({ rule: "control", msg: "> 0,5 (CONFIG.controlWarnPp)", level: "warn" });`,
].join("\n");
const BYPASS_DECOR = [
  `import { CONFIG } from "@so/engine/config";`,
  `const { controlFailPp, controlWarnPp } = CONFIG;`,
  `const d = r.yield.control_diff_pp;`,
  `if (d != null && d > 5) fail("control", "расхождение > 5");`,
  `else if (d != null && d > 0.5) out.push({ rule: "control", msg: "> 0,5", level: "warn" });`,
].join("\n");
const BYPASS_TYPE = [
  `import type { CONFIG as CFG } from "@so/engine/config";`,
  `import { type CONFIG, gradeOf } from "@so/engine/config";`,
  `const d = r.yield.control_diff_pp;`,
  `if (d != null && d > 5) fail("control", "расхождение > 5");`,
].join("\n");

function analyzerSelfTest(): Item[] {
  const bad = (a: RulesAnalysis) => a.items.filter((i) => !i.ok).map((i) => i.text.slice(0, 60));
  const ok = (a: RulesAnalysis) => a.items.every((i) => i.ok);
  const good = (a: RulesAnalysis, what: string) =>
    it(ok(a), `${what} проходит все ${a.items.length} утверждений${ok(a) ? "" : ` — не выполнено: ${bad(a).join(" | ")}`}`);
  const h = analyzeRules(BYPASS_HOISTED, "обход-константа");
  const c = analyzeRules(BYPASS_COMMENT, "обход-комментарий");
  const o = analyzeRules(BYPASS_OBJECT, "обход-объект");
  const s = analyzeRules(BYPASS_STRING, "обход-строка");
  const dd = analyzeRules(BYPASS_DECOR, "обход-деструктуризация");
  const t = analyzeRules(BYPASS_TYPE, "обход-type");
  return [
    good(analyzeRules(GOOD_RULES, "эталон-1"), "эталон-1 (CONFIG.controlFailPp/WarnPp, порог в сообщении из CONFIG)"),
    good(analyzeRules(GOOD_DESTRUCT, "эталон-2"), "эталон-2 (деструктуризация const { controlFailPp, controlWarnPp } = CONFIG)"),
    good(analyzeRules(GOOD_ALIAS, "эталон-3"), "эталон-3 (import { CONFIG as CFG } + CFG.controlFailPp)"),
    good(analyzeRules(GOOD_NS_ENV, "эталон-4"), "эталон-4 (import * as cfg; env-override Number(process.env… ?? cfg.CONFIG.controlFailPp); const { controlWarnPp: WARN_PP } = cfg.CONFIG)"),
    good(analyzeRules(GOOD_REASSIGN, "эталон-5"), "эталон-5 (const cfg = CONFIG; cfg.controlFailPp)"),
    it(!h.usesFail && !h.usesWarn && h.hoisted.length >= 2 && h.msgLit.length >= 1,
      `обход «const FAIL_PP = 5 // CONFIG.controlFailPp» распознан: usesFail=${h.usesFail}, usesWarn=${h.usesWarn}, hoisted=${h.hoisted.length}, литералы в сообщениях=${h.msgLit.length}`),
    it(!c.importsConfig && !c.usesFail && !c.usesWarn && c.failLitCode.length >= 1 && c.warnLitCode.length >= 1,
      `обход «CONFIG только в комментариях» распознан: importsConfig=${c.importsConfig}, usesFail=${c.usesFail}, литерал 5 в коде=${c.failLitCode.length}, литерал 0,5 в коде=${c.warnLitCode.length}`),
    it(!o.usesFail && o.hoisted.length >= 1,
      `обход «{ fail: 5, warn: 0.5 }» распознан: usesFail=${o.usesFail}, hoisted=${o.hoisted.length}`),
    it(s.importsConfig && !s.usesFail && !s.usesWarn && s.failLitCode.length >= 1 && s.warnLitCode.length >= 1,
      `обход «CONFIG.controlFailPp только в тексте сообщения, в коде литерал» распознан: importsConfig=${s.importsConfig}, usesFail=${s.usesFail}, usesWarn=${s.usesWarn}, литерал 5 в коде=${s.failLitCode.length}`),
    it(dd.importsConfig && !dd.usesFail && !dd.usesWarn && dd.failLitCode.length >= 1,
      `обход «деструктуризация объявлена, но правило сравнивает с литералом» распознан: usesFail=${dd.usesFail}, usesWarn=${dd.usesWarn}, литерал 5 в коде=${dd.failLitCode.length}`),
    it(!t.importsConfig && !t.usesFail,
      `обход «import type / import { type CONFIG }» распознан как отсутствие runtime-импорта: importsConfig=${t.importsConfig}, usesFail=${t.usesFail}`),
  ];
}

/* ───── проверки ───── */
export const checks: Check[] = [
  {
    id: "D.1",
    wp: "D",
    kind: "fixture",
    title: "Гейт controlFailPp: при расхождении own/биржа гаснут k_grid, fees, worst.call; worst с rates/default остаётся; биржевая главная; control_failed=true и «не сошёлся» в строке",
    async run() {
      const sections: [string, Item[]][] = [];

      // 1) реальная бумага: RU000A10AST0 (секьюритизация, null-купоны + амортизация) — Δ 43 п.п. до WP-A
      const ast0 = reportOf(await buildFixture("sfo_ast0"));
      const d = ast0.yield.control_diff_pp;
      if (d != null && d > CONFIG.controlFailPp) {
        sections.push([`sfo_ast0 ${ast0.security.secid}, гейт должен сработать`, gateFiredItems(ast0, true)]);
      } else {
        // после WP-A фикстура перестаёт расходиться (план, шаг 5) — тогда гейт обязан молчать, а сам гейт проверяет синтетика ниже
        sections.push([`sfo_ast0 ${ast0.security.secid}: Δ=${fmt(d)} ≤ порога (после WP-A) — гейт обязан молчать`, gateQuietItems(ast0, true)]);
      }

      // 2) синтетика без колла: гейт не зависит от конкретной фикстуры
      const synth = assembleReport(divergent());
      sections.push(["синтетика без колла (moexY=30, own≈12,3)", gateFiredItems(synth, false)]);

      // 3) синтетика с коллом через год: сегодня main = min(биржа, call.y) = own → при гейте должна остаться биржевая, worst без «call»
      const synthCall = assembleReport(divergent(withCall));
      sections.push(["синтетика с коллом 09.10.2027 (moexY=30, own≈12,3)", gateFiredItems(synthCall, true)]);

      return verdict(sections);
    },
  },

  {
    id: "D.3",
    wp: "D",
    kind: "static",
    title: "Валидатор tools/validate: пороги контроля читаются из CONFIG (runtime-импорт модуля конфигурации под любым локальным именем; доступ к полю или деструктуризация), литералов 5 / 0,5 нет ни в коде, ни в сообщениях, ни в «поднятых» константах — static по исходнику без комментариев, границы распознавания в detail",
    run() {
      const rel = "tools/validate/src/rules.ts";
      const a = analyzeRules(readSrc(rel), rel);
      const v = verdict([
        ["самопроверка анализатора", analyzerSelfTest()],
        [rel, a.items],
      ]);
      return { ...v, detail: `${v.detail} || [границы анализатора] ${ANALYZER_LIMITS}` };
    },
  },

  {
    id: "D.4",
    wp: "D",
    kind: "fixture",
    guard: true,
    title: "Гейт не срабатывает на нормальных бумагах: при Δ ≤ controlFailPp сетка комиссий, fees и worst (включая call) на месте, сигналов нет",
    async run() {
      const sections: [string, Item[]][] = [];
      // длинная ОФЗ (Δ 0,02) и пятничный РОЛЬФ (Δ 0,66 — выше warn, ниже fail): предупреждение ≠ гейт
      for (const name of ["ofz26244", "rolf_friday"] as const) {
        const r = reportOf(await buildFixture(name));
        sections.push([`${name} ${r.security.secid}`, gateQuietItems(r, false)]);
      }
      // колл-бумага с премией (Δ 0,97): worst.call должен остаться — он вырезается только при сработавшем гейте
      const tel = reportOf(await buildFixture("call_telhol"));
      sections.push([`call_telhol ${tel.security.secid}`, gateQuietItems(tel, true)]);
      // синтетика с почти нулевым расхождением (moexY=12,3 vs own≈12,33)
      const synth = assembleReport(facts({ moexY: 12.3, moexYPrice: 100, moexYDatetype: "MATDATE" }));
      sections.push(["синтетика Δ≈0,03", gateQuietItems(synth, false)]);
      return verdict(sections);
    },
  },
];
