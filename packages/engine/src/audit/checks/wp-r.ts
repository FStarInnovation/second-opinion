/**
 * WP-R — распознавание и ошибки источника (docs/AUDIT_PLAN_2026-10-09.md, раздел WP-R;
 * аудит R2-02, R2-03, R2-11, R2-12, R2-17, «api/report/route.ts:20 — не число»).
 * Каждая проверка утверждает ЖЕЛАЕМОЕ поведение; до правки — RED.
 *
 *   R.1 fixture  ISIN акции (audit-fixtures/stock_sber, RU0009029540) → {kind:"err"} «не облигация», не notfound
 *   R.2 live     «Сбер Sb42R» → ОТЧЁТ RU000A105SD9 (kind report). pick — RED: после поиска по токенам ISS по «Sb42R»
 *                отдаёт ровно 1 строку с shortname «Сбер Sb42R», и правило exact-shortname обязано дать отчёт
 *   R.3 live     «ВТБ» (ISS упирается в потолок 100 строк) → pick с truncated=true безусловно; total (если есть)
 *                согласован с числом показанных и числом stock_bonds в ISS. Простое поднятие среза 20→50 не проходит
 *   R.4 live     «26244-ПД» → отчёт ОФЗ 26244 (правило ОФЗ раньше правила регномера)
 *   R.5 unit     перебор программы 4-01-10797-A-001P офлайн по golden-снимку pick-program через подменённый
 *                fetch с задержкой 150 мс на запрос: < 3 с (последовательно 31 × 150 мс ≥ 4,65 с), ВСЕ 30 слотов
 *                4B02-NN-10797 опрошены («дырки» реальны — R2-11), пул 6–10 одновременных запросов (план WP-R;
 *                Promise.all на 30 = блокировка ISS, порог 3 с один не отличает пул 2 от пула 6), те же 8 бумаг
 *   R.6 unit     HTTP 500 / 403 / сетевой TypeError от ISS → build() возвращает {kind:"err", msg}, а не бросает
 *   R.7 unit     applyInputs с NaN в promised_pct / position_size+k_pct / offer_price_pct → нет «не число»/NaN
 *                в строках, числовые поля null или конечны, BondReport.safeParse проходит
 *   R.8 — кэш по SECID — сторона веба (apps/web/audit/checks/wp-r.ts), здесь не дублируется.
 */
import fs from "node:fs";
import path from "node:path";
import { build } from "../../build";
import { applyInputs } from "../../inputs";
import { BondReport, type BuildResultT, type ReportInputs } from "../../contract";
import { issJson, rows, q as issQ } from "../../iss/client";
import { buildFixture, buildGolden, fmt, FIXTURES_DIR, GOLDEN_DIR, reportOf, snapshotRows, type Check, type Verdict } from "../lib";

/* ───── общие помощники ───── */

interface Block { name: string; problems: string[]; facts: string }
const verdict = (blocks: Block[]): Verdict => ({
  pass: blocks.every((b) => b.problems.length === 0),
  detail: blocks
    .map((b) => `[${b.name}] ${b.problems.length ? "НЕ ВЫПОЛНЕНО: " + b.problems.join("; ") + " | " : "ок | "}${b.facts}`)
    .join("\n"),
});

const errStr = (e: unknown): string => {
  if (e instanceof Error) {
    const kind = (e as { kind?: string }).kind;
    const status = (e as { status?: number }).status;
    return `${e.constructor.name}${kind ? `(${kind}${status ? ` ${status}` : ""})` : ""}: ${e.message.slice(0, 160)}`;
  }
  return String(e).slice(0, 160);
};

/** Что вернул build() — одной строкой с ключевыми полями каждой ветки конверта */
function describeRes(res: BuildResultT): string {
  switch (res.kind) {
    case "report": {
      const s = res.report.security;
      return `report ${s.secid} (ISIN ${s.isin}, «${s.shortname}», ${s.typename}), status ${res.report.status.kind}`;
    }
    case "pick": {
      const known = new Set(["kind", "query", "note", "candidates"]);
      const extra = Object.entries(res as Record<string, unknown>).filter(([k]) => !known.has(k));
      const names = res.candidates.slice(0, 6).map((c) => c.shortname).join(", ");
      return `pick: ${res.candidates.length} кандидатов [${names}${res.candidates.length > 6 ? ", …" : ""}], note «${res.note}», ` +
        `доп. поля: ${extra.length ? extra.map(([k, v]) => `${k}=${String(v)}`).join(", ") : "нет"}`;
    }
    case "notfound":
      return `notfound (isinValid=${res.isinValid})`;
    case "err":
      return `err «${res.msg}»`;
  }
}

/** Подмена globalThis.fetch на время fn; восстанавливается в finally даже при исключении */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
async function withFetch<T>(mock: FetchLike, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = mock as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}
const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** Имя файла снимка — та же свёртка URL, что в iss/client.ts (slug) */
const ISS_BASE = "https://iss.moex.com";
const issSlug = (u: string) => u.replace(ISS_BASE + "/iss/", "").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 150);
const jsonResponse = (doc: unknown, status = 200) =>
  new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Обход отчёта: строки с «не число»/NaN/∞ и нечисловые числовые поля (путь = значение) */
function scan(obj: unknown, p = "", out = { strings: [] as string[], numbers: [] as string[] }) {
  if (typeof obj === "string") {
    if (/не число|NaN|Infinity|∞/i.test(obj)) out.strings.push(`${p} = «${obj.slice(0, 140)}»`);
  } else if (typeof obj === "number") {
    if (!Number.isFinite(obj)) out.numbers.push(`${p} = ${String(obj)}`);
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => scan(v, `${p}[${i}]`, out));
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) scan(v, p ? `${p}.${k}` : k, out);
  }
  return out;
}

interface SearchRowLite { secid: string; shortname: string; isin: string | null; type: string; group: string; regnumber: string | null }
const searchRaw = async (text: string) => rows<SearchRowLite>(await issJson(issQ.search(text)), "securities");
const bondsOf = (rs: SearchRowLite[]) => rs.filter((r) => r.group === "stock_bonds");

/** Доп. поля ветки pick, которых сегодня нет в контракте (план: total/truncated) */
function pickExtras(res: Extract<BuildResultT, { kind: "pick" }>) {
  const extra = res as unknown as Record<string, unknown>;
  return {
    total: typeof extra.total === "number" ? extra.total : null,
    truncated: typeof extra.truncated === "boolean" ? extra.truncated : null,
  };
}

/** Потолок выдачи ISS /securities.json?q= (limit игнорируется, проверено 08.10.2026) */
const ISS_CEILING = 100;

/* ───── проверки ───── */

export const checks: Check[] = [
  {
    id: "R.1",
    wp: "R",
    kind: "fixture",
    title: "ISIN акции (RU0009029540, Сбербанк) → err «это не облигация», а не notfound «не торгуется»",
    run: async () => {
      const dir = path.join(FIXTURES_DIR, "stock_sber");
      const raw = snapshotRows(dir, "securities_json_q_RU0009029540", "securities") as unknown as SearchRowLite[];
      const exact = raw.filter((r) => r.isin === "RU0009029540" || r.secid === "RU0009029540");
      const res = await buildFixture("stock_sber");
      const problems: string[] = [];
      if (res.kind !== "err") {
        problems.push(`kind=${res.kind}, ожидался err` + (res.kind === "notfound" ? ` — пользователь видит «не нашли / не торгуется», хотя ISS знает бумагу (${exact.length} точных совпадений по ISIN)` : ""));
      } else {
        if (!/не\s+облигаци/i.test(res.msg)) problems.push(`msg без «не облигация»: «${res.msg}»`);
        const named = /RU0009029540/i.test(res.msg) || /сбербанк/i.test(res.msg);
        if (!named) problems.push(`msg не называет бумагу (ни ISIN RU0009029540, ни «Сбербанк»): «${res.msg}»`);
      }
      const groups = [...new Set(raw.map((r) => r.group))].join(", ");
      const types = [...new Set(raw.map((r) => r.type))].join(", ");
      return verdict([{
        name: "stock_sber",
        problems,
        facts: `ISS q=RU0009029540: ${raw.length} строк, group {${groups}}, type {${types}}, shortname «${raw[0]?.shortname ?? "—"}»; ` +
          `после фильтра stock_bonds: ${bondsOf(raw).length} → build: ${describeRes(res)}`,
      }]);
    },
  },

  {
    id: "R.2",
    wp: "R",
    kind: "live",
    title: "«Сбер Sb42R» → ОТЧЁТ RU000A105SD9 (kind report; pick — не отчёт, даже если SD9 внутри списка)",
    run: async () => {
      const ISIN = "RU000A105SD9";
      const res = await build("Сбер Sb42R");
      const rawFull = await searchRaw("Сбер Sb42R");
      const rawTok = await searchRaw("Sb42R");
      const problems: string[] = [];
      if (res.kind === "report") {
        const s = res.report.security;
        if (s.isin !== ISIN && s.secid !== ISIN) problems.push(`отчёт по другой бумаге: ${s.secid} / ${s.isin} («${s.shortname}»)`);
      } else if (res.kind === "pick") {
        const pos = res.candidates.findIndex((c) => c.isin === ISIN || c.secid === ISIN);
        problems.push(
          `kind=pick из ${res.candidates.length} кандидатов, ${ISIN} ${pos >= 0 ? `на позиции ${pos + 1}` : "отсутствует"} — ` +
          `пользователь не получает отчёт, хотя ISS по токену «Sb42R» отдаёт ровно одну бумагу и exact-shortname должен дать report`,
        );
      } else {
        problems.push(`kind=${res.kind}, ожидался report ${ISIN}`);
      }
      const tokHit = rawTok.find((r) => r.isin === ISIN);
      const tokBonds = bondsOf(rawTok);
      return verdict([{
        name: "Сбер Sb42R",
        problems,
        facts: `ISS q=«Сбер Sb42R»: ${rawFull.length} строк (stock_bonds ${bondsOf(rawFull).length}), ${ISIN} среди них: ${rawFull.some((r) => r.isin === ISIN)}; ` +
          `q=«Sb42R»: ${rawTok.length} строк (stock_bonds ${tokBonds.length})${tokHit ? ` → «${tokHit.shortname}» ${tokHit.secid}` : ""}; build: ${describeRes(res)}`,
      }]);
    },
  },

  {
    id: "R.3",
    wp: "R",
    kind: "live",
    title: "«ВТБ» (ISS упирается в потолок 100 строк) → pick с truncated=true и согласованным total, а не молчаливый срез",
    run: async () => {
      const res = await build("ВТБ");
      const raw = await searchRaw("ВТБ");
      const bonds = bondsOf(raw);
      const ceiling = raw.length >= ISS_CEILING;
      const problems: string[] = [];
      let shown = "—";
      if (res.kind !== "pick") {
        problems.push(`kind=${res.kind}, ожидался pick`);
      } else {
        const { total, truncated } = pickExtras(res);
        const n = res.candidates.length;
        shown = `показано ${n}, total=${total == null ? "нет" : total}, truncated=${truncated == null ? "нет" : truncated}`;
        if (ceiling && truncated !== true)
          problems.push(`ISS отдал ${raw.length} строк — потолок ISS, полное множество неизвестно, а truncated≠true (${shown}): пользователь видит «нашли ${n}» как полный список`);
        if (!ceiling && truncated !== true && n !== bonds.length)
          problems.push(`показано ${n} из ${bonds.length} stock_bonds без truncated=true (${shown})`);
        if (total != null) {
          if (total < n) problems.push(`total=${total} меньше числа показанных кандидатов ${n}`);
          if (total > n && truncated !== true) problems.push(`total=${total} > показанных ${n}, но truncated≠true`);
          if (total !== bonds.length && truncated !== true) problems.push(`total=${total} ≠ stock_bonds в ISS ${bonds.length} при truncated≠true`);
        }
      }
      return verdict([{
        name: "ВТБ",
        problems,
        facts: `ISS q=«ВТБ»: ${raw.length} строк (stock_bonds ${bonds.length}; потолок ISS ${ISS_CEILING}, limit игнорирует; потолок достигнут: ${ceiling}); ${shown}; build: ${describeRes(res)}`,
      }]);
    },
  },

  {
    id: "R.4",
    wp: "R",
    kind: "live",
    title: "«26244-ПД» → отчёт ОФЗ 26244 (правило ОФЗ раньше правила регномера)",
    run: async () => {
      const res = await build("26244-ПД");
      const rawQ = await searchRaw("26244-ПД");
      const rawNum = (await searchRaw("26244")).filter((r) => r.type === "ofz_bond");
      const problems: string[] = [];
      if (res.kind !== "report") problems.push(`kind=${res.kind}, ожидался report SU26244RMFS2`);
      else {
        const s = res.report.security;
        if (s.secid !== "SU26244RMFS2" && s.isin !== "RU000A1074G2") problems.push(`отчёт по другой бумаге: ${s.secid} / ${s.isin} («${s.shortname}»)`);
      }
      return verdict([{
        name: "26244-ПД",
        problems,
        facts: `ISS q=«26244-ПД»: ${rawQ.length} строк; q=«26244» (ofz_bond): ${rawNum.length}${rawNum[0] ? ` → ${rawNum[0].secid} «${rawNum[0].shortname}»` : ""}; build: ${describeRes(res)}`,
      }]);
    },
  },

  {
    id: "R.5",
    wp: "R",
    kind: "unit",
    title: "Перебор программы 4-01-10797-A-001P: < 3 с при задержке ISS 150 мс/запрос, все 30 слотов опрошены, пул 6–10 одновременных, те же 8 бумаг",
    run: async () => {
      const dir = path.join(GOLDEN_DIR, "snapshots", "pick-program");
      const expected = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, "expected", "pick-program.json"), "utf8")) as BuildResultT;
      const wantSecids = expected.kind === "pick" ? expected.candidates.map((c) => c.secid).sort() : [];
      const LAT_MS = 150, LIMIT_MS = 3000, SLOTS = 30, POOL_MIN = 6, POOL_MAX = 10;
      let inflight = 0, maxInflight = 0;
      const urls: string[] = [];
      const missing: string[] = [];
      const mock: FetchLike = async (input) => {
        const url = urlOf(input);
        urls.push(url);
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        try {
          await sleep(LAT_MS);
          const f = path.join(dir, issSlug(url) + ".json");
          if (!fs.existsSync(f)) {
            missing.push(url.replace(ISS_BASE + "/iss/", ""));
            return jsonResponse({ securities: { columns: ["secid"], data: [] } });
          }
          return jsonResponse(JSON.parse(fs.readFileSync(f, "utf8")));
        } finally {
          inflight--;
        }
      };
      const t0 = Date.now();
      let res: BuildResultT | null = null;
      let thrown: string | null = null;
      try {
        res = await withFetch(mock, () => build("4-01-10797-A-001P", {}, { retries: 0 }));
      } catch (e) {
        thrown = errStr(e);
      }
      const ms = Date.now() - t0;
      const slots = new Set(urls.map((u) => u.match(/q=4B02-(\d\d)-10797/)?.[1]).filter(Boolean) as string[]);
      const missingSlots = Array.from({ length: SLOTS }, (_, i) => String(i + 1).padStart(2, "0")).filter((s) => !slots.has(s));
      const problems: string[] = [];
      if (thrown) problems.push(`build бросил ${thrown}`);
      if (ms >= LIMIT_MS) problems.push(`перебор занял ${(ms / 1000).toFixed(2)} с при задержке ${LAT_MS} мс/запрос: ${urls.length} запросов, максимум одновременно ${maxInflight} (пула нет)`);
      if (slots.size !== SLOTS)
        problems.push(`опрошено слотов ${slots.size}/${SLOTS}${missingSlots.length ? ` (нет: ${missingSlots.slice(0, 6).join(", ")}${missingSlots.length > 6 ? ", …" : ""})` : ""} — «дырки» в нумерации реальны (R2-11: РОЛЬФ 001P слоты 01–02 пусты), ранний выход теряет выпуски`);
      if (maxInflight > POOL_MAX) problems.push(`макс. параллельность ${maxInflight} > ${POOL_MAX} — не пул, а залп по ISS (риск блокировки)`);
      if (maxInflight < POOL_MIN) problems.push(`макс. параллельность ${maxInflight} < ${POOL_MIN} — план WP-R задаёт пул 6–10 (порог ${LIMIT_MS / 1000} с один пропускает пул 2: 16 × ${LAT_MS} мс = 2,4 с)`);
      if (res && res.kind !== "pick") problems.push(`kind=${res.kind}, ожидался pick из ${wantSecids.length} бумаг программы`);
      if (res && res.kind === "pick") {
        const got = res.candidates.map((c) => c.secid).sort();
        if (JSON.stringify(got) !== JSON.stringify(wantSecids))
          problems.push(`состав pick ≠ golden pick-program: получено [${got.join(", ")}], ожидалось [${wantSecids.join(", ")}]`);
      }
      return verdict([{
        name: "4-01-10797-A-001P (офлайн, golden/snapshots/pick-program)",
        problems,
        facts: `${urls.length} запросов к ISS за ${(ms / 1000).toFixed(2)} с (порог ${LIMIT_MS / 1000} с), макс. одновременно ${maxInflight} (норма ${POOL_MIN}–${POOL_MAX}), слотов 4B02-NN-10797 опрошено ${slots.size}/${SLOTS}` +
          (missing.length ? `, URL без снимка: ${missing.length} (${missing.slice(0, 3).join("; ")}${missing.length > 3 ? "; …" : ""})` : "") +
          `; результат: ${res ? describeRes(res) : "—"}`,
      }]);
    },
  },

  {
    id: "R.6",
    wp: "R",
    kind: "unit",
    title: "Сбой ISS (HTTP 500 / 403 / сетевой TypeError) → build() возвращает {kind:\"err\", msg про Мосбиржу}, а не исключение",
    run: async () => {
      const scenarios: { name: string; mock: FetchLike }[] = [
        { name: "HTTP 500", mock: async () => new Response("Internal Server Error", { status: 500 }) },
        { name: "HTTP 403 (блокировка по сети/пути)", mock: async () => new Response("Forbidden", { status: 403 }) },
        { name: "сетевой сбой TypeError('fetch failed')", mock: async () => { throw new TypeError("fetch failed"); } },
      ];
      const blocks: Block[] = [];
      for (const sc of scenarios) {
        const problems: string[] = [];
        let facts: string;
        try {
          const res = await withFetch(sc.mock, () => build("RU000A10ASE2", {}, { retries: 0 }));
          facts = `build → ${describeRes(res)}`;
          if (res.kind !== "err") problems.push(`kind=${res.kind}, ожидался err`);
          else {
            if (!res.msg.trim()) problems.push("msg пуст");
            else if (!/мосбирж|бирж|\bISS\b/i.test(res.msg)) problems.push(`msg не называет источник (Мосбиржа/ISS): «${res.msg}»`);
          }
        } catch (e) {
          problems.push(`build бросил исключение ${errStr(e)} — на /api/report это голый HTTP 500, на /check страница ошибки Next`);
          facts = "конверт BuildResult не получен";
        }
        blocks.push({ name: sc.name, problems, facts });
      }
      return verdict(blocks);
    },
  },

  {
    id: "R.7",
    wp: "R",
    kind: "unit",
    title: "applyInputs с NaN (promised_pct / position_size+k_pct / offer_price_pct) → нет «не число» в строках, числа null или конечны, BondReport проходит",
    run: async () => {
      const base = reportOf(await buildGolden("rolf"));
      const cases: { name: string; inputs: ReportInputs }[] = [
        { name: "promised_pct: NaN", inputs: { promised_pct: NaN } },
        { name: "position_size: NaN, k_pct: NaN", inputs: { position_size: NaN, k_pct: NaN } },
        { name: "offer_price_pct: NaN", inputs: { offer_price_pct: NaN } },
      ];
      const blocks: Block[] = [];
      for (const c of cases) {
        const problems: string[] = [];
        let facts: string;
        try {
          const r = applyInputs(base, c.inputs);
          const s = scan(r);
          if (s.strings.length) problems.push(`строки с «не число»/NaN (${s.strings.length}): ${s.strings.slice(0, 3).join("; ")}`);
          if (s.numbers.length) problems.push(`нечисловые числовые поля (${s.numbers.length}): ${s.numbers.slice(0, 4).join("; ")}`);
          const parsed = BondReport.safeParse(r);
          if (!parsed.success)
            problems.push(`BondReport.safeParse: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} — ${i.message}`).join("; ")}`);
          const f12 = r.flags.find((f) => f.id === 12);
          const inputsStr = Object.entries(r.inputs).map(([k, v]) => `${k}=${String(v)}`).join(", ");
          facts = `inputs {${inputsStr}}; claim.line ${r.claim.line == null ? "null" : `«${r.claim.line}»`}; claim.gap_pp ${String(r.claim.gap_pp)}; ` +
            `flag12 fired=${f12?.fired} details «${f12?.details ?? ""}»; liquidity.line «${r.liquidity.line.slice(0, 90)}»; ` +
            `liquidity {position_size ${String(r.liquidity.position_size)}, share_pct ${String(r.liquidity.share_pct)}, exit_now_money ${String(r.liquidity.exit_now_money)}, exit_days ${String(r.liquidity.exit_days)}}; ` +
            `fees_tax {k_pct ${String(r.fees_tax.k_pct)}, pre ${fmt(r.fees_tax.pre_tax_pct)}, post ${fmt(r.fees_tax.post_tax_pct)}}; truth_score ${r.truth_score.score}`;
        } catch (e) {
          problems.push(`applyInputs бросил ${errStr(e)}`);
          facts = "отчёт не получен";
        }
        blocks.push({ name: c.name, problems, facts });
      }
      return verdict(blocks);
    },
  },
];
