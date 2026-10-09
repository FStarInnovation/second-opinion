/**
 * WP-C — пара «цена ↔ доходность» и ноль (docs/AUDIT_PLAN_2026-10-09.md, раздел WP-C; аудит §C и R2-29).
 * Каждая проверка утверждает ЖЕЛАЕМОЕ поведение; до правки — RED, guard — GREEN уже сейчас.
 *
 * Желаемое (план WP-C): цепочка пар ISS
 *   marketdata_yields.EFFECTIVEYIELDWAPRICE ↔ marketdata_yields.WAPRICE
 *   → marketdata.YIELDATWAPRICE ↔ marketdata.WAPRICE
 *   → securities.YIELDATPREVWAPRICE ↔ securities.PREVWAPRICE;
 * ровно 0 в поле доходности = «не рассчитано» → null (отрицательные реальны); биржевая доходность становится main
 * ТОЛЬКО если её цена совпадает с показанной ценой (price.clean_pct) — одна пара; иначе main = own.
 *
 * Фикстуры (копии снимков audit-fixtures/rolf_friday и veb_zero с точечной правкой полей ISS, meta.json
 * хранит список правок в `edits`):
 *   C_rolf_noyield     marketdata_yields.EFFECTIVEYIELDWAPRICE=null при marketdata.WAPRICE=102.02 (глитч ISS, РОЛЬФ 09.10 12:46);
 *                      второе звено цепочки есть: marketdata.YIELDATWAPRICE=20.09 ↔ WAPRICE=102.02 → main должен быть 20.09
 *   C_rolf_noyield_md  + marketdata.YIELDATWAPRICE=null — к показанной цене 102.02 пары нет вовсе → main = own
 *   C_veb_zero0        marketdata_yields.EFFECTIVEYIELDWAPRICE=0 (ISS: 0 = «не рассчитано»; YIELDATWAPRICE=0, YIELDATPREVWAPRICE=0 — оригинал)
 *   C_veb_prev0        до первой сделки: WAPRICE/EFFECTIVEYIELDWAPRICE/YIELDATWAPRICE=null, PREVWAPRICE=100.59 ↔ YIELDATPREVWAPRICE=0
 *   C_rolf_negative    marketdata_yields.EFFECTIVEYIELDWAPRICE=−11.24 при той же паре WAPRICE=102.02 (guard)
 */
import fs from "node:fs";
import path from "node:path";
import { approx, buildFixture, fmt, FIXTURES_DIR, reportOf, type Check, type Verdict } from "../lib";
import type { BondReportT } from "../../contract";
import { collectFacts } from "../../iss/facts";
import { horizon, yieldOf } from "../../metrics";

/** Допуск для величин, округлённых движком до 2 знаков */
const EPS = 0.0051;

/* ───── сырые поля снимка №1 (engines_…, не history_…) ───── */
function n1Row(dir: string, table: string): Record<string, unknown> {
  const f = fs.readdirSync(dir).find((x) => x.startsWith("engines_stock_markets_bonds_boards_") && x.endsWith(".json"));
  if (!f) throw new Error(`в ${dir} нет снимка №1 (engines_stock_markets_bonds_boards_…)`);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, { columns: string[]; data: unknown[][] }>;
  const t = doc[table];
  if (!t) throw new Error(`в ${f} нет таблицы ${table}`);
  const row = t.data[0] ?? [];
  return Object.fromEntries(t.columns.map((c, i) => [c, row[i]]));
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

interface IssPair { src: string; price: number; y: number }
interface RawN1 {
  myWap: number | null; eff: number | null; // marketdata_yields: WAPRICE ↔ EFFECTIVEYIELDWAPRICE
  mdWap: number | null; yWap: number | null; // marketdata: WAPRICE ↔ YIELDATWAPRICE
  prevWap: number | null; yPrev: number | null; // securities: PREVWAPRICE ↔ YIELDATPREVWAPRICE
}

function rawN1(dir: string): RawN1 {
  const my = n1Row(dir, "marketdata_yields"), md = n1Row(dir, "marketdata"), sec = n1Row(dir, "securities");
  return {
    myWap: num(my.WAPRICE), eff: num(my.EFFECTIVEYIELDWAPRICE),
    mdWap: num(md.WAPRICE), yWap: num(md.YIELDATWAPRICE),
    prevWap: num(sec.PREVWAPRICE), yPrev: num(sec.YIELDATPREVWAPRICE),
  };
}

/** Пары «цена ↔ доходность», которые биржа реально опубликовала в снимке, В ПОРЯДКЕ ЦЕПОЧКИ плана.
 *  null и ровно 0 — «не рассчитано», пары нет. */
function issPairs(raw: RawN1): IssPair[] {
  const out: IssPair[] = [];
  const add = (src: string, price: number | null, y: number | null) => {
    if (price != null && y != null && y !== 0) out.push({ src, price, y });
  };
  add("marketdata_yields.EFFECTIVEYIELDWAPRICE↔WAPRICE", raw.myWap, raw.eff);
  add("marketdata.YIELDATWAPRICE↔WAPRICE", raw.mdWap, raw.yWap);
  add("securities.YIELDATPREVWAPRICE↔PREVWAPRICE", raw.prevWap, raw.yPrev);
  return out;
}

const pairStr = (q: IssPair) => `${q.src} ${fmt(q.y)}@${fmt(q.price)}`;
const pairsStr = (ps: IssPair[]) => (ps.length ? ps.map(pairStr).join(", ") : "ни одной");

const rawStr = (r: RawN1) =>
  `EFFECTIVEYIELDWAPRICE=${fmt(r.eff, 4)}@WAPRICE=${fmt(r.myWap)}, YIELDATWAPRICE=${fmt(r.yWap)}@WAPRICE=${fmt(r.mdWap)}, YIELDATPREVWAPRICE=${fmt(r.yPrev)}@PREVWAPRICE=${fmt(r.prevWap)}`;

interface Probe {
  name: string;
  r: BondReportT;
  raw: RawN1;
  pairs: IssPair[];
  /** Свой расчёт движка от ПОКАЗАННОЙ цены (price.clean_pct): yieldOf при k=0, сценарий 1, горизонт модели — определение own */
  own: number | null;
}

async function probe(name: string): Promise<Probe> {
  const dir = path.join(FIXTURES_DIR, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { todayIso: string };
  const r = reportOf(await buildFixture(name));
  const raw = rawN1(dir);
  let own: number | null = null;
  if (r.price.clean_pct != null) {
    const b = await collectFacts(r.security.secid, { fromSnapshotDir: dir, todayIso: meta.todayIso });
    own = yieldOf(b, r.price.clean_pct, 0, 1, horizon(b));
  }
  return { name, r, raw, pairs: issPairs(raw), own };
}

const reportStr = (p: Probe) => {
  const y = p.r.yield, ex = y.exchange;
  return `status ${p.r.status.kind}; main_pct ${fmt(y.main_pct)}; exchange {pct ${fmt(ex.pct)}, price_pct ${fmt(ex.price_pct)}, used_as_main ${ex.used_as_main}}; ` +
    `price.clean_pct ${fmt(p.r.price.clean_pct)} (prev_used ${p.r.price.prev_used}); own@clean ${fmt(p.own)}; own_control_pct ${fmt(y.own_control_pct)}, control_diff_pp ${fmt(y.control_diff_pp)}`;
};

const lineStr = (p: Probe) => `yield.line: «${(p.r.yield.line ?? "").split(" и удержании")[0]}»`;

const verdict = (blocks: { name: string; problems: string[]; facts: string }[]): Verdict => {
  const bad = blocks.filter((b) => b.problems.length);
  const detail = blocks
    .map((b) => `[${b.name}] ${b.problems.length ? "НЕ ВЫПОЛНЕНО: " + b.problems.join("; ") + " | " : "ок | "}${b.facts}`)
    .join("\n");
  return { pass: bad.length === 0, detail };
};

/** Инвариант «одна пара»: если отчёт показывает биржевую доходность, то (exchange.price_pct ↔ exchange.pct) — опубликованная ISS пара */
function onePairProblem(p: Probe): string | null {
  const ex = p.r.yield.exchange;
  if (ex.pct == null) return null;
  const pair = p.pairs.find((q) => approx(q.price, ex.price_pct, EPS) && approx(q.y, ex.pct, EPS));
  return pair ? null : `exchange (${fmt(ex.pct)}@${fmt(ex.price_pct)}) биржей как пара не опубликован; опубликованы: ${pairsStr(p.pairs)}`;
}

export const checks: Check[] = [
  {
    id: "C.1",
    wp: "C",
    kind: "fixture",
    title: "Биржевая доходность и показанная цена — одна пара ISS: есть пара к цене → она main; нет → main = own",
    run: async () => {
      // Замысел фикстур: в C_rolf_noyield пара к показанной цене ЕСТЬ (второе звено цепочки), в C_rolf_noyield_md — НЕТ.
      // Ожидание выбирается по снимку, а не по имени: частичная правка (только «useMoex при moexYPrice === cleanPct»,
      // без звена marketdata.YIELDATWAPRICE↔WAPRICE) даст на C_rolf_noyield main = own = 19.43 и останется RED.
      const intent: Record<string, boolean> = { C_rolf_noyield: true, C_rolf_noyield_md: false };
      const blocks = [];
      for (const name of Object.keys(intent)) {
        const p = await probe(name);
        const y = p.r.yield, ex = y.exchange, clean = p.r.price.clean_pct;
        const problems: string[] = [];
        if (p.r.status.kind !== "ok") problems.push(`status ${p.r.status.kind}, ожидался ok`);
        if (clean == null) problems.push("price.clean_pct = null при WAPRICE/PREVWAPRICE в снимке");

        // первая по цепочке опубликованная пара, чья цена = показанной
        const atClean = p.pairs.find((q) => approx(q.price, clean, EPS));
        if ((atClean != null) !== intent[name])
          problems.push(`фикстура не соответствует замыслу: пара к показанной цене ${fmt(clean)} ${atClean ? "есть (" + pairStr(atClean) + ")" : "отсутствует"}, ожидалось «${intent[name] ? "есть" : "нет"}»`);

        let expected: string;
        if (atClean) {
          expected = `к показанной цене ${fmt(clean)} биржа опубликовала ${pairStr(atClean)} → main должен быть биржевой ${fmt(atClean.y)}`;
          if (!ex.used_as_main)
            problems.push(`used_as_main = false, хотя пара к показанной цене есть (${pairStr(atClean)}) — биржевое число главное`);
          if (!approx(ex.pct, atClean.y, EPS))
            problems.push(`exchange.pct ${fmt(ex.pct)} ≠ ${fmt(atClean.y)} (${atClean.src} — первая пара цепочки к цене ${fmt(clean)})`);
          if (!approx(ex.price_pct, clean, EPS))
            problems.push(`exchange.price_pct ${fmt(ex.price_pct)} ≠ price.clean_pct ${fmt(clean)} — доходность от одной цены, показ другой`);
          // РОЛЬФ без колла: main = биржевой доходности (min с call.y не применяется)
          if (!approx(y.main_pct, ex.pct, EPS)) problems.push(`main_pct ${fmt(y.main_pct)} ≠ exchange.pct ${fmt(ex.pct)}`);
          if (!approx(y.main_pct, atClean.y, EPS)) problems.push(`main_pct ${fmt(y.main_pct)} ≠ биржевой ${fmt(atClean.y)} к цене ${fmt(clean)}`);
        } else {
          expected = `к показанной цене ${fmt(clean)} пары нет (опубликованы: ${pairsStr(p.pairs)}) → main должен быть own ${fmt(p.own)}`;
          if (ex.used_as_main)
            problems.push(`used_as_main = true при отсутствии пары к показанной цене ${fmt(clean)}: взято ${fmt(ex.pct)}@${fmt(ex.price_pct)} — доходность от одной цены, показ другой`);
          if (!approx(y.main_pct, p.own, EPS))
            problems.push(`main_pct ${fmt(y.main_pct)} ≠ own от показанной цены ${fmt(p.own)}`);
        }
        const op = onePairProblem(p);
        if (op) problems.push(op);

        blocks.push({
          name,
          problems,
          facts: `ожидание по снимку: ${expected}. ISS: ${rawStr(p.raw)} → ${reportStr(p)}; ${lineStr(p)}`,
        });
      }
      return verdict(blocks);
    },
  },
  {
    id: "C.2",
    wp: "C",
    kind: "fixture",
    title: "Биржевая доходность ровно 0 = «не рассчитано»: exchange.pct = null, main ≠ 0, status ok, используется own",
    run: async () => {
      const blocks = [];
      for (const name of ["C_veb_zero0", "C_veb_prev0"]) {
        const p = await probe(name);
        const y = p.r.yield, ex = y.exchange;
        const problems: string[] = [];
        // премисса фикстуры: все три биржевые доходности снимка — 0 или null, т.е. рассчитанной биржевой доходности нет
        if (p.pairs.length !== 0)
          problems.push(`фикстура не соответствует замыслу: в снимке есть ненулевая биржевая пара (${pairsStr(p.pairs)})`);
        if (p.r.status.kind !== "ok") problems.push(`status ${p.r.status.kind}, ожидался ok`);
        if (y.main_pct == null) problems.push("main_pct = null");
        else if (y.main_pct === 0) problems.push("main_pct = 0,00% — ноль ISS показан как доходность");
        // план: toNum(x) === 0 → null для обоих полей доходности — не «не ноль», а именно null
        if (ex.pct != null)
          problems.push(`exchange.pct = ${fmt(ex.pct)} — в снимке нет ненулевой биржевой доходности (0 = «не рассчитано»), ожидался null`);
        if (ex.used_as_main) problems.push(`used_as_main = true при биржевой доходности ${fmt(ex.pct)} — рассчитанной биржевой доходности в снимке нет (${p.pairs.length} опубликованных пар)`);
        if (!approx(y.main_pct, p.own, EPS)) problems.push(`main_pct ${fmt(y.main_pct)} ≠ own от показанной цены ${fmt(p.own)} (own − 5 = ${fmt(p.own == null ? null : p.own - 5)})`);
        if (name === "C_veb_prev0" && !p.r.price.prev_used) problems.push("WAPRICE пуст, но price.prev_used = false");
        blocks.push({
          name,
          problems,
          facts: `ISS: ${rawStr(p.raw)} → ${reportStr(p)}; ${lineStr(p)}`,
        });
      }
      return verdict(blocks);
    },
  },
  {
    id: "C.3",
    wp: "C",
    kind: "fixture",
    guard: true,
    title: "Отрицательная биржевая доходность (бумага выше номинала) реальна и остаётся main",
    run: async () => {
      const blocks = [];
      for (const { name, y: expected } of [{ name: "C_rolf_negative", y: -11.24 }, { name: "veb_zero", y: -0.4601 }]) {
        const p = await probe(name);
        const y = p.r.yield, ex = y.exchange, clean = p.r.price.clean_pct;
        const want = Math.round(expected * 100) / 100;
        const problems: string[] = [];
        if (p.r.status.kind !== "ok") problems.push(`status ${p.r.status.kind}, ожидался ok`);
        if (!ex.used_as_main) problems.push("биржевая доходность не использована как main");
        if (!approx(ex.pct, want, EPS)) problems.push(`exchange.pct ${fmt(ex.pct)} ≠ ${fmt(want)} из снимка`);
        if (!approx(y.main_pct, want, EPS)) problems.push(`main_pct ${fmt(y.main_pct)} ≠ ${fmt(want)}`);
        if (!approx(ex.price_pct, clean, EPS)) problems.push(`exchange.price_pct ${fmt(ex.price_pct)} ≠ price.clean_pct ${fmt(clean)}`);
        const op = onePairProblem(p);
        if (op) problems.push(op);
        blocks.push({
          name,
          problems,
          facts: `ISS: ${rawStr(p.raw)} → ${reportStr(p)} (расхождение с own — предмет гейта WP-D, не WP-C)`,
        });
      }
      return verdict(blocks);
    },
  },
];
