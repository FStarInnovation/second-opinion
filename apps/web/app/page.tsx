/**
 * Главная: первый экран — две карточки входа рядом: прямой путь без LLM (форма «проверь бумагу» → /check, главное действие)
 * и ассистент (/chat?m=…, за фичефлагом SO_CHAT; вторичное действие — заметен, но не конкурирует). Ниже — «Что покажем»,
 * FAQ «Как мы считаем» и подвал. Тексты «Что покажем», FAQ, подзаголовок и подвал — в app/home-content.tsx (их же берут
 * JSON-LD этой страницы и /llms.txt); числа FAQ — из CONFIG движка. Названия моделей и провайдеров на странице не упоминаются.
 * SEO: canonical «/» и og:url — здесь, остальное Open Graph — layout.tsx; schema.org (WebSite, WebApplication, FAQPage) —
 * components/HomeJsonLd.tsx из тех же пунктов FAQ, что рисуются ниже. data-goal — цели Метрики (app/metrika.tsx).
 * ym-hide-content ym-disable-keys — Вебвизор не записывает то, что вводит пользователь.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@so/blocks";
import { HomeJsonLd } from "@/components/HomeJsonLd";
import { OPEN_GRAPH } from "@/lib/site";
import { FEATURES, HOME, faq } from "./home-content";

export const metadata: Metadata = { alternates: { canonical: "/" }, openGraph: { ...OPEN_GRAPH, url: "/" } };

const EXAMPLES = [
  { label: "РОЛЬФ 1Р07, обещали 26%", q: "RU000A10ASE2", promised: 26 },
  { label: "ВЭБ.РФ 21, обещали 18%", q: "RU000A0JS4Z7", promised: 18 },
  { label: "ОФЗ 26238", q: "RU000A1038V6" },
  { label: "Черкизово (выбор выпуска)", q: "Черкизово" },
  { label: "ЧеркизБ1P6 (нет цены)", q: "RU000A105M67" },
];

/** Примеры вопросов ассистенту: /chat?m=<текст> — автоотправка первым сообщением (app/chat/page.tsx) */
const ASK = ["Что такое НКД?", "Проверь РОЛЬФ 1Р07, обещали 26%", "Чем облигация отличается от депозита?"];

export default function Home() {
  const chatOn = process.env.SO_CHAT !== "0";
  const items = faq(chatOn); // одни и те же пункты — в FAQ ниже и в FAQPage JSON-LD
  return (
    <div className="so">
      <HomeJsonLd faq={items} />
      <SiteHeader homeHref="/" />
      <main className="so-main home">
        <div className="so-title">
          <span className="so-title__kind">Second opinion · облигации</span>
          <h1>{HOME.h1}</h1>
          <p className="home__sub">{HOME.sub}</p>
        </div>

        {/* Первый экран: форма проверки (шире, единственная заливная кнопка) и вход в ассистента рядом;
            без чата форма — на всю ширину (в сетке один элемент) */}
        <div className="grid-2 home-grid">
          <form className="card home-card" action="/check" method="get" aria-labelledby="check-h" data-goal="check_submit">
            <h2 id="check-h">Проверить бумагу</h2>
            <div className="home-field">
              <label htmlFor="q" className="lbl">Бумага</label>
              <input id="q" name="q" className="inp ym-hide-content ym-disable-keys" required autoComplete="off" placeholder="ISIN, название выпуска или ссылка" />
            </div>
            <div className="home-row">
              <div className="home-field">
                <label htmlFor="promised" className="lbl">Сколько обещали, % годовых <span className="home-opt">(необязательно)</span></label>
                <input id="promised" name="promised" className="inp ym-hide-content ym-disable-keys" inputMode="decimal" autoComplete="off" placeholder="например, 26" />
              </div>
              <button type="submit" className="btn btn-primary btn-lg">Проверить</button>
            </div>
            <div className="home-examples">
              <span className="cap">Примеры:</span>
              {EXAMPLES.map((e) => (
                <Link key={e.label} className="btn btn-outline" href={`/check?q=${encodeURIComponent(e.q)}${e.promised ? `&promised=${e.promised}` : ""}`}>
                  {e.label}
                </Link>
              ))}
            </div>
          </form>

          {chatOn ? (
            <section className="card home-card home-ask" aria-labelledby="ask-h">
              <h2 id="ask-h">Спросить ассистента</h2>
              <p className="text">{HOME.ask}</p>
              <form className="home-row" action="/chat" method="get" data-goal="chat_open">
                <div className="home-field">
                  <label htmlFor="m" className="lbl">Вопрос или бумага</label>
                  <input id="m" name="m" className="inp ym-hide-content ym-disable-keys" maxLength={500} autoComplete="off" placeholder="Например: что такое оферта?" />
                </div>
                <button type="submit" className="btn btn-outline btn-lg">Открыть чат</button>
              </form>
              <div className="home-examples">
                <span className="cap">Примеры:</span>
                {ASK.map((t) => (
                  <Link key={t} className="btn btn-outline" href={`/chat?m=${encodeURIComponent(t)}`} data-goal="chat_open">{t}</Link>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <section className="home-sec" aria-labelledby="what-h">
          <h2 id="what-h" className="home-h2">Что покажем</h2>
          <ul className="home-features">
            {FEATURES.map((f) => (
              <li key={f.t}><b>{f.t}</b><span>{f.d}</span></li>
            ))}
          </ul>
        </section>

        <section className="home-sec" aria-labelledby="faq-h">
          <h2 id="faq-h" className="home-h2">Как мы считаем</h2>
          <div className="faq">
            {items.map((x) => (
              <details key={x.q}>
                <summary>{x.q}</summary>
                <div className="faq__a">{x.a}</div>
              </details>
            ))}
          </div>
        </section>
      </main>
      <footer className="so-foot">
        <div className="so-foot__in">
          {HOME.foot.map((t) => <p key={t} className="cap">{t}</p>)}
        </div>
      </footer>
    </div>
  );
}
