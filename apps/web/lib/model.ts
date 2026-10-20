/**
 * Модель диалога. Прод: OpenRouter — Haiku 5.5 с fallback на GPT-6 Luna в одном запросе,
 * учёт usage (токены, стоимость) включён. Тесты и демо без ключа (MOCK_LLM=1): скриптовая
 * модель, которая ведёт сценарии постановки через те же инструменты — проверяет обвязку,
 * а не качество модели.
 */
import type { LanguageModel } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart, LanguageModelV4Prompt } from "@ai-sdk/provider";

/**
 * Провайдер выбирается по ключам в .env:
 *   OPENROUTER_API_KEY — OpenRouter: Haiku 5.5 + fallback GPT-6 Luna в одном запросе (и Jev на том же ключе);
 *   ANTHROPIC_API_KEY  — Claude API напрямую: Haiku 5.5 без fallback-модели (Jev тогда недоступен → правила);
 *   LLM_PROVIDER=openrouter|anthropic — принудительно, если заданы оба ключа. Ни одного ключа — MOCK.
 */
export const PRIMARY_MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-haiku-5.5";
export const FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL ?? "openai/gpt-6-luna";
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5";

export type Provider = "openrouter" | "anthropic" | "mock";
export function provider(): Provider {
  if (process.env.MOCK_LLM === "1") return "mock";
  const forced = process.env.LLM_PROVIDER as Provider | undefined;
  if (forced === "openrouter" && process.env.OPENROUTER_API_KEY) return "openrouter";
  if (forced === "anthropic" && process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "mock";
}
export const isMock = () => provider() === "mock";
export const modelLabel = () =>
  provider() === "openrouter" ? `${PRIMARY_MODEL} → ${FALLBACK_MODEL}` : provider() === "anthropic" ? ANTHROPIC_MODEL + " (Claude API)" : "mock";

export function chatModel(): LanguageModel {
  switch (provider()) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      return anthropic(ANTHROPIC_MODEL);
    }
    case "openrouter": {
      const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
      return openrouter.chat(PRIMARY_MODEL, {
        models: [PRIMARY_MODEL, FALLBACK_MODEL],
        usage: { include: true },
        reasoning: { effort: "low", exclude: true },
        temperature: 0.3,
      });
    }
    default:
      return mockModel();
  }
}

/** Опции вызова для прямого Claude API: усилие low — вся математика в движке, модели рассуждать не о чем. */
export function callProviderOptions() {
  return provider() === "anthropic" ? { anthropic: { effort: "low" as const } } : undefined;
}

/* ───── скриптовая модель для сценариев без ключа ───── */

const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };
const finish = (reason: "stop" | "tool-calls"): LanguageModelV4StreamPart => ({ type: "finish", usage, finishReason: { unified: reason, raw: reason } });
const text = (s: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: s }, { type: "text-end", id: "t1" },
];
const call = (toolName: string, input: unknown): LanguageModelV4StreamPart[] => [
  { type: "tool-call", toolCallId: "call_" + Math.random().toString(36).slice(2, 8), toolName, input: JSON.stringify(input) },
];

function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role === "user") return m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
  }
  return "";
}
/**
 * thrown — инструмент упал (error-text/error-json: невалидный ввод или исключение в execute). На сайте блок есть: ReportToolUI рисует
 * note--bad с замаскированным errorText «An error occurred.» (onError по умолчанию у toUIMessageStream). В боте заглушка «Собираю отчёт…»
 * остаётся без правки (render.ts рисует только output-available). Русское объяснение сбоя — только текст «Инструмент вернул ошибку…»,
 * поэтому MOCK говорит его текстом. Сайт и бот здесь расходятся (И3) — известное расхождение, см. план, «Выполнено (19.10.2026)».
 */
function lastToolResult(prompt: LanguageModelV4Prompt): { toolName: string; output: unknown; thrown: boolean } | null {
  const m = prompt[prompt.length - 1];
  if (m?.role !== "tool") return null;
  const p = m.content.find((c) => c.type === "tool-result");
  if (!p || p.type !== "tool-result") return null;
  const out = p.output as { type: string; value?: unknown };
  if (out.type === "error-text" || out.type === "error-json") return { toolName: p.toolName, output: { error: "Инструмент вернул ошибку — попробуйте ещё раз." }, thrown: true };
  return { toolName: p.toolName, output: out.type === "json" ? out.value : out.value ?? out, thrown: false };
}

/** Сценарий: по реплике пользователя — инструмент; по результату — короткий текст без чисел (как требует промпт). */
function script(prompt: LanguageModelV4Prompt): LanguageModelV4StreamPart[] {
  const tr = lastToolResult(prompt);
  if (tr) {
    const d = tr.output as { status?: string; claim_line?: string | null; red_flags?: string[]; found?: boolean; title?: string; text?: string; error?: string };
    if (tr.toolName === "explain_term")
      return [...text(d.found ? `${d.title}. ${d.text}` : "Такого термина в глоссарии нет — спросите про НКД, оферту, дюрацию или флоатер."), finish("stop")];
    // {error}, который вернул сам инструмент (set_inputs без отчёта), уже на экране: блок инструмента на сайте (ReportToolUI) и правка
    // заглушки в боте (render.ts). Повтор текстом показал бы фразу дважды — не повторяем (как карточку термина в гейте)
    if (d.error) return tr.thrown ? [...text(d.error), finish("stop")] : [finish("stop")];
    // err (ссылка без ISIN, сбой Мосбиржи) — сообщение уже в блоке ErrView на сайте и в блоке ветки в боте (renderBranch); общий шаблон
    // «Отчёт собран…» ему противоречил бы, а повтор msg текстом дал бы дубль (как err в гейте)
    if (d.status === "err") return [finish("stop")];
    if (d.status === "pick") return [...text("Нашлось несколько выпусков — выберите нужный в списке выше или уточните запрос."), finish("stop")];
    if (d.status === "notfound") return [...text("На Мосбирже такой бумаги не нашлось. Проверьте ISIN или название — или загрузите документ продавца, когда появится вход файлом."), finish("stop")];
    if (d.status === "no_price") return [...text("По этой бумаге сейчас нет биржевой цены: сделок не было. По какой цене вам предлагают купить? Напишите в процентах от номинала — пересчитаю доходность от неё."), finish("stop")];
    if (d.status === "no_coupon_rate") return [...text("Ставка первого купона ещё не опубликована, поэтому доходность пока не рассчитать. Ликвидность и red flags — в блоках выше."), finish("stop")];
    const flags = d.red_flags?.length ? ` Главные red flags: ${d.red_flags.slice(0, 3).map((f) => f.replace(/\s*\(−\d+\)$/, "")).join(", ")}.` : " Ни один из red flags не сработал.";
    const claim = d.claim_line ? " Обещанную доходность сравнил с расчётной — разница в блоке «Доходность»." : "";
    return [...text(`Отчёт собран — смотрите блоки выше: доходность, ликвидность, комиссии и налог, worst-case и Truth Score.${claim}${flags}`), finish("stop")];
  }
  const u = lastUserText(prompt);
  const t = u.toLowerCase();
  const hadReport = prompt.some((m) => m.role === "tool" && m.content.some((c) => c.type === "tool-result" && c.toolName !== "explain_term"));
  // вопрос по показанному отчёту — текстовый ответ без чисел (как потребует промпт от живой модели)
  if (hadReport && /почему|зачем|стоит ли|как |чем |риск|балл|скор|держать|оферт/.test(t) && !/(RU|SU)[0-9A-Z]{10}/i.test(u))
    return [...text("Балл складывается из сработавших red flags — они перечислены в блоке Truth Score с весами. Снять их нельзя, но можно уточнить ввод: сумму, комиссию и что именно обещал продавец. Решение о покупке остаётся за вами — рекомендаций я не даю."), finish("stop")];
  const promised = t.match(/обеща[а-я]*[^\d]{0,24}?(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*%?\s*(годовых|обеща)/);
  const promisedPct = promised ? Number((promised[1] ?? promised[2]).replace(",", ".")) : undefined;
  const isin = u.match(/\b(RU|SU)[0-9A-Z]{10}\b/i)?.[0];
  if (/что такое|объясни|что значит/.test(t)) return [...call("explain_term", { term: u }), finish("tool-calls")];
  if (/по цене|предлагают по|цена\s*\d|по\s*\d+[.,]?\d*\s*%?$/.test(t)) {
    const n = Number((t.match(/(\d+(?:[.,]\d+)?)/)?.[1] ?? "0").replace(",", "."));
    return [...call("set_inputs", { offer_price_pct: n }), finish("tool-calls")];
  }
  if (/комисси/.test(t)) {
    const n = Number((t.match(/(\d+(?:[.,]\d+)?)/)?.[1] ?? "0").replace(",", "."));
    return [...call("set_inputs", { k_pct: n }), finish("tool-calls")];
  }
  if (/(млн|тыс|влож|сумм)/.test(t) && !isin && !/проверь/.test(t)) {
    const m = t.match(/(\d+(?:[.,]\d+)?)\s*(млн|тыс)?/);
    const n = m ? Number(m[1].replace(",", ".")) * (m[2] === "млн" ? 1e6 : m[2] === "тыс" ? 1e3 : 1) : 500_000;
    return [...call("set_inputs", { position_size: Math.round(n) }), finish("tool-calls")];
  }
  if (promisedPct != null && !isin && !/проверь|черкиз|рольф|вэб|офз/.test(t)) return [...call("set_inputs", { promised_pct: promisedPct }), finish("tool-calls")];
  // бумага: очищаем реплику от служебных слов и «обещали …»
  const query = isin ?? u.replace(/^(проверь|проверить|посмотри|что скажешь про|оцени)\s+/i, "").replace(/,?\s*обеща.*$/i, "").trim();
  if (promisedPct != null) return [...call("build_bond_report", { query, inputs: { promised_pct: promisedPct } }), finish("tool-calls")];
  return [...call("resolve_security", { query }), finish("tool-calls")];
}

function mockModel(): LanguageModel {
  return new MockLanguageModelV4({
    provider: "mock", modelId: "scripted-scenarios",
    doStream: async ({ prompt }) => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          for (const part of script(prompt)) c.enqueue(part);
          c.close();
        },
      }),
    }),
  }) as unknown as LanguageModel;
}
