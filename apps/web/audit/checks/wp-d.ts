/**
 * WP-D (apps/web) — веб-часть гейта расхождения `controlFailPp` (docs/AUDIT_PLAN_2026-10-09.md, раздел WP-D; аудит п. D / R2-01).
 * Движковая часть (D.1, D.3, guard D.4) — packages/engine/src/audit/checks/wp-d.ts. Здесь — то, что видит МОДЕЛЬ:
 * apps/web/lib/digest.ts (digestReport / digestResult — toModelOutput инструментов ассистента).
 *
 * Границы плана. Единственная правка digest.ts по плану WP-D — «diagnostics.warnings → digest.ts». Сам гейт
 * (k_grid=[], fees_tax.pre/post=null, panels без «fees», worst без «call», поле yield.control_failed=true И фраза
 * «наш расчёт по графику выплат не сошёлся с биржевым — показываем только биржевую доходность» в yield.line) живёт в
 * report.ts. Поэтому рукописная фикстура gatedReport() воспроизводит отчёт ТАКИМ, каким движок выдаст его ПОСЛЕ WP-D,
 * а от дайджеста требуется лишь честно его передать: не терять предупреждение и факт гейта (D.2) и не воскрешать
 * own-числа (D.5). Утверждения, выполнимые только правкой digest.ts сверх плана, здесь не кодируются (см. notes сдачи).
 *
 *  D.2 (план) — дайджест передаёт модели предупреждение контроля из diagnostics.warnings целиком и факт срабатывания
 *        гейта (фраза плана в yield_line либо ключ control_failed=true); на чистом отчёте (warnings=[]) про контроль молчит.
 *        Сквозной путь без рукописной фикстуры: build(снимок ISS sfo_ast0, Δ 43,05) → digestReport — сегодня RED
 *        (в дайджесте нет ни «контрол», ни «не сошёл»), после D.1 + прокидывания warnings — GREEN на реальном выходе движка.
 *        Правка WP-U (план 13.10, U.11): при СРАБОТАВШЕМ гейте предупреждения контроля целиком не требуются — сырые строки
 *        несут ненадёжный собственный расчёт и жаргон, дайджест заменяет их одной фразой. Для таких отчётов пункт «целиком»
 *        заменён пунктом gatedWarningsItem: прочие (не контрольные) предупреждения целиком, собственного расчёта
 *        (yield.own_control_pct) в дайджесте нет; упоминание контроля, Δ и факт гейта по-прежнему требуют соседние пункты.
 *        Без гейта (live_rolf_p26) пункт «целиком» прежний.
 *  D.5 (РАСШИРЕНИЕ плана: D.1 глазами модели; id D.5 в плане нет, WP-D = D.1–D.3) — при сработавшем гейте дайджест
 *        не отдаёт модели производное от собственного расчёта (fees_line с own-числами, доходность к коллу в worst),
 *        биржевую доходность оставляет; на нормальной бумаге fees_line на месте. RED обеспечивает сквозная секция
 *        build(sfo_ast0) → digest. Секция на gatedReport() — инвариант «дайджест не придумывает fees_line при panels без
 *        fees и не вытаскивает yield.own_control_pct/k_grid» — GREEN уже сейчас и остаётся GREEN после правки движка
 *        (digest.ts читает panels/worst/yield.line, а не own-поля).
 * Каждая проверка утверждает ЖЕЛАЕМОЕ поведение; до правки — RED. Сеть не нужна: живые фикстуры прода
 * (apps/web/audit/fixtures/*.json) + офлайн-сборка снимка ISS packages/engine/audit-fixtures/sfo_ast0 через build().
 */
import fs from "node:fs";
import path from "node:path";
import { build } from "@so/engine";
import { CONFIG } from "@so/engine/config";
import { fmt } from "@so/engine/format";
import { feesLine } from "@so/engine/inputs";
import type { BondReportT, BuildResultT } from "@so/engine/contract";
import { digestReport, digestResult } from "../../lib/digest";
import { fixture, REPO_ROOT, type Check, type Verdict } from "../lib";

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
const n2 = (x: number | null | undefined) => (x == null ? "null" : fmt(x, 2));
const q = (s: unknown, max = 110) => {
  const t = typeof s === "string" ? s : JSON.stringify(s) ?? String(s);
  return `«${t.length > max ? t.slice(0, max - 1) + "…" : t}»`;
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Листья объекта (строки и числа) с путями — чтобы в detail назвать ПОЛЕ дайджеста, а не «где-то» */
interface Leaf { path: string; value: string | number }
function leaves(o: unknown, p = "$"): Leaf[] {
  if (typeof o === "string" || typeof o === "number") return [{ path: p, value: o }];
  if (Array.isArray(o)) return o.flatMap((v, i) => leaves(v, `${p}[${i}]`));
  if (o && typeof o === "object") return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${p}.${k}`));
  return [];
}
/** Ключи, подходящие под re, со значениями (рекурсивно) */
function keysLike(o: unknown, re: RegExp, p = "$"): { path: string; value: unknown }[] {
  if (Array.isArray(o)) return o.flatMap((v, i) => keysLike(v, re, `${p}[${i}]`));
  if (o && typeof o === "object")
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
      (re.test(k) ? [{ path: `${p}.${k}`, value: v }] : []).concat(keysLike(v, re, `${p}.${k}`)));
  return [];
}
const strLeaves = (d: unknown) => leaves(d).filter((l): l is Leaf & { value: string } => typeof l.value === "string");
/** Фраза плана в yield.line при сработавшем гейте */
const GATE_PHRASE = "наш расчёт по графику выплат не сошёлся с биржевым — показываем только биржевую доходность";
/** Сигнал гейта в тексте — та же регулярка, что в движковом модуле (LINE_SIGNAL) */
const LINE_SIGNAL = /не сошёл|не сошл/i;
/** Диагностическая строка (само предупреждение контроля / фраза гейта) — ей own-числа называть МОЖНО */
const isDiagnostic = (s: string) => /контрол/i.test(s) || LINE_SIGNAL.test(s);
/** Модель видит упоминание контроля: строковый лист (не имя ключа) со словом «контроль» */
const controlMentions = (d: unknown) => strLeaves(d).filter((l) => /контрол/i.test(l.value));
/** Модель видит факт срабатывания гейта: фраза плана «не сошёлся» в строке (план: yield.line → yield_line) либо ключ control_failed=true */
const failedClaims = (d: unknown) => [
  ...strLeaves(d).filter((l) => LINE_SIGNAL.test(l.value)).map((l) => `${l.path}=${q(l.value, 80)}`),
  ...keysLike(d, /control_failed/i).filter((k) => k.value === true).map((k) => `${k.path}=true`),
];
/** Строки diagnostics.warnings, которых в дайджесте нет целиком */
const missingWarnings = (d: unknown, warnings: string[]) =>
  warnings.filter((w) => !strLeaves(d).some((l) => l.value.includes(w)));
/** Предупреждения движка о контроле (report.ts): «контроль: свой расчёт …», «гейт контроля: …» */
const CONTROL_WARNING = /^(контроль|гейт контроля)\s*:/i;
/** Варианты записи числа: «58,88» (строки движка), 58.88 (JSON-число) */
const variants = (x: number) => [...new Set([fmt(x, 2), x.toFixed(2), String(x)])];
/** Число встречается в дайджесте (в любой форме, в любом листе) */
const hasNumber = (d: unknown, x: number | null | undefined) =>
  x != null && leaves(d).some((l) => variants(x).some((v) => String(l.value).includes(v)));
/** Число целиком, по границам: «5,10» не находится внутри «15,10» или «5,105» — для запрета own-числа без ложного RED */
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWholeNumber = (d: unknown, x: number | null | undefined) =>
  x != null && leaves(d).some((l) => variants(x).some((v) => new RegExp(`(?<![\\d.,])${escRe(v)}(?!\\d)`).test(String(l.value))));
/**
 * Пункт «предупреждения переданы» для отчёта со СРАБОТАВШИМ гейтом (правка WP-U, U.11): сырые предупреждения контроля
 * целиком не требуются (в них собственный расчёт и жаргон «гейт», «сетка комиссий»), зато собственного расчёта
 * yield.own_control_pct в дайджесте быть не должно; не контрольные предупреждения — целиком, как раньше
 */
function gatedWarningsItem(d: unknown, r: BondReportT): Item {
  const ctl = r.diagnostics.warnings.filter((w) => CONTROL_WARNING.test(w));
  const miss = missingWarnings(d, r.diagnostics.warnings.filter((w) => !CONTROL_WARNING.test(w)));
  const own = r.yield.own_control_pct;
  const ownIn = hasWholeNumber(d, own);
  return it(miss.length === 0 && !ownIn,
    `гейт сработал: предупреждения контроля (${ctl.length}) переданы своей формулировкой, собственный расчёт own_control_pct=${n2(own)} в дайджесте: ${ownIn ? "ЕСТЬ" : "нет"} (ожид. нет, U.11); ` +
    `прочие предупреждения (${r.diagnostics.warnings.length - ctl.length}) переданы целиком${miss.length ? ` — не переданы ${miss.length}: ${miss.map((w) => q(w, 80)).join(", ")}` : ""}`);
}
/** Где в дайджесте ВНЕ диагностических строк встречаются own-числа: «путь=«значение» ← числа» */
function ownHits(d: unknown, own: number[]): string[] {
  const hits: string[] = [];
  for (const l of leaves(d)) {
    const s = String(l.value);
    if (typeof l.value === "string" && isDiagnostic(l.value)) continue;
    const found = own.filter((x) => variants(x).some((v) => s.includes(v)));
    if (found.length) hits.push(`${l.path}=${q(s, 90)} ← ${found.map((x) => fmt(x, 2)).join(", ")}`);
  }
  return hits;
}
/** Числа, производные от собственного расчёта, в отчёте: own_control, сетка k_grid (pre/post), fees pre/post, доходность к коллу из worst */
function ownNumbersOf(r: BondReportT): number[] {
  const out: number[] = [];
  const push = (x: number | null | undefined) => { if (x != null && Number.isFinite(x)) out.push(x); };
  push(r.yield.own_control_pct);
  push(r.fees_tax.pre_tax_pct);
  push(r.fees_tax.post_tax_pct);
  for (const [, pre, post] of r.fees_tax.k_grid) { push(pre); push(post); }
  for (const w of r.worst.filter((x) => x.id === "call"))
    for (const m of w.text.matchAll(/(\d+(?:[.,]\d+)?)\s?%/g)) push(Number(m[1].replace(",", ".")));
  return [...new Set(out)];
}
const yieldOf = (r: BondReportT) => (r.yield as unknown as Record<string, unknown>);
/** Строки digest.worst про колл (производное от own). Дайджест отдаёт worst как «${title}: ${text}» — сопоставляем
 *  ТОЛЬКО по заголовку элемента (до первого «:»): текст других элементов легитимно упоминает колл как горизонт
 *  («…держать до колла 25.01.2028…» в «Рост ставок» после WP-F — подпись горизонта биржи, не own-число). */
const callLines = (worst: string[]) => worst.filter((s) => /досрочн|колл/i.test(s.split(":")[0] ?? ""));

/* ───── фикстуры ───── */
const liveReport = (name: string): BondReportT => {
  const res = fixture<BuildResultT>(name);
  if (res.kind !== "report") throw new Error(`${name}: ожидался kind=report, получено ${res.kind}`);
  return clone(res.report);
};
/** Снимок ISS движка (как buildFixture в packages/engine/src/audit/lib.ts, но без импорта чужого lib) */
async function engineFixture(name: string): Promise<BondReportT> {
  const dir = path.join(REPO_ROOT, "packages", "engine", "audit-fixtures", name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { query: string; todayIso: string; inputs?: Record<string, number> };
  const res = await build(meta.query, meta.inputs ?? {}, { fromSnapshotDir: dir, todayIso: meta.todayIso });
  if (res.kind !== "report") throw new Error(`audit-fixtures/${name}: ожидался kind=report, получено ${res.kind}`);
  return res.report;
}
/** Сквозной путь движок → дайджест на одном и том же снимке RU000A10AST0 (секьюритизация, null-купоны; Δ 43,05 до WP-A) */
let ast0Promise: Promise<BondReportT> | undefined;
const ast0Report = () => (ast0Promise ??= engineFixture("sfo_ast0"));

/** Прод-числа RU000A10AST0 из аудита (п. D): биржа 15,73, own 58,88, Δ 43,16, цена 105,54 */
const AST0 = { exchange: 15.73, own: 58.88, diff: 43.16, price: 105.54 };
const AST0_WARNING = `контроль: свой расчёт ${fmt(AST0.own, 2)}% от цены биржи ${fmt(AST0.price, 2)}% отличается от биржевого ${fmt(AST0.exchange, 2)}% на ${fmt(AST0.diff, 2)} п.п.`;

/**
 * Сработавший гейт на каркасе живого отчёта live_rolf_p26 (k=0,3, позиция 2 млн) с прод-числами RU000A10AST0 —
 * в том виде, в каком движок выдаст отчёт ПОСЛЕ WP-D (план, раздел WP-D «Изменение»):
 *  yield.main/exchange остаются биржевыми; yield.control_failed=true И фраза плана в yield.line;
 *  k_grid=[], fees_tax.pre/post=null (fees_tax.line — то, что даёт feesLine([], k) движка: без own-чисел);
 *  panels без «fees»; worst без «call»; diagnostics.warnings с предупреждением контроля; own_control_pct остаётся
 *  как диагностика (план его не гасит).
 * От дайджеста требуется честно передать этот отчёт — не терять сигналы и не воскрешать own-числа.
 */
function gatedReport(): BondReportT {
  const r = liveReport("live_rolf_p26.json");
  r.security = { ...r.security, secid: "RU000A10AST0", isin: "RU000A10AST0", shortname: "ССекьюр_А" };
  r.yield.main_pct = AST0.exchange;
  r.yield.values = [{ label: "к погашению 31.12.2030", pct: AST0.exchange }];
  r.yield.exchange = { pct: AST0.exchange, price_pct: AST0.price, datetype: "OFFER", used_as_main: true };
  r.yield.horizon_date = "31.12.2030";
  r.yield.horizon_label = "погашения 31.12.2030";
  r.yield.own_control_pct = AST0.own;
  r.yield.control_diff_pp = AST0.diff;
  r.yield.line = `${fmt(AST0.exchange, 2)}% годовых — при покупке по ${fmt(AST0.price, 2)}% от номинала (747,35 ₽ с НКД) и удержании до погашения 31.12.2030. Купон — 23%. ${GATE_PHRASE[0].toUpperCase()}${GATE_PHRASE.slice(1)}.`;
  yieldOf(r).control_failed = true; // поле появится в контракте после правки движка
  const fee = feesLine([], 0.3);
  r.fees_tax = { k_pct: 0.3, k_grid: [], pre_tax_pct: fee.pre, post_tax_pct: fee.post, tax_note: r.fees_tax.tax_note, line: fee.line };
  r.panels = r.panels.filter((p) => p !== "fees");
  r.worst = r.worst.filter((w) => w.id !== "call");
  r.diagnostics = { ...r.diagnostics, control_diff_pp: AST0.diff, warnings: [AST0_WARNING] };
  return r;
}
/** Предусловие о форме gatedReport(): это именно пост-правочный отчёт движка, а не сегодняшний прод */
function gatedShapeItem(r: BondReportT): Item {
  const y = r.yield, ft = r.fees_tax;
  const ok = (y.control_diff_pp ?? 0) > CONFIG.controlFailPp && yieldOf(r).control_failed === true && LINE_SIGNAL.test(y.line ?? "")
    && ft.k_grid.length === 0 && ft.pre_tax_pct == null && ft.post_tax_pct == null && !r.panels.includes("fees")
    && !r.worst.some((w) => w.id === "call") && y.main_pct === y.exchange.pct && r.diagnostics.warnings.some((w) => /^контроль/i.test(w));
  return it(ok,
    `предусловие (форма отчёта после WP-D): Δ=${n2(y.control_diff_pp)} > controlFailPp=${CONFIG.controlFailPp}, control_failed=${String(yieldOf(r).control_failed)}, ` +
    `yield.line ${LINE_SIGNAL.test(y.line ?? "") ? "с фразой" : "БЕЗ фразы"} «не сошёлся», k_grid.length=${ft.k_grid.length}, fees_tax.pre/post=${n2(ft.pre_tax_pct)}/${n2(ft.post_tax_pct)}, ` +
    `fees_tax.line=${q(ft.line, 70)}, panels=${r.panels.join(",")}, worst=${r.worst.map((w) => w.id).join(",")}, main_pct=${n2(y.main_pct)}==exchange.pct=${n2(y.exchange.pct)}, warnings=[${q(r.diagnostics.warnings[0], 60)}]`);
}

/* ───── проверки ───── */
export const checks: Check[] = [
  {
    id: "D.2",
    wp: "D",
    kind: "fixture",
    title: "Дайджест для модели передаёт предупреждение контроля (diagnostics.warnings целиком; при сработавшем гейте — своей фразой с Δ, без собственного расчёта) и факт срабатывания гейта (фраза в yield_line / control_failed); на чистом отчёте молчит; сквозной путь build(sfo_ast0)→digest",
    async run() {
      const sections: [string, Item[]][] = [];

      // 1) реальный прод-отчёт РОЛЬФ 1Р07 (k=0,3): Δ 0,66 > controlWarnPp — предупреждение уже лежит в diagnostics.warnings
      const rolf = liveReport("live_rolf_p26.json");
      const dRolf = digestReport(rolf);
      const w0 = rolf.diagnostics.warnings[0] ?? "";
      const mRolf = controlMentions(dRolf);
      sections.push([`live_rolf_p26 ${rolf.security.isin}: реальное предупреждение`, [
        it(rolf.diagnostics.warnings.length >= 1 && /^контроль/i.test(w0) && (rolf.diagnostics.control_diff_pp ?? 0) > CONFIG.controlWarnPp,
          `предусловие: diagnostics.warnings=[${q(w0)}], control_diff_pp=${n2(rolf.diagnostics.control_diff_pp)} > controlWarnPp=${CONFIG.controlWarnPp}`),
        it(mRolf.length > 0,
          `дайджест упоминает контроль строкой для модели: ${mRolf.length ? mRolf.map((l) => `${l.path}=${q(l.value, 90)}`).join(", ") : `нет — ключи дайджеста: ${Object.keys(dRolf).join(",")}`}`),
        it(hasNumber(dRolf, rolf.diagnostics.control_diff_pp),
          `в дайджесте есть размер расхождения ${n2(rolf.diagnostics.control_diff_pp)} п.п. из предупреждения`),
        it(missingWarnings(dRolf, rolf.diagnostics.warnings).length === 0,
          `текст предупреждения ${q(w0, 70)} передан модели целиком`),
      ]]);

      // 2) сработавший гейт в форме отчёта движка ПОСЛЕ WP-D (прод-числа RU000A10AST0 на каркасе live_rolf_p26)
      const gated = gatedReport();
      const dGated = digestReport(gated);
      const mGated = controlMentions(dGated);
      const fGated = failedClaims(dGated);
      const viaResult = digestResult({ kind: "report", report: gated });
      sections.push([`гейт сработал (${gated.security.isin}, Δ=${n2(gated.yield.control_diff_pp)} > controlFailPp=${CONFIG.controlFailPp}; форма отчёта после WP-D)`, [
        gatedShapeItem(gated),
        it(mGated.length > 0,
          `дайджест упоминает контроль: ${mGated.length ? mGated.map((l) => `${l.path}=${q(l.value, 90)}`).join(", ") : `нет — ключи дайджеста: ${Object.keys(dGated).join(",")}`}`),
        it(hasNumber(dGated, AST0.diff), `в дайджесте есть Δ=${fmt(AST0.diff, 2)} п.п.`),
        gatedWarningsItem(dGated, gated),
        it(fGated.length > 0,
          `дайджест передаёт факт срабатывания гейта (фраза «не сошёлся» в yield_line или ключ control_failed=true): ${fGated.length ? fGated.join(", ") : `нет — yield_line=${q(dGated.yield_line, 90)}`}`),
        it(controlMentions(viaResult).length > 0 && failedClaims(viaResult).length > 0,
          `digestResult({kind:"report"}) — путь toModelOutput инструментов — несёт то же (упоминаний контроля: ${controlMentions(viaResult).length}, фактов гейта: ${failedClaims(viaResult).length})`),
      ]]);

      // 3) чистый отчёт ОФЗ 26244 (Δ 0,03, warnings=[]): дайджест про контроль не говорит и гейт не объявляет
      const ofz = liveReport("live_ofz26244.json");
      const dOfz = digestReport(ofz);
      const mOfz = controlMentions(dOfz);
      const fOfz = failedClaims(dOfz);
      sections.push([`live_ofz26244 ${ofz.security.isin}: чистый отчёт`, [
        it(ofz.diagnostics.warnings.length === 0 && (ofz.diagnostics.control_diff_pp ?? 99) <= CONFIG.controlWarnPp,
          `предусловие: warnings=[], control_diff_pp=${n2(ofz.diagnostics.control_diff_pp)} ≤ ${CONFIG.controlWarnPp}`),
        it(mOfz.length === 0, `дайджест не упоминает контроль (${mOfz.length ? mOfz.map((l) => l.path).join(",") : "упоминаний нет"})`),
        it(fOfz.length === 0, `дайджест не объявляет гейт (${fOfz.length ? fOfz.join(",") : "не объявляет"})`),
      ]]);

      // 4) сквозная цепочка движок → дайджест на снимке ISS RU000A10AST0 — без рукописной фикстуры
      const ast0 = await ast0Report();
      const dAst0 = digestReport(ast0);
      const d = ast0.yield.control_diff_pp;
      const warns = ast0.diagnostics.warnings;
      const ctlWarns = warns.filter((w) => /^контроль/i.test(w));
      const missA = missingWarnings(dAst0, warns);
      const fA = failedClaims(dAst0);
      if (d != null && d > CONFIG.controlFailPp) {
        const viaA = digestResult({ kind: "report", report: ast0 });
        sections.push([`sfo_ast0 ${ast0.security.isin} build()→digest: Δ=${n2(d)} > ${CONFIG.controlFailPp}, гейт должен сработать`, [
          it(ctlWarns.length >= 1,
            `предусловие: движок пишет предупреждение контроля в diagnostics.warnings: ${q(ctlWarns[0] ?? "—")} (own_control=${n2(ast0.yield.own_control_pct)} vs биржа ${n2(ast0.yield.exchange.pct)}, datetype=${ast0.yield.exchange.datetype})`),
          gatedWarningsItem(dAst0, ast0),
          it(hasNumber(dAst0, d), `в дайджесте есть Δ=${n2(d)} п.п.`),
          it(fA.length > 0,
            `дайджест передаёт факт срабатывания гейта (фраза «не сошёлся» в yield_line или ключ control_failed=true): ${fA.length ? fA.join(", ") : `нет — yield_line=${q(dAst0.yield_line, 100)}, yield.control_failed=${String(yieldOf(ast0).control_failed)}`}`),
          it(controlMentions(viaA).length > 0 && failedClaims(viaA).length > 0,
            `digestResult({kind:"report"}) несёт то же (упоминаний контроля: ${controlMentions(viaA).length}, фактов гейта: ${failedClaims(viaA).length})`),
        ]]);
      } else {
        // после WP-A (план, шаг 5) расхождение на AST0 исчезает — гейт обязан молчать; предупреждение (если Δ > warn) всё равно доходит до модели
        sections.push([`sfo_ast0 ${ast0.security.isin} build()→digest: Δ=${n2(d)} ≤ ${CONFIG.controlFailPp} (после WP-A) — гейт обязан молчать`, [
          it(fA.length === 0, `дайджест не объявляет гейт (${fA.length ? fA.join(",") : "не объявляет"})`),
          it(warns.length === 0 ? controlMentions(dAst0).length === 0 : missA.length === 0,
            `warnings=${warns.length}: ${warns.length === 0 ? `упоминаний контроля в дайджесте нет (${controlMentions(dAst0).length})` : `все предупреждения переданы целиком (не переданы: ${missA.length})`}`),
        ]]);
      }

      return verdict(sections);
    },
  },

  {
    id: "D.5",
    wp: "D",
    kind: "fixture",
    title: "[расширение плана: D.1 глазами модели] При сработавшем гейте дайджест не отдаёт модели доходности собственного расчёта (fees_line, колл в worst); биржевая остаётся; на нормальной бумаге fees_line на месте",
    async run() {
      const sections: [string, Item[]][] = [];

      // 1) инвариант на форме отчёта ПОСЛЕ WP-D: дайджест не придумывает fees_line при panels без «fees», не вытаскивает own_control_pct, биржевую и фразу гейта передаёт
      const gated = gatedReport();
      const own = ownNumbersOf(gated);
      const dGated = digestReport(gated);
      const hits = ownHits(dGated, own);
      const calls = callLines(dGated.worst);
      sections.push([`гейт сработал (${gated.security.isin}, Δ=${n2(gated.yield.control_diff_pp)} > controlFailPp=${CONFIG.controlFailPp}; форма отчёта после WP-D) — инвариант дайджеста`, [
        gatedShapeItem(gated),
        it(dGated.fees_line == null,
          `digest.fees_line=${dGated.fees_line == null ? "null — панели fees нет, строка не придумана" : q(dGated.fees_line)} — ожидалось null`),
        it(hits.length === 0,
          `own-чисел отчёта (${own.map((x) => fmt(x, 2)).join(", ") || "нет"}; yield.own_control_pct остаётся диагностикой) вне диагностических строк нет${hits.length ? ` — найдено ${hits.length}: ${hits.join(" ; ")}` : ""}`),
        it(calls.length === 0,
          `в digest.worst нет строки про колл (worst=${dGated.worst.length}: ${dGated.worst.map((s) => s.split(":")[0]).join(", ")})${calls.length ? ` — есть: ${calls.map((s) => q(s, 80)).join(", ")}` : ""}`),
        it(dGated.yield_line != null && dGated.yield_line.includes(fmt(AST0.exchange, 2)) && LINE_SIGNAL.test(dGated.yield_line),
          `биржевая доходность и фраза гейта остаются: yield_line содержит ${fmt(AST0.exchange, 2)}% и «не сошёлся» (${q(dGated.yield_line, 120)})`),
        it(dGated.status === "ok", `status=${q(dGated.status)} остаётся ok`),
      ]]);

      // 2) сквозная цепочка движок → дайджест на снимке ISS RU000A10AST0 (секьюритизация, Δ 43 до WP-A)
      const ast0 = await ast0Report();
      const dAst0 = digestReport(ast0);
      const d = ast0.yield.control_diff_pp;
      const ownA = ownNumbersOf(ast0);
      if (d != null && d > CONFIG.controlFailPp) {
        const hitsA = ownHits(dAst0, ownA);
        const callsA = callLines(dAst0.worst);
        sections.push([`sfo_ast0 ${ast0.security.isin} build()→digest: Δ=${n2(d)} > ${CONFIG.controlFailPp}, гейт должен сработать`, [
          it(true, `предусловие: own_control=${n2(ast0.yield.own_control_pct)} vs биржа ${n2(ast0.yield.exchange.pct)} (datetype=${ast0.yield.exchange.datetype}); own-чисел в отчёте ${ownA.length} (${ownA.slice(0, 6).map((x) => fmt(x, 2)).join(", ")}…); panels=${ast0.panels.join(",")}; worst=${ast0.worst.map((w) => w.id).join(",")}`),
          it(dAst0.fees_line == null, `digest.fees_line=${dAst0.fees_line == null ? "null" : q(dAst0.fees_line)} — ожидалось null (panels без fees)`),
          it(hitsA.length === 0, `own-чисел вне диагностических строк нет${hitsA.length ? ` — найдено ${hitsA.length}: ${hitsA.join(" ; ")}` : ""}`),
          it(callsA.length === 0, `в digest.worst нет доходности к коллу от own${callsA.length ? ` — есть: ${callsA.map((s) => q(s, 90)).join(", ")}` : ""}`),
          it(ast0.yield.main_pct != null && hasNumber(dAst0, ast0.yield.main_pct) && ast0.yield.main_pct === ast0.yield.exchange.pct,
            `биржевая остаётся главной и видна модели: main_pct=${n2(ast0.yield.main_pct)} == exchange.pct=${n2(ast0.yield.exchange.pct)}, в yield_line есть ${n2(ast0.yield.main_pct)}`),
        ]]);
      } else {
        // после WP-A (план, шаг 5) расхождение на AST0 исчезает — тогда гейт обязан молчать, а дайджест отдавать fees_line
        const k0 = ast0.fees_tax.k_grid[0];
        sections.push([`sfo_ast0 ${ast0.security.isin} build()→digest: Δ=${n2(d)} ≤ ${CONFIG.controlFailPp} (после WP-A) — гейт обязан молчать`, [
          it(typeof dAst0.fees_line === "string" && k0 != null && k0[1] != null && dAst0.fees_line.includes(fmt(k0[1], 2)),
            `digest.fees_line=${q(dAst0.fees_line, 90)} на месте и содержит own-доходность k=0 ${k0?.[1] != null ? fmt(k0[1], 2) : "null"}%`),
          it(failedClaims(dAst0).length === 0, `дайджест не объявляет гейт`),
        ]]);
      }

      // 3) нормальная бумага ОФЗ 26244 (Δ 0,03): гейт молчит — fees_line с own-числами по графику выплат отдаётся модели
      const ofz = liveReport("live_ofz26244.json");
      const dOfz = digestReport(ofz);
      const k0 = ofz.fees_tax.k_grid[0];
      sections.push([`live_ofz26244 ${ofz.security.isin}: Δ=${n2(ofz.yield.control_diff_pp)} ≤ ${CONFIG.controlFailPp} — гейт молчит`, [
        it(typeof dOfz.fees_line === "string" && k0 != null && k0[1] != null && dOfz.fees_line.includes(fmt(k0[1], 2)),
          `digest.fees_line=${q(dOfz.fees_line, 90)} содержит own-доходность k=0 ${k0?.[1] != null ? fmt(k0[1], 2) : "null"}%`),
        it(failedClaims(dOfz).length === 0, `дайджест не объявляет гейт`),
      ]]);

      return verdict(sections);
    },
  },
];
