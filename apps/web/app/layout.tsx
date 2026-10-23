import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@so/blocks/styles.css";
import "./chat.css";
import { OPEN_GRAPH, SITE, SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";
import { Metrika } from "./metrika";

/**
 * Метаданные по умолчанию для всех страниц: абсолютные адреса — от SITE (lib/site.ts), Open Graph и Twitter-карточка.
 * Картинки — по соглашению файлов Next: opengraph-image.png (1200×630), icon.svg, apple-icon.png (180×180) рядом.
 * canonical — у каждой страницы свой (page.tsx / check / chat).
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  openGraph: OPEN_GRAPH,
  twitter: { card: "summary_large_image", title: SITE_NAME, description: SITE_DESCRIPTION },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

/** Номер счётчика Метрики — только из окружения сборки; без него Метрики нет совсем */
const YM_ID = process.env.NEXT_PUBLIC_YM_ID;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" />
      </head>
      <body>
        {children}
        {YM_ID ? <Metrika id={YM_ID} /> : null}
      </body>
    </html>
  );
}
