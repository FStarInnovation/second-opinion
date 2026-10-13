/**
 * Jev-гейт: уверенные реплики исполняются инструментом напрямую, без LLM, и отдаются в тот же UI message stream, что и ответы
 * модели — чат их не отличает. Тексты — шаблоны (П25); единственные «числа» в них — те, что ввёл пользователь.
 * Принцип: детерминированный путь ТОЧНЫЙ, полнота не важна. Применить неверное число или отказать на законный вопрос хуже, чем
 * отдать реплику модели: при сомнении (parseInputs.unsure, вводы вне схемы инструментов) вся реплика уходит модели (handled=false),
 * без частичного применения; сложную реплику (isComplex) Jev только маршрутизирует (для журнала). До Jev — прямая просьба о совете
 * (отказ шаблоном) и голое число в ответ на «Напишите комиссию брокера». Проверка бумаги применяет «обещали» из реплики, вводы
 * со страницы /check и сумму с комиссией прошлого отчёта; если в реплике проверки названы свои сумма или комиссия — не разбирает их
 * и не применяет ни прошлые, ни со страницы, а просит написать отдельно.
 * Инструмент отчёта пишется в поток в два шага: начало — до сборки («Собираю отчёт…»), результат — после, тем же toolCallId.
 */
import type { UIMessageStreamWriter } from "ai";
import type { BondReportT, BuildResultT, ReportInputs } from "@so/engine/contract";
import { CONFIG } from "@so/engine/config";
import { fmtMax, rub } from "@so/engine/format";
import {
  isAdviceRequest, isComplex, isFollowUp, isRetell, looksLikePaper, offerPriceIn, parseInputs, routeMessage, jevThreshold, type PromiseDecision, type RouteDecision,
} from "./jev";
import { buildCached, rebuild } from "./engine";
import { findTerm } from "./glossary";
import { setResult, type ChatSession } from "./session";
import { inputsSchema, type ReportToolResult, type ExplainResult, type ToolName } from "./tools";

export interface GateOutcome { handled: boolean; decision: RouteDecision }

const id = () => "gate_" + Math.random().toString(36).slice(2, 10);

function writeText(w: UIMessageStreamWriter, s: string) {
  const tid = id();
  w.write({ type: "text-start", id: tid });
  w.write({ type: "text-delta", id: tid, delta: s });
  w.write({ type: "text-end", id: tid });
}

const BUILD_FAILED = "Не получилось собрать отчёт — попробуйте ещё раз через минуту.";
/**
 * Инструмент отчёта в два шага: tool-input-available — до сборки (в чате заглушка «Собираю отчёт…»), tool-output-available — после,
 * тем же toolCallId: отчёт, список выпусков, «не найдена» или ошибка (исключение сборки — тоже, иначе заглушка осталась бы навсегда).
 */
async function reportTool(
  w: UIMessageStreamWriter, toolName: ToolName, input: unknown, query: string, run: () => Promise<ReportToolResult>,
): Promise<ReportToolResult> {
  const toolCallId = id();
  w.write({ type: "tool-input-available", toolCallId, toolName, input });
  let out: ReportToolResult;
  try {
    out = await run();
  } catch (e) {
    if (process.env.SO_QUIET !== "1") console.error("[gate] сборка отчёта не удалась:", e);
    out = { query, result: { kind: "err", query, msg: BUILD_FAILED } };
  }
  w.write({ type: "tool-output-available", toolCallId, output: out });
  return out;
}

/** «а», «а и б», «а, б и в» */
const joinRu = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} и ${xs[xs.length - 1]}`);

/* ───── вводы в ответе после отчёта ───── */

/**
 * Откуда вводы отчёта: given — всё применённое; fromPage — со страницы /check (сумма по умолчанию — не ввод); inherited — из прошлого
 * отчёта сессии; reset — сумма и комиссия прошлого отчёта, не перенесённые (повторная проверка той же бумаги или named); named — в реплике
 * проверки названы сумма или комиссия (не разобраны, прошлые и со страницы не применены — просим написать отдельно)
 */
interface InputsOrigin { given: ReportInputs; fromPage: ReportInputs | null; inherited: ReportInputs; reset: ReportInputs; named: boolean }

/** «Учёл данные со страницы проверки: …» / «… — как в прошлой проверке: …» / «… прошлой проверки сброшены.»; комиссию — только при видимом блоке комиссий */
function carriedText(r: BondReportT, o: InputsOrigin): string {
  const fees = r.panels.includes("fees");
  let s = "";
  const p = o.fromPage;
  if (p) {
    const got: string[] = [];
    if (p.position_size != null) got.push(`сумма ${rub(p.position_size)}`);
    if (p.k_pct != null && fees) got.push(`комиссия брокера ${fmtMax(p.k_pct, 2)}%`);
    if (p.promised_pct != null && o.given.promised_pct === p.promised_pct) got.push(`обещали ${fmtMax(p.promised_pct, 2)}% годовых`);
    if (p.offer_price_pct != null) got.push(`цена предложения ${fmtMax(p.offer_price_pct, 2)}% номинала`);
    if (got.length) s += ` Учёл данные со страницы проверки: ${got.join(", ")}.`;
  }
  const pos = o.inherited.position_size;
  const k = fees ? o.inherited.k_pct : null;
  if (pos != null && k != null) s += ` Сумма и комиссия — как в прошлой проверке: ${rub(pos)} и ${fmtMax(k, 2)}%.`;
  else if (pos != null) s += ` Сумма — как в прошлой проверке: ${rub(pos)}.`;
  else if (k != null) s += ` Комиссия брокера — как в прошлой проверке: ${fmtMax(k, 2)}%.`;
  const z = o.reset;
  if (z.position_size != null && z.k_pct != null) s += " Сумма и комиссия прошлой проверки сброшены.";
  else if (z.position_size != null) s += " Сумма прошлой проверки сброшена.";
  else if (z.k_pct != null) s += " Комиссия прошлой проверки сброшена.";
  return s;
}

/** Хвост «Напишите … — пересчитаю»: только то, чего ещё нет. Комиссию — только при видимом блоке комиссий, «обещали» — только когда есть с чем сравнить. */
function askText(r: BondReportT, given: ReportInputs): string {
  const want: string[] = [];
  if (given.position_size == null) want.push("сумму");
  if (given.k_pct == null && r.panels.includes("fees")) want.push("комиссию брокера");
  const promise = given.promised_pct == null && r.yield.main_pct != null;
  if (!want.length && !promise) return "";
  if (!want.length) return " Напишите, сколько вам обещали, — пересчитаю.";
  const all = promise ? [...want, "сколько вам обещали"] : want;
  return ` Напишите ${all.length > 1 ? `${all.slice(0, -1).join(", ")} или ${all[all.length - 1]}` : all[0]} — пересчитаю.`;
}

const SEPARATELY = " Сумму и комиссию напишите отдельным сообщением — пересчитаю.";
function reportText(res: BuildResultT, origin?: InputsOrigin): string {
  if (res.kind === "pick") return `Нашлось несколько выпусков по запросу «${res.query}» — выберите нужный в списке выше или уточните запрос.`;
  if (res.kind === "notfound") return res.isinValid
    ? "ISIN корректный, но на Мосбирже бумага не торгуется — внебиржевой или погашенный выпуск. Такие мы пока не проверяем."
    : "На Мосбирже такой бумаги не нашлось. Проверьте ISIN или название.";
  if (res.kind === "err") return res.msg;
  const r = res.report;
  const carried = origin ? carriedText(r, origin) : "";
  const tail = origin?.named ? SEPARATELY : "";
  if (r.status.kind === "no_price") return "По этой бумаге сейчас нет биржевой цены: сделок не было. По какой цене вам предлагают купить? Напишите в процентах от номинала — пересчитаю доходность от неё." + carried + tail;
  if (r.status.kind === "not_traded") return "Бумага не торгуется на Мосбирже — выйти через биржу нельзя. Red flags и Truth Score — в блоке выше." + carried + tail;
  if (r.status.kind === "no_coupon_rate") return "Ставка первого купона ещё не опубликована, поэтому доходность пока не рассчитать. Ликвидность и red flags — в блоках выше." + carried + tail;
  const fired = r.flags.filter((f) => f.fired).sort((a, b) => b.points - a.points).slice(0, 3).map((f) => f.title.toLowerCase());
  const flags = fired.length ? ` Главные red flags: ${fired.join(", ")}.` : " Ни один из red flags не сработал.";
  const claim = r.claim.line ? " Обещанную доходность сравнил с расчётной — разница в блоке «Доходность»." : "";
  return `Отчёт по ${r.security.shortname} собран — смотрите блоки выше.${carried}${claim}${flags}${tail || askText(r, origin?.given ?? {})}`;
}

/** Ответ на ввод при готовом отчёте: что учтено и пересчитано — по статусу отчёта; при скрытом блоке комиссий комиссия «запомнена» (перейдёт к следующей бумаге) */
function appliedText(r: BondReportT, inputs: ReportInputs, pr: PromiseDecision | null): string {
  const fees = r.panels.includes("fees");
  const got: string[] = [];
  if (inputs.position_size != null) got.push(`сумму ${rub(inputs.position_size)}`);
  if (inputs.k_pct != null && fees) got.push(`комиссию брокера ${fmtMax(inputs.k_pct, 2)}%`);
  if (inputs.promised_pct != null) got.push(`обещанные ${fmtMax(inputs.promised_pct, 2)}% годовых`);
  let s = got.length ? `Учёл ${joinRu(got)}.` : "";
  if (inputs.promised_pct != null && pr?.kind === "per_period") s += ` Вы назвали ставку за период — в годовых это ${fmtMax(inputs.promised_pct, 2)}%.`;
  if (inputs.k_pct != null && !fees) s += ` Запомнил комиссию брокера ${fmtMax(inputs.k_pct, 2)}%: блока «Комиссии и налог» у этой бумаги нет, в расчёт она не вошла.`;
  const redo: string[] = [];
  if (inputs.position_size != null) redo.push("стоимость выхода и худший случай");
  if (inputs.k_pct != null && fees) redo.push("доходность после комиссии и налога");
  if (inputs.promised_pct != null && r.claim.line != null) redo.push("сравнение с расчётной доходностью и Truth Score");
  if (redo.length) s += redo.length > 1 ? ` Пересчитал: ${redo.join("; ")} — смотрите блоки выше.` : ` Пересчитал ${redo[0]} — смотрите блоки выше.`;
  if (inputs.promised_pct != null && r.claim.line == null)
    s += r.status.kind === "no_price"
      ? " Сравню с расчётной доходностью, когда назовёте цену, по которой вам предлагают купить."
      : " Расчётной доходности по этой бумаге нет, поэтому сравнить не с чем.";
  return s.trim();
}

/* ───── новая бумага в той же сессии ───── */
const norm = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
/** Запрос называет ту же бумагу, что и прошлый отчёт (тот же запрос, ISIN, SECID, название или регномер) */
function samePaper(query: string, prevQuery: string | null, prev: BondReportT): boolean {
  const q = norm(query);
  const s = prev.security;
  return [prevQuery, s.isin, s.secid, s.shortname, s.regnumber].some((v) => v != null && norm(v) === q);
}
/**
 * Сумма (кроме суммы по умолчанию) и комиссия прошлого отчёта — для новой бумаги (обещание про бумагу, не переносится). Повторная
 * проверка той же бумаги — с чистого листа (e2e: сценарий 5); ответ говорит, что сумма и комиссия сброшены.
 */
function carryOver(prev: BondReportT): ReportInputs {
  const out: ReportInputs = {};
  if (prev.inputs.position_size != null && prev.inputs.position_size !== CONFIG.positionDefault) out.position_size = prev.inputs.position_size;
  if (prev.inputs.k_pct != null) out.k_pct = prev.inputs.k_pct;
  return out;
}

/* ───── шаблоны отказа ───── */
const OUT_OF_SCOPE = "Я помогаю только с проверкой облигаций, которые торгуются на Мосбирже: назовите выпуск, ISIN или эмитента — соберу отчёт. Советов, что купить, не даю.";
const ADVICE_NO_REPORT = "Советов и рекомендаций, что покупать, не даю — решение за вами. Я помогаю только с проверкой облигаций, которые торгуются на Мосбирже: назовите выпуск, ISIN или эмитента, который вам предлагают, — соберу отчёт.";
const ADVICE_WITH_REPORT = "Советов и рекомендаций, что покупать, не даю — решение за вами. Могу объяснить отчёт выше или проверить другую бумагу: назовите выпуск, ISIN или эмитента.";

/** Прошлый ответ просил комиссию (askText): голое число — комиссия; если просили и сумму — только со знаком % или меньше 1 («1,5» скорее миллионы) */
const ASKED_K_ONLY = /Напишите (сумму или )?комиссию брокера — пересчитаю/;
const BARE_NUM = /^\s*(\d{1,3}(?:[.,]\d{1,4})?)(\s*%)?\s*[.!]?\s*$/;
const byRules = (intent: RouteDecision["intent"], confidence = 1): RouteDecision =>
  ({ intent, confidence, probabilities: { [intent]: confidence }, mentionsSecurity: 0, source: "rules" });
/** Вводы гейта — в пределах той же схемы, что у инструментов модели (tools.ts): иначе реплику решает модель */
const validInputs = (x: ReportInputs) => inputsSchema.safeParse(x).success;

export async function runGate(
  w: UIMessageStreamWriter, session: ChatSession, text: string, lastAssistant: string | null,
): Promise<GateOutcome> {
  const hasReport = session.result?.kind === "report";
  const complex = isComplex(text);
  const report = async (query: string, inputs: ReportInputs = {}): Promise<ReportToolResult> => {
    const result = await buildCached(query, inputs);
    if (result.kind === "report") setResult(session, query, result);
    return { query, result };
  };
  /** Пересчёт готового отчёта; неудачная пересборка (ошибка ISS) прошлый отчёт сессии не затирает */
  const change = async (query: string, current: BuildResultT, inputs: ReportInputs): Promise<ReportToolResult> => {
    const result = await rebuild(query, current, inputs);
    if (result.kind === "report") setResult(session, query, result);
    return { query, result };
  };

  // Прямая просьба о совете («посоветуй облигацию», «какую облигацию купить?») — отказ шаблоном до Jev, модель не нужна
  if (!complex && isAdviceRequest(text)) {
    writeText(w, hasReport ? ADVICE_WITH_REPORT : ADVICE_NO_REPORT);
    return { handled: true, decision: byRules("out_of_scope") };
  }

  // «0,3» в ответ на «Напишите комиссию брокера — пересчитаю» — комиссия (без слов обещания число обещанием не считается)
  const asked = !complex && hasReport && lastAssistant && text.length <= 40 ? lastAssistant.match(ASKED_K_ONLY) : null;
  const bare = asked ? text.match(BARE_NUM) : null;
  const bareN = bare ? Number(bare[1].replace(",", ".")) : null;
  const bareK = bare && bareN != null && (!asked?.[1] || bare[2] || bareN < 1) ? bareN : null;
  if (bareK != null && bareK >= 0 && bareK <= CONFIG.kMax && session.query && session.result) {
    const query = session.query;
    const current = session.result;
    const out = await reportTool(w, "set_inputs", { k_pct: bareK }, query, () => change(query, current, { k_pct: bareK }));
    writeText(w, out.result.kind === "report" ? appliedText(out.result.report, { k_pct: bareK }, null) : reportText(out.result));
    return { handled: true, decision: byRules("set_commission") };
  }

  const decision = await routeMessage(text, hasReport, lastAssistant);
  session.usage.jev += 1;
  const done = (): GateOutcome => ({ handled: true, decision });
  const pass = (): GateOutcome => ({ handled: false, decision });
  if (complex || decision.confidence < jevThreshold()) return pass();

  switch (decision.intent) {
    case "check_security": {
      // Вводы снизу вверх: сумма и комиссия прошлого отчёта (новая бумага), со страницы /check (к первому отчёту сессии), «обещали» /
      // «под N%» из реплики; сумму и комиссию из реплики проверки не разбираем. Запрос не похож на бумагу («Проверь ещё раз»,
      // «менеджер говорит 18 годовых») или доход за срок («обещали 30% за 2,5 года») — решает модель
      const p = await parseInputs(text, "check");
      const { query } = p, promised = p.promise?.annualized ?? null;
      if (p.unsure || !looksLikePaper(query) || (p.promise && promised == null)) return pass();
      const prev = session.result?.kind === "report" ? session.result.report : null;
      const page: ReportInputs = { ...(session.pendingInputs ?? {}) };
      if (page.position_size === CONFIG.positionDefault) delete page.position_size; // /check передаёт сумму всегда: по умолчанию — не ввод
      // В реплике названы свои сумма или комиссия (named) — ни прошлые, ни со страницы не берём: только просьба написать их отдельно
      if (p.named) { delete page.position_size; delete page.k_pct; }
      const carry = prev ? carryOver(prev) : {};
      const keep = !p.named && !(prev && samePaper(query, session.query, prev));
      const inherited: ReportInputs = keep ? carry : {};
      const reset: ReportInputs = keep ? {} : carry;
      const fromPage = session.pendingInputs ? page : null;
      const inputs: ReportInputs = { ...inherited, ...page, ...(promised != null ? { promised_pct: promised } : {}) };
      if (!validInputs(inputs)) return pass();
      const applied = Object.keys(inputs).length > 0;
      const out = await reportTool(w, applied ? "build_bond_report" : "resolve_security", applied ? { query, inputs } : { query }, query, () => report(query, inputs));
      writeText(w, reportText(out.result, { given: inputs, fromPage, inherited, reset, named: p.named }));
      return done();
    }
    case "set_position":
    case "set_commission":
    case "set_promised": {
      // Сумма, комиссия и «обещали» — из одной реплики все сразу («вложу 2 млн, комиссия 0,3%»), одним пересчётом
      const query = session.query;
      const current = session.result;
      if (!hasReport || !query || !current) return pass();
      const p = await parseInputs(text, "set", lastAssistant);
      if (p.unsure) return pass(); // «у меня 3 млн, вложу 1 млн», «комиссия 0,3 или 0,05», «обещали от 18 до 26%» — решает модель
      // Jev выбрал сумму или комиссию, а правила этого ввода не нашли или нашли обещание (эти интенты обещание не применяли: «Самолёт,
      // обещали 26%», «комиссия биржи 0,01%» при Jev set_position) — Jev и правила разошлись, решает модель
      if (decision.source === "jev" && decision.intent !== "set_promised" &&
        (p.promise || (decision.intent === "set_position" ? p.position_size : p.k_pct) == null)) return pass();
      const inputs: ReportInputs = {};
      if (p.position_size != null) inputs.position_size = p.position_size;
      if (p.k_pct != null) inputs.k_pct = p.k_pct;
      const pr = p.promise;
      const askTerm = pr?.kind === "total_for_term" && pr.value != null
        ? `Вы назвали доход за весь срок (${fmtMax(pr.value, 2)}%), а сравниваем мы годовые. Уточните, сколько это в процентах годовых, или скажите срок — и я пересчитаю.`
        : null;
      if (pr && !askTerm && pr.annualized != null) inputs.promised_pct = pr.annualized;
      if (!Object.keys(inputs).length) {
        if (!askTerm) return pass();
        writeText(w, askTerm);
        return done();
      }
      if (!validInputs(inputs)) return pass(); // «вложу 999 999 999 999 млн» — вне схемы ввода
      const out = await reportTool(w, "set_inputs", inputs, query, () => change(query, current, inputs));
      const res = out.result;
      writeText(w, res.kind === "report" ? appliedText(res.report, inputs, pr) + (askTerm ? " " + askTerm : "") : reportText(res));
      return done();
    }
    case "set_price": {
      const n = offerPriceIn(text, lastAssistant); // только «98,5%» / «по цене 99» в ответ на «По какой цене вам предлагают купить?»
      const query = session.query;
      const current = session.result;
      if (!query || n == null || current?.kind !== "report" || current.report.status.kind !== "no_price") return pass();
      const out = await reportTool(w, "set_inputs", { offer_price_pct: n }, query, () => change(query, current, { offer_price_pct: n }));
      writeText(w, out.result.kind === "report"
        ? `Посчитал от цены предложения ${fmtMax(n, 2)}% номинала — доходность, комиссии и worst-case в блоках выше.`
        : reportText(out.result));
      return done();
    }
    case "explain_term": {
      const t = findTerm(text);
      if (!t) return pass();
      const out: ExplainResult = { found: true, id: t.id, title: t.title, text: t.text };
      const toolCallId = id();
      w.write({ type: "tool-input-available", toolCallId, toolName: "explain_term", input: { term: text } });
      w.write({ type: "tool-output-available", toolCallId, output: out });
      // Текст термина уже в карточке инструмента — не повторяем его репликой (дубль на странице), только подсказка дальше
      writeText(w, "Если нужно — спросите про другой термин или назовите бумагу, соберу отчёт.");
      return done();
    }
    case "out_of_scope": {
      // «ты уверен?», «почему?», «не понял» — уточнение к прошлому ответу; «слышал, что…, так ли это?» — пересказ: отвечает модель
      if ((lastAssistant?.trim() && isFollowUp(text)) || isRetell(text)) return pass();
      writeText(w, OUT_OF_SCOPE);
      return done();
    }
    default:
      return pass(); // pick_variant и ask_about_report — модели
  }
}
