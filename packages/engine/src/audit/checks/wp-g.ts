/** WP-G — проверки по docs/AUDIT_PLAN_2026-10-09.md. Каждая утверждает ЖЕЛАЕМОЕ поведение; до правки — RED. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GOLDEN_DIR, REPO_ROOT, buildFixture, buildGolden, expect, fail, facts, readSrc, reportOf, snapshotRows,
  type Check,
} from "../lib";
import { CONFIG } from "../../config";
import { flags, liquidity, yieldModel } from "../../metrics";
import { applyInputs } from "../../inputs";
import { assembleReport } from "../../report";
import type { BondReportT } from "../../contract";

const C = CONFIG.flags;
const POS = CONFIG.positionDefault;
const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10);
const flagOf = (r: BondReportT, id: number) => r.flags.find((f) => f.id === id)!;
/** «2,0» / «5,01» (ru-RU, возможен NBSP) → число */
const ru = (s: string) => Number(s.replace(/[\s  ]/g, "").replace("−", "-").replace(",", "."));

/** Тело экспортируемой функции-блока в blocks.tsx (от «export function Name» до следующего export) */
function fnBody(src: string, name: string): string {
  const i = src.indexOf("export function " + name);
  if (i < 0) throw new Error(`в blocks.tsx нет export function ${name}`);
  const j = src.indexOf("\nexport ", i + 1);
  return src.slice(i, j < 0 ? undefined : j);
}

/** Снять комментарии — строчные (две косые черты до конца строки) и блочные (косая-звёздочка … звёздочка-косая) — с учётом
 *  строковых литералов в одинарных, двойных кавычках и обратных апострофах (экранирование обратной косой учитывается).
 *  Не распознаёт regex-литералы (косая черта внутри них может быть принята за начало комментария) — в телах Claim/FlagsScore их нет. */
function stripComments(src: string): string {
  let out = "";
  let q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (q) {
      out += c;
      if (c === "\\" && n != null) { out += n; i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { q = c; out += c; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; i--; continue; }
    if (c === "/" && n === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? src.length : j + 1; out += " "; continue; }
    out += c;
  }
  return out;
}

/** Динамический import по строке: не даёт tsc ругаться на .tsx-путь/типы react; сбой резолва → ERROR только этой проверки */
const dyn = (spec: string): Promise<any> => import(spec);

/** React-блоки из packages/blocks рендерим офлайн (react/react-dom — из корневого node_modules).
 *  Движковый tsconfig без "jsx" → esbuild даёт классический рантайм React.createElement, поэтому React кладём в globalThis. */
async function loadBlocks(): Promise<{ React: any; renderToStaticMarkup: (el: any) => string; blocks: any }> {
  const React = (await dyn("react")).default;
  (globalThis as any).React = React;
  const { renderToStaticMarkup } = await dyn("react-dom/server");
  const blocks = await dyn(pathToFileURL(path.join(REPO_ROOT, "packages/blocks/src/blocks.tsx")).href);
  return { React, renderToStaticMarkup, blocks };
}

/* В JS `\w` = только ASCII, кириллические окончания им не поймать — поэтому в русских шаблонах явный класс [а-яё]. */

/** Слово градации кредитного риска — по основе, устойчиво к падежу, перефразу и порядку слов.
 *  1) Текст режется на предложения по «.»/«;» (аббревиатура «б.п.» тоже режет — безвредно: якорь и слово градации стоят в одном куске).
 *  2) Берётся первое предложение с якорем. Якорь о кредитном риске («кредитн… риск…», «риск… эмитента», «риск… дефолт…»)
 *     предпочитается якорю «преми… за риск»: если в предложении есть оба, слово ищется от первого.
 *  3) Основа из STEMS ищется сначала ПОСЛЕ якоря («…риск эмитента как существенный»), затем ДО него («Высокий кредитный риск…»);
 *     основа берётся вместе с приставкой «не» («невысокий» ≠ «высокий»), только с начала слова («безопасный» ≠ «опасный»).
 *     Если основы нет — последнее русское слово предложения (догадка: позволяет сравнивать и незнакомые слова).
 *  Нет якоря → null («о кредитном риске не сказано»).
 *  Не распознаёт: формулировки без слов «риск»/«дефолт»/«премия за риск» («надёжность эмитента низкая»); два слова градации
 *  после одного якоря (берётся первое); слово вне списка STEMS, стоящее не последним в предложении. */
const ANCHOR_RISK = /кредитн[а-яё]*\s+риск[а-яё]*|риск[а-яё]*\s+эмитента|риск[а-яё]*\s+дефолт[а-яё]*/i;
const ANCHOR_PREM = /преми[а-яё]*\s+за\s+(?:кредитн[а-яё]*\s+)?риск[а-яё]*/i;
const STEMS = /(^|[^а-яё])((?:не)?(?:существенн|высок|умеренн|повышенн|значительн|критич|серь[её]зн|низк|заметн|больш|минимальн|максимальн|предельн|экстремальн|сильн|слаб|средн|ощутим|тревожн|опасн))/i;
const STEM_LIST = "существенн/высок/умеренн/повышенн/значительн/критич/серьёзн/низк/заметн/больш/минимальн/максимальн/предельн/экстремальн/сильн/слаб/средн/ощутим/тревожн/опасн (± приставка «не»)";
const norm = (w: string) => w.toLowerCase().replace(/ё/g, "е");
function gradeWord(s: string): string | null {
  const sent = s.split(/[.;]/).find((p) => ANCHOR_RISK.test(p) || ANCHOR_PREM.test(p));
  if (sent == null) return null;
  const a = sent.match(ANCHOR_RISK) ?? sent.match(ANCHOR_PREM);
  if (!a || a.index == null) return null;
  const after = sent.slice(a.index + a[0].length);
  const before = sent.slice(0, a.index);
  const m = after.match(STEMS) ?? before.match(STEMS);
  if (m) return norm(m[2]);
  const words = sent.trim().split(/\s+/).map((w) => w.replace(/[^а-яё-]/gi, "")).filter((w) => w.length > 0);
  const last = words.pop();
  return last ? norm(last) : null;
}

/** Дефект R2-07 и его равнозначные формы: details приписывает отсутствие ЗАЯВЛЕННОЙ/ОБЕЩАННОЙ величине
 *  («заявленная не указана», «обещанная доходность не задана», «не указана заявленная», «нет заявленной», «заявленная отсутствует»;
 *  между словами допустимы ≤2 русских слова). Фразы про другие величины («цена не указана», «расчётная не определена»,
 *  «нет расчётной доходности для сравнения с заявленной») под шаблон не попадают — это допустимое объяснение, а не дефект. */
const MISATTR = /(заявленн|обещанн)[а-яё]*(\s+[а-яё]+){0,2}\s+(не\s+(указан|задан|введ|заполнен)|отсутств)|(не\s+(указан|задан|введ|заполнен)[а-яё]*|нет|отсутству[а-яё]*)\s+(заявленн|обещанн)/i;

export const checks: Check[] = [
  /* ───── G.1: флаг 5 штрафует бумагу, а не время запроса ───── */
  {
    id: "G.1", wp: "G", kind: "fixture",
    title: "Флаг 5: закрытый стакан (BID и OFFER пусты при закрытой сессии) у ликвидной бумаги не штрафуется; односторонний стакан при открытой сессии — штрафуется (spreadPts)",
    run: async () => {
      // (а) Ликвидная бумага (avg 50 млн/день, 500 сделок/день), стакан пуст с обеих сторон, сессия закрыта
      //     (новое поле плана b.tradingOpen=false; UPDATETIME нет) → флаг 5 не горит, details про закрытый стакан.
      const bc = Object.assign(facts({ bid: null, offerQ: null, upd: null }), { tradingOpen: false });
      const liqC = liquidity(bc, POS);
      const fC = flags(bc, yieldModel(bc, {}), liqC, null).all.find((f) => f.id === 5)!;
      const rC = assembleReport(bc, {});
      const rC5 = flagOf(rC, 5);
      const closedOk = !fC.fired && fC.points === 0 && !rC5.fired && rC5.points === 0 && /закрыт/i.test(rC5.details);

      // (б) Та же ликвидная бумага, но стакан односторонний (BID есть, OFFER нет) при ОТКРЫТОЙ сессии (UPDATETIME 13:00:00,
      //     tradingOpen=true) → флаг 5 горит на spreadPts, liquidity.missing=true. Защита от перекоса правки:
      //     «не штрафовать закрытый стакан» не должно превратиться в «не штрафовать пустую сторону вообще».
      const bo = Object.assign(facts({ bid: 100, offerQ: null, upd: "13:00:00" }), { tradingOpen: true });
      const liqO = liquidity(bo, POS);
      const fO = flags(bo, yieldModel(bo, {}), liqO, null).all.find((f) => f.id === 5)!;
      const rO = assembleReport(bo, {});
      const rO5 = flagOf(rO, 5);
      const openOk = liqO.missing === true && fO.fired && fO.points === C.spreadPts && rO5.fired && rO5.points === C.spreadPts && rO.liquidity.spread_missing_side === true;

      // Иллюстрация (НЕ утверждение): golden cherk1p6 (RU000A105M67) — единственный односторонний стакан в снимках, но снимок
      // ПРЕДТОРГОВЫЙ: SYSTIME 09:15:15, UPDATETIME 09:00:07, NUMTRADES=0, WAPRICE=null; «открытость» там доказывает только
      // TRADINGSTATUS=T. Трактовка «свежего UPDATETIME» остаётся за исполнителем правки, поэтому на этот снимок не опираемся.
      const rg = reportOf(await buildGolden("cherk1p6"));
      const md = snapshotRows(path.join(GOLDEN_DIR, "snapshots", "cherk1p6"), "engines_stock", "marketdata")[0] ?? {};
      const g5 = flagOf(rg, 5);

      return expect(closedOk && openOk,
        `(а) закрытый стакан: avg=${bc.avg} ₽/день, avgNT=${bc.avgNT}, bid=null, offerQ=null, upd=null, tradingOpen=false → liquidity.missing=${liqC.missing}; ` +
        `flags(): флаг 5 fired=${fC.fired} points=${fC.points} details=«${fC.details}»; отчёт: fired=${rC5.fired} points=${rC5.points} truth_score=${rC.truth_score.score} ` +
        `[ожидание: не горит, 0 баллов, details про закрытый стакан, не «нет BID или OFFER»] → ${closedOk ? "✓" : "✗"}; ` +
        `(б) односторонний стакан при открытой сессии: bid=${bo.bid}, offerQ=null, upd=${bo.upd}, tradingOpen=true → liquidity.missing=${liqO.missing}; ` +
        `flags(): флаг 5 fired=${fO.fired} points=${fO.points} details=«${fO.details}»; отчёт: fired=${rO5.fired} points=${rO5.points} spread_missing_side=${rO.liquidity.spread_missing_side} ` +
        `[ожидание: горит, ${C.spreadPts} баллов] → ${openOk ? "✓" : "✗"}; ` +
        `иллюстрация golden cherk1p6 (предторговый снимок, не утверждается): BID=${md.BID} OFFER=${md.OFFER} TRADINGSTATUS=${md.TRADINGSTATUS} UPDATETIME=${md.UPDATETIME} ` +
        `SYSTIME=${md.SYSTIME} NUMTRADES=${md.NUMTRADES} WAPRICE=${md.WAPRICE}; флаг 5 fired=${g5.fired} points=${g5.points} details=«${g5.details}»; status=${rg.status.kind}`);
    },
  },

  /* ───── G.2: одно значение gap для правила, баллов и показа ───── */
  {
    id: "G.2", wp: "G", kind: "fixture",
    title: "Флаг 12: fired ⇔ claim.gap_pp > gapPp, баллы по тому же округлённому числу, «Разница» в строке и цвет блока Claim согласованы с правилом (1,99 / 2,00 / 22,093 / 2,01; 4,99 / 5,00 / 5,003 / 5,01); Claim читает fired, не пересчитывает",
    run: async () => {
      const base = reportOf(await buildFixture("rolf_friday"));
      const m = base.yield.main_pct;
      if (m == null) return fail(`rolf_friday: yield.main_pct=null (status ${base.status.kind}) — сравнивать нечего`);
      const { React, renderToStaticMarkup, blocks } = await loadBlocks();
      const r3 = (x: number) => Math.round(x * 1000) / 1000;
      // 22,093 — случай прода (RU000A10ASE2, main 20,09): третий знак обещания даёт gap 2,003
      const promisedList = [r3(m + 1.99), r3(m + 2), 22.093, r3(m + 2.01), r3(m + 4.99), r3(m + 5), r3(m + 5.003), r3(m + 5.01)];
      const rows: string[] = [];
      let bad = 0;
      for (const p of promisedList) {
        const r = applyInputs(base, { promised_pct: p });
        const f = flagOf(r, 12);
        const gp = r.claim.gap_pp;
        const wantFired = gp != null && gp > C.gapPp;
        const wantPts = gp == null ? 0 : gp > C.gapHighPp ? C.gapHighPts : gp > C.gapPp ? C.gapPts : 0;
        const mt = r.claim.line?.match(/Разница:\s*(\S+)\s*п\.п\./);
        const shown = mt ? ru(mt[1]) : NaN;
        // напечатанная разница должна давать тот же ответ, что правило: > 2 ⇔ флаг горит, > 5 ⇔ 30 баллов
        const shownOk = Number.isFinite(shown) && (shown > C.gapPp) === f.fired && (shown > C.gapHighPp) === (f.points === C.gapHighPts);
        const scoreOk = r.truth_score.score === Math.max(0, 100 - r.flags.filter((x) => x.fired).reduce((s, x) => s + x.points, 0));
        // блок Claim (packages/blocks): красный ⇔ флаг 12 сработал — это продовый кейс R2-08 (promised 22,093: флаг −20, блок зелёный)
        const html: string = renderToStaticMarkup(React.createElement(blocks.Claim, { r }));
        const tone = /tone-bad/.test(html) ? "tone-bad" : /tone-good/.test(html) ? "tone-good" : "?";
        const claimOk = (tone === "tone-bad") === f.fired;
        const ok = f.fired === wantFired && f.points === wantPts && shownOk && scoreOk && claimOk;
        if (!ok) bad++;
        rows.push(`${ok ? "✓" : "✗"} promised=${p}: gap_pp=${gp} fired=${f.fired} (ожид. ${wantFired}) points=${f.points} (ожид. ${wantPts}) «Разница: ${mt?.[1] ?? "—"}» score=${r.truth_score.score} Claim=${tone}`);
      }
      // статика (комментарии сняты, все совпадения): в теле блока Claim нет ссылки на порог gapPp и нет сравнения gap_pp «<»/«>» —
      // одна реализация правила. Не распознаёт пересчёт через вспомогательную функцию/константу с другим именем (его поймает
      // поведенческая часть: цвет блока ≠ fired).
      const claimBody = stripComments(fnBody(readSrc("packages/blocks/src/blocks.tsx"), "Claim"));
      const recalc = [...claimBody.matchAll(/^.*(gapPp|gap_pp\s*[<>]).*$/gm)].map((x) => `«${x[0].trim()}»`);
      const noRecalc = recalc.length === 0;
      return expect(bad === 0 && noRecalc,
        `rolf_friday main_pct=${m}; gapPp=${C.gapPp}, gapHighPp=${C.gapHighPp}; расхождений ${bad}/${promisedList.length}. ` + rows.join("; ") +
        `. Статика blocks.tsx/Claim (комментарии сняты; ищется gapPp или сравнение gap_pp < / >, все строки): ` +
        `${noRecalc ? "порог не пересчитывается ✓" : `пересчёт правила в блоке (${recalc.length}): ${recalc.join(", ")} ✗`}`);
    },
  },

  /* ───── G.3: null — не ноль ───── */
  {
    id: "G.3", wp: "G", kind: "unit",
    title: "Null → не 0: durDays=null → worst «Рост ставок» остаётся без чисел (loss_pct_* = null, текст «дюрация не опубликована», нет «0,0%»/«−0 ₽»), флаг 7 не «DURATION = 0,0 г.»; GSPREADBP=null → флаг 3 не горит, details «G-спред не опубликован», не «нет б.п.»",
    run: () => {
      // (а) дюрация не опубликована. План: элемент «rates» ОСТАЁТСЯ, но без чисел и с текстом «дюрация не опубликована» —
      //     удаление элемента скрыло бы существующий (просто не оцифрованный) риск, поэтому его отсутствие = RED.
      const b = facts({ durDays: null });
      const r = assembleReport(b, {});
      const w = r.worst.find((x) => x.id === "rates");
      const f7 = flagOf(r, 7);
      const text = w?.text ?? "";
      const zeroPct = /(^|[^\d,])0,0\s?%/.test(text);
      const zeroRub = /[−-]\s?0\s?₽/.test(text);
      const ratesOk = w != null && w.loss_pct_1pp == null && w.loss_pct_3pp == null
        && /дюрац/i.test(text) && /не опубликован/i.test(text) && !zeroPct && !zeroRub;
      const f7ok = !/=\s*0,0\s*г/.test(f7.details);
      // (б) G-спред не опубликован: флаг 3 не горит, details говорит «не опубликован», а не «GSPREADBP = нет б.п.»
      const r0 = assembleReport(facts({ g: null }), {});
      const f3 = flagOf(r0, 3);
      const gOk = !f3.fired && f3.points === 0 && !/нет\s*б\.п\./i.test(f3.details) && /не опубликован/i.test(f3.details);
      return expect(ratesOk && f7ok && gOk,
        `(а) durDays=null, ctype=${b.ctype}, status=${r.status.kind} → worst.rates: ${w ? `loss_pct_1pp=${w.loss_pct_1pp} loss_pct_3pp=${w.loss_pct_3pp} text=«${w.text}»` : "элемента нет (ожидался без чисел)"}; ` +
        `«0,0%» в тексте: ${zeroPct}; «−0 ₽»: ${zeroRub}; «дюрац…не опубликован»: ${/дюрац/i.test(text) && /не опубликован/i.test(text)} → ${ratesOk ? "✓" : "✗"}; ` +
        `флаг 7 fired=${f7.fired} details=«${f7.details}» → ${f7ok ? "✓" : "✗"}; ` +
        `(б) g=null → флаг 3 fired=${f3.fired} points=${f3.points} details=«${f3.details}» [ожидание: не горит, «G-спред не опубликован»] → ${gOk ? "✓" : "✗"}`);
    },
  },

  /* ───── G.4: обещание задано, доходность не рассчитана ───── */
  {
    id: "G.4", wp: "G", kind: "fixture",
    title: "Флаг 12: «обещали» задано, а доходность не рассчитана (нет цены) — details не приписывает отсутствие заявленной величине («заявленная не указана» и равнозначные формы), флаг не горит (синтетика и golden cherk1p6); упоминание 20 % и причины — информационно, план их не задаёт",
    run: async () => {
      const cases: { name: string; r: BondReportT }[] = [
        { name: "синтетика wap=null, prevWap=null, promised 20", r: assembleReport(facts({ wap: null, prevWap: null }), { promised_pct: 20 }) },
        { name: "golden cherk1p6 (no_price), promised 20", r: reportOf(await buildGolden("cherk1p6", { inputs: { promised_pct: 20 } })) },
      ];
      const rows: string[] = [];
      let bad = 0;
      for (const { name, r } of cases) {
        const f = flagOf(r, 12);
        const d = f.details;
        // Утверждение (план G.4 / R2-07): заявленное 20 % дошло до отчёта, main=null, флаг не горит, details непустой и
        // НЕ говорит, что отсутствует ЗАЯВЛЕННАЯ величина (это и есть дефект — отсутствует расчётная, а не заявленная).
        const misattr = MISATTR.test(d);
        const ok = r.claim.promised_pct === 20 && r.yield.main_pct == null && !f.fired && d.trim().length > 0 && !misattr;
        // Информация (НЕ в вердикте — план содержания details не задаёт): упомянуто ли заявленное значение и причина отсутствия сравнения
        const mentions20 = /(^|[^\d,.])20(?![\d]|[,.]\d*[1-9])/.test(d);
        const reason = /не рассчит|нет цены|цена не|не определ|нет расч[её]тн|без цены/i.test(d);
        if (!ok) bad++;
        rows.push(`${ok ? "✓" : "✗"} ${name}: status=${r.status.kind} main_pct=${r.yield.main_pct} claim.promised_pct=${r.claim.promised_pct} gap_pp=${r.claim.gap_pp} ` +
          `флаг 12 fired=${f.fired} details=«${d}» [приписывает отсутствие заявленной: ${misattr ? "да ✗" : "нет ✓"}; информационно — упоминает 20: ${mentions20 ? "да" : "нет"}, называет причину: ${reason ? "да" : "нет"}]`);
      }
      return expect(bad === 0, rows.join("; ") +
        `. Граница: вердикт = details непустой и не формы «заявленная/обещанная [≤2 слова] не указана/задана/введена/заполнена | отсутствует», ` +
        `«не указана/нет/отсутствует заявленная» (обратный порядок); короткое «—»/«нет» или «расчётная не определена» план не запрещает — ` +
        `содержание details вне утверждения (план G.4 задаёт только «не „заявленная не указана“»)`);
    },
  },

  /* ───── G.5: единая градация G-спреда ───── */
  {
    id: "G.5", wp: "G", kind: "unit",
    title: "Градация G-спреда едина: при премии (флаг 3 горит) во флаге 3 и в worst «Дефолт эмитента» одно и то же слово о кредитном риске (600 / 879 / 1 000 / 1 001 / 1 100 б.п.), fired/баллы по порогам; без премии worst либо молчит о кредитном риске, либо говорит тем же словом; различие слов на уровнях 20/30 баллов — информационно",
    run: () => {
      const rows: string[] = [];
      let bad = 0;
      const byG: Record<number, { pts: number; w3: string | null; wd: string | null }> = {};
      for (const g of [C.premiumBp, 879, C.premiumHighBp, C.premiumHighBp + 1, 1100]) {
        const r = assembleReport(facts({ g }), {});
        const f3 = flagOf(r, 3);
        const d = r.worst.find((w) => w.id === "default");
        const wantFired = g > C.premiumBp;
        const wantPts = !wantFired ? 0 : g > C.premiumHighBp ? C.premiumHighPts : C.premiumPts;
        const w3 = gradeWord(f3.text) ?? gradeWord(f3.details);
        const wd = d ? gradeWord(d.text) : null;
        byG[g] = { pts: f3.points, w3, wd };
        // горит → в флаге 3 и в worst слово о кредитном риске есть и оно одно (одно число — одно слово; это и есть R2-26);
        // не горит → worst либо молчит о кредитном риске (как сейчас), либо говорит тем же словом, что флаг 3 — иного план не требует
        const ok = f3.fired === wantFired && f3.points === wantPts
          && (wantFired ? w3 != null && wd != null && w3 === wd : wd == null || wd === w3);
        if (!ok) bad++;
        rows.push(`${ok ? "✓" : "✗"} g=${g}: флаг 3 fired=${f3.fired} points=${f3.points} (ожид. ${wantFired}/${wantPts}) text=«${f3.text}» → «${w3}»; worst.default=«${d?.text ?? "элемента нет"}» → «${wd}»`);
      }
      // Информация (НЕ в вердикте: план требует лишь одинаковую градацию в двух местах, не разные слова на уровнях 20 и 30 баллов)
      const w20 = byG[879]?.w3, w30 = byG[1100]?.w3;
      const levels = w20 != null && w30 != null ? (w20 === w30 ? "одно слово на оба уровня" : "различаются") : "не распознано";
      return expect(bad === 0,
        `premiumBp=${C.premiumBp} (${C.premiumPts} б.), premiumHighBp=${C.premiumHighBp} (${C.premiumHighPts} б.); расхождений ${bad}/5. ` + rows.join("; ") +
        `. Информационно: слово при ${C.premiumPts} б. (879) = «${w20}», при ${C.premiumHighPts} б. (1100) = «${w30}» → ${levels}. ` +
        `Распознавание слова: предложение (до «.»/«;») с якорем о кредитном риске «кредитн… риск…» / «риск… эмитента» / «риск… дефолт…» (предпочтительно) или «преми… за риск»; ` +
        `основа из списка ${STEM_LIST} — сначала после якоря, затем до него; иначе последнее слово предложения; нет якоря → «о кредитном риске не сказано» (null). ` +
        `Не распознаёт формулировки без слов «риск»/«дефолт»/«премия за риск»`);
    },
  },

  /* ───── G.6: одна граница callSoonDays ───── */
  {
    id: "G.6", wp: "G", kind: "unit",
    title: "Колл ровно через callSoonDays: флаг 8 «скоро» (callSoonPts) и yieldModel.call.short — одна граница; соседние дни тоже согласованы",
    run: () => {
      const today = "2026-10-09";
      const rows: string[] = [];
      let bad = 0;
      for (const d of [C.callSoonDays - 1, C.callSoonDays, C.callSoonDays + 1]) {
        const b = facts({ todayIso: today, offerKind: "call", offerDateIso: addDays(today, d), offerPrice: 100 });
        const ym = yieldModel(b, {});
        const F = flags(b, ym, liquidity(b, POS), null);
        const f8 = F.all.find((f) => f.id === 8)!;
        const r = assembleReport(b, {});
        const r8 = flagOf(r, 8);
        const short = ym.call?.short ?? null;
        const ptsSoon = f8.points === C.callSoonPts;
        const reportSoon = r.yield.kind === "period_income";
        const reportPtsSoon = r8.points === C.callSoonPts;
        const ok = short != null && F.callSoon === short && ptsSoon === short && reportSoon === reportPtsSoon;
        if (!ok) bad++;
        rows.push(`${ok ? "✓" : "✗"} +${d} дн. (${addDays(today, d)}): call.days=${ym.call?.days} call.short=${short} flags.callSoon=${F.callSoon} флаг 8 points=${f8.points}; отчёт: yield.kind=${r.yield.kind} флаг 8 points=${r8.points}`);
      }
      return expect(bad === 0, `callSoonDays=${C.callSoonDays}, callSoonPts=${C.callSoonPts}, callPts=${C.callPts}; расхождений ${bad}/3. ` + rows.join("; "));
    },
  },

  /* ───── G.7: число правил не захардкожено ───── */
  {
    id: "G.7", wp: "G", kind: "static",
    title: "Блок Truth Score (packages/blocks/src/blocks.tsx): число правил не захардкожено — в тексте FlagsScore (комментарии сняты) нет литерала перед «red/правил/флаг», а отрисованная фраза «Ни один из …» называет flags.length",
    run: async () => {
      const src = readSrc("packages/blocks/src/blocks.tsx");
      const body = stripComments(fnBody(src, "FlagsScore"));
      // Отчёт без сработавших флагов: синтетика ликвидна, g=100 < premiumBp, dur 1,8 г., без оферты, рубли
      const b = facts({ g: 100 });
      const r = assembleReport(b, {});
      const nRules = r.flags.length;
      const nEngine = flags(b, yieldModel(b, {}), liquidity(b, POS), null).all.length;
      // статика (все совпадения): любое ЧИСЛО-литерал (не выражение в {…}) перед «red», «правил», «флаг» — захардкоженное количество (13, 15, …).
      // Равнозначные формы правки (flags.length, CONFIG-константа, вычисленная переменная) литерала не содержат и проходят;
      // не распознаёт число, вынесенное в константу-литерал ВНЕ тела FlagsScore (его поймает поведенческая часть: рендер ≠ flags.length).
      const hits = [...body.matchAll(/(^|[^\d{.\w])(\d+)(?=\s+(red|правил|флаг))/gi)].map((x) => `«${x[2]} ${x[3]}»`);
      // поведение: рендер блока при none_fired — все числа во фразе «Ни один из …» равны фактическому числу правил
      const { React, renderToStaticMarkup, blocks } = await loadBlocks();
      const html: string = renderToStaticMarkup(React.createElement(blocks.FlagsScore, { r }));
      const note = html.match(/note--good[^>]*>([^<]*)</)?.[1] ?? null;
      const nums = (note?.match(/\d+/g) ?? []).map(Number);
      const renderOk = r.truth_score.none_fired && note != null && nums.every((n) => n === nRules);
      return expect(hits.length === 0 && renderOk,
        `правил в движке: flags().all.length=${nEngine}, report.flags.length=${nRules}; литералы числа правил в FlagsScore (комментарии сняты, все совпадения): ${hits.length ? hits.join(", ") : "нет"}; ` +
        `рендер при none_fired=${r.truth_score.none_fired} (score ${r.truth_score.score}): фраза «${note}» → числа [${nums.join(", ")}] ${renderOk ? "= flags.length ✓" : `≠ ${nRules} ✗`}`);
    },
  },
];
