/**
 * WP-U guard-проверки (пакет U-K: глоссарий, промпт, дайджест): краевые случаи, найденные ревью 13.10.2026. Должны быть GREEN
 * после правки. Каждая вызывает реальную функцию продукта (findTerm, GLOSSARY, digestReport, SYSTEM_PROMPT, runGate) и
 * закрепляет «вход → ожидаемое» из guard_cases ревьюеров; detail показывает входы и фактический ответ.
 *
 *  - U.K1, U.K3–U.K7, U.K11, U.K13 — findTerm (lib/glossary.ts) прямо в процессе харнеса. Строки recheck 13.10 (служебное слово
 *    после вопроса, длинная реплика, «в чём отличие», два термина во фразе вопроса) — в U.K2–U.K5, U.K11; строки третьего ревью
 *    13.10 («<термин> что значит у облигации?», «…, а купон это что?», «налоговый вычет», «лифтинг», вопрос не только о термине,
 *    оценка «это хорошо?») — в U.K2–U.K6, U.K13; строки recheck2 13.10 («Объясни, что за ОФЗ», «Объясни, это облигация?»,
 *    «что такое спред над ОФЗ») — в U.K2, U.K4–U.K6.
 *  - U.K2 — сквозной путь гейта на правилах (JEV_ENABLED=0, без отчёта): что увидит пользователь. Гейт тянет `import "server-only"`
 *    и читает окружение при импорте, поэтому, как в wp-u-gate.ts, он гоняется в ДОЧЕРНЕМ процессе:
 *    `node --import tsx <этот файл> --scenario gate` (cwd = apps/web), "server-only" → пустой модуль, fetch запрещён целиком
 *    (любое обращение в сеть — исключение, URL попадает в detail). LLM не вызывается: handled=false — реплика ушла бы модели.
 *  - U.K8 — тексты статей GLOSSARY. U.K9, U.K10 — digestReport на build() снимков ISS (audit-fixtures/sfo_ast0 и golden/snapshots),
 *    U.K12 — SYSTEM_PROMPT (lib/prompt.ts).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "@so/engine";
import type { BondReportT, BuildResultT, ReportInputs } from "@so/engine/contract";
import { findTerm, GLOSSARY, type Term } from "../../lib/glossary";
import { digestReport } from "../../lib/digest";
import type { ChatSession } from "../../lib/session";
import { type Check, type Verdict, pass, fail, fixture, readJson, REPO_ROOT, WEB_ROOT } from "../lib";

const THIS_FILE = fileURLToPath(import.meta.url);
const MARK = "@@WP-U-GUARDS-K@@";
const show = (v: unknown) => JSON.stringify(v);
const q = (s: unknown, max = 120) => {
  const t = typeof s === "string" ? s : JSON.stringify(s) ?? String(s);
  const one = t.replace(/\s+/g, " ").trim();
  return `«${one.length > max ? one.slice(0, max - 1) + "…" : one}»`;
};
const termStr = (t: Term | null) => (t ? t.id : "null");
/** Рассказ без вопроса с терминами «оферта», «амортизация» (recheck 13.10): ×2 — длиннее 600 символов, вопрос в конце */
const STORY = "Здравствуйте. Мне в банке менеджер долго рассказывал про облигации одного застройщика, говорил, что у них есть оферта и " +
  "амортизация, что это надёжнее вклада и что банк сам их держит. Я честно мало что понял, потому что он говорил очень быстро и всё " +
  "время отвлекался на телефон, а потом пришёл другой сотрудник и начал рассказывать про страховку жизни. ";

/* ═════════════════════════════ findTerm: таблица «реплика → допустимые ответы» ═════════════════════════════ */

/** Ожидание: id статьи или "null"; несколько допустимых — через «|» */
type Row = [said: string, want: string];
function table(rows: Row[], note = ""): Verdict {
  const res = rows.map(([s, want]) => {
    const got = termStr(findTerm(s));
    return { s, want, got, ok: want.split("|").includes(got) };
  });
  const bad = res.filter((r) => !r.ok);
  const detail = `${res.length - bad.length}/${res.length} ок${note ? ` (${note})` : ""}` +
    (bad.length ? ` | НЕ ок: ${bad.map((r) => `${q(r.s, 80)}→${r.got} (ожид. ${r.want})`).join("; ")}` : "") +
    ` | все: ${res.map((r) => `${q(r.s, 60)}→${r.got}`).join("; ")}`;
  return bad.length === 0 ? pass(detail) : fail(detail);
}

const UK1: Check = {
  id: "U.K1", wp: "U", kind: "unit", guard: true,
  title: "findTerm: спрошенный базовый термин при вкладе в контексте — не карточка «Облигация и вклад» («Банк вместо вклада предлагает облигации. Что такое купон?» → Купон или null)",
  // ревью A (major): до правки U-K всё это → deposit, гейт закрывал ход чужой карточкой
  run: () => table([
    ["Банк вместо вклада предлагает облигации. Что такое купон?", "coupon|null"],
    ["что такое облигация? мне в банке предлагают вместо вклада", "bond|null"],
    ["У меня вклад заканчивается, банк предлагает облигации. Что такое погашение?", "maturity|null"],
    ["Объясни, что такое ОФЗ — в банке советуют вместо депозита", "ofz|null"],
    ["закрыл вклад и купил облигации — что такое купон?", "coupon"],
    ["Банк вместо вклада предлагает облигации, купон это что?", "coupon|null"],
  ], "deposit недопустим ни в одной"),
};

const UK3: Check = {
  id: "U.K3", wp: "U", kind: "unit", guard: true,
  title: "findTerm: спрошенный базовый термин важнее термина из контекста («в отчёте написано НКД, а что такое купон?» → Купон, а не НКД); служебное слово после вопроса («что значит у облигации купон?», «объясни, как работает погашение») и второй термин во фразе вопроса («что такое купон у облигации с офертой») — не чужая карточка",
  run: () => table([
    // recheck 13.10 (major): «что значит у/для …», «объясни, как …» — до правки шаг 2 отдавал самый ранний термин реплики (НКД, Колл)
    ["в отчёте написано НКД, а что значит у облигации купон?", "coupon|null"],
    ["НКД понятно, а что значит для облигации номинал?", "nominal|null"],
    ["у бумаги есть колл. Объясни, как работает погашение", "maturity|null"],
    ["Объясни, как работает купон, если в отчёте есть НКД", "coupon|null"],
    // recheck 13.10 (minor): термин из aliases дальше во фразе не перебивает спрошенное базовое слово (не рамку)
    ["что такое купон у облигации с офертой", "coupon|null"],
    ["что такое купон и как он связан с НКД?", "coupon|null"],
    ["НКД понятно, а купон что такое?", "coupon|null"],
    ["в отчёте написано НКД, а что такое купон?", "coupon"],
    ["у бумаги колл через год. что такое купон?", "coupon"],
    ["у бумаги есть оферта, а что такое номинал?", "nominal"],
    ["НКД ясно. Что такое облигация?", "bond"],
    ["в отчёте есть колл, а что такое ОФЗ?", "ofz"],
    ["в отчёте доходность к погашению 18%, а что такое НКД?", "nkd"],
    ["досрочное погашение через год — что такое оферта?", "offer"],
    // ревью 3 (major): термин перед вопросом, рамка после него — до правки карточка «Облигация»/«ОФЗ»; «…, а купон это что?» — карточка НКД
    ["Дюрация что значит у облигации?", "duration|null"],
    ["Купон что значит у ОФЗ?", "coupon|null"],
    ["флоатер что значит у ОФЗ?", "float|null"],
    ["Купон что значит при оферте?", "coupon|null"],
    ["НКД понятно, а купон это что?", "coupon|null"],
    ["в отчёте есть оферта, а номинал это что?", "nominal|null"],
  ]),
};

const UK4: Check = {
  id: "U.K4", wp: "U", kind: "unit", guard: true,
  title: "findTerm: спрошенное слово не из глоссария → null, даже если в реплике есть другие термины («у облигации есть оферта, а что такое дефолт?», «что такое бессрочная облигация с коллом», «что значит для облигации с офертой дефолт?», «что значит при оферте технический дефолт?»); спред при ОФЗ — не «Спред в стакане» («что такое спред над ОФЗ» → G-спред или null)",
  run: () => table([
    ["у облигации есть оферта, а что такое дефолт?", "null"],
    ["НКД понятно, а что такое дефолт?", "null"],
    ["что такое бессрочная облигация с коллом", "null"],
    ["что такое бессрочная облигация", "null"],
    ["что такое субординированная облигация с колл-опционом", "null"],
    ["что такое ВДО с амортизацией", "null"],
    ["в отчёте флаг про дюрацию, а что такое рейтинг?", "null"],
    ["что такое ИИС и как он влияет на налог?", "null"],
    ["что такое реструктуризация облигации с офертой", "null"],
    ["что такое кредитный скоринг?", "null"],
    // recheck 13.10 (major): служебное слово после вопроса — фраза вопроса о другом, термин из неё же («с офертой») не в счёт
    ["Объясни, чем опасен дефолт для облигации с офертой", "null"],
    ["что значит для облигации с офертой дефолт эмитента?", "null"],
    ["что значит для облигации с офертой дефолт?", "null"],
    ["что значит в отчёте дефолт, если у бумаги оферта?", "null"],
    ["что значит у бумаги рейтинг, если есть колл?", "null"],
    ["что значит при оферте технический дефолт?", "null"],
    ["что значит без оферты технический дефолт?", "null"],
    ["у бумаги оферта, а рейтинг что значит?", "null"],
    // ревью 3 (major): прилагательное от основы термина и слово перед термином — другое понятие (до правки — «Налог», «Квал», «Колл»)
    ["расскажи про налоговый вычет", "null"],
    ["что такое вычет НДФЛ", "null"],
    ["что такое налоговая льгота", "null"],
    ["что такое квалификационный тест", "null"],
    ["что такое досрочное погашение по требованию владельцев", "null"],
    ["что такое налог на имущество", "null"],
    ["что такое оферта в договоре", "null"],
    // recheck2 13.10 (major): слово «спред» и ОФЗ в одной реплике — контекст G-спреда; до правки (и в проде) — карточка «Спред в стакане»
    ["Что значит спред между облигацией и ОФЗ?", "gspread|null"],
    ["что значит спред облигации к ОФЗ", "gspread|null"],
    ["что такое спред над ОФЗ", "gspread|null"],
    ["спред над ОФЗ это что?", "gspread|null"],
    ["у ОФЗ спред что значит?", "gspread|null"],
    ["что такое спред относительно гособлигаций", "gspread|null"],
    ["Купил ОФЗ. Что такое спред?", "gspread|null"],
  ]),
};

const UK5: Check = {
  id: "U.K5", wp: "U", kind: "unit", guard: true,
  title: "findTerm: сравнение с вкладом и термин рядом с контекстными словами находятся («Чем облигация отличается от депозита?», «в чём отличие облигации с офертой от вклада?» → Облигация и вклад, «что значит флаг «Длинная дюрация»?» → Дюрация, «Объясни, как работает оферта» → Оферта, «в 2025 г. спред» — не G-спред)",
  run: () => table([
    // сравнение (правило 9 промпта передаёт в explain_term «облигация и вклад»)
    ["Чем облигация отличается от депозита?", "deposit"],
    ["облигация или вклад?", "deposit"],
    ["Облигации Сбера или вклад в Сбере?", "deposit|null"],
    ["облигация и вклад", "deposit"],
    ["Чем облигация с офертой отличается от вклада?", "deposit"],
    ["что лучше: ОФЗ или вклад?", "deposit"],
    ["объясни, чем облигация отличается от вклада", "deposit"],
    ["Мне вместо вклада предлагают облигацию с офертой — что такое оферта?", "offer"],
    ["это лучше депозита?", "null"],
    // recheck 13.10 (minor): «отличие/отличия» — тоже сравнение
    ["в чём отличие облигации с офертой от вклада?", "deposit"],
    ["в чём отличия облигации от вклада?", "deposit"],
    ["Объясни разницу между облигацией и вкладом", "deposit"],
    // термин рядом с контекстом
    ["у ОФЗ большая дюрация, что это?", "duration"],
    ["по купону начисляется НКД — что это?", "nkd|null"],
    ["облигация с плавающим купоном — это что?", "float"],
    ["что за облигации для квалов", "qual"],
    ["у облигации есть колл — что это?", "call|null"],
    ["что значит флаг «Длинная дюрация»?", "duration"],
    ["что такое облигация с офертой", "offer"],
    ["что такое облигация ОФЗ ?", "ofz"],
    ["что значит у облигации дюрация", "duration"],
    ["что такое уровень листинга", "listlevel"],
    ["в 2025 г. спред вырос, что это?", "spread|null"],
    ["в 2025 г. спред — что это?", "spread"],
    ["что такое G-спред у облигации?", "gspread"],
    ["что такое Г-спред", "gspread"],
    // recheck2 13.10: «спред к ОФЗ» — G-спред алиасом, спред без ОФЗ — «Спред в стакане»; термин из aliases после «что за» — его статья
    ["что такое спред к ОФЗ", "gspread"],
    ["что такое премия за риск", "gspread"],
    ["широкий спред", "spread"],
    ["что такое спред в стакане", "spread"],
    ["Объясни, что за оферта", "offer"],
    ["Объясни, что это такое, оферта", "offer"],
    // служебные слова после вопроса и вопрос после термина — фраза вопроса только о термине
    ["Объясни, как работает оферта", "offer"],
    ["что значит для меня дюрация?", "duration"],
    ["что такое номинал облигации", "nominal"],
    ["как работают облигации", "bond"],
    ["погашение облигации", "maturity"],
    ["как работают облигации и купон", "null"],
    ["что значит флаг у облигации", "truth"],
    // ревью 3: в вопросе не только термин — отвечает модель (null) или карточка спрошенного термина, но не другого
    ["НКД что значит? У меня оферта", "nkd|null"],
    ["дюрация — что такое? И почему она большая?", "duration|null"],
    // ревью 3: заголовок статьи (так его передаёт модель), многословные термины, голова и рассказ перед вопросом
    ["Налог на доход по облигациям", "tax"],
    ["Колл — досрочное погашение по решению эмитента", "call"],
    ["что такое Truth Score", "truth"],
    ["что такое worst-case сценарий", "worst"],
    ["что такое ставка налога", "tax"],
    ["что такое налогообложение облигаций", "tax"],
    ["что такое дата оферты", "offer"],
    ["Хочу понять что такое НКД", "nkd"],
    ["Привет! Что такое НКД?", "nkd"],
    ["Объясни, что лучше: облигация или вклад", "deposit"],
    ["Говорят, что это надёжно. Что такое оферта?", "offer"],
  ]),
};

const UK6: Check = {
  id: "U.K6", wp: "U", kind: "unit", guard: true,
  title: "findTerm: бытовые слова и вопросы о конкретной бумаге → null («путь», «коллега посоветовал», «дурацкий вопрос», «что за облигация Магнит?», «Объясни, что за ОФЗ», «Объясни, это облигация?», «это ОФЗ?», «а купон?», «что такое ОФЗ-ПК»)",
  run: () => table([
    ["путь", "null"], ["спутник", "null"], ["скоро", "null"], ["скоро погашение?", "null|maturity"], ["коллега посоветовал", "null"],
    ["номинация", "null"], ["дурацкий вопрос", "null"], ["флагман рынка", "null"], ["это надолго?", "null"], ["намного выше", "null"],
    ["депозит в банке открыл", "null"], ["13% годовых это много?", "null|ytm"], ["сколько баллов", "null"], ["кредит", "null"],
    ["вкладка", "null"], ["кулон", "null"], ["среда", "null"], ["бондарь", "null"],
    ["что это за облигация?", "null"], ["что за облигация Магнит?", "null"], ["это ОФЗ?", "null"], ["а купон?", "null"],
    ["бессрочная облигация, что это?", "null"], ["что такое нулевой купон", "null"], ["что такое ОФЗ-ПК", "null"],
    ["расскажи про эту облигацию", "null"], ["Что такое ОФЗ 26238?", "null"],
    // ревью 3 (minor): «лифтинг» на расстоянии одной буквы от «листинг» — не опечатка
    ["лифтинг", "null"], ["что такое лифтинг", "null"], ["что такое лифтинг лица", "null"],
    // recheck2 13.10 (major): «что за» после «объясни/расскажи» — тоже о конкретной бумаге; до правки — базовая карточка и шаблон
    ["Объясни, что за ОФЗ", "null"], ["Объясни мне, что за облигация", "null"], ["Объясни, что за вклад", "null"],
    ["Расскажи, что это за купон", "null"], ["Поясни, что это за купон?", "null"], ["Объясни, что за погашение", "null"],
    // recheck2 13.10 (minor): «Объясни, это X?» — вопрос, тот ли это термин (о строке отчёта), а не просьба об определении
    ["Объясни, это облигация?", "null"], ["Поясни, это купон?", "null"], ["Объясни, это оферта?", "null"], ["Расскажи, это ОФЗ?", "null"],
  ]),
};

const UK7: Check = {
  id: "U.K7", wp: "U", kind: "unit", guard: true,
  title: "findTerm: опечатки и падежи находят статью («Срок драции», «дюрацыя», «флоутер», «наминал», «погошение», «облегация», «накопленый купонный доход»)",
  run: () => table([
    ["Срок драции", "duration"], ["дюрацыя", "duration"], ["что такое дюррация", "duration"], ["флоутер", "float"], ["флоатр", "float"],
    ["флотер", "float"], ["что такое наминал", "nominal"], ["что такое погошение", "maturity"], ["облегация", "bond"],
    ["амортизаця", "amort"], ["накопленый купонный доход", "nkd"], ["объясни мне, пожалуйста, про дюрацию", "duration"],
  ]),
};

const UK13: Check = {
  id: "U.K13", wp: "U", kind: "unit", guard: true,
  title: "findTerm: вопрос не только о термине → null, отвечает модель: просьба о совете или сомнение после термина или перед ним («Что такое НКД? Стоит ли покупать сейчас?», «Объясни дюрацию. Ты уверен, что она у этой бумаги большая?», «Ты уверен? Что такое НКД?»), два термина («что такое НКД и дюрация?»), число о бумаге, оценка «это хорошо?» и вопрос о не-термине перед термином («Что значит дефолт? И что такое оферта?»)",
  // ревью 3 (major): до правки карточка первого термина, вторая половина вопроса терялась, ход закрывался шаблоном
  run: () => table([
    ["Что такое НКД? Стоит ли покупать сейчас?", "null"],
    // приёмка 13.10 (регрессия к проду): номер ОФЗ слитно — это бумага, не термин «ОФЗ»
    ["ОФЗ26238", "null"],
    ["офз26238?", "null"],
    ["OFZ26238", "null"],
    ["что такое ОФЗ 26238?", "null"],
    ["Что значит у облигации оферта? Мне её предъявлять?", "null"],
    ["Что такое колл? Брать или нет?", "null"],
    ["Что значит третий уровень листинга? Это опасно?", "null"],
    ["Объясни, что значит колл, и стоит ли покупать", "null"],
    ["Объясни дюрацию. Ты уверен, что она у этой бумаги большая?", "null"],
    ["Объясни НКД и как его считают", "null"],
    ["что такое НКД и дюрация?", "null"],
    ["что такое оферта или колл?", "null"],
    ["Объясни: оферта или колл?", "null"],
    ["Что значит дефолт? И что такое оферта?", "null"],
    ["у облигации есть колл, что это? Брать или нет?", "null"],
    ["что значит дюрация 3,2 года?", "null"],
    // вопрос перед явным вопросом о термине — тоже вопрос: сомнение, совет, оценка
    ["Ты уверен? Что такое НКД?", "null"],
    ["Стоит ли брать? Что такое оферта?", "null"],
    ["Мне предлагают облигацию вместо вклада, это хорошо? Что такое оферта?", "null"],
    // ревью 3 (minor): оценка без явного вопроса о термине (гейт на правилах шлёт «это хорошо/плохо» в explain_term)
    ["дюрация 3 года это хорошо?", "null"],
    ["у бумаги есть оферта, это хорошо?", "null"],
    ["Колл через год это плохо?", "null"],
    ["Truth Score 45 это плохо?", "null"],
    ["почему у бумаги такая большая дюрация?", "null"],
  ]),
};

const UK11: Check = {
  id: "U.K11", wp: "U", kind: "unit", guard: true,
  title: "findTerm на длинной реплике: рассказ 700+ символов с офертой и вопросом в конце — не карточка «Оферта» (спрошенный термин или null); 10 000+ символов — быстрее 10 мс (лучший из 5 замеров): длинная реплика не тратит CPU гейта",
  run(): Verdict {
    // recheck 13.10 (minor): до правки в длинной реплике вопрос в конце не виден, и шаг 2 отдавал «Оферту» из начала рассказа
    const rows = table([
      [STORY + STORY + "Так вот, что такое НКД?", "nkd|null"], [STORY + STORY + "Так вот, что такое купон?", "coupon|null"],
      [STORY + STORY + "Так вот, что такое дюрация?", "duration|null"], [STORY + STORY + "Так вот, что такое дефолт?", "null"],
    ], `рассказ ${(STORY + STORY).length} символов + вопрос`);
    const long = "У меня вклад заканчивается, банк предлагает облигации с офертой и коллом. Что такое купон? ".repeat(120);
    findTerm(long); // прогрев JIT
    const ms: number[] = [];
    for (let k = 0; k < 5; k++) { const t0 = performance.now(); findTerm(long); ms.push(performance.now() - t0); }
    const best = Math.min(...ms);
    const detail = `реплика ${long.length} символов: замеры ${ms.map((x) => x.toFixed(2)).join(", ")} мс, лучший ${best.toFixed(2)} мс (порог 10 мс) | ${rows.detail}`;
    return long.length >= 10_000 && best < 10 && rows.pass ? pass(detail) : fail(detail);
  },
};

/* ═════════════════════════════ тексты статей ═════════════════════════════ */

const UK8: Check = {
  id: "U.K8", wp: "U", kind: "unit", guard: true,
  title: "GLOSSARY: базовые статьи без цифр; ОФЗ не противоречит «Флоатеру» (цена ОФЗ-ПК почти не меняется), у облигации — исключения (бессрочные), у погашения — остаток номинала, НДФЛ 15% сверх порога, амортизация без «абсолютные выплаты уменьшаются»",
  run(): Verdict {
    const text = (id: string) => GLOSSARY.find((g) => g.id === id)?.text ?? "";
    const noDigits = ["bond", "ofz", "coupon", "nominal", "maturity", "deposit"].map((id) => ({ id, d: text(id).match(/\d[\d.,%]*/g) ?? [] }));
    const ofzAll = /когда ставки растут, цена офз падает/i.test(text("ofz"));
    const ofzFloat = /ОФЗ-ПК|плавающ/i.test(text("ofz"));
    const items: Array<[boolean, string]> = [
      [noDigits.every((x) => text(x.id) !== "" && x.d.length === 0),
        `без цифр: ${noDigits.map((x) => `${x.id}${text(x.id) ? (x.d.length ? ` — цифры ${x.d.join(" ")}` : " ок") : " — статьи нет"}`).join(", ")}`],
      [!ofzAll && ofzFloat, `ofz: про ОФЗ-ПК/плавающий купон ${ofzFloat ? "есть" : "НЕТ"}, безусловное «цена ОФЗ падает» ${ofzAll ? "ЕСТЬ" : "нет"}; float: ${q(text("float"), 90)}`],
      [/бессрочн/i.test(text("bond")), `bond: оговорка о бессрочных ${/бессрочн/i.test(text("bond")) ? "есть" : "НЕТ"} — ${q(text("bond"), 100)}`],
      [/остат/i.test(text("maturity")), `maturity: остаток номинала при амортизации ${/остат/i.test(text("maturity")) ? "есть" : "НЕТ"}`],
      [/15\s?%/.test(text("tax")), `tax: ставка 15% сверх порога ${/15\s?%/.test(text("tax")) ? "есть" : "НЕТ"} — ${q(text("tax"), 100)}`],
      [!/абсолютные выплаты/i.test(text("amort")), `amort: ${q(text("amort"), 120)}`],
    ];
    const detail = items.map(([ok, s]) => `${ok ? "ок" : "НЕ ок"}: ${s}`).join(" | ");
    return items.every(([ok]) => ok) ? pass(detail) : fail(detail);
  },
};

/* ═════════════════════════════ промпт ═════════════════════════════ */

const UK12: Check = {
  id: "U.K12", wp: "U", kind: "static", guard: true,
  title: "SYSTEM_PROMPT, правило 9: без отчёта — предложить назвать бумагу; ставку вклада, названную пользователем, повторять можно, своих не называть",
  async run(): Promise<Verdict> {
    const { SYSTEM_PROMPT } = await import("../../lib/prompt");
    const rule = SYSTEM_PROMPT.split("\n").find((l) => /^9\.\s/.test(l)) ?? "";
    const noReport = /отч[её]та (ещё )?нет[^.]*назва/i.test(rule);
    const userRate = /ставк[а-я]* вклада, котор[а-я]* назвал сам пользователь[^.]*можно/i.test(rule);
    const detail = `правило 9: ${q(rule, 400)} | без отчёта → назвать бумагу: ${noReport}; ставку вклада от пользователя повторять можно: ${userRate}`;
    return noReport && userRate ? pass(detail) : fail(detail);
  },
};

/* ═════════════════════════════ дайджест ═════════════════════════════ */

const AST0_DIR = path.join(REPO_ROOT, "packages", "engine", "audit-fixtures", "sfo_ast0");
async function ast0(inputs: ReportInputs = {}): Promise<BondReportT> {
  const meta = JSON.parse(fs.readFileSync(path.join(AST0_DIR, "meta.json"), "utf8")) as { query: string; todayIso: string; inputs?: ReportInputs };
  const res = await build(meta.query, { ...(meta.inputs ?? {}), ...inputs }, { fromSnapshotDir: AST0_DIR, todayIso: meta.todayIso });
  if (res.kind !== "report") throw new Error(`audit-fixtures/sfo_ast0: ожидался kind=report, получено ${res.kind}`);
  return res.report;
}
interface GoldenCases { todayIso: string; cases: Array<{ name: string; query: string; inputs?: ReportInputs; todayIso?: string }> }
async function golden(name: string): Promise<BondReportT> {
  const meta = readJson<GoldenCases>("packages/engine/golden/cases.json");
  const c = meta.cases.find((x) => x.name === name);
  if (!c) throw new Error(`golden-кейс ${name} не найден в cases.json`);
  const res = await build(c.query, c.inputs ?? {}, {
    fromSnapshotDir: path.join(REPO_ROOT, "packages", "engine", "golden", "snapshots", name), todayIso: c.todayIso ?? meta.todayIso,
  });
  if (res.kind !== "report") throw new Error(`golden ${name}: ожидался kind=report, получено ${res.kind}`);
  return res.report;
}
const strs = (o: unknown): string[] =>
  typeof o === "string" ? [o] : Array.isArray(o) ? o.flatMap(strs) : o && typeof o === "object" ? Object.values(o).flatMap(strs) : [];
/** Число в строке целиком, в записи движка («34,01») и с точкой; «4,01» не находится внутри «34,01» */
const hasNum = (s: string, x: number) => [x.toFixed(2).replace(".", ","), x.toFixed(2)].some((v) => new RegExp(`(?<![\\d.,])${v.replace(".", "\\.")}(?!\\d)`).test(s));
const JARGON = /гейт|сетк[аи]\s+комисси|контроль\s*:/i;
const OURS = /наш[аеу]? доходност/i;
const EXCH = /биржев[а-я]* доходност/i;

const UK9: Check = {
  id: "U.K9", wp: "U", kind: "fixture", guard: true,
  title: "digestReport при гейте контроля (build(sfo_ast0)): одна фраза с Δ 18,27 без собственного расчёта 34,01 и жаргона; «чья доходность показана» совпадает с yield_source (цена биржи, цена пользователя 100%), а при доходе за период (синтетический period_income) фраза об этом молчит — в yield_line движок говорит «биржевую»; без гейта (live_rolf_p26) — warnings движка целиком",
  async run(): Promise<Verdict> {
    const rows: Array<[boolean, string]> = [];
    // wantPhrase — что фраза в warnings говорит о том, чья доходность («—» — ничего), по умолчанию то же, что yield_source
    const judge = (label: string, r: BondReportT, wantSrc: string, wantPhrase = wantSrc) => {
      const d = digestReport(r);
      const own = r.yield.own_control_pct;
      const all = strs(d);
      const ownIn = own != null && all.some((s) => hasNum(s, own));
      const jargon = all.some((s) => JARGON.test(s));
      const w0 = d.warnings[0] ?? "";
      const diff = r.yield.control_diff_pp;
      const diffIn = diff != null && hasNum(w0, diff);
      const phraseSrc = OURS.test(w0) ? "наш расчёт по графику выплат" : EXCH.test(w0) ? "Мосбиржа" : "—";
      const ok = r.yield.control_failed === true && d.control_failed === true && d.yield_source === wantSrc && phraseSrc === wantPhrase
        && d.warnings.filter((s) => /контрол/i.test(s)).length === 1 && /не сош[её]л/i.test(w0) && diffIn && !ownIn && !jargon;
      rows.push([ok, `${label}: control_failed=${show(d.control_failed)}, yield_source=${q(d.yield_source, 40)} (ожид. ${q(wantSrc, 40)}), во фразе — ${q(phraseSrc, 40)} (ожид. ${q(wantPhrase, 40)}); ` +
        `Δ=${show(diff)} во фразе: ${diffIn}; own_control_pct=${show(own)} в дайджесте: ${ownIn ? "ЕСТЬ" : "нет"}; жаргон: ${jargon ? "ЕСТЬ" : "нет"}; warnings=${q(d.warnings, 260)}`]);
    };
    const base = await ast0();
    judge("sfo_ast0 (цена биржи)", base, "Мосбиржа");
    judge("sfo_ast0, offer_price_pct=100", await ast0({ offer_price_pct: 100 }), "наш расчёт по графику выплат");
    // доход за период до близкого колла (period_income) при used_as_main=true: снимка ISS с коротким коллом под гейтом нет — тот же отчёт с kind.
    // В блоке наш доход за период и доходность к погашению, а фраза движка в yield_line — «только биржевую» (recheck 13.10): чья — не утверждаем
    const synth = JSON.parse(JSON.stringify(base)) as BondReportT;
    (synth.yield as { kind: string }).kind = "period_income";
    judge("sfo_ast0 синтетически kind=period_income, used_as_main=true", synth, "наш расчёт по графику выплат", "—");
    // без гейта: строки движка целиком (D.2, секция 1)
    const p26 = fixture<BuildResultT>("live_rolf_p26.json");
    if (p26.kind !== "report") throw new Error("live_rolf_p26: ожидался kind=report");
    const dp = digestReport(p26.report);
    const same = dp.warnings.length > 0 && JSON.stringify(dp.warnings) === JSON.stringify(p26.report.diagnostics.warnings);
    rows.push([same, `live_rolf_p26 (без гейта): warnings дайджеста ${same ? "=" : "≠"} diagnostics.warnings ${q(p26.report.diagnostics.warnings, 120)}`]);
    const detail = rows.map(([ok, s]) => `${ok ? "ок" : "НЕ ок"} ${s}`).join(" | ");
    return rows.every(([ok]) => ok) ? pass(detail) : fail(detail);
  },
};

const UK10: Check = {
  id: "U.K10", wp: "U", kind: "fixture", guard: true,
  title: "digestReport.yield_source на golden-снимках: ОФЗ 26238 → «Мосбиржа»; флоатер cherk1p7, доход за период cherk2p2, CNY cherk2p1 → «наш расчёт по графику выплат»; нет цены cherk1p6 → null",
  async run(): Promise<Verdict> {
    const want: Array<[string, string | null]> = [
      ["ofz26238", "Мосбиржа"], ["cherk1p7", "наш расчёт по графику выплат"], ["cherk2p2", "наш расчёт по графику выплат"],
      ["cherk2p1", "наш расчёт по графику выплат"], ["cherk1p6", null],
    ];
    const rows = [];
    for (const [name, w] of want) {
      const r = await golden(name);
      const got = digestReport(r).yield_source;
      rows.push({ name, w, got, kind: r.yield.kind, ok: got === w });
    }
    const detail = rows.map((r) => `${r.ok ? "ок" : "НЕ ок"} ${r.name} (yield.kind=${r.kind}): ${show(r.got)} (ожид. ${show(r.w)})`).join("; ");
    return rows.every((r) => r.ok) ? pass(detail) : fail(detail);
  },
};

/* ═════════════════════════════ сквозной путь гейта (дочерний процесс) ═════════════════════════════ */

/** Реплики для гейта на правилах без отчёта и допустимые карточки (null — гейт карточку термина не показал) */
const GATE_ROWS: Array<[said: string, allowed: Array<string | null>]> = [
  ["Банк вместо вклада предлагает облигации. Что такое купон?", [null, "coupon"]],
  ["в отчёте написано НКД, а что такое купон?", [null, "coupon"]],
  ["у облигации есть оферта, а что такое дефолт?", [null]],
  ["что такое бессрочная облигация с коллом", [null]],
  ["Чем облигация отличается от депозита?", [null, "deposit"]],
  // recheck 13.10: служебное слово после «что значит/объясни» — до правки карточка «Оферта» и ход закрыт шаблоном
  ["что значит для облигации с офертой дефолт эмитента?", [null]],
  ["Объясни, чем опасен дефолт для облигации с офертой", [null]],
  ["что значит при оферте технический дефолт?", [null]],
  ["в отчёте написано НКД, а что значит у облигации купон?", [null, "coupon"]],
  // рассказ короче MAX_PARSE_LEN гейта и без тире — доходит до findTerm (длинный гейт сам отдаёт модели, его findTerm — в U.K11)
  ["Мне в банке рассказывали про облигации застройщика, говорили, что у них есть оферта и амортизация, что это надёжнее вклада. " +
    "Я мало что понял. Что значит у облигации купон?", [null, "coupon"]],
  // ревью 3: термин перед вопросом, «это что», налоговый вычет, вопрос не только о термине, оценка
  ["Дюрация что значит у облигации?", [null, "duration"]],
  ["НКД понятно, а купон это что?", [null, "coupon"]],
  ["расскажи про налоговый вычет", [null]],
  ["Менеджер рассказывал про облигации с офертой, что это надёжнее вклада. Что такое НКД? И стоит ли их брать?", [null]],
  ["Объясни дюрацию. Ты уверен, что она у этой бумаги большая?", [null]],
  ["дюрация 3 года это хорошо?", [null]],
  // recheck2 13.10: «что за» после «объясни», спред при ОФЗ, «Объясни, это X?» — до правки карточка и шаблон «назовите бумагу»
  ["Объясни, что за ОФЗ", [null]],
  ["Расскажи, что это за купон", [null]],
  ["Что значит спред между облигацией и ОФЗ?", [null, "gspread"]],
  ["Объясни, это облигация?", [null]],
];
interface GateRow { said: string; handled: boolean; intent: string | null; source: string | null; card: string | null; cardTitle: string | null; text: string }
interface GateOut { rows: GateRow[]; blocked: string[] }

async function childGate(): Promise<GateOut> {
  const nm = (await import("node:module")) as unknown as { registerHooks?: (hooks: unknown) => unknown };
  if (typeof nm.registerHooks !== "function") throw new Error("node:module.registerHooks недоступен — нужен Node ≥ 22.15");
  nm.registerHooks({
    resolve(spec: string, ctx: unknown, next: (s: string, c: unknown) => unknown) {
      if (spec === "server-only") return { url: "data:text/javascript,", shortCircuit: true, format: "module" };
      return next(spec, ctx);
    },
  });
  const blocked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    blocked.push(u);
    throw new Error(`аудит U-K: сеть запрещена (fetch ${u.slice(0, 100)})`);
  }) as typeof fetch;
  process.env.JEV_ENABLED = "0";
  const gate = await import("../../lib/gate");
  const rows: GateRow[] = [];
  for (const [said] of GATE_ROWS) {
    const parts: Record<string, unknown>[] = [];
    const w = { write: (p: Record<string, unknown>) => { parts.push(p); }, merge: () => {} } as unknown as Parameters<typeof gate.runGate>[0];
    const s: ChatSession = { id: "audit-uk", query: null, result: null, pendingInputs: null, userMessages: 0,
      usage: { input: 0, output: 0, cost: 0, calls: 0, jev: 0 }, touched: Date.now() };
    const out = await gate.runGate(w, s, said, null);
    const card = parts.find((p) => p.type === "tool-output-available" && (p.output as { found?: boolean } | undefined)?.found)?.output as
      { id?: string; title?: string } | undefined;
    rows.push({
      said, handled: out.handled, intent: out.decision?.intent ?? null, source: out.decision?.source ?? null,
      card: card?.id ?? null, cardTitle: card?.title ?? null,
      text: parts.filter((p) => p.type === "text-delta").map((p) => String(p.delta ?? "")).join("").replace(/\s+/g, " ").trim(),
    });
  }
  return { rows, blocked };
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(THIS_FILE); } catch { return false; }
}
if (isMain() && process.argv.includes("--scenario")) {
  childGate().then(
    (out) => new Promise<void>((res) => process.stdout.write(MARK + JSON.stringify(out) + "\n", () => res())).then(() => process.exit(0)),
    (e) => { console.error(e); process.exit(3); },
  );
}

function runChild(): GateOut {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "so-audit-uk-usage-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1", SO_USAGE_DIR: dir, SO_USAGE_LOG: "0", SO_QUIET: "1", JEV_ENABLED: "0" };
    for (const k of ["SO_OFFLINE", "TYPESAFE_URL", "TYPESAFE_API_KEY", "JEV_DECISIONS_URL", "MOCK_LLM", "JEV_THRESHOLD", "JEV_PROVIDER",
      "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "LLM_PROVIDER", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
    const r = spawnSync(process.execPath, ["--import", "tsx", THIS_FILE, "--scenario", "gate"], {
      cwd: WEB_ROOT, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    const line = String(r.stdout ?? "").split("\n").reverse().find((l) => l.startsWith(MARK));
    if (r.status !== 0 || !line) {
      const tail = String(r.stderr ?? "").trim().split("\n").slice(-8).join(" | ");
      throw new Error(`сценарий гейта U-K: exit=${r.status} signal=${r.signal ?? "-"}; stderr: ${tail || "(пусто)"}`);
    }
    return JSON.parse(line.slice(MARK.length)) as GateOut;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const UK2: Check = {
  id: "U.K2", wp: "U", kind: "fixture", guard: true,
  title: "Гейт на правилах (JEV_ENABLED=0, без отчёта): «Банк вместо вклада предлагает облигации. Что такое купон?», «…НКД, а что такое купон?», «Дюрация что значит у облигации?», «НКД понятно, а купон это что?», рассказ с офертой и «Что значит у облигации купон?» — не чужая карточка (handled=false или спрошенный термин); «…а что такое дефолт?», «что значит при оферте технический дефолт?», «расскажи про налоговый вычет», «Что такое НКД? И стоит ли их брать?», «дюрация 3 года это хорошо?», «Объясни, что за ОФЗ», «Объясни, это облигация?» — отвечает модель; «Что значит спред между облигацией и ОФЗ?» — не «Спред в стакане»",
  run(): Verdict {
    const o = runChild();
    const res = o.rows.map((r) => {
      const allowed = GATE_ROWS.find(([s]) => s === r.said)?.[1] ?? [];
      return { ...r, allowed, ok: allowed.includes(r.card) };
    });
    const bad = res.filter((r) => !r.ok);
    const detail = `${res.length - bad.length}/${res.length} ок | ` +
      res.map((r) => `${q(r.said, 70)} → ${r.intent ?? "—"} (${r.source ?? "—"}), handled=${r.handled}, карточка ${r.card ? `${r.card} ${q(r.cardTitle, 50)}` : "нет"} ` +
        `(допустимо: ${r.allowed.map((a) => a ?? "нет").join("/")})${r.ok ? "" : " — ЧУЖАЯ"}${r.text ? `; текст ${q(r.text, 70)}` : ""}`).join("; ") +
      (o.blocked.length ? ` | ВНИМАНИЕ: заблокированные обращения в сеть: ${o.blocked.slice(0, 3).join("; ")}` : "");
    return bad.length === 0 && o.rows.length === GATE_ROWS.length ? pass(detail) : fail(detail);
  },
};

export const checks: Check[] = [UK1, UK2, UK3, UK4, UK5, UK6, UK7, UK8, UK9, UK10, UK11, UK12, UK13];
