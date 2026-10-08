import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChatApp } from "@/components/ChatApp";
import { isMock, modelLabel } from "@/lib/model";
import { jevProvider } from "@/lib/jev";

export const metadata: Metadata = { title: "Ассистент · Second opinion" };

export const dynamic = "force-dynamic"; // статус читает окружение при каждом запросе

export default function ChatPage() {
  if (process.env.SO_CHAT === "0") notFound(); // фичефлаг ассистентного слоя
  // Строка статуса: что реально отвечает (без ключей — mock) и кто маршрутизирует (Jev или правила).
  // Только имена провайдеров/моделей, никаких значений из .env.
  const jev = jevProvider();
  const status = isMock()
    ? "Режим MOCK: скриптовая модель, ключи не заданы — расход $0"
    : `Модель: ${modelLabel()} · маршрутизация: ${jev ? `Jev (${jev})` : "правила без Jev"}`;
  return <ChatApp status={status} mock={isMock()} />;
}
