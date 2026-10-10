/**
 * Главная: первый экран — две карточки входа рядом: прямой путь без LLM (форма «проверь бумагу» → /check, главное действие)
 * и ассистент (/chat?m=…, за фичефлагом SO_CHAT; вторичное действие — заметен, но не конкурирует). Ниже — «Что покажем»,
 * FAQ «Как мы считаем» и подвал. Числа FAQ — из CONFIG движка (packages/engine/src/config.ts), правила — из metrics.ts /
 * iss/facts.ts / inputs.ts: правка весов и порогов меняет текст здесь сама. Термины поясняются словами при первом упоминании.
 * Названия моделей и провайдеров на странице не упоминаются.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { SiteHeader } from "@so/blocks";
import { CONFIG } from "@so/engine/config";
import { fmtMax, rub } from "@so/engine/format";

const EXAMPLES = [
  { label: "РОЛЬФ 1Р07, обещали 26%", q: "RU000A10ASE2", promised: 26 },
  { label: "ВЭБ.РФ 21, обещали 18%", q: "RU000A0JS4Z7", promised: 18 },
  { label: "ОФЗ 26238", q: "RU000A1038V6" },
  { label: "Черкизово (выбор выпуска)", q: "Черкизово" },
  { label: "ЧеркизБ1P6 (нет цены)", q: "RU000A105M67" },
];

/** Примеры вопросов ассистенту: /chat?m=<текст> — автоотправка первым сообщением (app/chat/page.tsx) */
const ASK = ["Что такое НКД?", "Проверь РОЛЬФ 1Р07, обещали 26%", "Чем облигация отличается от депозита?"];

const FEATURES = [
  { t: "Доходность и «обещали»", d: "Реальная доходность и разница с обещанной" },
  { t: "Ликвидность", d: "Оборот, спред и сколько дней продавать позицию" },
  { t: "Комиссии и налог", d: "Доходность после комиссии брокера и НДФЛ" },
  { t: "Worst-case", d: "Рост ставок и дефолт — в рублях на вашу позицию" },
  { t: "Product Truth Score", d: "100 баллов минус штрафы за 15 red flags" },
];

const F = CONFIG.flags;
const n = (x: number) => fmtMax(x, 2); // «2,5», «1 000» — как в отчёте
const pct = (share: number) => fmtMax(share * 100, 2) + "%";
const mlnRub = (x: number) => fmtMax(x / 1e6, 2) + " млн ₽";

/** Правила Product Truth Score — metrics.ts flags() (15 правил), веса и пороги — CONFIG.flags; по убыванию веса */
const RULES: [string, string][] = [
  ["Дефолт в истории выпуска", `−${F.defaultPts}`],
  ["Бумага не торгуется на бирже", `−${F.notTradedPts}`],
  ["Бессрочная облигация", `−${F.perpetualPts}`],
  ["Структурный продукт", `−${F.structuredPts}`],
  [`Обещали выше расчётной: больше чем на ${n(F.gapPp)} п.п. / на ${n(F.gapHighPp)} п.п.`, `−${F.gapPts} / −${F.gapHighPts}`],
  // GSPREADBP — в базисных пунктах (б.п.): 100 б.п. = 1 п.п.
  [`G-спред (премия к доходности ОФЗ того же срока) больше ${n(F.premiumBp / 100)} п.п. / ${n(F.premiumHighBp / 100)} п.п. (${n(F.premiumBp)} / ${n(F.premiumHighBp)} б.п.), кроме флоатеров`, `−${F.premiumPts} / −${F.premiumHighPts}`],
  [`Неликвидный выпуск: оборот меньше ${mlnRub(F.illiqTurnover)} или меньше ${F.illiqTrades} сделок в день`, `−${F.illiqPts}`],
  [`Эмитент может погасить досрочно (колл) / колл в ближайшие ${F.callSoonDays} дней`, `−${F.callPts} / −${F.callSoonPts}`],
  ["Только для квалифицированных инвесторов", `−${F.qualPts}`],
  ["Третий (низший) уровень листинга", `−${F.listPts}`],
  [`Спред больше ${n(F.spreadPct)}% или в стакане нет встречных заявок`, `−${F.spreadPts}`],
  [`Дюрация (средний срок до выплат) больше ${F.longDurYears} лет — цена сильно зависит от ставок; кроме флоатеров`, `−${F.longDurPts}`],
  ["Ставка после оферты неизвестна", `−${F.resetPts}`],
  ["Номинал не в рублях", `−${F.fxPts}`],
  ["Плавающий купон (флоатер)", `−${F.floatPts}`],
];

/** FAQ «Как мы считаем». Числа — из CONFIG; правила — packages/engine/src/metrics.ts, iss/facts.ts, inputs.ts. */
function faq(chatOn: boolean): { q: string; a: ReactNode }[] {
  const S = CONFIG.scenarios;
  const L = CONFIG.liq;
  const G = CONFIG.grades;
  const items: { q: string; a: ReactNode }[] = [
    {
      q: "Откуда данные?",
      a: (
        <p>
          Из открытого API Мосбиржи (ISS): карточка выпуска, котировки и доходности, график купонов, амортизаций и оферт,
          итоги торгов за последние {L.windowDays} календарных дней — из них берём до 20 последних торговых. Данные приходят
          с задержкой до 15 минут, время среза указано в каждом отчёте. Если у бумаги нет биржевой цены, можно ввести цену,
          по которой её предлагают, — отчёт пересчитается от неё.
        </p>
      ),
    },
    {
      // metrics.ts yieldModel: main = moexY (useMoex) | own; гейт controlFailPp; yield-to-worst (б) — main = call.y, горизонт — колл
      q: "Как считаем доходность?",
      a: (
        <>
          <p>
            Главная цифра — эффективная доходность Мосбиржи от средневзвешенной цены к той дате, к которой её считает биржа:
            погашению, оферте (дате, когда бумагу можно предъявить эмитенту к выкупу) или коллу (праву эмитента погасить
            выпуск досрочно).
          </p>
          <p>
            Сами мы пересчитываем её по графику выплат — это контроль. Если он расходится с биржей больше чем на{" "}
            {n(CONFIG.controlFailPp)} процентных пунктов (п.п.), показываем только биржевую и пишем об этом, а комиссии,
            налог и доходность к коллу не считаем.
          </p>
          <p>
            Свой расчёт главный для вашей цены, валютных выпусков и флоатеров (облигаций с плавающим купоном), а также
            когда у биржи нет доходности к показанной цене или своя доходность к коллу ниже биржевой.
          </p>
        </>
      ),
    },
    {
      q: "Что значит «обещали»?",
      a: (
        <p>
          Это доходность в процентах годовых, которую назвал продавец; сравниваем её с расчётной. Если обещали больше
          расчётной чем на {n(F.gapPp)} п.п. — минус {F.gapPts} баллов Product Truth Score, больше чем на{" "}
          {n(F.gapHighPp)} п.п. — минус {F.gapHighPts}.
          {chatOn ? " Ставку «в месяц» или «за квартал» ассистент переводит в годовые — умножает на 12 или на 4." : null}
        </p>
      ),
    },
    {
      q: "Как учитываем комиссии и налог?",
      a: (
        <p>
          Комиссия брокера — в процентах от суммы покупки, от 0 до {n(CONFIG.kMax)}%: она увеличивает цену покупки и
          снижает доходность. НДФЛ {pct(CONFIG.tax)} — с купонов и с разницы между погашением и ценой покупки; доходность
          после налога считаем по выплатам за вычетом налога. Льготы ИИС и долгосрочного владения не учитываем. НКД — не
          комиссия: вы платите его продавцу при покупке и получаете обратно с ближайшим купоном.
        </p>
      ),
    },
    {
      q: "Как оцениваем ликвидность?",
      a: (
        <p>
          Берём средний дневной оборот и число сделок за последние торговые дни (до 20). Оборот больше{" "}
          {mlnRub(L.goodTurnover)} в день — ликвидность «норм», от {mlnRub(L.midTurnover)} — «умеренно», меньше или
          сделок не было — «низкая». Моментальный выход стоит примерно половину спреда — разницы между лучшими ценами
          продажи и покупки в стакане заявок, в процентах от средневзвешенной цены. Аккуратный выход — сколько дней
          продавать позицию, если каждый день продавать не больше {pct(L.dayShare)} среднего дневного оборота.
        </p>
      ),
    },
    {
      // metrics.ts worst(): dmod = дюрация / (1 + доходность), потери d1 = dmod, d3 = 3 × dmod; текст — inputs.ts worstRatesText (горизонт ym.h)
      q: "Что входит в worst-case?",
      a: (
        <ul className="faq__list">
          <li>
            <b>Рост ставок на 1 и 3 п.п.</b> Цена падает примерно на модифицированную дюрацию — на сколько процентов цена
            меняется при сдвиге ставок на 1 п.п. (при дюрации 5 — около −5% и −15%). Убыток — в рублях на вашу позицию
            (по умолчанию {rub(CONFIG.positionDefault)}); если держать до погашения, оферты или колла — срока, к которому
            посчитана доходность, — его не будет.
          </li>
          <li><b>Дефолт эмитента.</b> Можно потерять до всей суммы.</li>
          <li><b>Колл.</b> Доходность при досрочном погашении; если до него меньше {F.callSoonDays} дней — доход за этот срок.</li>
          <li>
            <b>Флоатер.</b> Цена от ставок почти не зависит, доходность — в трёх сценариях: ставки не изменятся, снизятся
            на {n(-S.down.delta)} п.п. за год, останутся высокими дольше.
          </li>
          <li><b>Валютный выпуск.</b> Потеря при укреплении рубля на {pct(CONFIG.fxShock)}.</li>
        </ul>
      ),
    },
    {
      q: "Как устроен Product Truth Score?",
      a: (
        <>
          <p>100 минус баллы сработавших red flags, но не ниже 0. Правила одинаковые для всех бумаг — их {RULES.length}:</p>
          <ul className="faq__rules">
            {RULES.map(([t, p]) => (
              <li key={t}>{t} — <b>{p}</b></li>
            ))}
          </ul>
          <p>
            Итог: от {G[0][0]} баллов — «{G[0][1]}», от {G[1][0]} — «{G[1][1]}», от {G[2][0]} — «{G[2][1]}», ниже{" "}
            {G[2][0]} — «{G[3][1]}».
          </p>
        </>
      ),
    },
  ];
  if (chatOn)
    items.push({
      q: "Что делает ассистент?",
      a: (
        <p>
          Отвечает на вопросы по отчёту и объясняет термины; назовите бумагу — соберёт тот же отчёт, что и форма проверки.
          Все числа — расчёт по данным Мосбиржи: ассистент их не придумывает и не пересчитывает, а показывает и объясняет.
          Сумму, комиссию брокера и что обещал продавец можно сказать словами: «вложу 300 тысяч», «комиссия 0,3%»,
          «обещали 2% в месяц».
        </p>
      ),
    });
  items.push({
    q: "Чего мы не делаем?",
    a: (
      <p>
        Не даём индивидуальных инвестиционных рекомендаций: отчёт показывает факты и риски, решение — за вами. У
        структурных облигаций (выплата зависит от базового актива) и бессрочных (нет даты погашения) доходность не
        считаем — показываем, что это за продукт, ликвидность и red flags. Льготы ИИС и долгосрочного владения в налоге
        не учитываем.
      </p>
    ),
  });
  return items;
}

export default function Home() {
  const chatOn = process.env.SO_CHAT !== "0";
  return (
    <div className="so">
      <SiteHeader homeHref="/" />
      <main className="so-main home">
        <div className="so-title">
          <span className="so-title__kind">Second opinion · облигации</span>
          <h1>Проверь, что тебе продают</h1>
          <p className="home__sub">Реальная доходность, ликвидность, комиссии и риски облигации по данным Мосбиржи. Без регистрации.</p>
        </div>

        {/* Первый экран: форма проверки (шире, единственная заливная кнопка) и вход в ассистента рядом;
            без чата форма — на всю ширину (в сетке один элемент) */}
        <div className="grid-2 home-grid">
          <form className="card home-card" action="/check" method="get" aria-labelledby="check-h">
            <h2 id="check-h">Проверить бумагу</h2>
            <div className="home-field">
              <label htmlFor="q" className="lbl">Бумага</label>
              <input id="q" name="q" className="inp" required autoComplete="off" placeholder="ISIN, название выпуска или ссылка" />
            </div>
            <div className="home-row">
              <div className="home-field">
                <label htmlFor="promised" className="lbl">Сколько обещали, % годовых <span className="home-opt">(необязательно)</span></label>
                <input id="promised" name="promised" className="inp" inputMode="decimal" autoComplete="off" placeholder="например, 26" />
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
              <p className="text">
                Ассистент соберёт отчёт и объяснит термины. Числа он не придумывает — только расчёт по данным Мосбиржи.
              </p>
              <form className="home-row" action="/chat" method="get">
                <div className="home-field">
                  <label htmlFor="m" className="lbl">Вопрос или бумага</label>
                  <input id="m" name="m" className="inp" maxLength={500} autoComplete="off" placeholder="Например: что такое оферта?" />
                </div>
                <button type="submit" className="btn btn-outline btn-lg">Открыть чат</button>
              </form>
              <div className="home-examples">
                <span className="cap">Примеры:</span>
                {ASK.map((t) => (
                  <Link key={t} className="btn btn-outline" href={`/chat?m=${encodeURIComponent(t)}`}>{t}</Link>
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
            {faq(chatOn).map((x) => (
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
          <p className="cap">Не является индивидуальной инвестиционной рекомендацией.</p>
          <p className="cap">Данные Мосбиржи с задержкой до 15 минут.</p>
        </div>
      </footer>
    </div>
  );
}
