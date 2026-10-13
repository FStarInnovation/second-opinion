/**
 * WP-U (движок): находки разбора диалогов 12.10.2026 (docs/DIALOGS_REVIEW_2026-10-12.md).
 * Каждая проверка утверждает ЖЕЛАЕМОЕ поведение: RED = дефект есть сейчас, GREEN = поведение уже правильное.
 *
 *   U.21  ликвидность учитывает размер позиции (средний дефект №5: 50 млн ₽ при обороте 5,5 млн ₽/день — «выход ≈ 0,07%, умеренно»)
 *   U.22  guard: при 500 000 ₽ строка ликвидности и категория не меняются от правки U.21 (значения заморожены 12.10.2026 на b106b4a)
 *   U.23  дюрация согласована: число «DURATION = X г.» в отчёте ↔ правило карточки глоссария ↔ worst «Рост ставок» (низкая находка)
 *
 * Проверяются оба пути, которыми продукт показывает ликвидность от позиции: сборка движком с position_size (build → assembleReport →
 * applyInputs) и пересчёт готового отчёта applyInputs(base, {position_size}) — так работают чат (gate.ts → rebuild) и страница /check.
 */
import fs from "node:fs";
import path from "node:path";
import { applyInputs } from "../../inputs";
import { collectFacts, yearsFrom } from "../../iss/facts";
import { yieldModel } from "../../metrics";
import type { BondReportT, ReportInputs } from "../../contract";
import {
  FIXTURES_DIR, GOLDEN_DIR, REPO_ROOT, buildFixture, buildGolden, fmt, goldenCases, readSrc, reportOf,
  type Check, type Verdict,
} from "../lib";

/* ───── локальные помощники (lib не трогаем) ───── */
interface Item { ok: boolean; text: string; info?: boolean }
const it = (ok: boolean, text: string): Item => ({ ok, text });
/** Справочный факт: в вердикт не входит, в detail печатается с «·» */
const info = (text: string): Item => ({ ok: true, text, info: true });
const render = (items: Item[]) => items.map((i) => `${i.info ? "·" : i.ok ? "✓" : "✗"} ${i.text}`).join("; ");
const verdict = (sections: [string, Item[]][], tail = ""): Verdict => ({
  pass: sections.every(([, items]) => items.every((i) => i.ok)),
  detail: sections
    .map(([name, items]) => {
      const asserted = items.filter((i) => !i.info);
      return `[${name}: ${asserted.filter((i) => !i.ok).length} из ${asserted.length} не выполнено] ${render(items)}`;
    })
    .join(" || ") + (tail ? " || " + tail : ""),
});
/** Intl ru-RU группирует разряды неразрывным пробелом — для сравнения строк приводим к обычному */
const norm = (s: string) => s.replace(/[   ]/g, " ");
const q = (s: string | null | undefined) => (s == null ? "null" : `«${norm(s)}»`);

/* ───── источники ───── */
const ROLF_ISIN = "RU000A10ASE2"; // РОЛЬФ 1Р07
const OFZ26238_ISIN = "RU000A1038V6";

/** Имя golden-кейса ищем по запросу в cases.json (кейс РОЛЬФ называется «rolf», не «rolf_friday» — та фикстура в audit-fixtures) */
function goldenNameByQuery(query: string): string {
  const c = goldenCases().cases.find((x) => x.query === query);
  if (!c) throw new Error(`в golden/cases.json нет кейса с query=${query}`);
  return c.name;
}

interface Src {
  label: string;
  /** собрать отчёт движком с данным вводом (поверх inputs кейса) */
  build: (inputs?: ReportInputs) => Promise<BondReportT>;
  dir: string;
  todayIso: string;
}
function goldenSrc(query: string): Src {
  const name = goldenNameByQuery(query);
  const meta = goldenCases();
  const c = meta.cases.find((x) => x.name === name)!;
  return {
    label: `golden «${name}»`,
    build: async (inputs) => reportOf(await buildGolden(name, { inputs })),
    dir: path.join(GOLDEN_DIR, "snapshots", name),
    todayIso: c.todayIso ?? meta.todayIso,
  };
}
function fixtureSrc(name: string): Src {
  const dir = path.join(FIXTURES_DIR, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { todayIso: string };
  return {
    label: `фикстура «${name}»`,
    build: async (inputs) => reportOf(await buildFixture(name, { inputs })),
    dir,
    todayIso: meta.todayIso,
  };
}
/** Оба снимка РОЛЬФ: golden (08.10, оборот 5,4 млн ₽/день) и фикстура пятницы 09.10 (5,5 млн ₽/день — ближе к диалогу 09.10 21:54) */
const rolfSources = (): Src[] => [goldenSrc(ROLF_ISIN), fixtureSrc("rolf_friday")];

/* ───── U.21 / U.22: ликвидность ───── */
const BIG = 50_000_000;
const SMALL = 500_000;
const RANK: Record<string, number> = { "норм": 0, "умеренно": 1, "низкая": 2 };

/** «стоимость моментального выхода ≈ 0,04%» — полуспред, поданный как стоимость выхода всей позиции */
const INSTANT_EXIT = /моментальн[а-яё]*\s+выход[а-яё]*\s*(?:—|-|:)?\s*≈?\s*(\d+(?:[.,]\d+)?)\s*%/i;
/** Оговорка об объёме: полуспред верен только для объёма в пределах стакана / дневного оборота */
const VOLUME_CAVEAT = /оборот|объ[её]м|стакан|глубин|не весь|не всю|скидк|част[ьи]\s+позици|сразу\s+прода|быстро\s+прода/i;
/** «≈ 47 дней» — срок выхода в днях */
const DAYS_N = /(\d+)\s*(?:дн\.|день|дня|дней)/gi;
const LINE_CATEGORY = /Категория ликвидности\s*—\s*([а-яё—-]+)/i;

const liqFacts = (r: BondReportT) => {
  const L = r.liquidity;
  return `позиция ${L.position_size}, avg_turnover ${L.avg_turnover}, share_pct ${fmt(L.share_pct)}, spread_pct ${fmt(L.spread_pct)}, ` +
    `exit_now_pct ${fmt(L.exit_now_pct, 4)}, exit_now_money ${L.exit_now_money}, exit_days ${L.exit_days}, category «${L.category}»`;
};

/** Утверждения о строке/категории ликвидности при позиции больше среднего дневного оборота */
export function bigPositionItems(big: BondReportT, small: BondReportT): Item[] {
  const L = big.liquidity, line = norm(L.line);
  const instant = line.match(INSTANT_EXIT);
  const caveat = line.match(VOLUME_CAVEAT);
  const days = [...line.matchAll(DAYS_N)].map((m) => Number(m[1]));
  const turnoverWord = /оборот/i.test(line);
  const rBig = RANK[L.category], rSmall = RANK[small.liquidity.category];
  const lineCat = line.match(LINE_CATEGORY)?.[1] ?? null;
  return [
    it(L.share_pct != null && L.share_pct > 100,
      `предусловие: позиция ${L.position_size} ₽ больше среднего дневного оборота ${L.avg_turnover} ₽ (share_pct=${fmt(L.share_pct)}%)`),
    it(!instant || !!caveat,
      instant
        ? `строка подаёт полуспред как стоимость моментального выхода всей позиции: «…${instant[0]}…»` +
          (caveat ? ` — есть оговорка об объёме («${caveat[0]}»)` : " — без оговорки об объёме/обороте/стакане") +
          ` (exit_now_pct=${fmt(L.exit_now_pct, 4)} = спред ${fmt(L.spread_pct)}%/2; exit_now_money=${L.exit_now_money} ₽)`
        : `строка не называет «моментальный выход ≈ X%» для позиции больше оборота`),
    it(turnoverWord || days.some((n) => n > 1),
      `строка прямо говорит о размере позиции относительно оборота или о сроке выхода в днях: ` +
      `«оборот» ${turnoverWord ? "есть" : "нет"}, дни в строке [${days.join(", ") || "—"}] (exit_days=${L.exit_days})`),
    it(rBig !== undefined && rSmall !== undefined && rBig > rSmall,
      rBig === undefined
        ? `категория при ${L.position_size} ₽ «${L.category}» не из известной шкалы норм<умеренно<низкая — обнови RANK в wp-u.ts`
        : `категория при ${L.position_size} ₽ «${L.category}» хуже, чем при ${small.liquidity.position_size} ₽ «${small.liquidity.category}» (шкала норм<умеренно<низкая)`),
    it(lineCat == null || lineCat === L.category,
      `категория в строке ${lineCat == null ? "не названа" : "«" + lineCat + "»"} совпадает с полем category «${L.category}»`),
    info(`строка при ${small.liquidity.position_size}: ${q(small.liquidity.line)}`),
    info(`строка при ${L.position_size}: ${q(L.line)}`),
    info(`поля при ${small.liquidity.position_size}: ${liqFacts(small)}`),
    info(`поля при ${L.position_size}: ${liqFacts(big)}`),
  ];
}

/* ───── U.22: замороженные значения при 500 000 ₽ (сняты 12.10.2026 на b106b4a; пробелы нормализованы norm()) ───── */
const FROZEN_SMALL: Record<string, { line: string; category: string }> = {
  "golden «rolf»": {
    line: "При позиции 500 000 ₽ стоимость моментального выхода ≈ 0,04%, аккуратного выхода ≈ 1 день. Категория ликвидности — умеренно.",
    category: "умеренно",
  },
  "фикстура «rolf_friday»": {
    line: "При позиции 500 000 ₽ стоимость моментального выхода ≈ 0,08%, аккуратного выхода ≈ 1 день. Категория ликвидности — умеренно.",
    category: "умеренно",
  },
};

/* ───── U.23: дюрация ───── */
/** Число, подписанное в отчёте как дюрация: «DURATION = 4,9 г.», «Дюрация 4,9 года», «дюрация — 4,9 лет» */
const DUR_LABELED = /(DURATION|[Дд]юраци[а-яё]*)\s*(?:=|:|—|≈|-)?\s*(\d+(?:[.,]\d+)?)\s*(?:г\.|год|года|лет)/g;
/** Оговорка о переходе от показанной (Маколея) к падению цены: делить на (1 + доходность). Слово «модифицированная» само по себе
 *  оговоркой не считается — это и есть правило карточки, а подпись «модифицированная» у числа Маколея была бы ошибкой, не оговоркой. */
const DIV_CAVEAT = /Маколе|1\s*\+\s*(?:y|доходност|ставк)|делён|делен|раздел|подел/i;

/** Все строковые листья отчёта с путём — где отчёт подписывает число как дюрацию */
function labeledDurations(r: BondReportT): { where: string; text: string; value: number }[] {
  const out: { where: string; text: string; value: number }[] = [];
  const walk = (v: unknown, p: string) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(DUR_LABELED)) out.push({ where: p, text: v, value: Number(m[2].replace(",", ".")) });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(r, "");
  return out;
}

/** Карточка «Дюрация» из глоссария чата (apps/web/lib/glossary.ts) — как текст */
function durationCard(): string {
  const src = readSrc("apps/web/lib/glossary.ts");
  const m = src.match(/id:\s*"duration"[\s\S]*?text:\s*"([^"]*)"/);
  if (!m) throw new Error("в apps/web/lib/glossary.ts не найдена карточка id: \"duration\"");
  return m[1];
}

/** Выводят ли UI-блоки отчёта flags[].details (там живёт «DURATION = X г.») — справочно, на вердикт не влияет */
function uiRendersFlagDetails(): string {
  const dir = path.join(REPO_ROOT, "packages", "blocks", "src");
  const files = fs.readdirSync(dir).filter((f) => /\.(tsx?|jsx?)$/.test(f));
  const hits = files.filter((f) => /\.details\b/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  return hits.length
    ? `UI-блоки (packages/blocks/src) обращаются к .details: ${hits.join(", ")}`
    : `справочно: UI-блоки (packages/blocks/src, ${files.length} файлов) flags[].details не выводят (карточка флага — title+text без числа) — ` +
      `«DURATION = X г.» видно в JSON-контракте (GET /api/report → flags[].details), а не в карточках отчёта`;
}

/** Независимая дюрация Маколея по потокам снимка при биржевой доходности (эффективная годовая), лет — подтверждает, что DURATION ISS = Маколей */
async function macaulayIndependent(src: Src, r: BondReportT) {
  const b = await collectFacts(r.security.secid, { fromSnapshotDir: src.dir, todayIso: src.todayIso });
  const ym = yieldModel(b, {});
  const yPct = b.moexY ?? ym.main;
  if (yPct == null || b.ctype !== "fixed" || b.offerKind !== "none" || !b.matIso) return { b, yPct, mac: null as number | null };
  const y = yPct / 100;
  const flows: [number, number][] = [];
  for (const c of b.coupons) {
    if (!c.future) continue;
    const v = c.value ?? ((b.face ?? 0) * (b.cp ?? 0)) / 100 * ((b.period ?? 0) / 365);
    flows.push([yearsFrom(b.settleIso, c.dateIso), v]);
  }
  for (const a of b.amortFuture) flows.push([a.t, a.value]);
  flows.push([yearsFrom(b.settleIso, b.matIso), (b.face ?? 0) - b.amortFuture.reduce((s, a) => s + a.value, 0)]);
  const pv = flows.reduce((s, [t, cf]) => s + cf / Math.pow(1 + y, t), 0);
  const mac = flows.reduce((s, [t, cf]) => s + (t * cf) / Math.pow(1 + y, t), 0) / pv;
  return { b, yPct, mac };
}

const TOL_PP = 0.1;

export const checks: Check[] = [
  {
    id: "U.21",
    title: "Ликвидность учитывает размер позиции: 50 млн ₽ при обороте ≈ 5,5 млн ₽/день (РОЛЬФ 1Р07)",
    wp: "U",
    kind: "fixture",
    async run() {
      const sections: [string, Item[]][] = [];
      for (const src of rolfSources()) {
        const small = await src.build({ position_size: SMALL });
        const big = await src.build({ position_size: BIG });
        sections.push([`${src.label} · build(position_size=${BIG})`, bigPositionItems(big, small)]);
        // путь чата и страницы: базовый отчёт (позиция по умолчанию) → applyInputs с новой суммой («50000000 рублей», 09.10 21:54)
        const base = await src.build();
        const viaApply = applyInputs(base, { position_size: BIG });
        sections.push([`${src.label} · applyInputs(base@${base.inputs.position_size} → ${BIG})`, bigPositionItems(viaApply, base)]);
      }
      return verdict(sections);
    },
  },
  {
    id: "U.22",
    title: "Guard: при 500 000 ₽ строка ликвидности и категория РОЛЬФ не меняются (правка U.21 не задевает малую позицию)",
    wp: "U",
    kind: "unit",
    guard: true,
    async run() {
      const sections: [string, Item[]][] = [];
      for (const src of rolfSources()) {
        const want = FROZEN_SMALL[src.label];
        if (!want) throw new Error(`нет замороженных значений для ${src.label}`);
        const small = await src.build({ position_size: SMALL });
        const dflt = await src.build();
        const big = await src.build({ position_size: BIG });
        const paths: [string, BondReportT][] = [
          [`build(position_size=${SMALL})`, small],
          [`build() — позиция по умолчанию ${dflt.inputs.position_size}`, dflt],
          [`applyInputs(base@${dflt.inputs.position_size} → ${SMALL})`, applyInputs(dflt, { position_size: SMALL })],
          // обратный пересчёт (rebuild в чате: отчёт уже на 50 млн, пользователь вернул 500 тыс.) — категория обязана вернуться
          [`applyInputs(build@${BIG} → ${SMALL})`, applyInputs(big, { position_size: SMALL })],
        ];
        const items: Item[] = [];
        for (const [name, r] of paths) {
          const L = r.liquidity;
          const same = norm(L.line) === want.line;
          items.push(it(same && L.category === want.category,
            `${name}: category «${L.category}» (заморожено «${want.category}»), line ${q(L.line)}` +
            (same ? " = замороженной" : ` ≠ замороженной «${want.line}»`)));
        }
        items.push(info(`поля при ${SMALL}: ${liqFacts(small)}`));
        sections.push([src.label, items]);
      }
      return verdict(sections);
    },
  },
  {
    id: "U.23",
    title: "Дюрация согласована: «DURATION» отчёта по правилу карточки глоссария = падение цены в worst «Рост ставок»",
    wp: "U",
    kind: "fixture",
    async run() {
      const card = durationCard();
      const cardCaveat = card.match(DIV_CAVEAT);
      const sources: Src[] = [fixtureSrc("ofz26244"), goldenSrc(OFZ26238_ISIN), goldenSrc(ROLF_ISIN)];
      const sections: [string, Item[]][] = [];
      for (const src of sources) {
        const r = await src.build();
        const rates = r.worst.find((w) => w.id === "rates");
        const shown = labeledDurations(r);
        const { b, yPct, mac } = await macaulayIndependent(src, r);
        const durY = b.durDays == null ? null : b.durDays / 365;
        const f7 = r.flags.find((f) => f.id === 7);
        const items: Item[] = [
          info(`${r.security.shortname} (${r.security.isin}): ISS DURATION = ${b.durDays} дн. = ${fmt(durY, 4)} г.; ` +
            `независимая дюрация Маколея по потокам снимка при y=${fmt(yPct, 4)}% = ${fmt(mac, 4)} г.; ` +
            `модифицированная = Маколей/(1+y) = ${fmt(mac == null || yPct == null ? null : mac / (1 + yPct / 100), 4)} г.`),
          info(`worst «Рост ставок»: loss_pct_1pp = ${fmt(rates?.loss_pct_1pp, 4)}% (metrics.ts dmod = durDays/365/(1+main), main = ${fmt(r.yield.main_pct, 4)}%); текст ${q(rates?.text)}`),
          info(`флаг 7 «${f7?.title}»: fired=${f7?.fired}, порог — DURATION/365 > 5 г. (Маколей), details ${q(f7?.details)}`),
        ];
        if (!rates || rates.loss_pct_1pp == null) {
          items.push(it(false, `в отчёте нет worst «rates» с loss_pct_1pp — сравнивать не с чем (status ${r.status.kind})`));
        } else if (!shown.length) {
          items.push(it(true, `отчёт нигде не подписывает число как дюрацию — расхождения с карточкой нет`));
        } else {
          for (const s of shown) {
            const diff = Math.abs(s.value - rates.loss_pct_1pp);
            const strCaveat = s.text.match(DIV_CAVEAT);
            const ok = diff <= TOL_PP || !!strCaveat || !!cardCaveat;
            items.push(it(ok,
              `${s.where} = ${q(s.text)}: по правилу карточки («цена падает примерно на величину … дюрации в процентах») ` +
              `падение при +1 п.п. ≈ ${fmt(s.value, 1)}%, отчёт (worst rates) — ${fmt(rates.loss_pct_1pp, 4)}%; |Δ| = ${fmt(diff, 3)} п.п. ` +
              `(допуск ${TOL_PP}); оговорка о делении на 1+y / Маколее — в строке: ${strCaveat ? "«" + strCaveat[0] + "»" : "нет"}, ` +
              `в карточке: ${cardCaveat ? "«" + cardCaveat[0] + "»" : "нет"}`));
          }
        }
        sections.push([src.label, items]);
      }
      const tail = `карточка «Дюрация» (apps/web/lib/glossary.ts): «${card}»; ${uiRendersFlagDetails()}`;
      return verdict(sections, tail);
    },
  },
];
