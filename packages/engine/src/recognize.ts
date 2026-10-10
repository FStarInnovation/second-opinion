/**
 * Распознавание ввода по правилам 2.3.0 (сводная постановка):
 * ссылка → ISIN/SECID → рег. номер → номер программы → название.
 * Правила применяются по порядку, первое сработавшее останавливает перебор;
 * поиск — /iss/securities.json?q=, только group = stock_bonds.
 * Распознавание возвращает тип продукта (пока только bond) — задел под линейку.
 */
import { issJson, rows, q, type FetchOptions } from "./iss/client";

export type Recognized =
  | { kind: "bond"; secid: string; product_type: "bond" }
  | { kind: "pick"; candidates: Candidate[]; note: string }
  | { kind: "notfound"; isinValid: boolean }
  | { kind: "err"; msg: string };

export interface Candidate {
  secid: string; isin: string | null; shortname: string; regnumber: string | null;
  is_traded: boolean; emitent_title: string | null;
}

interface SearchRow {
  secid: string; shortname: string; regnumber: string | null; name: string;
  isin: string | null; is_traded: number; emitent_title: string | null;
  type: string; group: string;
}

async function search(text: string, opts: FetchOptions): Promise<SearchRow[]> {
  const doc = await issJson(q.search(text), opts);
  return rows<SearchRow>(doc, "securities").filter((r) => r.group === "stock_bonds");
}

const toCandidate = (r: SearchRow): Candidate => ({
  secid: r.secid, isin: r.isin, shortname: r.shortname, regnumber: r.regnumber,
  is_traded: r.is_traded === 1, emitent_title: r.emitent_title,
});

function outcome(hits: SearchRow[], isinValid: boolean): Recognized {
  if (hits.length === 1) return { kind: "bond", secid: hits[0].secid, product_type: "bond" };
  if (hits.length > 1)
    return {
      kind: "pick",
      candidates: hits
        .map(toCandidate)
        .sort((a, b) => Number(b.is_traded) - Number(a.is_traded))
        .slice(0, 20),
      note: "Уточните выпуск",
    };
  return { kind: "notfound", isinValid };
}

export async function recognize(input: string, opts: FetchOptions = {}): Promise<Recognized> {
  const raw = String(input ?? "").trim();
  if (!raw) return { kind: "err", msg: "Пустой запрос" };

  // 1. Ссылка: достаём ISIN или code=, страницы сайтов не парсим
  const isUrl = /^(https?:\/\/|www\.)|[a-z0-9-]+\.(ru|com|org|net)(\/|$)/i.test(raw);
  let id: string | null = null;
  const mIsin = raw.toUpperCase().match(/RU[0-9A-Z]{10}/);
  const mCode = raw.match(/[?&]code=([A-Za-z0-9]+)/);
  if (mIsin) id = mIsin[0];
  else if (mCode) id = mCode[1].toUpperCase();
  if (isUrl && !id)
    return {
      kind: "err",
      msg: "В ссылке нет ISIN. Подойдёт ссылка, в адресе которой есть ISIN (страница Мосбиржи или брокера), либо сам ISIN или название выпуска. Страницы сайтов мы пока не разбираем.",
    };

  // 2–3. ISIN / SECID: точное совпадение; у ОФЗ SECID ≠ ISIN, резолв всегда через поиск (П4)
  if (!id && /^SU[0-9A-Z]{10}$/i.test(raw)) id = raw.toUpperCase();
  if (id) {
    const hits = await search(id, opts);
    const exact = hits.filter((r) => r.isin === id || r.secid === id);
    if (exact.length >= 1) return { kind: "bond", secid: exact[0].secid, product_type: "bond" };
    return { kind: "notfound", isinValid: /^(RU|SU)[0-9A-Z]{10}$/.test(id) };
  }

  // 4. Рег. номер выпуска: точное совпадение regnumber
  if (/^[0-9][0-9A-Za-zБ]*-/.test(raw) && raw.includes("-")) {
    const hits = await search(raw, opts);
    const exact = hits.filter(
      (r) => (r.regnumber ?? "").toUpperCase() === raw.toUpperCase(),
    );
    if (exact.length) return outcome(exact, false);
    // 5. Номер программы: ISS его не знает, а поиск матчит regnumber только с начала
    //    строки (проверено 08.10.2026) — перебираем 4B02-01-… … 4B02-30-…, как в постановке
    const m = raw.match(/^\d+-\d+-(\w{5})-(\w)(?:-(\d{3}\w))?$/i);
    if (m) {
      const code = m[1].toUpperCase(), letter = m[2].toUpperCase(), prog = m[3]?.toUpperCase() ?? null;
      const found: SearchRow[] = [];
      for (let i = 1; i <= 30; i++) {
        const ii = String(i).padStart(2, "0");
        const hits2 = await search(`4B02-${ii}-${code}`, opts);
        for (const r of hits2) {
          const rn = (r.regnumber ?? "").toUpperCase();
          if (rn.startsWith(`4B02-${ii}-${code}-${letter}`) && (!prog || rn.endsWith(`-${prog}`)))
            if (!found.some((f) => f.secid === r.secid)) found.push(r);
        }
      }
      if (found.length) return outcome(found, false);
    }
    return { kind: "notfound", isinValid: false };
  }

  // 5а. ОФЗ по номеру выпуска: «ОФЗ-26243-ПД», «ОФЗ 26243», «офз26243» — ISS ищет по словам, и дефисное
  //     «ОФЗ-26243-ПД» для него одно слово без совпадений (08.10.2026). Пятизначный номер сам по себе
  //     находит ровно одну бумагу типа ofz_bond.
  const ofz = raw.match(/^\s*(?:ОФЗ|OFZ)\s*[-–—]?\s*(?:П[ДКВ]|ИН|АД)?\s*[-–—]?\s*(\d{5})\b/i) ?? raw.match(/\b(\d{5})\b.*(?:ОФЗ|OFZ)/i);
  if (ofz) {
    const hits0 = (await search(ofz[1], opts)).filter((r) => r.type === "ofz_bond");
    if (hits0.length === 1) return { kind: "bond", secid: hits0[0].secid, product_type: "bond" };
  }

  // 6. Название выпуска или эмитента: точное совпадение shortname → одна бумага, иначе список.
  //    Если ISS ничего не нашёл, повторяем с дефисами/точками → пробелы («ЧеркизБ1P7» ≠ «Черкиз-Б1P7»).
  let hits = await search(raw, opts);
  if (hits.length === 0) {
    const spaced = raw.replace(/[-–—_./]+/g, " ").replace(/\s+/g, " ").trim();
    if (spaced !== raw) hits = await search(spaced, opts);
  }
  const exact = hits.filter((r) => r.shortname.toLowerCase() === raw.toLowerCase());
  if (exact.length === 1) return { kind: "bond", secid: exact[0].secid, product_type: "bond" };
  // Совпадение без учёта пробелов/дефисов/регистра: «ОФЗ 26243 ПД» ⊇ «ОФЗ 26243», «Черкиз Б1P7» = «ЧеркизБ1P7»
  const norm = (t: string) => t.toLowerCase().replace(/[^a-zа-яё0-9]/gi, "");
  const nq = norm(raw);
  const loose = hits.filter((r) => { const ns = norm(r.shortname); return ns.length >= 5 && (ns === nq || nq.includes(ns)); });
  if (loose.length === 1) return { kind: "bond", secid: loose[0].secid, product_type: "bond" };
  return outcome(hits, false);
}
