/**
 * Главная: прямой путь постановки без LLM — форма «проверь бумагу» → /check.
 * Ассистентный слой — отдельной ссылкой (/chat), за фичефлагом.
 */
import Link from "next/link";
import { SiteHeader } from "@so/blocks";

const EXAMPLES = [
  { label: "РОЛЬФ 1Р07, обещали 26%", q: "RU000A10ASE2", promised: 26 },
  { label: "ВЭБ.РФ 21, обещали 18%", q: "RU000A0JS4Z7", promised: 18 },
  { label: "ОФЗ 26238", q: "RU000A1038V6" },
  { label: "Черкизово (выбор выпуска)", q: "Черкизово" },
  { label: "ЧеркизБ1P6 (нет цены)", q: "RU000A105M67" },
];

export default function Home() {
  const chatOn = process.env.SO_CHAT !== "0";
  return (
    <div className="so">
      <SiteHeader homeHref="/" />
      <main className="so-main so-main--narrow" style={{ gap: 28 }}>
        <div className="so-title">
          <span className="so-title__kind">Second opinion · облигации</span>
          <h1>Проверь, что тебе продают</h1>
          <p className="text" style={{ fontSize: 17, maxWidth: 640 }}>
            Вставьте ISIN, название выпуска или ссылку на бумагу — покажем реальную доходность, ликвидность,
            комиссии и налог, worst-case и Product Truth Score по данным Мосбиржи. Без регистрации.
          </p>
        </div>

        <form className="card" action="/check" method="get" style={{ gap: 14 }}>
          <div className="inputs__field">
            <label htmlFor="q" className="lbl">Бумага</label>
            <input id="q" name="q" className="inp" required autoComplete="off" placeholder="RU000A10ASE2, РОЛЬФ 1Р07 или ссылка" />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
            <div className="inputs__field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="promised" className="cap">Сколько обещали, % годовых (не обязательно)</label>
              <input id="promised" name="promised" className="inp" inputMode="decimal" autoComplete="off" placeholder="например, 26" />
            </div>
            <button type="submit" className="btn btn-primary btn-lg" style={{ flex: "0 0 auto" }}>Проверить</button>
          </div>
        </form>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span className="cap">Примеры:</span>
          {EXAMPLES.map((e) => (
            <Link key={e.label} className="btn btn-outline" href={`/check?q=${encodeURIComponent(e.q)}${e.promised ? `&promised=${e.promised}` : ""}`}>
              {e.label}
            </Link>
          ))}
        </div>

        {chatOn ? (
          <section className="card" style={{ background: "#eef3fa", borderColor: "#c9d6ea" }}>
            <h2>Спросить ассистента</h2>
            <p className="text">
              Можно проверить бумагу в диалоге: назвать выпуск, сумму, комиссию и что обещал продавец — ассистент соберёт
              те же блоки отчёта и объяснит термины. Все числа считает движок, ассистент их не придумывает.
            </p>
            <Link className="btn btn-primary" href="/chat" style={{ alignSelf: "flex-start" }}>Открыть чат</Link>
          </section>
        ) : null}

        <p className="cap">Не является индивидуальной инвестиционной рекомендацией. Данные Мосбиржи с задержкой до 15 минут.</p>
      </main>
    </div>
  );
}
