import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@so/blocks/styles.css";
import "./chat.css";

export const metadata: Metadata = {
  title: "Second opinion · Атремус",
  description: "Проверь, что тебе продают: реальная доходность, ликвидность, риски и Product Truth Score облигации на данных Мосбиржи.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
