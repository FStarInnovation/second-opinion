/**
 * Jev-гейт: уверенные реплики исполняются инструментом напрямую, без LLM, и отдаются в тот же
 * UI message stream, что и ответы модели — чат их не отличает. Тексты — шаблоны (П25);
 * единственные «числа» в них — те, что ввёл пользователь.
 */
import type { UIMessageStreamWriter } from "ai";
import type { BuildResultT, ReportInputs } from "@so/engine/contract";
import { fmtMax, rub } from "@so/engine/format";
import { moneyIn, numbersIn, parsePromise, routeMessage, jevThreshold, type RouteDecision } from "./jev";
import { buildCached, rebuild } from "./engine";
import { findTerm } from "./glossary";
import { setResult, type ChatSession } from "./session";
import type { ReportToolResult, ExplainResult, ToolName } from "./tools";

export interface GateOutcome {
  handled: boolean;
  decision: RouteDecision;
}

const id = () => "gate_" + Math.random().toString(36).slice(2, 10);

function writeTool(w: UIMessageStreamWriter, toolName: ToolName, input: unknown, output: unknown) {
  const toolCallId = id();
  w.write({ type: "tool-input-available", toolCallId, toolName, input });
  w.write({ type: "tool-output-available", toolCallId, output });
}
function writeText(w: UIMessageStreamWriter, s: string) {
  const tid = id();
  w.write({ type: "text-start", id: tid });
  w.write({ type: "text-delta", id: tid, delta: s });
  w.write({ type: "text-end", id: tid });
}

function reportText(res: BuildResultT): string {
  if (res.kind === "pick") return `Нашлось несколько выпусков по запросу «${res.query}» — выберите нужный в списке выше или уточните запрос.`;
  if (res.kind === "notfound")
    return res.isinValid
      ? "ISIN корректный, но на Мосбирже бумага не торгуется — внебиржевой или погашенный выпуск. Такие мы пока не проверяем."
      : "На Мосбирже такой бумаги не нашлось. Проверьте ISIN или название.";
  if (res.kind === "err") return res.msg;
  const r = res.report;
  if (r.status.kind === "no_price") return "По этой бумаге сейчас нет биржевой цены: сделок не было. По какой цене вам предлагают купить? Напишите в процентах от номинала — пересчитаю доходность от неё.";
  if (r.status.kind === "not_traded") return "Бумага не торгуется на Мосбирже — выйти через биржу нельзя. Red flags и Truth Score — в блоке выше.";
  if (r.status.kind === "no_coupon_rate") return "Ставка первого купона ещё не опубликована, поэтому доходность пока не рассчитать. Ликвидность и red flags — в блоках выше.";
  const fired = r.flags.filter((f) => f.fired).sort((a, b) => b.points - a.points).slice(0, 3).map((f) => f.title.toLowerCase());
  const flags = fired.length ? ` Главные red flags: ${fired.join(", ")}.` : " Ни один из red flags не сработал.";
  const claim = r.claim.line ? " Обещанную доходность сравнил с расчётной — разница в блоке «Доходность»." : "";
  return `Отчёт по ${r.security.shortname} собран — смотрите блоки выше.${claim}${flags} Напишите сумму, комиссию брокера или сколько вам обещали — пересчитаю.`;
}

export async function runGate(
  w: UIMessageStreamWriter, session: ChatSession, text: string, lastAssistant: string | null,
): Promise<GateOutcome> {
  const hasReport = session.result?.kind === "report";
  const decision = await routeMessage(text, hasReport, lastAssistant);
  session.usage.jev += 1;
  const sure = decision.confidence >= jevThreshold();
  const done = (): GateOutcome => ({ handled: true, decision });
  const pass = (): GateOutcome => ({ handled: false, decision });
  if (!sure) return pass();

  const report = async (query: string, inputs: ReportInputs = {}): Promise<ReportToolResult> => {
    const result = await buildCached(query, inputs);
    if (result.kind === "report") setResult(session, query, result);
    return { query, result };
  };
  const change = async (inputs: ReportInputs): Promise<ReportToolResult | null> => {
    if (!session.result || !session.query) return null;
    const result = await rebuild(session.query, session.result, inputs);
    setResult(session, session.query, result);
    return { query: session.query, result };
  };

  switch (decision.intent) {
    case "check_security": {
      // «проверь РОЛЬФ 1Р07, обещали 26%» — бумага и обещание в одной реплике
      const pr = await parsePromise(text);
      const promised = /обеща|говор|сулят|презентац/.test(text.toLowerCase()) && pr.annualized != null ? pr.annualized : null;
      const query = text
        .replace(/^(проверь(те)?|проверить|посмотри(те)?|что скажешь (про|о|насчёт)|оцени(те)?|разбери)\s+/i, "")
        .replace(/[,;—-]?\s*(а\s+)?(мне\s+)?(обеща|говор|сулят|презентац).*$/i, "")
        .trim() || text.trim();
      const out = await report(query, promised != null ? { promised_pct: promised } : {});
      writeTool(w, promised != null ? "build_bond_report" : "resolve_security",
        promised != null ? { query, inputs: { promised_pct: promised } } : { query }, out);
      writeText(w, reportText(out.result));
      return done();
    }
    case "set_promised": {
      if (!hasReport) return pass();
      const pr = await parsePromise(text);
      if (pr.kind === "total_for_term" && pr.value != null) {
        writeText(w, `Вы назвали доход за весь срок (${fmtMax(pr.value, 2)}%), а сравниваем мы годовые. Уточните, сколько это в процентах годовых, или скажите срок — и я пересчитаю.`);
        return done();
      }
      if (pr.annualized == null) return pass();
      const out = await change({ promised_pct: pr.annualized });
      if (!out) return pass();
      writeTool(w, "set_inputs", { promised_pct: pr.annualized }, out);
      const note = pr.kind === "per_period" ? ` Вы назвали ставку за период — в годовых это ${fmtMax(pr.annualized, 2)}%.` : "";
      writeText(w, `Учёл обещанные ${fmtMax(pr.annualized, 2)}% годовых.${note} Сравнение с расчётной доходностью и Truth Score обновились в блоках выше.`);
      return done();
    }
    case "set_position": {
      const n = moneyIn(text);
      if (!hasReport || n == null) return pass();
      const out = await change({ position_size: n });
      if (!out) return pass();
      writeTool(w, "set_inputs", { position_size: n }, out);
      writeText(w, `Пересчитал на позицию ${rub(n)}: стоимость выхода и худший случай обновились в блоках выше.`);
      return done();
    }
    case "set_commission": {
      const n = numbersIn(text).find((x) => x >= 0 && x <= 3);
      if (!hasReport || n == null) return pass();
      const out = await change({ k_pct: n });
      if (!out) return pass();
      writeTool(w, "set_inputs", { k_pct: n }, out);
      writeText(w, `Учёл комиссию брокера ${fmtMax(n, 2)}% — доходность после комиссии и налога в блоке «Комиссии и налог».`);
      return done();
    }
    case "set_price": {
      const n = numbersIn(text).find((x) => x > 1 && x <= 300);
      if (!hasReport || n == null || session.result?.kind !== "report" || session.result.report.status.kind !== "no_price") return pass();
      const out = await change({ offer_price_pct: n });
      if (!out) return pass();
      writeTool(w, "set_inputs", { offer_price_pct: n }, out);
      writeText(w, `Посчитал от цены предложения ${fmtMax(n, 2)}% номинала — доходность, комиссии и worst-case в блоках выше.`);
      return done();
    }
    case "explain_term": {
      const t = findTerm(text);
      if (!t) return pass();
      const out: ExplainResult = { found: true, id: t.id, title: t.title, text: t.text };
      writeTool(w, "explain_term", { term: text }, out);
      writeText(w, `${t.title}. ${t.text}`);
      return done();
    }
    case "out_of_scope": {
      writeText(w, "Я помогаю только с проверкой облигаций, которые торгуются на Мосбирже: назовите выпуск, ISIN или эмитента — соберу отчёт. Советов, что купить, не даю.");
      return done();
    }
    default:
      return pass(); // pick_variant и ask_about_report — модели
  }
}
