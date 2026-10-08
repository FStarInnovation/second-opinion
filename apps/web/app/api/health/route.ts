/**
 * Проверка живости для строки статуса в чате: какой провайдер модели выбран и отвечает ли Jev.
 * Один крошечный decision-запрос к Jev (≈30 токенов, ~$0.000001); значения ключей наружу не уходят —
 * только имена провайдеров и текст ошибки без заголовков.
 */
import { isMock, provider, modelLabel } from "@/lib/model";
import { jevProvider, jevDecide } from "@/lib/jev";

export const dynamic = "force-dynamic";

export async function GET() {
  const jev = jevProvider();
  let jevStatus: { ok: boolean; ms: number; error?: string } | null = null;
  if (jev) {
    const t0 = Date.now();
    try {
      const r = await jevDecide(
        { message: "проверь RU000A10ASE2" },
        { kind: { type: "choice", instructions: "Что хочет пользователь?", criteria: { check_security: "Просит проверить конкретную облигацию.", other: "Что-то другое." } } },
      );
      const a = r.answers?.kind;
      jevStatus = { ok: a?.type === "choice" && a.choice === "check_security", ms: Date.now() - t0 };
    } catch (e) {
      jevStatus = { ok: false, ms: Date.now() - t0, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
    }
  }
  return Response.json({ mode: isMock() ? "mock" : provider(), model: modelLabel(), jev: jev ? { provider: jev, ...jevStatus } : null });
}
