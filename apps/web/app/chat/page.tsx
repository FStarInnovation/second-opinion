import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReportInputs } from "@so/engine/contract";
import { ChatApp, type ChatInitial } from "@/components/ChatApp";
import { isMock, modelLabel } from "@/lib/model";
import { jevProvider } from "@/lib/jev";
import { inputsSchema } from "@/lib/tools";

export const metadata: Metadata = { title: "Ассистент · Second opinion" };

export const dynamic = "force-dynamic"; // статус читает окружение при каждом запросе

type Search = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const num = (v: string | string[] | undefined) => {
  const s = str(v);
  if (!s) return undefined;
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
};

/** Переход «отчёт → ассистент»: /chat?q=…&promised=…&pos=…&k=…&price=… (как у /check). Недоверенный ввод:
 *  q — до 200 символов (как /api/report), числа — поодиночке через схему set_inputs; невалидное игнорируется, не ошибка. */
function initialOf(sp: Search): ChatInitial | undefined {
  const q = str(sp.q).trim();
  if (!q || q.length > 200) return undefined;
  const raw: [keyof ReportInputs, number | undefined][] = [
    ["promised_pct", num(sp.promised)], ["position_size", num(sp.pos)], ["k_pct", num(sp.k)], ["offer_price_pct", num(sp.price)],
  ];
  const inputs: ReportInputs = Object.fromEntries(
    raw.filter(([k, v]) => v !== undefined && (k !== "promised_pct" || v > 0) && inputsSchema.safeParse({ [k]: v }).success), // «обещали 0%» — не обещание
  );
  return { q, inputs };
}

export default async function ChatPage({ searchParams }: { searchParams: Promise<Search> }) {
  if (process.env.SO_CHAT === "0") notFound(); // фичефлаг ассистентного слоя
  // Строка статуса: что реально отвечает (без ключей — mock) и кто маршрутизирует (Jev или правила).
  // Только имена провайдеров/моделей, никаких значений из .env.
  const jev = jevProvider();
  const status = isMock()
    ? "Режим MOCK: скриптовая модель, ключи не заданы — расход $0"
    : `Модель: ${modelLabel()} · маршрутизация: ${jev ? `Jev (${jev})` : "правила без Jev"}`;
  return <ChatApp status={status} mock={isMock()} initial={initialOf(await searchParams)} />;
}
