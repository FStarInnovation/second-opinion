import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChatApp } from "@/components/ChatApp";

export const metadata: Metadata = { title: "Ассистент · Second opinion" };

export default function ChatPage() {
  if (process.env.SO_CHAT === "0") notFound(); // фичефлаг ассистентного слоя
  return <ChatApp />;
}
