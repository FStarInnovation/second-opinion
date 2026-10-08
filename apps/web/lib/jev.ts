/**
 * Два decision-пункта на Jev (TypeSafe, через OpenRouter Decisions API):
 *   1. routeMessage — маршрут реплики до LLM: при уверенности ≥ порога инструмент вызывается напрямую, без модели.
 *   2. parsePromise — что за величину назвал пользователь в «обещали»: годовая / купон / за срок / за период.
 * Без ключа или при JEV_ENABLED=0 работает правило-фоллбэк (регулярки) — детерминированно, для тестов и демо без сети.
 * Вопросы (criteria) — на русском: по тестам на раскрытии 29–30.09 русские инструкции работают не хуже английских.
 */

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
}

export interface PromiseDecision {
  kind: PromiseKind;
  confidence: number;
  value: number | null;        // число из текста
  annualized: number | null;   // что подставлять в promised_pct (годовые) — null, если нельзя привести
  source: "jev" | "rules";
}

const THRESHOLD = Number(process.env.JEV_THRESHOLD ?? 0.8);
const JEV_MODEL = process.env.JEV_MODEL ?? "typesafe/jev-1.13";
export const jevEnabled = () => process.env.JEV_ENABLED !== "0" && !!process.env.OPENROUTER_API_KEY && process.env.MOCK_LLM !== "1";
export const jevThreshold = () => THRESHOLD;

/* ───── клиент Decisions API (POST /api/alpha/decisions) ───── */
type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: string[] };
type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };
interface DecisionResponse { model: string; answers: Record<string, Answer>; usage?: { input_tokens?: number; output_tokens?: number; cost?: number } }

const DECISIONS_URL = process.env.JEV_DECISIONS_URL ?? "https://openrouter.ai/api/alpha/decisions";

export async function jevDecide(state: Record<string, unknown>, questions: Record<string, Question>, signal?: AbortSignal): Promise<DecisionResponse> {
  const res = await fetch(DECISIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    signal: signal ?? AbortSignal.timeout(Number(process.env.JEV_TIMEOUT_MS ?? 2500)),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}`);
  return (await res.json()) as DecisionResponse;
}

/* ───── числа в тексте ───── */
export const ISIN_RE = /\b(RU|SU)[0-9A-Z]{10}\b/i;
const NUM_RE = /(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d+))?/g;
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const n = Number(m[1].replace(/[  ]/g, "") + (m[2] ? "." + m[2] : ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
/** Сумма с единицами: «1 млн», «500 тыс», «2,5 миллиона», «миллион», «2 750 000». */
const WORD_NUM: Record<string, number> = { один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, пол: 0.5 };
export function moneyIn(text: string): number | null {
  const t = text.toLowerCase().replace(/ё/g, "е");
  const m = t.match(/(\d{1,3}(?:[ \u00a0]\d{3})+|\d+(?:[.,]\d+)?|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|пол)?\s*(млн|миллион[а-я]*|тыс[а-я.]*|т\.?р\.?|к(?![а-я]))/)
    ?? t.match(/(\d{1,3}(?:[ \u00a0]\d{3})+|\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const raw = m[1];
  let n = raw == null ? 1 : WORD_NUM[raw] ?? Number(raw.replace(/[ \u00a0]/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const u = m[2] ?? "";
  if (/^млн|^миллион/.test(u)) n *= 1e6;
  else if (/^тыс|^т\.?р|^к$/.test(u)) n *= 1e3;
  else if (raw == null || n < 1000) return null; // «вложить 2» без единиц — не сумма
  return Math.round(n);
}

/* ───── правило-фоллбэк (без Jev) ───── */
export function routeByRules(text: string, hasReport: boolean): RouteDecision {
  // Внимание: в JS-регулярках без флага u «\w» и «\b» не знают кириллицы — пишем классы [а-я] явно
  const t = text.toLowerCase().replace(/ё/g, "е").trim();
  const hit = (intent: Intent, mentions = 0): RouteDecision => ({ intent, confidence: 0.9, probabilities: { [intent]: 0.9 }, mentionsSecurity: mentions, source: "rules" });
  const low = (intent: Intent, c = 0.4): RouteDecision => ({ intent, confidence: c, probabilities: { [intent]: c }, mentionsSecurity: 0, source: "rules" });
  const words = t.split(/\s+/).filter(Boolean);
  const nums = numbersIn(t);
  const promiseWords = /обеща|говор[а-я]*,? (что )?(будет|доходност|заработа)|заработа|сулят|презентац|доходност[а-я]* \d/;
  // код выпуска: «1Р07», «2P1», «БО-03», «26238» рядом с буквами, рег. номер «4B02-07-16689-A-001P», программа «4-01-10797-A-001P»
  const issueCode = /(^|\s)[а-яa-z]*\d+[а-яa-z]+\d*|(^|\s)[а-яa-z]+\d{2,}|\d[a-zа-я]\d{2}-\d{2}-|^\d+-\d+-[a-z0-9а-я]{5}/i;

  if (ISIN_RE.test(text)) return hit("check_security", 1);
  if (/^(проверь|проверьте|проверить|посмотри|посмотрите|что скажешь|оцени|оцените|разбери)( |$)/.test(t)) return hit("check_security", 1);
  if (promiseWords.test(t) && nums.length) {
    if (hasReport) return hit("set_promised");
    const rest = t.replace(/[,;—-]?\s*(а\s+)?(мне\s+)?(обеща|говор|сулят|презентац|заработа).*$/, "").trim();
    return rest.length >= 3 ? hit("check_security", 1) : low("check_security");
  }
  if (/комисси|брокер берет|брокер берёт|тариф/.test(t) && nums.length) return hit("set_commission");
  if (hasReport && /(предлагают|предложение|цена|по цене|продают)[^\d]*\d|^по \d+[.,]?\d*\s*%?$/.test(t)) return hit("set_price");
  if (/(влож|сумм|позици|на \d|у меня \d|хочу \d|млн|тыс|\d\s?к(?![а-я]))/.test(t) && moneyIn(t) != null) return hit("set_position");
  if (hasReport && /\d+\s*(%|процент|годовых)/.test(t) && words.length <= 6) return hit("set_promised");
  if (/^(перв|втор|трет|четверт|пят|шест|седьм|восьм|девят|десят)[а-я]*( |$)|^(бер(ем|у) |давай тот|этот|вот эт)|тот,? (что|который)/.test(t)) return hit("pick_variant");
  if (/что такое|что значит|объясни|поясни|расскажи про|это что|что за |это хорошо|это плохо/.test(t)) return hit("explain_term");
  if (/^(привет|здравствуй|добрый|хай|спасибо|пока)|акци|крипт|биткоин|недвиж|что купить|куда вложить|напиши|стих|погод|анекдот/.test(t)) return hit("out_of_scope");
  if (hasReport && /почему|зачем|стоит ли|как |чем |риск|балл|скор|держать|оферт|вопрос|если/.test(t)) return low("ask_about_report");
  if (issueCode.test(t) && words.length <= 6) return hit("check_security", 1);
  if (/^\d{1,2}[).]?$/.test(t)) return low(hasReport ? "set_promised" : "check_security", 0.5); // голое число — пусть решает модель
  // одно-два слова без глагола («Черкизово», «Самолет БО») — похоже на имя эмитента, но уверенности нет
  if (!hasReport && /^[а-яa-z][а-яa-z.\- ]{2,40}$/.test(t) && words.length <= 3) return low("check_security", 0.6);
  return low("ask_about_report");
}

export function promiseByRules(text: string): PromiseDecision {
  const t = text.toLowerCase().replace(/ё/g, "е");
  // число обещания: сначала рядом с «обещали…», потом со знаком %, потом первое подходящее
  const near = t.match(/(?:обеща|говор|сулят|презентац)[а-я]*[^\d]{0,24}?(\d+(?:[.,]\d+)?)/);
  const pct = t.match(/(\d+(?:[.,]\d+)?)\s*%/);
  const nums = numbersIn(t);
  const pick = (m: RegExpMatchArray | null) => (m ? Number(m[1].replace(",", ".")) : null);
  const v = pick(near) ?? pick(pct) ?? nums.find((n) => n > 0 && n <= 100) ?? null;
  const dec = (kind: PromiseKind, annualized: number | null, c = 0.85): PromiseDecision => ({ kind, confidence: c, value: v, annualized, source: "rules" });
  if (v == null) return dec("not_a_promise", null, 0.9);
  if (/в месяц|ежемесячн|за месяц/.test(t)) return dec("per_period", Math.round(v * 12 * 100) / 100);
  if (/в квартал|за квартал/.test(t)) return dec("per_period", Math.round(v * 4 * 100) / 100);
  if (/за (весь )?срок|за (\d+|два|три|четыре|пять|полтора) (года|лет|год)|к погашению за|всего заработа|заработаете/.test(t)) return dec("total_for_term", null);
  if (/купон/.test(t) && !/доходност/.test(t)) return dec("coupon_rate", v);
  return dec("annual_yield", v);
}

/* ───── Jev ───── */
export async function routeMessage(text: string, hasReport: boolean, lastAssistant?: string | null): Promise<RouteDecision> {
  if (!jevEnabled()) return routeByRules(text, hasReport);
  try {
    const res = await jevDecide(
      {
        message: text,
        context: {
          report_shown: hasReport ? "пользователю уже показан отчёт по одной бумаге" : "отчёта ещё нет",
          last_assistant: (lastAssistant ?? "").slice(0, 400),
        },
      },
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
    const m = res.answers.mentions_security;
    if (a.type !== "choice" || !(a.choice in INTENTS)) return routeByRules(text, hasReport);
    return {
      intent: a.choice as Intent, confidence: a.confidence, probabilities: a.probabilities as Partial<Record<Intent, number>>,
      mentionsSecurity: m?.type === "noul" ? m.noul : 0, source: "jev",
      usage: { inputTokens: res.usage?.input_tokens, cost: res.usage?.cost },
    };
  } catch {
    // Jev недоступен — падаем на правила, диалог не ломаем
    return routeByRules(text, hasReport);
  }
}

export async function parsePromise(text: string): Promise<PromiseDecision> {
  const rules = promiseByRules(text);
  if (!jevEnabled() || rules.value == null) return rules;
  try {
    const res = await jevDecide(
      { message: text, number_found: rules.value },
      { kind: { type: "choice", instructions: "Что за величину назвал пользователь, говоря о том, что ему обещал продавец?", criteria: PROMISE_KINDS } },
    );
    const a = res.answers.kind;
    if (a.type !== "choice" || !(a.choice in PROMISE_KINDS)) return rules;
    const kind = a.choice as PromiseKind;
    const v = rules.value;
    const annualized =
      kind === "annual_yield" || kind === "coupon_rate" ? v
      : kind === "per_period" ? rules.annualized
      : null;
    return { kind, confidence: a.confidence, value: v, annualized, source: "jev" };
  } catch {
    return rules;
  }
}
