import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { initialOf, type EntryParams } from "@so/present/entry";
import { ChatApp } from "@/components/ChatApp";
import { isMock } from "@/lib/model";

export const metadata: Metadata = { title: "Ассистент · Second opinion" };

export const dynamic = "force-dynamic"; // фичефлаг и режим MOCK читаются из окружения при каждом запросе

type Search = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Параметры входа из URL: повторённый параметр — первое значение. Разбор и проверка — initialOf (@so/present/entry):
 *  /chat?q=…&promised=…&pos=…&k=…&price=… (переход с /check) или /chat?m=… (вопрос с главной); невалидное игнорируется. */
const entryOf = (sp: Search): EntryParams =>
  ({ q: str(sp.q), promised: str(sp.promised), pos: str(sp.pos), k: str(sp.k), price: str(sp.price), m: str(sp.m) });

export default async function ChatPage({ searchParams }: { searchParams: Promise<Search> }) {
  if (process.env.SO_CHAT === "0") notFound(); // фичефлаг ассистентного слоя
  // Строки «модель · маршрутизация» в интерфейсе нет: пользователю она не нужна. Остаётся только бейдж режима MOCK (разработка).
  return <ChatApp mock={isMock()} initial={initialOf(entryOf(await searchParams))} />;
}
