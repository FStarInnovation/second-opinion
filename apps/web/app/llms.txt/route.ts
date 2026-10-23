/**
 * /llms.txt (llmstxt.org): что это за сервис — для ассистентов и поисковиков на LLM. Только тексты страниц: описание сайта
 * (lib/site.ts), первый экран, «Что покажем», FAQ «Как мы считаем» и подвал главной (app/home-content.tsx — та же копия,
 * что на странице). Ссылки — абсолютные, на основной домен. Статический: собирается при next build, как главная.
 */
import { FEATURES, HOME, faq } from "@/app/home-content";
import { nodeText } from "@/lib/node-text";
import { SITE, SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

export const dynamic = "force-static";

export function GET(): Response {
  const chatOn = process.env.SO_CHAT !== "0"; // как на главной: без чата нет ни карточки ассистента, ни /chat
  const lines = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    `${HOME.h1}. ${HOME.sub}`,
    "",
    "## Страницы",
    "",
    `- [Главная](${SITE}/): форма «Проверить бумагу», «Что покажем» и FAQ «Как мы считаем»`,
    `- [Проверка бумаги](${SITE}/check): отчёт по облигации; q — ISIN, название выпуска или ссылка, promised — сколько обещали, % годовых (необязательно), например ${SITE}/check?q=RU000A1038V6`,
    ...(chatOn ? [`- [Ассистент](${SITE}/chat): ${HOME.ask}`] : []),
    "",
    "## Что покажем",
    "",
    ...FEATURES.map((f) => `- ${f.t}: ${f.d}`),
    "",
    "## Как мы считаем",
    "",
    ...faq(chatOn).flatMap(({ q, a }) => [`### ${q}`, "", nodeText(a), ""]),
    ...HOME.foot,
  ];
  return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
}
