import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReportInputs } from "@so/engine/contract";
import { ChatApp, type ChatInitial } from "@/components/ChatApp";
import { isMock } from "@/lib/model";
import { inputsSchema } from "@/lib/tools";

export const metadata: Metadata = { title: "Ассистент · Second opinion", alternates: { canonical: "/chat" } };

export const dynamic = "force-dynamic"; // фичефлаг и режим MOCK читаются из окружения при каждом запросе

type Search = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const num = (v: string | string[] | undefined) => {
  const s = str(v);
  if (!s) return undefined;
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
};

/** Длина текста первого сообщения с главной (?m=…) */
const M_MAX = 500;

/** Вход в чат — недоверенный ввод, невалидное игнорируется (не ошибка):
 *  (1) переход «отчёт → ассистент»: /chat?q=…&promised=…&pos=…&k=…&price=… (как у /check). q — до 200 символов (как /api/report),
 *      числа — поодиночке через схему set_inputs. Есть q — решает только он, m не смотрим (приоритет у q).
 *  (2) вопрос с главной: /chat?m=<текст> — первое сообщение пользователя как есть (trim, до M_MAX символов; пустое — без автоотправки).
 *      Проверяется только длина: дальше это обычная реплика — гейт и модель разбирают её как любой ввод. */
function initialOf(sp: Search): ChatInitial | undefined {
  const q = str(sp.q).trim();
  if (q) {
    if (q.length > 200) return undefined;
    const raw: [keyof ReportInputs, number | undefined][] = [
      ["promised_pct", num(sp.promised)], ["position_size", num(sp.pos)], ["k_pct", num(sp.k)], ["offer_price_pct", num(sp.price)],
    ];
    const inputs: ReportInputs = Object.fromEntries(
      raw.filter(([k, v]) => v !== undefined && (k !== "promised_pct" || v > 0) && inputsSchema.safeParse({ [k]: v }).success), // «обещали 0%» — не обещание
    );
    return { q, inputs };
  }
  const text = str(sp.m).trim();
  return text && text.length <= M_MAX ? { text } : undefined;
}

export default async function ChatPage({ searchParams }: { searchParams: Promise<Search> }) {
  if (process.env.SO_CHAT === "0") notFound(); // фичефлаг ассистентного слоя
  // Строки «модель · маршрутизация» в интерфейсе нет: пользователю она не нужна. Остаётся только бейдж режима MOCK (разработка).
  return <ChatApp mock={isMock()} initial={initialOf(await searchParams)} />;
}
