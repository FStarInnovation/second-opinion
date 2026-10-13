/**
 * Два decision-пункта на Jev (TypeSafe, через OpenRouter Decisions API):
 *   1. routeMessage — маршрут реплики до LLM: при уверенности ≥ порога инструмент вызывается напрямую, без модели.
 *   2. parsePromise — что за величину назвал пользователь в «обещали»: годовая / купон / за срок / за период.
 * Без ключа или при JEV_ENABLED=0 работает правило-фоллбэк (регулярки) — детерминированно, для тестов и демо без сети.
 * Вопросы (criteria) — на русском: по тестам на раскрытии 29–30.09 русские инструкции работают не хуже английских.
 * Здесь же детерминированный разбор реплик для гейта (lib/gate.ts). Принцип: разбор ТОЧНЫЙ, полнота не важна — число берётся только
 * по узкому шаблону, любое сомнение — parseInputs.unsure, и вся реплика уходит модели; сложная реплика (isComplex) не разбирается.
 */
import { CONFIG } from "@so/engine/config";

export const INTENTS = {
  check_security: "Пользователь называет конкретную бумагу, которую надо проверить: ISIN (RU… / SU…), название выпуска или эмитента, регистрационный номер, номер программы, ссылку на страницу бумаги. Пример: «проверь РОЛЬФ 1Р07», «RU000A10ASE2», «что скажешь про ВЭБ.РФ 21».",
  set_promised: "Пользователь сообщает, какую доходность или ставку ему пообещал продавец, без новой бумаги. Пример: «обещали 26%», «менеджер говорит 18 годовых», «в презентации 22%».",
  set_position: "Пользователь называет сумму, которую планирует вложить. Пример: «хочу вложить миллион», «сумма 500 тысяч», «на 2 млн».",
  set_commission: "Пользователь называет комиссию брокера. Пример: «комиссия 0,3%», «брокер берёт 0,05».",
  set_price: "Пользователь называет цену, по которой ему предлагают купить бумагу, в процентах от номинала или в рублях. Пример: «предлагают по 98,5», «цена 1010 рублей».",
  pick_variant: "Пользователь выбирает один выпуск из показанного списка. Пример: «второй», «тот что 2P1», «берём первый».",
  explain_term: "Пользователь спрашивает, что означает термин или метрика: НКД, оферта, колл, дюрация, флоатер, спред, G-спред, амортизация, листинг, Truth Score, worst-case, налог. Пример: «что такое НКД», «объясни оферту».",
  ask_about_report: "Пользователь задаёт вопрос по уже показанному отчёту, требующий объяснения: почему такой балл, что значит этот риск, стоит ли держать до оферты, чем отличается от депозита. Нужен развёрнутый ответ модели.",
  out_of_scope: "Сообщение не о проверке облигации: приветствие, болтовня, другие активы (акции, крипта, недвижимость), просьба дать совет что купить, что-то постороннее.",
} as const;
export type Intent = keyof typeof INTENTS;

export const PROMISE_KINDS = {
  annual_yield: "Названа годовая доходность или ставка в процентах годовых: «26% годовых», «доходность 18%», «под 20 процентов». Если единица не указана, по умолчанию это годовые проценты.",
  coupon_rate: "Названа именно ставка купона, а не доходность: «купон 15%», «купонная ставка 12,5».",
  total_for_term: "Назван доход за весь срок, а не в годовых: «заработаете 30% за два года», «доход 15% к погашению за весь срок».",
  per_period: "Названа ставка за период короче года: «2% в месяц», «5% за квартал».",
  not_a_promise: "Число не относится к обещанной доходности: это сумма, цена, срок или что-то иное.",
} as const;
export type PromiseKind = keyof typeof PROMISE_KINDS;

export interface RouteDecision {
  intent: Intent;
  confidence: number;
  probabilities: Partial<Record<Intent, number>>;
  mentionsSecurity: number; // Noul: есть ли в тексте идентификатор бумаги
  source: "jev" | "rules";
  usage?: { inputTokens?: number; cost?: number };
  jevError?: string; // источник rules при включённом Jev: почему не Jev (HTTP-код, таймаут) — без ключа
}

export interface PromiseDecision {
  kind: PromiseKind;
  confidence: number;
  value: number | null;        // число из текста
  annualized: number | null;   // что подставлять в promised_pct (годовые) — null, если нельзя привести
  source: "jev" | "rules";
}

const THRESHOLD = Number(process.env.JEV_THRESHOLD ?? 0.8);
export const jevThreshold = () => THRESHOLD;

/**
 * Два бэкенда с одинаковым форматом запроса (state + questions) и почти одинаковым ответом:
 *   typesafe   — прямой API TypeSafe: POST https://api.typesafe.ai/v1/systemone, ключ TYPESAFE_API_KEY (apikey_…), model jev-latest
 *   openrouter — OpenRouter Decisions API: POST /api/alpha/decisions, ключ OPENROUTER_API_KEY, model typesafe/jev-1.13
 * JEV_PROVIDER выбирает принудительно; иначе — тот, для которого есть ключ (TypeSafe в приоритете: это его модель).
 */
export type JevProvider = "typesafe" | "openrouter";
export function jevProvider(): JevProvider | null {
  if (process.env.JEV_ENABLED === "0" || process.env.MOCK_LLM === "1") return null;
  const forced = process.env.JEV_PROVIDER as JevProvider | undefined;
  if (forced === "typesafe" && process.env.TYPESAFE_API_KEY) return "typesafe";
  if (forced === "openrouter" && process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.TYPESAFE_API_KEY) return "typesafe";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return null;
}
export const jevEnabled = () => jevProvider() !== null;

/* ───── клиент: один формат запроса, два адреса ───── */
type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: string[] };
type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul?: number; probability?: number } // TypeSafe документирует noul; на всякий случай читаем и probability
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };
interface DecisionResponse { model: string; answers: Record<string, Answer>; usage?: { input_tokens?: number; output_tokens?: number; cost?: number } }

const ENDPOINTS: Record<JevProvider, { url: string; key: () => string | undefined; model: string }> = {
  typesafe: { url: process.env.TYPESAFE_URL ?? "https://api.typesafe.ai/v1/systemone", key: () => process.env.TYPESAFE_API_KEY, model: process.env.JEV_MODEL ?? "jev-latest" },
  openrouter: { url: process.env.JEV_DECISIONS_URL ?? "https://openrouter.ai/api/alpha/decisions", key: () => process.env.OPENROUTER_API_KEY, model: process.env.JEV_MODEL_OPENROUTER ?? "typesafe/jev-1.13" },
};

export async function jevDecide(state: Record<string, unknown>, questions: Record<string, Question>, signal?: AbortSignal): Promise<DecisionResponse> {
  const p = jevProvider();
  if (!p) throw new Error("Jev отключён");
  const ep = ENDPOINTS[p];
  const res = await fetch(ep.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ep.key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: ep.model, state, questions }),
    signal: signal ?? AbortSignal.timeout(Number(process.env.JEV_TIMEOUT_MS ?? 2500)),
  });
  if (!res.ok) throw new Error(`Jev ${p} HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  return (await res.json()) as DecisionResponse;
}
const noulOf = (a: Answer | undefined) => (a?.type === "noul" ? a.noul ?? a.probability ?? 0 : 0);

/* ───── числа и разметка текста ───── */
const ISIN_RE = /\b(RU|SU)[0-9A-Z]{10}\b/i;
const NUM_RE = /(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d+))?/g;
const numOf = (m: RegExpMatchArray) => Number(m[1].replace(/[  ]/g, "") + (m[2] ? "." + m[2] : ""));
export const numbersIn = (text: string): number[] => [...text.matchAll(NUM_RE)].map(numOf).filter(Number.isFinite);
const lower = (text: string) => text.toLowerCase().replace(/ё/g, "е");
/** Заменить участки пробелами той же длины — позиции остального текста не сдвигаются */
const blank = (t: string, spans: Array<[number, number]>) => spans.reduce((s, [a, b]) => s.slice(0, a) + " ".repeat(Math.max(0, b - a)) + s.slice(b), t);

/** Сложная реплика правилами не разбирается — её целиком решает модель: длинная (письмо, текст предложения), с переводом строки или тире */
export const MAX_PARSE_LEN = 300;
export const isComplex = (text: string) => text.length > MAX_PARSE_LEN || /[\n\r—–]|\s-\s/.test(text);

/** Идентификаторы (ISIN, регномер, код выпуска «1Р07», «ОФЗ-26243-ПД», ссылка) — слово с цифрами и буквами, кроме числа с единицей («2млн», «15%», «2-х»), — пробелами */
const NUM_WITH_UNIT = /^\d+(?:[.,]\d+)?(?:%.*|(?:к|т|млн|млрд|тыс[а-я]*|т\.?р|руб[а-я]*|р|₽)\.?(?:руб[а-я]*|р|₽)?\.?|-(?:ти|х|ух|ех|й|го|му|м|ми))$/;
const stripIds = (t: string) => t.replace(/\S+/g, (tok) => {
  const [, l, core, r] = tok.match(/^([«"'(]*)(.*?)([»"'),.;:!?]*)$/) ?? ["", "", tok, ""];
  return /\d/.test(core) && /[a-zа-я]/.test(core) && !NUM_WITH_UNIT.test(core) ? l + " ".repeat(core.length) + r : tok;
});

/** Единица за числом: «млн», «тыс», «т.р.»; «к» и «т» — только вплотную («300к») */
const UNIT_AFTER = /^(?:\s*(?:млн|миллион[а-я]*|млрд|миллиард[а-я]*|тыс[а-я]*|т\.\s?р)\.?|[кт](?![а-я]))/;
const RUB_AFTER = /^\s*(?:руб[а-я]*|р\.|р(?![а-я])|₽)/;
/** Срок или счёт за числом («на 2 года», «за 2 сделки», «100 облигаций») */
const TERM_AFTER = /^\s*(?:год|года|году|лет|г\.|мес[а-я]*|дн[еяи][а-я]*|день|недел[а-я]*|квартал[а-я]*|сделк[а-я]*|раз|раза|штук[а-я]*|шт|лот[а-я]*|бумаг[а-я]*|облигаци[а-я]*|акци[а-я]*)(?![а-я])/;
/** Номер ОФЗ — ровно пять цифр: «ОФЗ 262381» (опечатка) — не «ОФЗ 26238»; OFZ_ANY — и с опечаткой (названа бумага, не просьба о совете) */
const OFZ_NUM = /(?:^|[^а-я])(?:офз|ofz)[\s-]*(?:п[дкв]|ин|ад)?[\s-]*(\d{5})(?!\d)/;
const OFZ_ANY = /(?:^|[^а-я])(?:офз|ofz)[\s-]*(?:п[дкв]|ин|ад)?[\s-]*\d{5}/;
const CURRENCY = /[$€£¥]|(?<![а-я])(?:долл|бакс|евро|юан|фунт|франк|валют|тенге|гривн|лир|usd|eur|cny|у\.\s?е|уе(?![а-я]))/;
const HYPOTHETICAL = /(?<![а-я])(?:если|бы|допустим|предположим|вдруг)(?![а-я])/;
interface Num { value: number; start: number; end: number; unit: boolean; rub: boolean; money: boolean; term: boolean; ofz: boolean }
/** Числа реплики (нижний регистр, без идентификаторов); money — рубли: с единицей или от 1000, кроме года («в 2027») и номера ОФЗ (пять цифр после «ОФЗ») */
function scanNums(t: string): Num[] {
  const out: Num[] = [];
  for (const m of t.matchAll(NUM_RE)) {
    const start = m.index ?? 0;
    if (start > 0 && /[a-zа-я0-9.,]/.test(t[start - 1])) continue;
    const u = t.slice(start + m[0].length).match(UNIT_AFTER);
    const end = start + m[0].length + (u?.[0].length ?? 0);
    const after = t.slice(end);
    const v = numOf(m);
    const year = !u && Number.isInteger(v) && v >= 1900 && v <= 2100 && !RUB_AFTER.test(after);
    const ofz = !u && /^\d{5}$/.test(m[0]) && /(?:офз|ofz)[\s-]*(?:п[дкв]|ин|ад)?[\s-]*$/.test(t.slice(Math.max(0, start - 12), start));
    const mult = !u ? 1 : /млн|миллион/.test(u[0]) ? 1e6 : /млрд|миллиард/.test(u[0]) ? 1e9 : 1e3;
    out.push({ value: u ? Math.round(v * mult) : v, start, end, unit: !!u, rub: RUB_AFTER.test(after), money: !!u || (v >= 1000 && !year && !ofz), term: TERM_AFTER.test(after), ofz });
  }
  return out;
}

/* ───── сумма вложения ───── */
/** Сумма словами без цифр («миллион», «двух миллионов») — правилами не взять */
const MONEY_WORD = /(?<![а-я])(?:млн|млрд|миллион|миллиард|тыс)/;
/** Опора суммы прямо перед числом: глагол вложения в первом лице («вложу», «хочу вложить», «куплю на (сумму)») или «на (сумму)» в начале реплики */
const ANCHOR_BEFORE = new RegExp("(?:(?:^|[^а-я])(?:(?:хочу|хотим|планирую|готов[аы]?|собираюсь|буду|могу)\\s+" +
  "(?:вложить|инвестировать|купить|потратить|положить|взять|закинуть)|вложу|вкладываю|инвестирую|куплю|покупаю|беру|возьму|положу|закину|потрачу)" +
  "(?:\\s+на)?|^\\s*(?:(?:а|ну|и|давай)\\s+)?на)(?:\\s+сумму)?\\s*$");
/** За суммой (и «руб»): конец, знак препинания или предлог («вложу 2 млн в ОФЗ»); «больше», «ещё», «каждый месяц», «тенге» — не сумма вложения */
const SUM_NEXT = /^\s*(?:$|[,.;:!?)]|(?:в|во|на|под|и|а|но|сейчас|сразу)(?![а-я]))/;
/** Отказ или прошлое («не вложу», «не хочу», «передумал», «вложил», «хотела купить») — не сумма будущего вложения */
const SUM_NOT_NOW = /(?<![а-я])(?:не|передумал[а-я]*|(?:вложил|вкладывал|инвестировал|купил|покупал|потратил|положил|взял|брал|закинул|хотел|планировал|собирал)(?:а|и|о|ся|ась|ись)?)(?![а-я])/;
/** Предлог где угодно в реплике (сумма вырезана) — только к этой бумаге («в эту», «в облигации», «в ОФЗ»), «на сумму», «на 3 года», «под 26%»; «в депозит», «на вклад», «в акции», «в другую», «за месяц» — модели */
const SUM_ELSEWHERE = /(?<![а-я])(?:в|во|на|за|под)\s+(?=[а-яa-z0-9])(?!(?:эт[а-я]*|не[ей]|него|сумм[а-я]*|выпуск[а-я]*|бумаг[а-я]*|облигаци[а-я]*|офз)(?![а-я])|(?<=на\s+)\d+\s*(?:год|года|лет)(?![а-я])|(?<=под\s+)\d)/;
/** Ассистент спрашивал сумму — только шаблоны гейта (askText, SEPARATELY), не вопрос модели о минимальной сумме продавца */
const ASKED_SUM = /Напишите сумму|Сумму и комиссию напишите/;
/** Вся реплика — одна сумма («2 млн», «300к», «сумма 500 тысяч») */
const WHOLE_BEFORE = /^\s*(?:(?:сумма|сумму|ну|а|давай|итого|всего)\s*[:,]?\s*)?$/;
/** Условия продавца, доля капитала, доход, добавка и периодичность — где угодно в реплике: сумму вложения правилами не брать */
const NOT_OWN_SUM = new RegExp("(?<![а-я])(?:выпуск|за[йе]м|эмисси|миним|максим|мин\\.|макс\\.|номинал|оборот|выручк|капитал|половин|заработ|прибыл" +
  "|больш|меньш|ещ[её]|дополнительн|сверх|кажд|ежекварт|квартал|недел|ежедневн|купон|ежемесячн|ежегодн|доход(?!ност)|лот(?:а|ов|ы|е|ом)?(?![а-я])|цен(?:а|у|ы|е|ой)(?![а-я])|част(?:ь|и|ью|ично)(?![а-я])" +
  "|трет(?:ь|и|ью)(?![а-я])|долг(?:а|у|ом|е|и|ов)?(?![а-я])|(?:по|из|от)\\s*\\d|в\\s+(?:месяц|год|году|день)(?![а-я]))");
interface MoneyScan { value: number | null; span: [number, number] | null; seen: boolean; unsure: boolean }
/**
 * Сумма вложения — единственное денежное число, с единицей, при опоре ANCHOR_BEFORE и SUM_NEXT или вся реплика — эта сумма (askedSum:
 * ассистент спрашивал сумму). Иначе любое денежное число или сумма словами — unsure («у меня 3 млн, вложу 1 млн», «2 000 000», «минимальная
 * сумма 100 тыс», «половину», «из 5 млн», «по 1000 рублей», «2 тыс облигаций», «на 500 тыс больше», валюта, «не вложу», «вложил», «в депозит»).
 */
function moneyScan(t: string, askedSum: boolean): MoneyScan {
  const nums = scanNums(t).filter((n) => n.money);
  const words = MONEY_WORD.test(blank(t, nums.map((n): [number, number] => [n.start, n.end])));
  if (!nums.length && !words) return { value: null, span: null, seen: false, unsure: false };
  const n = nums[0];
  const before = t.slice(0, n?.start ?? 0), after = t.slice(n?.end ?? 0), rest = after.replace(RUB_AFTER, "");
  const ok = nums.length === 1 && !words && n.unit && !NOT_OWN_SUM.test(t) && !CURRENCY.test(t) && !SUM_NOT_NOW.test(t) && !SUM_ELSEWHERE.test(blank(t, [[n.start, n.end]])) &&
    ((ANCHOR_BEFORE.test(before) && SUM_NEXT.test(rest)) || (askedSum && WHOLE_BEFORE.test(before) && /^\s*\.?[.!]?\s*$/.test(rest)));
  return ok ? { value: n.value, span: [n.start, n.end + (after.match(RUB_AFTER)?.[0].length ?? 0)], seen: true, unsure: false }
    : { value: null, span: null, seen: true, unsure: true };
}
/** Сумма вложения по тем же правилам (вся реплика-сумма — без требования контекста); сомнительная — null */
export function moneyIn(text: string): number | null {
  if (isComplex(text)) return null;
  const t = stripIds(lower(text));
  return moneyScan(blank(t, commissionScan(t).spans), true).value;
}

/* ───── комиссия брокера ───── */
/** Ключ: «комисси…» (и «коммиссия», «камиссия», «komissiya»), «брокер (Тинькофф) берёт», «тариф» */
const K_KEY_SRC = "к[оа]м+и[сc]+и[а-я]*|kom+is+i[a-z]*|брокер[а-я]*(?:\\s+[а-яa-z]+)?\\s+(?:берет|берут|брал[а-я]*|взима[а-я]*)|тариф[а-я]*";
const K_KEY = new RegExp(K_KEY_SRC, "g");
/** Поправка, выбор, вилка, надбавка или плата за период в окне («не 0,3», «0,3 или 0,05», «от 0,05», «0,3 + 0,05», «0,3% в год») */
const K_DOUBT = /(?<![а-я])(?:не|или|либо|плюс|годов[а-я]*|ежегодн[а-я]*|ежемесячн[а-я]*)(?![а-я])|\+|(?<![а-я])(?:от|до)\s*\d|\d\s*[-–/]\s*\d|в\s+(?:год|месяц)/;
/** Не комиссия брокера за сделку (в окне или до конца фразы): управляющего, за вывод, при погашении, за обслуживание, депозитария, банка, биржи (Мосбиржи), за круг «покупка + продажа» */
const K_OTHER = /(?<![а-я])(?:управл|вывод|погашени|обслуживан|депозитар|банк|(?:мос)?бирж)|за\s+круг|покупк[а-я]*\s+и\s+продаж|туда\s+и\s+обратно|в\s+обе\s+сторон/;
/** За числом комиссии: «%», «процент», конец или знак препинания, «за сделку» / «с оборота» / «от суммы»; «за 2 сделки», «2 руб», «2 евро» — не комиссия в % */
const K_NEXT = /^\s*(?:%|процент|$|[,.;!?)]|(?:за|от|с)\s+(?:сделк|оборот|сумм))/;
interface KScan { value: number | null; seen: boolean; unsure: boolean; spans: Array<[number, number]> }
/**
 * Комиссия — одно число 0–kMax (опц. %) в окне до трёх слов после ключа (до запятой или точки после числа), «ноль» — 0. Два числа,
 * K_DOUBT, чужая комиссия (K_OTHER), число вне 0–kMax или не K_NEXT за ним («2 руб», «2 евро», «за 2 сделки»), две разные комиссии — unsure. spans (ключ с окном) сумма и обещание не видят.
 */
function commissionScan(t: string): KScan {
  const vals = new Set<number>();
  const spans: Array<[number, number]> = [];
  let unsure = false;
  for (const k of t.matchAll(K_KEY)) {
    const from = (k.index ?? 0) + k[0].length;
    let w = t.slice(from).match(/^\S*(?:\s+\S+){0,3}/)?.[0] ?? "";
    const d = w.search(/\d|ноль|нол[ья]|нулев/);
    const stop = d < 0 ? -1 : w.slice(d).search(/[,;!?.](?=\s|$)/);
    if (stop >= 0) w = w.slice(0, d + stop);
    spans.push([k.index ?? 0, from + w.length]);
    const nums = [...w.matchAll(NUM_RE)];
    const doubt = K_DOUBT.test(w) || K_OTHER.test(t.slice(k.index ?? 0).split(/[,;!?](?=\s|$)|\.(?=\s|$)/)[0]);
    if (!nums.length) { if (!doubt && /(?<![а-я])(?:ноль|нол[ья]|нулев[а-я]*)(?![а-я])/.test(w)) vals.add(0); continue; }
    const v = numOf(nums[0]);
    const after = t.slice(from + (nums[0].index ?? 0) + nums[0][0].length);
    if (doubt || nums.length > 1 || !(v >= 0 && v <= CONFIG.kMax) || !K_NEXT.test(after)) unsure = true;
    else vals.add(v);
  }
  if (vals.size > 1) unsure = true;
  return { value: !unsure && vals.size === 1 ? [...vals][0] : null, seen: unsure || vals.size > 0, unsure, spans };
}

/* ───── обещание ───── */
/** Слова обещания: «обещали», «пообещали», «говорит», «сулят», «в презентации» (не «договор», не «разговор») */
const PROMISE_SRC = "(?<![а-я])(?:по)?обеща|(?<![а-я])говор|сулят|презентац";
const PROMISE_RE = new RegExp(PROMISE_SRC);
/** Маршрут правил без отчёта: голое «говорит N%» — не обещание (кто говорит — не бумага) */
const ROUTE_PROMISE = /(?<![а-я])(?:по)?обеща|(?<![а-я])говор[а-я]*,?\s+(?:что\s+)?(?:будет|доходност|заработа)|сулят|презентац/;
/** «под 26%» — обещание, только если во фразе глагол продавца и нет банка, вклада, кредита, счёта («в банке дают под 18%», «друг купил под 30%» — нет) */
const UNDER_PCT = /(?<![а-я])под\s*\d+(?:[.,]\d+)?\s*(?:%|процент)/;
const SELLER = /(?<![а-я])(?:предлага|предложи|продают|(?:по)?обещ)/;
const BANKISH = /(?<![а-я])(?:банк|вклад(?:а|у|ом|е|ы|ов)?(?![а-я])|депозит|кредит|ипотек|накопит|сч[её]т)/;
/** Надбавка к ставке («КС + 2%», «ставку ЦБ плюс 3%», «на 3% выше депозита»), ставка кредита («ипотека под 10%») — не обещанная доходность */
const SPREAD = new RegExp("\\+|(?<![а-я])(?:плюс|надбавк[а-я]*|ключев[а-я]*|ключ|кс|ruonia|руони[а-я]*|инфляци[а-я]*|цб|сверх|выше|депозит[а-я]*|вклад(?:а|у|ом|е|ы|ов)?" +
  "|кредит[а-я]*|ипотек[а-я]*|за[йе]м[а-я]*|рассрочк[а-я]*|лизинг[а-я]*|долг(?:а|у|ом|е|и|ов)?)(?![а-я])");
/** Поправка, выбор или граница («обещали не 26%», «до 26%», «не меньше 20%»); ставка на часть срока, после налога, «с лишним» («только первый год», «потом снизят», «чистыми») */
const PROMISE_DOUBT = new RegExp("(?<![а-я])(?:не|или|либо|ниже|больше|меньше|более|менее|минимум|максимум|только|потом|затем|перв[а-я]*|чист[а-я]*|сниз[а-я]*)(?![а-я])" +
  "|(?<![а-я])(?:от|до)\\s*\\d|после\\s+налог|с\\s+лишним");
/** Период при числе («2% в месяц» ×12, «5% за квартал» ×4); слово периода не при числе — к годовым не привести */
const PERIODS: Array<[RegExp, number]> = [[/^(?:(?:в|за|каждый)\s+месяц|ежемесячн)/, 12], [/^(?:(?:в|за|каждый)\s+квартал|ежекварт)/, 4]];
const PERIOD_ANY = /(?<![а-я])мес(?:яц|(?![а-я]))|ежемесячн|квартал|ежекварт|недел|ежедневн|в\s+день|полгод|полугод/;
const ANNUAL = /^(?:годов|в\s+год|за\s+(?:1\s+|один\s+)?год|ежегодн)/;
/** Срок («за 2,5 года», «за пару лет», «в течение 3 лет», «за весь срок»): сразу за числом — доход за срок (переспрос), в другом месте фразы — модели */
const TERM_SRC = "за\\s+(?:весь\\s+)?(?:срок|период)|(?:за|через|в\\s+течение)\\s+(?:\\S+\\s+){1,3}?(?:год|года|лет)(?![а-я])|к\\s+(?:концу|погашению\\s+за)|заработа";
const TERM_AT = new RegExp(`^(?:${TERM_SRC})`), TERM_ANY = new RegExp(TERM_SRC);
const isEnd = (t: string, i: number) => "!?;".includes(t[i]) || (t[i] === "." && (i + 1 >= t.length || /\s/.test(t[i + 1])));
interface PScan { decision: PromiseDecision | null; seen: boolean; unsure: boolean; region: [number, number] | null }
/** Фраза вокруг позиции i: от запятой перед ней (или начала предложения) до конца предложения */
function phraseAt(t: string, i: number): [number, number] {
  let a = i, b = i;
  while (a > 0 && !isEnd(t, a - 1) && !(t[a - 1] === "," && /\s/.test(t[a] ?? ""))) a--;
  while (b < t.length && !isEnd(t, b)) b++;
  return [a, b];
}
/**
 * Обещание — только при словах обещания или «под N%» продавца: числа фразы (phraseAt), кроме сроков, счёта, чисел от 1000 и вырезанной
 * комиссии. Нет числа — обещания нет («обещали много»). Два разных числа («от 18 до 26», «не 26, а 22»), деньги во фразе («заработать
 * 300 тыс»), надбавка или кредит, поправка или граница, ставка на часть срока, период или срок не при числе, число вне 0–100 — unsure.
 */
function promiseScan(t: string): PScan {
  const u = t.search(UNDER_PCT);
  const up = u >= 0 ? t.slice(...phraseAt(t, u)) : "";
  const hits = [t.search(PROMISE_RE), SELLER.test(up) && !BANKISH.test(up) ? u : -1].filter((i) => i >= 0);
  if (!hits.length) return { decision: null, seen: false, unsure: false, region: null };
  const region = phraseAt(t, Math.min(...hits));
  const [a, b] = region;
  const nums = scanNums(t).filter((n) => n.start >= a && n.start < b);
  const cand = nums.filter((n) => !n.money && !n.term && n.value < 1000);
  const doubt: PScan = { decision: null, seen: true, unsure: true, region };
  if (nums.some((n) => n.money)) return doubt;
  if (!cand.length) return { decision: null, seen: false, unsure: false, region };
  const v = cand[0].value;
  const words = t.slice(a, b);
  const after = t.slice(cand[0].end, b).replace(/^\s*(?:%|процент[а-я]*)?\s*/, "");
  if (new Set(cand.map((n) => n.value)).size > 1 || !(v > 0 && v <= 100) || SPREAD.test(words) || PROMISE_DOUBT.test(words)) return doubt;
  const dec = (kind: PromiseKind, annualized: number | null): PScan =>
    ({ decision: { kind, confidence: 0.85, value: v, annualized, source: "rules" }, seen: true, unsure: false, region });
  for (const [re, n] of PERIODS) if (re.test(after)) return dec("per_period", Math.round(v * n * 100) / 100);
  if (ANNUAL.test(after)) return dec("annual_yield", v);
  if (TERM_AT.test(after)) return dec("total_for_term", null);
  if (PERIOD_ANY.test(words) || TERM_ANY.test(words)) return doubt;
  return dec(/купон/.test(words) && !/доходност/.test(words) ? "coupon_rate" : "annual_yield", v);
}

/* ───── все вводы реплики ───── */
/** Названа бумага или эмитент: ISIN, номер ОФЗ или слово с заглавной не в начале предложения («облигацию Самолёт») */
const NOT_NAME = /^(?:офз|ofz|иис|цб|кс|рф|нкд|ндфл|ruonia|isin|мосбирж[а-я]*)$/i;
const namesPaper = (text: string) => ISIN_RE.test(text) || OFZ_ANY.test(lower(text)) || text.split(/[.!?]+(?:\s+|$)/)
  .some((s) => s.split(/[^A-Za-zА-Яа-яЁё]+/).filter(Boolean).slice(1).some((w) => /^[A-ZА-ЯЁ]/.test(w) && !NOT_NAME.test(w)));
/** Запрос похож на бумагу: цифра, латиница или заглавная («Самолёт», «рольф 1р07»), а не «ещё раз» / «риски» / «менеджер» / «облигации» */
export const looksLikePaper = (query: string) => /[0-9A-Za-zА-ЯЁ]/.test(query);
/** Две бумаги или сравнение («Проверь X и Y», «сравни X с ОФЗ 26238», «X или Y»; текст в нижнем регистре) — отчёт по одной бумаге не ответ */
/** Счёт бумаг — и с опечаткой в номере ОФЗ («ОФЗ 262381 и ОФЗ 26238» — две, не одна 26238) */
const manyPapers = (t: string) => (t.match(/(?:ru|su)[0-9a-z]{10}|офз[\s-]*(?:п[дкв]|ин|ад)?[\s-]*\d{5,}/g)?.length ?? 0) > 1 || /сравн|(?<![а-я])(?:или|либо|лучше)(?![а-я])/.test(t);
/** Запрос проверки: ISIN — он сам; иначе реплика без приветствия и глагола (и «облигацию») в начале — до запятой, слов обещания или ввода («Привет! Проверь Самолёт на 2 млн» → «Самолёт») */
const VERB_PREFIX = /^\s*(?:проверь(?:те)?|проверить|посмотри(?:те)?|оцени(?:те)?|разбери(?:те)?|что\s+скажешь\s+(?:про|о|насчет|насчёт)|(?:мне\s+)?(?:предлагают|предложили)(?:\s+купить)?)(?![а-яё])[\s,:]*(?:пожалуйста[\s,]*)?(?:(?:облигаци|бумаг)[а-яё]*\s+)?/i;
const QUERY_END = new RegExp(`[,;:](?=\\s|$)|[!?]|${PROMISE_SRC}|(?<![а-я])(?:под|на)\\s*\\d|(?<![а-я])(?:сумм|комисси|брокер|тариф|у\\s+меня|хочу|вложу|вложить|куплю)` +
  "|(?<![a-zа-я0-9-])\\d+(?:[.,]\\d+)?\\s*(?:млн|млрд|миллион|миллиард|тыс|т\\.р|к(?![а-я])|руб|₽)");
/** Приветствия и вводные перед бумагой: «Привет!», «Здравствуйте,», «Добрый день,», «Пожалуйста,», «Подскажите,», «Слушай,», «Скажи,» */
const INTRO_SRC = "(?:(?:привет|здравствуй(?:те)?|добрый\\s+(?:день|вечер)|доброе\\s+утро|пожалуйста|подскажи(?:те)?|слушай(?:те)?|скажи(?:те)?)(?![а-яё])[\\s,!.:)]*)+";
const INTRO = new RegExp(`^\\s*${INTRO_SRC}`, "i"), INTRO_ONLY = new RegExp(`^${INTRO_SRC}$`, "i");
/** Номер ОФЗ в запросе — «ОФЗ NNNNN» («что с ОФЗ 26238» → «ОФЗ 26238»); запрос из одних вводных слов — пустой (решает модель) */
function paperQuery(text: string): string {
  const isin = text.match(ISIN_RE);
  if (isin) return isin[0].toUpperCase();
  const s = text.replace(INTRO, "").replace(VERB_PREFIX, "");
  const cut = lower(s).search(QUERY_END);
  const q = (cut >= 0 ? s.slice(0, cut) : s).replace(/(?:(?:^|\s+)(?:на|в|по|за|и|а|с|у|мне))+\s*$/i, "").replace(/[\s.—–-]+$/, "").trim();
  const ofz = lower(q).match(OFZ_NUM);
  return ofz ? `ОФЗ ${ofz[1]}` : INTRO_ONLY.test(q) ? "" : q;
}

/**
 * Сумма, комиссия или вложение словами в реплике проверки (после приветствия и глагола проверки): единицы и жаргон («полмиллиона», «1кк»,
 * «1,5 ляма», «на сотку», «на десятку», «косарь»), числительные («на двести»), брокер и тариф («плачу брокеру»), глагол вложения или
 * покупки, «сумма» («вложу меньше», «сумма как раньше») — прошлые сумма и комиссия к такой реплике не переносятся
 */
const CHECK_NAMED = new RegExp(`${K_KEY_SRC}|миллион|миллиард|млн|млрд|тыс|тыщ|₽|(?<![а-я])(?:руб(?:л|\\.|(?![а-я]))|лям|лимон|ляр|ярд|сотк|сотн|сотен` +
  "|косар|кус(?:ок|к)|штук|десятк|двадцатк|полтинник|пятихат|брокер|тариф|плач|влож|вклад|инвест|куп(?:л|и|а)|покуп|потрач|бюджет|сумм|деньг|денег)" +
  "|(?<![а-я])(?:кк|пол|полтор[аы]|один|одн[аиу]|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|двадцать|тридцать|сорок|пятьдесят" +
  "|сто|двести|триста|четыреста|пятьсот)(?![а-я])");

export interface ParsedInputs {
  position_size: number | null;
  k_pct: number | null;
  promise: PromiseDecision | null; // annualized null — к годовым не привести (доход за срок — переспросить)
  unsure: string | null;           // правилами не решить — реплику целиком решает модель (без частичного применения); значение — причина
  named: boolean;                  // проверка бумаги: названы сумма или комиссия (любое число вне номера ОФЗ и фразы обещания, слово денег или комиссии) — их не разбираем и не переносим прошлые, просим написать отдельным сообщением
  query: string;                   // проверка бумаги: запрос в ISS; пустой — бумагу не выделить, решает модель
}
/**
 * Вводы реплики. "set" (отчёт есть) — сумма, комиссия, обещание; число без опоры («вложу 2 млн или 3») и названная бумага — unsure.
 * "check" (проверка бумаги) — только обещание и запрос, сумма и комиссия не разбираются (named); при обещании второе число-кандидат
 * в другой фразе («обещали 20%. Нет, 26%»), две бумаги или сравнение — unsure. Jev (тип обещания) — только без сомнений.
 */
export async function parseInputs(text: string, mode: "check" | "set", lastAssistant: string | null = null): Promise<ParsedInputs> {
  const set = mode === "set";
  const out: ParsedInputs = { position_size: null, k_pct: null, promise: null, unsure: "сложная реплика", named: false, query: "" };
  if (isComplex(text)) return out;
  if (!set) out.query = paperQuery(text);
  const t0 = stripIds(lower(text));
  const k = commissionScan(t0);
  const t = blank(t0, k.spans);
  const money = moneyScan(t, ASKED_SUM.test(lastAssistant ?? ""));
  const tp = set && money.span ? blank(t, [money.span]) : t;
  const p = promiseScan(tp);
  // Число без опоры: не деньги, не срок, вне фразы обещания; при проверке бумаги — меньше 1000 (номер ОФЗ и год — не кандидаты)
  const loose = (n: Num) => !n.money && !n.term && (set || n.value < 1000) && !(p.region && n.start >= p.region[0] && n.start < p.region[1]);
  const seen = money.seen || k.seen || p.seen;
  out.unsure = seen && HYPOTHETICAL.test(t0) ? "условное наклонение" // «а если комиссия 1%?»
    : seen && CURRENCY.test(t0) ? "сумма или ставка в валюте"
    : set && money.unsure ? "сумма неоднозначна"
    : set && k.unsure ? "комиссия неоднозначна"
    : p.unsure ? "обещание неоднозначно"
    : (set || p.decision) && scanNums(tp).some(loose) ? "число без опоры" // «вложу 2 млн, 26%», «Проверь X, обещали 20%. Нет, 26%»
    : !set && manyPapers(lower(text)) ? "несколько бумаг или сравнение"
    : set && namesPaper(text) ? "названа другая бумага" // «мне предложили облигацию Самолёт под 26%» — не вводы текущего отчёта
    : set && (isRetell(text) || text.includes("?")) ? "пересказ или вопрос" // «банк предложил облигации под 26%, стоит ли?», «а под 26% стоит брать?»
    : null;
  if (out.unsure) return out;
  // Проверка бумаги: после вырезания ISIN, кода выпуска, номера ОФЗ и фразы обещания осталось любое число или слово денег / комиссии
  // («сумма 1 000 000», «на 1кк», «на полмиллиона», «плачу брокеру 0,05%») — названы свои сумма или комиссия (named)
  const inPromise = (i: number) => !!p.region && i >= p.region[0] && i < p.region[1];
  const named = !set && (money.seen || k.seen || scanNums(t).some((n) => !n.ofz && !inPromise(n.start)) ||
    CHECK_NAMED.test(blank(lower(text), p.region ? [p.region] : []).replace(INTRO, "").replace(VERB_PREFIX, "")));
  const promise = p.decision ? await jevKind(text, p.decision) : null;
  // Jev и правила разошлись (правила: за период / за срок, Jev: годовые) или к годовым не привести — решает модель
  const rk = p.decision?.kind;
  if (promise && ((promise.kind !== rk && (rk === "per_period" || rk === "total_for_term")) || (promise.annualized == null && promise.kind !== "total_for_term")))
    return { ...out, unsure: "тип обещания неясен" };
  return { ...out, unsure: null, position_size: set ? money.value : null, k_pct: set ? k.value : null, promise, named };
}

/** Цена предложения, % номинала — только в ответ на «По какой цене вам предлагают купить?», вся реплика — «98,5%», «98 от номинала», «по цене 99»; вне 50–150 — модели */
const PRICE_ONLY = /^(?:по\s+(?:цене\s+)?)?(\d+(?:[.,]\d+)?)\s*(%|процент[а-я]*)?\s*(от\s+номинала)?\s*[.!]?$/;
export function offerPriceIn(text: string, lastAssistant: string | null): number | null {
  const t = lower(text).trim();
  const m = t.match(PRICE_ONLY);
  if (!m || !/по какой цене/i.test(lastAssistant ?? "") || !(m[2] || m[3] || /^по\s+цене/.test(t))) return null;
  const v = Number(m[1].replace(",", "."));
  return v >= 50 && v <= 150 ? v : null; // «по цене 1,5» — скорее рубли (тысячи), «15%» — скорее доходность, «250» — опечатка
}

/**
 * Прямая просьба о совете (отказ шаблоном до Jev): в начале реплики «посоветуй / предложи / подбери / порекомендуй / дай совет», в пяти словах
 * предмет, остальные — служебные; или вся реплика — «какую облигацию купить?», «что лучше купить?», «во что вложить?». Пересказ (isRetell),
 * ISIN, номер ОФЗ, код выпуска, любое другое слово («посоветуй облигации сбера») — не просьба: пропуск закроет промпт модели.
 */
const GREETING = /^(?:(?:привет|здравствуй(?:те)?|добрый\s+(?:день|вечер)|доброе\s+утро|спасибо|пока|хай)(?![а-я])[\s,!.)]*)?/;
const RETELL = /(?<![а-я])(?:слышал|читал|видел|говорят|сказал|советуют|предлага|предложил|есть\s+мнение|так\s+ли|правда\s+ли|стоит\s+ли|верно\s+ли)/;
/** Пересказ или сомнение («слышал, что…, так ли это?», «мне предложили…») — вопрос по теме «второго мнения», не для шаблона отказа */
export const isRetell = (text: string) => RETELL.test(lower(text));
const ADVICE_VERB = /^(?:(?:посоветуй|предложи|подбери|порекомендуй)(?:те)?|дай(?:те)?\s+совет)(?![а-я])/;
const ADVICE_OBJECT = /^(?:облигаци[а-я]*|бумаг[а-я]*|офз|что|куда|вариант[а-я]*|выпуск[а-я]*)$/;
const ADVICE_FILLER = /^(?:мне|нам|ты|вы|пожалуйста|плиз|бы|лучше|сейчас|какую|какие|какой|какую-нибудь|какие-нибудь|что-нибудь|что-то|купить|взять|выбрать|вложить|вложиться|инвестировать|в|во|на|для|(?:хорош|надежн|выгодн|доходн|коротк|длинн)[а-я]*)$/;
const ADVICE_WHOLE = /^(?:(?:какую|какие|какой)\s+(?:облигаци[а-я]*|бумаг[а-я]*|выпуск[а-я]*|офз)\s+(?:(?:мне|лучше)\s+)*(?:купить|взять|выбрать)|что\s+(?:(?:мне|лучше)\s+)*купить|во\s+что\s+(?:(?:мне|лучше)\s+)*вложить(?:ся)?)$/;
export function isAdviceRequest(text: string): boolean {
  if (isComplex(text)) return false;
  const t = lower(text).trim().replace(GREETING, "").replace(/[\s?.!]+$/, "");
  if (isRetell(t) || OFZ_ANY.test(t) || stripIds(t) !== t) return false;
  if (ADVICE_WHOLE.test(t)) return true;
  const m = t.match(ADVICE_VERB);
  const words = m ? t.slice(m[0].length).split(/[^a-zа-я0-9-]+/).filter(Boolean) : [];
  return words.slice(0, 5).some((w) => ADVICE_OBJECT.test(w)) && words.every((w) => ADVICE_OBJECT.test(w) || ADVICE_FILLER.test(w));
}

/** Уточнение к прошлому ответу: до шести слов, начинается с маркера («ты уверен?», «точно?», «почему?», «а если…», «не понял», «объясни») */
const FOLLOW_UP = /^(?:(?:а|и|но|ну)\s+)?(?:(?:ты|вы)\s+уверен[аы]?|уверен[аы]?|точно|почему|если|не\s+понял[аи]?|объясни(?:те)?|поясни(?:те)?|правда|откуда|зачем)(?![а-я])/;
export const isFollowUp = (text: string) => !isComplex(text) && text.trim().split(/\s+/).length <= 6 && FOLLOW_UP.test(lower(text).trim().replace(/^[^a-zа-я0-9]+/, ""));

/* ───── правило-фоллбэк (без Jev) ───── */
export function routeByRules(text: string, hasReport: boolean): RouteDecision {
  const hit = (intent: Intent, mentions = 0): RouteDecision => ({ intent, confidence: 0.9, probabilities: { [intent]: 0.9 }, mentionsSecurity: mentions, source: "rules" });
  const low = (intent: Intent, c = 0.4): RouteDecision => ({ intent, confidence: c, probabilities: { [intent]: c }, mentionsSecurity: 0, source: "rules" });
  if (isComplex(text)) return low("ask_about_report", 0); // сложную реплику гейт всё равно отдаёт модели
  // Внимание: в JS-регулярках без флага u «\w» и «\b» не знают кириллицы — пишем классы [а-я] явно
  const t = lower(text).trim();
  const words = t.split(/\s+/).filter(Boolean);
  const nums = numbersIn(t);
  // код выпуска: «1Р07», «2P1», «БО-03», «26238» рядом с буквами, рег. номер «4B02-07-16689-A-001P», программа «4-01-10797-A-001P»
  const issueCode = /(^|\s)[а-яa-z]*\d+[а-яa-z]+\d*|(^|\s)[а-яa-z]+\d{2,}|\d[a-zа-я]\d{2}-\d{2}-|^\d+-\d+-[a-z0-9а-я]{5}/i;
  // ISIN и ОФЗ в любой записи («ОФЗ-26243-ПД», «офз 26243», «ОФЗ-ПК 29014») — имя бумаги, даже внутри вопроса
  if (ISIN_RE.test(text) || OFZ_NUM.test(t)) return hit("check_security", 1);
  // «Проверь ещё раз», «оцени риски» — не бумага: пусть решает модель
  if (/^(проверь|проверьте|проверить|посмотри|посмотрите|что скажешь|оцени|оцените|разбери)( |$)/.test(t))
    return looksLikePaper(paperQuery(text)) ? hit("check_security", 1) : low("check_security", 0.6);
  // Без отчёта «говорит» — обещание только в «говорит, (что) будет / доходность / заработать» (как до WP-U): «Менеджер говорит 18 годовых»,
  // «Банк говорит 18%» — не проверка бумаги «Менеджер» / «Банк», решает модель
  if (((hasReport ? PROMISE_RE : ROUTE_PROMISE).test(t) || /заработа|доходност[а-я]* \d/.test(t)) && nums.length) {
    if (hasReport) return hit("set_promised");
    const rest = t.replace(new RegExp(`[,;]?\\s*(?:а\\s+)?(?:мне\\s+)?(?:${PROMISE_SRC}|заработа).*$`), "").trim();
    return rest.length >= 3 ? hit("check_security", 1) : low("check_security");
  }
  if (new RegExp(K_KEY_SRC).test(t) && nums.length) return hit("set_commission");
  const priceAt = t.search(/предлагают|предложение|цена|по цене|продают/); // слово цены и цифра после него
  if (hasReport && ((priceAt >= 0 && /\d/.test(t.slice(priceAt))) || /^по \d+(?:[.,]\d*)?\s*%?$/.test(t))) return hit("set_price");
  if (/(влож|сумм|позици|на \d|у меня \d|хочу \d|млн|тыс|\d\s?к(?![а-я]))/.test(t) && moneyIn(t) != null) return hit("set_position");
  if (hasReport && /\d\s*(%|процент|годовых)/.test(t) && words.length <= 6) return hit("set_promised"); // без слов обещания гейт число не применит
  if (/^(перв|втор|трет|четверт|пят|шест|седьм|восьм|девят|десят)[а-я]*( |$)|^(бер(ем|у) |давай тот|этот|вот эт)|тот,? (что|который)/.test(t)) return hit("pick_variant");
  if (/что такое|что значит|объясни|поясни|расскажи про|это что|что за |это хорошо|это плохо/.test(t)) return hit("explain_term");
  // Не по теме — только реплика-приветствие целиком или до трёх слов из словаря: «спасибо, а почему балл низкий?» — вопрос модели
  const offTopic = /(?<![а-я])акци(?:я|и|ю|й|ях|ям|ями)?(?![а-я])|крипт|биткоин|недвиж|что купить|куда вложить|стих|погод[аеуы](?![а-я])|анекдот/.test(t) && !/облигац|офз/.test(t);
  if (!t.replace(GREETING, "") || (words.length <= 3 && offTopic)) return hit("out_of_scope");
  if (hasReport && /почему|зачем|стоит ли|как |чем |риск|балл|скор|держать|оферт|вопрос|если/.test(t)) return low("ask_about_report");
  if (issueCode.test(t) && words.length <= 6) return hit("check_security", 1);
  if (/^\d{1,2}[).]?$/.test(t)) return low(hasReport ? "set_promised" : "check_security", 0.5); // голое число — пусть решает модель
  if (/^\d{5}$/.test(t)) return low("check_security", 0.6); // «26243» — похоже на номер ОФЗ, но пусть подтвердит модель
  // одно-два слова без глагола («Черкизово», «Самолет БО») — похоже на имя эмитента, но уверенности нет
  if (!hasReport && /^[а-яa-z][а-яa-z.\- ]{2,40}$/.test(t) && words.length <= 3) return low("check_security", 0.6);
  return low("ask_about_report");
}

/** Обещание по правилам (без Jev): число, тип величины, годовые; неоднозначное (вилка, надбавка, деньги рядом) — not_a_promise без числа */
export function promiseByRules(text: string): PromiseDecision {
  const t = isComplex(text) ? "" : stripIds(lower(text));
  return promiseScan(blank(t, commissionScan(t).spans)).decision ?? { kind: "not_a_promise", confidence: 0.9, value: null, annualized: null, source: "rules" };
}

/* ───── Jev ───── */
export async function routeMessage(text: string, hasReport: boolean, lastAssistant?: string | null): Promise<RouteDecision> {
  if (!jevEnabled()) return routeByRules(text, hasReport);
  try {
    const res = await jevDecide(
      { message: text, context: { report_shown: hasReport ? "пользователю уже показан отчёт по одной бумаге" : "отчёта ещё нет", last_assistant: (lastAssistant ?? "").slice(0, 400) } },
      {
        intent: { type: "choice", instructions: "Что хочет пользователь этим сообщением в чате сервиса проверки облигаций?", criteria: INTENTS },
        mentions_security: {
          type: "noul",
          instructions: "Есть ли в сообщении идентификатор конкретной облигации или эмитента: ISIN, название выпуска, эмитент, рег. номер, ссылка?",
          criteria: { true: "Да, названа конкретная бумага или эмитент.", false: "Нет, бумага не названа." },
        },
      },
    );
    const a = res.answers.intent;
    if (a.type !== "choice" || !(a.choice in INTENTS)) return routeByRules(text, hasReport);
    return {
      intent: a.choice as Intent, confidence: a.confidence, probabilities: a.probabilities as Partial<Record<Intent, number>>,
      mentionsSecurity: noulOf(res.answers.mentions_security), source: "jev", usage: { inputTokens: res.usage?.input_tokens, cost: res.usage?.cost },
    };
  } catch (e) {
    // Jev недоступен — падаем на правила, диалог не ломаем; причину пишем в журнал (route.ts → jev_error)
    return { ...routeByRules(text, hasReport), jevError: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

/** Тип величины обещания — Jev по реплике целиком (число — из правил); без Jev или без числа — решение правил. В продовом коде не вызывается — тестовый шов проверок wp-h / wp-u-gate (гейт берёт обещание из parseInputs) */
export const parsePromise = (text: string): Promise<PromiseDecision> => jevKind(text, promiseByRules(text));
/** Jev выбирает только тип величины для числа правил; «за период» приводится к годовым, только если правила нашли период при числе (×12 / ×4) */
async function jevKind(text: string, rules: PromiseDecision): Promise<PromiseDecision> {
  if (!jevEnabled() || rules.value == null) return rules;
  try {
    const res = await jevDecide(
      { message: text, number_found: rules.value },
      { kind: { type: "choice", instructions: "Что за величину назвал пользователь, говоря о том, что ему обещал продавец?", criteria: PROMISE_KINDS } },
    );
    const a = res.answers.kind;
    if (a.type !== "choice" || !(a.choice in PROMISE_KINDS)) return rules;
    const kind = a.choice as PromiseKind;
    const annualized = kind === "annual_yield" || kind === "coupon_rate" ? rules.value : kind === "per_period" && rules.kind === "per_period" ? rules.annualized : null;
    return { kind, confidence: a.confidence, value: rules.value, annualized, source: "jev" };
  } catch {
    return rules;
  }
}
