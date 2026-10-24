/**
 * schema.org для главной (только «/»): WebSite + WebApplication + FAQPage одним графом.
 * FAQPage строится из тех же пунктов FAQ «Как мы считаем», что рисует app/page.tsx (props faq — тот же массив),
 * текст ответа — nodeText (lib/node-text.ts). Все адреса — основной домен (lib/site.ts).
 */
import type { FaqItem } from "@/app/home-content";
import { nodeText } from "@/lib/node-text";
import { SITE, SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

export function homeJsonLd(faq: FaqItem[]) {
  const home = `${SITE}/`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "@id": `${home}#website`, url: home, name: SITE_NAME, description: SITE_DESCRIPTION, inLanguage: "ru" },
      {
        "@type": "WebApplication", "@id": `${home}#app`, url: home, name: SITE_NAME, description: SITE_DESCRIPTION,
        // Цену и «бесплатно» не размечаем: на странице этого нет — разметка повторяет только видимый текст
        applicationCategory: "FinanceApplication", inLanguage: "ru",
      },
      {
        "@type": "FAQPage", "@id": `${home}#faq`, url: home, inLanguage: "ru",
        mainEntity: faq.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: nodeText(a) } })),
      },
    ],
  };
}

export function HomeJsonLd({ faq }: { faq: FaqItem[] }) {
  // «<» → <: текст ответа не может закрыть <script> раньше времени
  const json = JSON.stringify(homeJsonLd(faq)).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
