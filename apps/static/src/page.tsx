/**
 * Оболочка HTML-страницы. Константы дизайна и разметка — без единого факта о бумаге:
 * факты попадают только в title, SSR-разметку #root и JSON в #so-data (их валидатор вырезает
 * перед поиском фактов в шаблоне).
 */
import { renderToString } from "react-dom/server";
import type { BuildResultT } from "@so/engine/contract";
import { ResultApp } from "@so/blocks";

export interface PageData {
  result: BuildResultT;
  home: string;
  links: Record<string, string>;
}

export const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonForScript = (x: unknown) => JSON.stringify(x).replace(/</g, "\\u003c");

export function titleOf(res: BuildResultT): string {
  if (res.kind === "report") return `${res.report.security.shortname} · Second opinion`;
  if (res.kind === "pick") return "Уточните выпуск · Second opinion";
  if (res.kind === "notfound") return "Не нашли бумагу · Second opinion";
  return "Second opinion";
}

export function renderPage(data: PageData, assetsPrefix: string): string {
  const html = renderToString(
    <ResultApp result={data.result} homeHref={data.home} hrefFor={(secid) => data.links[secid] ?? null} />,
  );
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titleOf(data.result))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONT_HREF}">
<link rel="stylesheet" href="${assetsPrefix}blocks.css">
</head>
<body>
<div id="root">${html}</div>
<script type="application/json" id="so-data">${jsonForScript(data)}</script>
<script src="${assetsPrefix}client.js"></script>
</body>
</html>
`;
}
