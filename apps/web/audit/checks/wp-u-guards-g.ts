/**
 * WP-U guard-проверки (пакет U-G): краевые случаи ревью 13.10.2026, recheck-замечаний и ревью переписанного разбора (поправка обещания
 * в проверке бумаги, относительная / периодическая / валютная сумма, ставка кредита, срок и «в мес», шаблон «не по теме» на пути правил,
 * «на сумму», вопрос модели о минимальной сумме, две бумаги) и recheck2 13.10 (перенос суммы при названной в реплике, приветствие перед
 * бумагой, отказ / прошлое / другой инструмент у суммы, «под N%» без продавца, чужая комиссия). Должны быть GREEN после правки.
 *
 * Решение оркестратора после трёх раундов ревью: детерминированный путь гейта ТОЧНЫЙ, полнота не важна. Применить неверное
 * число или отказать шаблоном на законный вопрос хуже, чем отдать реплику модели; при сомнении вся реплика уходит модели
 * (handled=false) без частичного применения. Поэтому проверки утверждают два инварианта:
 *   1) никогда не неверное число — сумма, комиссия, обещание, цена применены только верные, либо реплика ушла модели;
 *   2) никогда не отказ на законный вопрос — пересказ, сомнение, уточнение не закрываются шаблоном «советов не даю» / «не по теме».
 * «Модели» допускается и там, где раньше ждали применения (modelOr); строго «применено» требуется только в проверках WP-U (U.1, U.10,
 * H.2 и др.), не здесь. Сумма и комиссия из реплики проверки бумаги не разбираются вовсе — ответ просит написать их отдельно.
 *
 * Как устроено (как в wp-u-gate.ts):
 *  - чистые функции jev.ts — в процессе харнеса при JEV_ENABLED=0, fetch — заглушка, бросающая исключение;
 *  - runGate — в одном дочернем процессе на все сценарии (`node --import tsx <этот файл> --guards-g`, cwd = apps/web):
 *    "server-only" → пустой модуль; ISS — снимки packages/engine/golden/snapshots (rolf RU000A10ASE2, ofz26238, cherk1p6) по тому же
 *    slug, что в iss/client.ts, продовая ветка buildCached (SO_OFFLINE снят); Jev — мок по адресу TypeSafe с заданным интентом
 *    (уверенность 0,9 ≥ порога по умолчанию 0,8) и типом обещания annual_yield; любой другой URL — исключение. LLM не вызывается.
 *  - Отчёт в сессии — живой отчёт ОФЗ 26244 (audit/fixtures/live_ofz26244.json, сумма 500 000 по умолчанию, комиссии нет) или эталон
 *    cherk1p6 (packages/engine/golden/expected/cherk1p6.json, нет биржевой цены) — для ветки цены предложения.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BondReportT, BuildResultT, ReportInputs } from "@so/engine/contract";
import type { ChatSession } from "../../lib/session";
import { isAdviceRequest, isComplex, isFollowUp, moneyIn, offerPriceIn, parseInputs, promiseByRules, routeByRules, MAX_PARSE_LEN } from "../../lib/jev";
import { type Check, type Verdict, pass, fail, fixture, readJson, REPO_ROOT, WEB_ROOT } from "../lib";

const THIS_FILE = fileURLToPath(import.meta.url);
const MARK = "@@WP-U-GUARDS-G@@";
const ISS_BASE = "https://iss.moex.com";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const show = (v: unknown) => JSON.stringify(v);
const q = (s: string, max = 70) => { const one = s.replace(/\s+/g, " ").trim(); return `«${one.length > max ? one.slice(0, max - 1) + "…" : one}»`; };
const said = (s: string) => (s.length > 90 ? `«${s.slice(0, 20).replace(/\s+/g, " ")}…» (${s.length} симв.)` : `«${s.replace(/\n/g, "⏎")}»`);

/* ═════════════════════════════ сценарии гейта (общие для родителя и дочернего процесса) ═════════════════════════════ */

const LAST_REPORT = "Отчёт по ОФЗ 26244 собран — смотрите блоки выше. Ни один из red flags не сработал. Напишите сумму, комиссию брокера или сколько вам обещали — пересчитаю.";
const LAST_SUM_OR_K = "Отчёт по ОФЗ 26244 собран — смотрите блоки выше. Ни один из red flags не сработал. Напишите сумму или комиссию брокера — пересчитаю.";
const LAST_K_DONE = "Учёл комиссию брокера 0,3%. Пересчитал доходность после комиссии и налога — смотрите блоки выше.";
const LAST_NO_PRICE = "По этой бумаге сейчас нет биржевой цены: сделок не было. По какой цене вам предлагают купить? Напишите в процентах от номинала — пересчитаю доходность от неё.";
const BASE_POS = 500_000; // сумма по умолчанию в отчётах live_ofz26244 / rolf / cherk1p6

/** Сценарий: реплика; jev — интент мока (0,9), без него — правила (JEV_ENABLED=0); report — отчёт в сессии; last — прошлый ответ;
 *  prev — вводы прошлого отчёта сессии (поверх фикстуры); page — вводы со страницы /check (pendingInputs) */
interface GCase { id: string; said: string; jev?: string; report?: "ofz" | "cherk"; last?: string; prev?: ReportInputs; page?: ReportInputs }
const LONG = 39_000;
const R = { report: "ofz" as const, last: LAST_REPORT };
const GCASES: GCase[] = [
  // U.G1 — проверка бумаги без отчёта, правила (ISIN → check_security 0,9 без Jev): сумма и комиссия реплики не применяются
  { id: "cs-issue", said: "Проверь RU000A10ASE2, сумма выпуска 500 млн" },
  { id: "cs-issue-dash", said: "Проверь RU000A10ASE2, объём выпуска — 500 млн" },
  { id: "cs-issue-na", said: "Проверь RU000A10ASE2, выпуск на 500 млн" },
  { id: "cs-issue-dash2", said: "Проверь RU000A10ASE2 — выпуск на 500 млн, купон 20%" },
  { id: "cs-min", said: "Проверь RU000A10ASE2, минимальная сумма 100 тысяч" },
  { id: "cs-min-dash", said: "Проверь RU000A10ASE2, минимальная сумма — 100 тысяч" },
  { id: "cs-min-hyphen", said: "Проверь RU000A10ASE2, минимальная сумма - 100 тысяч" },
  { id: "cs-min-nl", said: "Проверь RU000A10ASE2,\nминимальная сумма 100 тысяч" },
  { id: "cs-lot", said: "Проверь RU000A10ASE2, лот — 50 тыс" },
  { id: "cs-half", said: "Проверь RU000A10ASE2, у меня 5 млн, хочу вложить половину" },
  { id: "cs-part", said: "Проверь RU000A10ASE2, у меня на счету 5 млн, хочу вложить часть" },
  { id: "cs-from", said: "Проверь RU000A10ASE2, из 5 млн вложу 2" },
  { id: "cs-per-piece", said: "Проверь RU000A10ASE2, куплю 100 облигаций по 1000 рублей" },
  { id: "cs-two-sums", said: "Проверь RU000A10ASE2, у меня 3 млн, вложу 1 млн" },
  { id: "cs-seller-min", said: "Мне предлагают RU000A10ASE2 под 26%, минимальная сумма 100 тысяч" },
  { id: "cs-seller-min-dash", said: "Мне предлагают RU000A10ASE2 под 26%, мин. сумма — 100 тыс." },
  { id: "cs-monthly", said: "Проверь RU000A10ASE2 под 22%, купон ежемесячный" },
  { id: "cs-sum-k", said: "Проверь RU000A10ASE2 на 1 млн, комиссия 0,3%" },
  { id: "cs-promise", said: "Проверь RU000A10ASE2, обещали 26%" },
  // поправка или второе обещание в следующей фразе, срок, «в мес», две бумаги, «ещё раз» — модели, не первое число и не поиск «ещё раз»
  { id: "cs-fix-no", said: "Проверь RU000A10ASE2, обещали 20%. Нет, 26%" },
  { id: "cs-fix-no-jev", said: "Проверь RU000A10ASE2, обещали 20%. Нет, 26%", jev: "check_security" },
  { id: "cs-fix-no-jev-rep", said: "Проверь RU000A10ASE2, обещали 20%. Нет, 26%", jev: "check_security", ...R },
  { id: "cs-fix-though", said: "Проверь RU000A10ASE2 под 26%. Хотя нет, под 22%" },
  { id: "cs-fix-or", said: "Проверь RU000A10ASE2, обещали 26%? Или 22%?" },
  { id: "cs-fix-now", said: "Проверь RU000A10ASE2, обещали 20%. А теперь обещают 26%" },
  { id: "cs-term", said: "Проверь RU000A10ASE2, обещали 30% за 2,5 года" },
  { id: "cs-month", said: "Проверь RU000A10ASE2, обещали 2% в мес. Т.е. 24% годовых" },
  { id: "cs-two", said: "Проверь RU000A10ASE2 и RU000A0JX0J2" },
  { id: "cs-compare", said: "Сравни RU000A10ASE2 и ОФЗ 26238, что лучше?" },
  { id: "cs-again", said: "Проверь ещё раз с комиссией 0,3%", ...R },
  { id: "cs-again-jev", said: "Проверь ещё раз с комиссией 0,3%", jev: "check_security", ...R },
  { id: "cs-risks", said: "оцени риски", ...R },
  { id: "cs-manager-jev", said: "менеджер говорит 18 годовых", jev: "check_security" },
  // в реплике проверки названы свои сумма или комиссия — прошлые и со страницы не переносятся (recheck2 U-G №1); без них — переносятся (U.10)
  { id: "cs-named-prev", said: "Проверь RU000A10ASE2 на 1 млн", ...R, prev: { position_size: 2_000_000 } },
  { id: "cs-named-prev-jev", said: "Проверь RU000A10ASE2 на 1 млн", jev: "check_security", ...R, prev: { position_size: 2_000_000 } },
  { id: "cs-named-k-prev", said: "Проверь RU000A10ASE2, комиссия 0,05%", ...R, prev: { k_pct: 0.3 } },
  { id: "cs-named-both-prev", said: "Проверь RU000A10ASE2, вложу 1 млн, комиссия 0,05%", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  { id: "cs-named-page", said: "Проверь RU000A10ASE2, на 1 млн", page: { position_size: 2_000_000, k_pct: 0.1 } },
  { id: "cs-carry", said: "Проверь RU000A10ASE2", ...R, prev: { position_size: 2_000_000 } },
  // приветствие или вводное слово перед бумагой — не запрос в ISS (recheck2 U-G №2)
  { id: "hello-jev", said: "Привет! Проверь Самолёт", jev: "check_security" },
  { id: "hello-jev2", said: "Здравствуйте, проверьте Самолёт БО-П13", jev: "check_security" },
  { id: "hello-promise-jev", said: "Добрый день, проверьте РОЛЬФ 1Р07, обещали 26%", jev: "check_security" },
  { id: "hello-prev-jev", said: "Привет! Проверь Самолёт", jev: "check_security", ...R, prev: { position_size: 2_000_000 } },
  { id: "hello-only-jev", said: "Привет", jev: "check_security" },
  { id: "please-ofz", said: "Пожалуйста, проверь ОФЗ 26238" },
  { id: "hello-ofz", said: "Привет, что с ОФЗ 26238?" },
  { id: "ask-ofz", said: "Подскажите, ОФЗ 26238 надёжная?", ...R },
  // «под N%» без глагола продавца или со словами банк / счёт — не обещание (recheck2 U-G №4)
  { id: "cs-bank", said: "Проверь RU000A10ASE2, в банке дают под 18%" },
  { id: "cs-friend", said: "Проверь RU000A10ASE2, друг купил под 30%" },
  { id: "cs-seller", said: "Проверь RU000A10ASE2, мне предлагают под 26%" },
  // приёмка U-G 13.10: сумма или комиссия в реплике проверки без единицы, жаргоном или словами — прошлые 2 000 000 / 0,3 не переносятся
  { id: "cs-named-bare", said: "Проверь RU000A10ASE2, сумма 1 000 000", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  { id: "cs-named-bare-jev", said: "Проверь RU000A10ASE2, сумма 1 000 000", jev: "check_security", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  { id: "cs-named-kk", said: "Проверь RU000A10ASE2 на 1кк", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  { id: "cs-named-half", said: "Проверь RU000A10ASE2 на полмиллиона", jev: "check_security", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  { id: "cs-named-lyam", said: "Проверь RU000A10ASE2, хочу вложить 1,5 ляма", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  { id: "cs-named-sotka", said: "Проверь RU000A10ASE2 на сотку", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  { id: "cs-named-pay", said: "Проверь RU000A10ASE2, плачу брокеру 0,05%", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  { id: "cs-named-broker", said: "Проверь RU000A10ASE2, у брокера 0,05% за сделку", jev: "check_security", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  { id: "cs-named-ofz", said: "Проверь ОФЗ 26238, сумма 300000", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  // приёмка U-G 13.10: «X говорит N%» без отчёта (правила) — не проверка бумаги «Менеджер» / «Банк»
  { id: "say-manager", said: "Менеджер говорит 18 годовых" },
  { id: "say-bank", said: "Банк говорит 18%" },
  { id: "say-manager-page", said: "Менеджер говорит 18 годовых", page: { position_size: 2_000_000, k_pct: 0.1 } },
  { id: "say-manager-q", said: "Менеджер говорит купон 20% годовых, что это значит?" },
  // приёмка U-G 13.10: номер ОФЗ с лишней цифрой — не «ОФЗ 26238»
  { id: "ofz-6", said: "ОФЗ 262381" },
  { id: "ofz-6-rep", said: "что с ОФЗ 262380?", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  { id: "ofz-6-jev", said: "ОФЗ 262381", jev: "check_security" },
  { id: "ofz-7-jev-rep", said: "офз 2623812", jev: "check_security", ...R, prev: { position_size: 2_000_000, k_pct: 0.3 } },
  // U.G2 — сумма при готовом отчёте (ОФЗ 26244)
  { id: "pos-genitive", said: "хочу вложить около двух миллионов", ...R },
  { id: "pos-2x", said: "вложу 2-х миллионов", ...R },
  { id: "pos-gen3", said: "на сумму трёх миллионов", ...R },
  { id: "pos-per-piece-jev", said: "куплю 100 облигаций по 1000 рублей", jev: "set_position", ...R },
  { id: "pos-min-jev", said: "обещали 26% годовых, минимальная сумма 100 тысяч", jev: "set_promised", ...R },
  { id: "pos-min-dash-jev", said: "обещали 26% годовых, минимальная сумма — 100 тысяч", jev: "set_promised", ...R },
  { id: "pos-entry-jev", said: "менеджер говорит: доходность 24% годовых, минимальный вход — 300 тыс", jev: "set_promised", ...R },
  { id: "pos-issue-jev", said: "сумма выпуска — 500 млн", jev: "set_position", ...R },
  { id: "pos-fix-jev", said: "не 2 млн, а 3 млн", jev: "set_position", ...R },
  { id: "pos-not", said: "вложу не 2 млн, а 1 млн", ...R },
  { id: "pos-no", said: "вложу 2 млн. Нет, 1 млн", ...R },
  { id: "pos-or", said: "вложу 2 млн или 3", ...R },
  { id: "pos-capital", said: "у меня 3 млн, хочу вложить 1 млн", ...R },
  { id: "pos-half", said: "у меня 5 млн, хочу вложить половину", ...R },
  { id: "pos-from", said: "из 5 млн вложу 2", ...R },
  { id: "pos-third-jev", said: "у меня есть 3 млн, готов вложить треть", jev: "set_position", ...R },
  { id: "pos-count", said: "хочу купить облигации на 1000 штук", ...R },
  { id: "pos-year-jev", said: "вложу деньги в 2027", jev: "set_position", ...R },
  { id: "pos-usd", said: "вложу 10 тыс долларов", ...R },
  { id: "pos-huge", said: "вложу 999 999 999 999 999 999 млн", ...R },
  { id: "pos-whole-unasked", said: "2 млн", report: "ofz", last: LAST_K_DONE },
  { id: "pos-whole-asked", said: "2 млн", ...R },
  { id: "pos-ok", said: "вложу 1,5 млн под 26%", ...R },
  // относительная, дополнительная, периодическая, валютная сумма; «на сумму» без глагола; вопрос модели о минимальной сумме продавца
  { id: "pos-more-q", said: "а на 500 тыс больше?", ...R },
  { id: "pos-more-da", said: "давай на 1 млн больше", ...R },
  { id: "pos-more", said: "вложу на 500 тыс больше", ...R },
  { id: "pos-more-jev", said: "вложу на 500 тыс больше", jev: "set_position", ...R },
  { id: "pos-less", said: "куплю на 200 тыс меньше", ...R },
  { id: "pos-extra", said: "вложу 500 тыс дополнительно", ...R },
  { id: "pos-extra2", said: "вложу 500 тыс ещё", ...R },
  { id: "pos-monthly", said: "вкладываю 100 тыс каждый месяц", ...R },
  { id: "pos-quarterly", said: "вложу 300 тыс ежеквартально", ...R },
  { id: "pos-tenge", said: "хочу вложить 2 млн тенге", ...R },
  { id: "pos-tenge-jev", said: "хочу вложить 2 млн тенге", jev: "set_position", ...R },
  { id: "pos-uah", said: "вложу 2 млн гривен", ...R },
  { id: "pos-fx", said: "хочу вложить 2 млн в валюте", ...R },
  { id: "pos-ue", said: "вложу 10 тыс уе", ...R },
  { id: "pos-loss", said: "убыток на сумму 100 тыс", ...R },
  { id: "pos-deduct", said: "налоговый вычет на сумму 52 тыс", ...R },
  { id: "pos-min-asked", said: "100 тыс", report: "ofz", last: "Уточните, какая минимальная сумма входа у продавца?" },
  { id: "pos-min-asked2", said: "2 млн", report: "ofz", last: "Какую минимальную сумму покупки вам назвал продавец?" },
  // отказ, прошедшее время, вложение в другой инструмент или период (recheck2 U-G №3)
  { id: "pos-neg", said: "не вложу 2 млн", ...R },
  { id: "pos-neg-ready", said: "не готов вложить 2 млн в такую бумагу", ...R },
  { id: "pos-changed", said: "хотел вложить 2 млн, но передумал", ...R },
  { id: "pos-changed-jev", said: "хотел вложить 2 млн, но передумал", jev: "set_position", ...R },
  { id: "pos-wont", said: "хотела купить на 2 млн, но после отчёта не буду", ...R },
  { id: "pos-not-this", said: "вложу 2 млн, но не в эту", ...R },
  { id: "pos-past", said: "вложил 2 млн", ...R },
  { id: "pos-deposit", said: "лучше положу 2 млн на депозит", ...R },
  { id: "pos-deposit-jev", said: "лучше положу 2 млн на депозит", jev: "set_position", ...R },
  { id: "pos-vklad", said: "положу 2 млн на вклад", ...R },
  { id: "pos-stocks", said: "вложу 2 млн в акции", ...R },
  { id: "pos-other", said: "вложу 2 млн в другую облигацию", ...R },
  { id: "pos-various", said: "вложу 2 млн в разные облигации", ...R },
  { id: "pos-credit", said: "беру 2 млн в кредит", ...R },
  { id: "pos-per-month", said: "вкладываю 200 тыс за месяц", ...R },
  { id: "pos-this", said: "вложу 2 млн в эту облигацию", ...R },
  { id: "pos-term", said: "вложу 2 млн на 3 года", ...R },
  // U.G3 — обещание
  { id: "pr-range", said: "обещали от 18 до 26%", ...R },
  { id: "pr-fix", said: "обещали не 26, а 22%", ...R },
  { id: "pr-not", said: "обещали не 26%", ...R },
  { id: "pr-two", said: "обещали купон 20% и доходность 26%", ...R },
  { id: "pr-later", said: "обещали 20, потом сказали 26", ...R },
  { id: "pr-annual-monthly", said: "обещали 22% годовых с ежемесячным купоном", ...R },
  { id: "pr-unbound-period", said: "обещали 20%, купон ежемесячно", ...R },
  { id: "pr-halfyear", said: "обещали 15% за полгода", ...R },
  { id: "pr-halfyear2", said: "обещали 10% в полугодие", ...R },
  { id: "pr-term", said: "обещали 50% через 2 года", ...R },
  { id: "pr-term2", said: "через 3 года обещали вернуть 60%", ...R },
  { id: "pr-ks-jev", said: "обещали КС + 2,5%", jev: "set_promised", ...R },
  { id: "pr-key-jev", said: "обещали ключевую плюс 2%", jev: "set_promised", ...R },
  { id: "pr-key-short", said: "обещали ключ + 2%", ...R },
  { id: "pr-cb", said: "обещали ставку ЦБ плюс 3%", ...R },
  { id: "pr-cb-jev", said: "обещали ставку ЦБ плюс 3%", jev: "set_promised", ...R },
  { id: "pr-whatif", said: "а если ключевую снизят до 10%?", ...R },
  { id: "pr-hypo", said: "а если бы обещали 30%?", ...R },
  { id: "pr-broker", said: "брокер Тинькофф берёт 0,3%", ...R },
  { id: "pr-offer", said: "мне предложили облигацию Самолёт под 26%", ...R },
  { id: "pr-offer-jev", said: "мне предложили облигацию Самолёт под 26%", jev: "set_promised", ...R },
  { id: "pr-monthly-ok", said: "обещали 2% в месяц", ...R },
  // Jev (мок: тип обещания всегда annual_yield) спорит с правилами («в месяц», «за 2 года») — модели, а не 2,2 / 30 годовых
  { id: "pr-month-jev", said: "обещают 2,2% в месяц", jev: "set_promised", ...R },
  { id: "pr-term-jev", said: "обещали 30% за 2 года", jev: "set_position", ...R },
  { id: "pr-retell-jev", said: "Банк предложил купить облигации под 26%, стоит ли?", jev: "set_position", ...R },
  // ставка кредита — не обещание; срок дробью, словом, «в течение»; «в мес», «/мес»; срок не при числе; вопрос
  { id: "pr-credit", said: "беру кредит под 20%", ...R },
  { id: "pr-mortgage", said: "у меня ипотека под 10%", ...R },
  { id: "pr-credit2", said: "кредит под 20%", ...R },
  { id: "pr-mortgage-jev", said: "у меня ипотека под 10%, может лучше её гасить?", jev: "set_promised", ...R },
  { id: "pr-term25", said: "обещали 30% за 2,5 года", ...R },
  { id: "pr-term25-jev", said: "обещали 30% за 2,5 года", jev: "set_promised", ...R },
  { id: "pr-term6", said: "обещали 70% за шесть лет", ...R },
  { id: "pr-term-pair", said: "обещали 30% за пару лет", ...R },
  { id: "pr-term35", said: "обещали 40% за три с половиной года", ...R },
  { id: "pr-term-during", said: "обещали 20% в течение 3 лет", ...R },
  { id: "pr-mes", said: "обещали 2% в мес", ...R },
  { id: "pr-mes-jev", said: "обещали 2% в мес", jev: "set_promised", ...R },
  { id: "pr-mes-slash", said: "обещали 2%/мес", ...R },
  { id: "pr-nominal-term", said: "обещали 26% и вернуть номинал через 3 года", ...R },
  { id: "pr-question", said: "а под 26% стоит брать?", ...R },
  // «под N%» без глагола продавца или со словами банк / счёт (recheck2 U-G №4); ставка на часть срока, после налога (minor)
  { id: "pr-bank", said: "в банке дают под 18%", ...R },
  { id: "pr-bank-jev", said: "в банке дают под 18%", jev: "set_promised", ...R },
  { id: "pr-sber", said: "сбер даёт под 18%", ...R },
  { id: "pr-savings", said: "накопительный счёт под 16%", ...R },
  { id: "pr-friend", said: "друг купил под 30%", ...R },
  { id: "pr-friend-jev", said: "друг купил под 30%", jev: "set_promised", ...R },
  { id: "pr-stocks", said: "акции дают под 30%", ...R },
  { id: "pr-first-year", said: "обещали 26% только первый год", ...R },
  { id: "pr-first-year-jev", said: "обещали 26% только первый год", jev: "set_promised", ...R },
  { id: "pr-after-tax", said: "обещали 26% после налогов", ...R },
  // приёмка U-G 13.10: Jev выбрал сумму или комиссию, а в реплике обещание по другой бумаге — Jev и правила разошлись, модели
  { id: "pr-other-pos-jev", said: "Самолёт, обещали 26%", jev: "set_position", ...R },
  { id: "pr-other-k-jev", said: "проверь рольф, обещали 26", jev: "set_commission", ...R },
  { id: "pr-other-k-jev2", said: "что скажешь про самолёт, обещали 27%", jev: "set_commission", ...R },
  { id: "pr-other-sum-jev", said: "Самолёт, обещали 26%, вложу 2 млн", jev: "set_position", ...R },
  // U.G4 — комиссия
  { id: "k-bare-15", said: "1,5", report: "ofz", last: LAST_SUM_OR_K },
  { id: "k-bare-03", said: "0,3", report: "ofz", last: LAST_SUM_OR_K },
  { id: "k-fix", said: "комиссия не 0,3, а 0,05", ...R },
  { id: "k-neg", said: "комиссия не 0,3%", ...R },
  { id: "k-two", said: "вложу 2 млн, комиссия 0,3 или 0,05", ...R },
  { id: "k-plus", said: "комиссия 0,3% + 0,05%", ...R },
  { id: "k-trades", said: "комиссия 0,3% за 2 сделки", ...R },
  { id: "k-5", said: "комиссия 5%", ...R },
  { id: "k-eur", said: "комиссия 2 евро", ...R },
  { id: "k-hypo", said: "а если комиссия 1%?", ...R },
  { id: "k-zero", said: "комиссия ноль", jev: "set_commission", ...R },
  { id: "k-tariff", said: "тариф инвестор, 0,3%", ...R },
  { id: "k-threshold", said: "комиссия 0,3% при сумме сделки от 1 млн", ...R },
  { id: "k-ok", said: "вложу 2 млн, комиссия 0,3%", ...R },
  { id: "k-year", said: "комиссия 0,3% в год", ...R },
  { id: "k-trades2", said: "комиссия за 2 сделки", ...R },
  { id: "k-kopeks", said: "комиссия 2 копейки", ...R },
  // не комиссия брокера за сделку (recheck2 U-G №5)
  { id: "k-manager", said: "комиссия управляющего 2%", ...R },
  { id: "k-manager-jev", said: "комиссия управляющего 2%", jev: "set_commission", ...R },
  { id: "k-withdraw", said: "комиссия за вывод 1%", ...R },
  { id: "k-withdraw-jev", said: "комиссия за вывод 1%", jev: "set_commission", ...R },
  { id: "k-maturity", said: "комиссия при погашении 1%", ...R },
  { id: "k-service", said: "комиссия за обслуживание 0,1%", ...R },
  { id: "k-depo", said: "комиссия депозитария 0,01%", ...R },
  { id: "k-bank", said: "комиссия банка 1%", ...R },
  { id: "k-round", said: "комиссия 0,6% за покупку и продажу", ...R },
  { id: "k-broker", said: "комиссия брокера 0,05%", ...R },
  // приёмка U-G 13.10: биржевой сбор — не комиссия брокера
  { id: "k-exchange", said: "комиссия биржи 0,01%", ...R },
  { id: "k-exchange-pos-jev", said: "комиссия биржи 0,01%", jev: "set_position", ...R },
  { id: "k-exchange-k-jev", said: "комиссия биржи 0,01%", jev: "set_commission", ...R },
  { id: "k-moex", said: "комиссия Мосбиржи 0,01%", ...R },
  // U.G5 — цена предложения (cherk1p6: нет биржевой цены, ассистент спросил цену)
  { id: "price-sum-first", said: "у меня 2 млн, предлагают по 99", report: "cherk", last: LAST_NO_PRICE },
  { id: "price-sum-first-jev", said: "вложу 2 млн, предлагают по 98,5", jev: "set_price", report: "cherk", last: LAST_NO_PRICE },
  { id: "price-under", said: "предлагают под 26% годовых", report: "cherk", last: LAST_NO_PRICE },
  { id: "price-under-q", said: "Предлагают облигации под 26% годовых, это нормально?", report: "cherk", last: LAST_NO_PRICE },
  { id: "price-under-jev", said: "предлагают под 26% годовых", jev: "set_price", report: "cherk", last: LAST_NO_PRICE },
  { id: "price-coupon-jev", said: "предлагают по номиналу, купон 22%", jev: "set_price", report: "cherk", last: LAST_NO_PRICE },
  { id: "price-unasked-jev", said: "98,5%", jev: "set_price", report: "cherk", last: LAST_REPORT },
  { id: "price-ok-jev", said: "98,5%", jev: "set_price", report: "cherk", last: LAST_NO_PRICE },
  { id: "price-small", said: "по цене 1,5", report: "cherk", last: LAST_NO_PRICE },
  { id: "price-250", said: "по цене 250", report: "cherk", last: LAST_NO_PRICE },
  { id: "price-15-jev", said: "15%", jev: "set_price", report: "cherk", last: LAST_NO_PRICE },
  // U.G6 — пересказ, сомнение, уточнение: не шаблон отказа (перехват совета идёт до Jev — интент мока не важен)
  { id: "adv-retell", said: "Менеджер в банке сказал, что лучше купить облигации сейчас, пока ставки высокие. Так ли это?", jev: "ask_about_report", ...R },
  { id: "adv-heard", said: "слышал, что стоит купить RU000A10ASE2 — так ли это?", jev: "ask_about_report", ...R },
  { id: "adv-heard-ofz", said: "Слышал, что сейчас лучше покупать длинные ОФЗ. Так ли это?", jev: "ask_about_report", ...R },
  { id: "adv-heard-no-report", said: "Слышал, что сейчас лучше покупать длинные облигации. Так ли это?", jev: "ask_about_report" },
  { id: "adv-read", said: "Читал, что лучше купить флоатеры, это так?", jev: "out_of_scope", ...R },
  { id: "adv-opinion", said: "есть мнение, что лучше купить ОФЗ, согласен?", jev: "out_of_scope", ...R },
  { id: "adv-understood", said: "понял, что брать не стоит, спасибо", jev: "ask_about_report", ...R },
  { id: "adv-real", said: "предложи ты бумагу", jev: "ask_about_report", ...R },
  { id: "fu-inflation", said: "почему инфляция влияет на облигации?", jev: "out_of_scope", ...R },
  { id: "fu-sure", said: "ты уверен?", jev: "out_of_scope", ...R },
  // путь правил (Jev выключен или упал): приветствие, «спасибо», «напиши», «погоди» в начале законного вопроса — не шаблон «не по теме»
  { id: "off-hello-check", said: "Привет! Проверь Самолёт" },
  { id: "off-hello-check2", said: "Здравствуйте, проверьте Самолёт БО-П13" },
  { id: "off-thanks-default", said: "спасибо. а что будет при дефолте?", ...R },
  { id: "off-thanks-score", said: "спасибо, а почему балл такой низкий?", ...R },
  { id: "off-write", said: "напиши подробнее про риски", ...R },
  { id: "off-wait", said: "погоди, а почему так?", ...R },
  { id: "off-hello", said: "Привет" },
  // U.G7 — сложные и длинные реплики (правила, без отчёта): модели, быстро
  { id: "long-spaces-po", said: "RU000A10ASE2 " + " ".repeat(LONG) + "по" },
  { id: "long-newlines-obe", said: "RU000A10ASE2 " + "\n".repeat(LONG) + "обе" },
  { id: "long-promise", said: "x" + " ".repeat(39_988) + "y обещали 5" },
  { id: "long-under", said: "Проверь RU000A10ASE2" + " ".repeat(39_960) + "y под 5%" },
  { id: "long-advice", said: "посоветуй облигацию " + "очень ".repeat(7_000) },
  { id: "over-limit", said: "Проверь RU000A10ASE2, обещали 26%" + " ".repeat(MAX_PARSE_LEN) },
  { id: "complex-nl", said: "вложу 2 млн\nкомиссия 0,3%", ...R },
];
const NOTE = /Сумму и комиссию напишите отдельным сообщением/;

interface GOut {
  id: string; handled: boolean; intent: string | null; source: string | null; tools: Array<{ tool: string; input: unknown }>;
  kind: string | null; inputs: ReportInputs | null; fired: string[]; text: string; ms: number; error: string | null;
}

/* ═════════════════════════════ дочерний процесс ═════════════════════════════ */

type GateMod = typeof import("../../lib/gate");
type Writer = Parameters<GateMod["runGate"]>[0];
const SNAP_DIRS = ["rolf", "ofz26238", "cherk1p6"].map((d) => path.join(REPO_ROOT, "packages", "engine", "golden", "snapshots", d));
function issFile(u: string): string | null {
  const file = u.replace(ISS_BASE + "/iss/", "").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 150) + ".json";
  for (const d of SNAP_DIRS) if (fs.existsSync(path.join(d, file))) return path.join(d, file);
  if (/_from_/.test(file)) {
    const stem = file.replace(/_from_.*$/, "");
    for (const d of SNAP_DIRS) { const c = fs.readdirSync(d).find((f) => f.startsWith(stem)); if (c) return path.join(d, c); }
  }
  return null;
}
async function childMain(): Promise<void> {
  const nm = (await import("node:module")) as unknown as { registerHooks?: (hooks: unknown) => unknown };
  if (typeof nm.registerHooks !== "function") throw new Error("node:module.registerHooks недоступен — нужен Node ≥ 22.15");
  nm.registerHooks({
    resolve(spec: string, ctx: unknown, next: (s: string, c: unknown) => unknown) {
      if (spec === "server-only") return { url: "data:text/javascript,", shortCircuit: true, format: "module" };
      return next(spec, ctx);
    },
  });
  let jevIntent: string | null = null;
  const blocked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u === JEV_URL && jevIntent) {
      const qs = (JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, unknown> }).questions ?? {};
      const choice = (c: string) => ({ type: "choice", choice: c, confidence: 0.9, probabilities: { [c]: 0.9 } });
      const answers: Record<string, unknown> = {};
      if (qs.intent) answers.intent = choice(jevIntent);
      if (qs.mentions_security) answers.mentions_security = { type: "noul", noul: 0.1 };
      if (qs.kind) answers.kind = choice("annual_yield");
      return new Response(JSON.stringify({ model: "jev-mock", answers }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.startsWith(ISS_BASE + "/iss/")) {
      const f = issFile(u);
      if (f) return new Response(fs.readFileSync(f, "utf8"), { status: 200, headers: { "content-type": "application/json" } });
    }
    blocked.push(u.slice(0, 120));
    throw new Error(`аудит U-G: сеть запрещена (${u.slice(0, 100)})`);
  }) as typeof fetch;

  const gate = (await import("../../lib/gate")) as GateMod;
  const reports: Record<string, BuildResultT> = {
    ofz: fixture<BuildResultT>("live_ofz26244.json"),
    cherk: readJson<BuildResultT>("packages/engine/golden/expected/cherk1p6.json"),
  };
  const out: GOut[] = [];
  for (const c of GCASES) {
    if (c.jev) { delete process.env.JEV_ENABLED; jevIntent = c.jev; } else { process.env.JEV_ENABLED = "0"; jevIntent = null; }
    const res = c.report ? (JSON.parse(JSON.stringify(reports[c.report])) as BuildResultT) : null;
    if (res?.kind === "report" && c.prev) Object.assign(res.report.inputs, c.prev);
    const s: ChatSession = {
      id: "ug-" + c.id, query: res?.kind === "report" ? (res.report.security.isin ?? res.report.security.secid) : null, result: res,
      pendingInputs: c.page ?? null, userMessages: 0, usage: { input: 0, output: 0, cost: 0, calls: 0, jev: 0 }, touched: Date.now(),
    };
    const parts: Array<Record<string, unknown>> = [];
    const w = { write: (p: Record<string, unknown>) => { parts.push(p); }, merge: () => {} } as unknown as Writer;
    const t0 = performance.now();
    let handled = false, intent: string | null = null, source: string | null = null, error: string | null = null;
    try {
      const o = await gate.runGate(w, s, c.said, c.last ?? null);
      handled = o.handled; intent = o.decision?.intent ?? null; source = o.decision?.source ?? null;
    } catch (e) { error = String(e instanceof Error ? e.message : e).slice(0, 200); }
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    const rep: BondReportT | null = s.result?.kind === "report" ? s.result.report : null;
    out.push({
      id: c.id, handled, intent, source, error, ms,
      tools: parts.filter((p) => p.type === "tool-input-available").map((p) => ({ tool: String(p.toolName), input: p.input })),
      kind: s.result?.kind ?? null, inputs: rep ? rep.inputs : null, fired: rep ? rep.flags.filter((f) => f.fired).map((f) => f.title) : [],
      text: parts.filter((p) => p.type === "text-delta").map((p) => String(p.delta ?? "")).join("").replace(/\s+/g, " ").trim(),
    });
  }
  // stdout в pipe на macOS асинхронный: дождаться сброса строки до process.exit
  await new Promise<void>((res) => process.stdout.write(MARK + JSON.stringify({ blocked, out }) + "\n", () => res()));
}
function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(THIS_FILE); } catch { return false; }
}
if (isMain() && process.argv.includes("--guards-g")) childMain().then(() => process.exit(0), (e) => { console.error(e); process.exit(3); });

/* ═════════════════════════════ родитель: один запуск дочернего процесса на все проверки ═════════════════════════════ */

let memo: { ok: true; v: { blocked: string[]; out: GOut[] } } | { ok: false; err: Error } | null = null;
function gateRuns(): { blocked: string[]; out: GOut[] } {
  if (memo) { if (memo.ok) return memo.v; throw memo.err; }
  try {
    const usage = fs.mkdtempSync(path.join(os.tmpdir(), "so-audit-ug-usage-"));
    process.on("exit", () => { try { fs.rmSync(usage, { recursive: true, force: true }); } catch { /* best effort */ } });
    const env: NodeJS.ProcessEnv = {
      ...process.env, NODE_NO_WARNINGS: "1", SO_USAGE_DIR: usage, SO_USAGE_LOG: "0", SO_QUIET: "1", JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "audit-fake-key",
    };
    for (const k of ["SO_OFFLINE", "TYPESAFE_URL", "JEV_DECISIONS_URL", "JEV_ENABLED", "MOCK_LLM", "JEV_THRESHOLD", "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY", "LLM_PROVIDER", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
    const r = spawnSync(process.execPath, ["--import", "tsx", THIS_FILE, "--guards-g"], { cwd: WEB_ROOT, env, encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
    if (r.error) throw r.error;
    const line = String(r.stdout ?? "").split("\n").reverse().find((l) => l.startsWith(MARK));
    if (r.status !== 0 || !line) throw new Error(`guards-g: exit=${r.status}; stderr: ${String(r.stderr ?? "").trim().split("\n").slice(-6).join(" | ") || "(пусто)"}`);
    const v = JSON.parse(line.slice(MARK.length)) as { blocked: string[]; out: GOut[] };
    memo = { ok: true, v };
    return v;
  } catch (e) {
    memo = { ok: false, err: e instanceof Error ? e : new Error(String(e)) };
    throw memo.err;
  }
}
const G = (id: string): GOut => {
  const o = gateRuns().out.find((x) => x.id === id);
  if (!o) throw new Error(`guards-g: нет сценария ${id}`);
  return o;
};
const caseOf = (id: string): GCase => {
  const c = GCASES.find((x) => x.id === id);
  if (!c) throw new Error(`guards-g: нет сценария ${id}`);
  return c;
};
/** Что гейт передал инструменту: вход set_inputs или inputs у build_bond_report */
function applied(o: GOut): ReportInputs {
  const t = o.tools.find((x) => x.tool === "set_inputs" || x.tool === "build_bond_report");
  if (!t) return {};
  return (t.tool === "build_bond_report" ? (t.input as { inputs?: ReportInputs }).inputs : (t.input as ReportInputs)) ?? {};
}
const fmtTurn = (o: GOut) => {
  const c = caseOf(o.id);
  return `${said(c.said)} [${c.jev ? `Jev ${c.jev} 0,9` : "правила"}${c.report ? `, отчёт ${c.report}` : ", без отчёта"}] → ${o.intent ?? "—"} (${o.source ?? "—"}), handled=${o.handled}` +
    (o.error ? `, ИСКЛЮЧЕНИЕ ${q(o.error, 120)}` : "") +
    (o.tools.length ? `, ${o.tools.map((t) => `${t.tool}${show(t.input).slice(0, 140)}`).join("; ")}` : "") +
    (o.inputs ? `, вводы отчёта ${show({ pos: o.inputs.position_size, k: o.inputs.k_pct, pr: o.inputs.promised_pct, price: o.inputs.offer_price_pct })}` : "") +
    (o.text ? `, текст ${q(o.text, 90)}` : "");
};
const blockedNote = () => { const b = gateRuns().blocked; return b.length ? ` | сеть заблокирована (${b.length}): ${b.slice(0, 2).join("; ")}` : ""; };

/** Ряд проверки гейта: сценарий, ожидание словами, предикат */
type GRow = [id: string, want: string, ok: (o: GOut) => boolean];
function gateCheck(rows: GRow[]): Verdict {
  const res = rows.map(([id, want, ok]) => { const o = G(id); return { o, want, good: !o.error && ok(o) }; });
  const bad = res.filter((r) => !r.good);
  const detail = `${res.length - bad.length}/${res.length} ок; ` + res.map((r) => `${r.good ? "ок" : "НЕ ок"}: ${fmtTurn(r.o)} — ожид. ${r.want}`).join(" | ") + blockedNote();
  return bad.length ? fail(detail) : pass(detail);
}
const SUM_TEXT = /Учёл[^.]*сумм/i;
/** Сумма не применена: в инструменте нет position_size, в отчёте — по умолчанию (или отчёта нет), текст не говорит «Учёл сумму» */
const noSum = (o: GOut) => applied(o).position_size == null && (o.inputs == null || o.inputs.position_size === BASE_POS) && !SUM_TEXT.test(o.text);
/** Модели (handled=false) или верное значение */
const modelOr = (ok: (o: GOut) => boolean) => (o: GOut) => !o.handled || ok(o);
const posIs = (v: number) => (o: GOut) => o.inputs?.position_size === v && applied(o).position_size === v;

/** Комиссия не применена (в инструменте нет k_pct, в отчёте её нет или отчёта нет) */
const noK = (o: GOut) => applied(o).k_pct == null && o.inputs?.k_pct == null;
/** Обещание не применено */
const noPr = (o: GOut) => applied(o).promised_pct == null && o.inputs?.promised_pct == null;
/** Проверка бумаги собрала отчёт, сумма и комиссия реплики не применены, хвост просит написать их отдельно */
const checkedNoInputs = (o: GOut) => o.handled && o.kind === "report" && noSum(o) && noK(o) && NOTE.test(o.text);
const ADVICE_TEMPLATE = /Советов и рекомендаций/i;
const OFF_TEMPLATE = /помогаю только с проверкой облигаций/i;
const noTemplate = (o: GOut) => !ADVICE_TEMPLATE.test(o.text) && !OFF_TEMPLATE.test(o.text);
/** Нет поиска бумаги (resolve_security / build_bond_report) — «ещё раз», «риски», «менеджер» не уходят в ISS как запрос */
const noSearch = (o: GOut) => !o.tools.some((t) => t.tool === "resolve_security" || t.tool === "build_bond_report");
/** Запрос поиска бумаги (resolve_security / build_bond_report) */
const queryOf = (o: GOut) => (o.tools.find((t) => t.tool === "resolve_security" || t.tool === "build_bond_report")?.input as { query?: string } | undefined)?.query;
/** Прошлые сумма и комиссия или со страницы не применены и не названы в ответе */
const noCarry = (o: GOut) => !/как в прошлой проверке|со страницы проверки/.test(o.text);
/** Прошлые 2 000 000 / 0,3 не переданы инструменту и не названы в ответе (отчёт сессии при сбое поиска остаётся прошлым — его вводы не смотрим) */
const noPrev = (o: GOut) => applied(o).position_size !== 2_000_000 && applied(o).k_pct !== 0.3 && noCarry(o);

/* ═════════════════════════════ чистые функции ═════════════════════════════ */

async function rules<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved = { en: process.env.JEV_ENABLED, f: globalThis.fetch };
  process.env.JEV_ENABLED = "0";
  globalThis.fetch = (async (u: unknown) => { throw new Error(`аудит U-G: сеть запрещена (${String(u).slice(0, 80)})`); }) as typeof fetch;
  try { return await fn(); }
  finally { if (saved.en === undefined) delete process.env.JEV_ENABLED; else process.env.JEV_ENABLED = saved.en; globalThis.fetch = saved.f; }
}
/** Ряд таблицы: вход, что получено, верно ли, что ожидалось */
type Row = [label: string, got: unknown, ok: boolean, want: string];
function table(rows: Row[]): Verdict {
  const bad = rows.filter((r) => !r[2]);
  const detail = `${rows.length - bad.length}/${rows.length} ок; ` + rows.map(([s, v, ok, want]) => `${ok ? "ок" : "НЕ ок"}: ${s} → ${show(v)} (ожид. ${want})`).join(" | ");
  return bad.length ? fail(detail) : pass(detail);
}

/* ═════════════════════════════ проверки ═════════════════════════════ */

const UG1: Check = {
  id: "U.G1", wp: "U", kind: "fixture", guard: true,
  title: "Проверка бумаги (check_security, правила и Jev): сумма и комиссия из реплики не применяются никогда (сумма выпуска, минимальная сумма, лот, «половину», «из 5 млн», цена за штуку, две суммы — и через тире, дефис, перевод строки); «Проверь X на 1 млн, комиссия 0,3%» → отчёт без них и просьба написать отдельно; обещание — верное или модели: поправка или второе обещание в следующей фразе («20%. Нет, 26%», «Хотя нет, под 22%», «Или 22%?»), срок («за 2,5 года»), «в мес» — никогда не первое / не годовое число; две бумаги и сравнение — модели; «Проверь ещё раз», «оцени риски», «менеджер говорит…» — не поиск в ISS; названы свои сумма или комиссия — прошлые и со страницы не переносятся (без них — переносятся); приветствие или вводное слово перед бумагой («Привет!», «Здравствуйте,», «Пожалуйста,», «Подскажите,») — не запрос, номер ОФЗ — «ОФЗ NNNNN»; «под N%» без глагола продавца («в банке дают», «друг купил») — не обещание; сумма или комиссия в реплике без единицы, жаргоном или словами («сумма 1 000 000», «на 1кк», «на полмиллиона», «1,5 ляма», «на сотку», «плачу брокеру 0,05%») — прошлые 2 000 000 / 0,3 не переносятся; «Менеджер / Банк говорит N%» без отчёта (правила, и со страницы) — модели, не поиск; «ОФЗ 262381» — не «ОФЗ 26238»",
  run: () => gateCheck([
    ...["cs-issue", "cs-issue-na", "cs-min", "cs-half", "cs-part", "cs-from", "cs-per-piece", "cs-two-sums"]
      .map((id): GRow => [id, "отчёт без суммы и комиссии, хвост «напишите отдельным сообщением»", checkedNoInputs]),
    ...["cs-issue-dash", "cs-issue-dash2", "cs-min-dash", "cs-min-hyphen", "cs-min-nl", "cs-lot"]
      .map((id): GRow => [id, "модели (фраза через тире / перевод строки)", (o) => !o.handled && noSum(o)]),
    ["cs-seller-min", "модели или отчёт с обещанием 26 без суммы", modelOr((o) => o.inputs?.promised_pct === 26 && noSum(o))],
    ["cs-seller-min-dash", "модели или отчёт с обещанием 26 без суммы", modelOr((o) => o.inputs?.promised_pct === 26 && noSum(o))],
    ["cs-monthly", "модели или обещание 22 / нет; флаг «обещанная доходность выше реальной» не сработал",
      modelOr((o) => (o.inputs?.promised_pct == null || o.inputs.promised_pct === 22) && !o.fired.some((f) => /обещанн/i.test(f)))],
    ["cs-sum-k", "отчёт по «RU000A10ASE2», сумма и комиссия не применены, хвост «Сумму и комиссию напишите отдельным сообщением»",
      (o) => checkedNoInputs(o) && (o.tools[0]?.input as { query?: string } | undefined)?.query === "RU000A10ASE2"],
    ["cs-promise", "отчёт с обещанием 26, хвост без просьбы «отдельным сообщением»", (o) => o.handled && o.inputs?.promised_pct === 26 && !NOTE.test(o.text)],
    ...["cs-fix-no", "cs-fix-no-jev", "cs-fix-no-jev-rep", "cs-fix-now"].map((id): GRow => [id, "модели или обещание 26, никогда не 20", modelOr((o) => o.inputs?.promised_pct === 26)]),
    ["cs-fix-though", "модели, без обещания («под N%» без глагола продавца — не обещание) или 22; никогда не 26", modelOr((o) => o.inputs?.promised_pct == null || o.inputs.promised_pct === 22)],
    ["cs-fix-or", "модели или без обещания (26 или 22 — выбор не за правилами)", modelOr(noPr)],
    ["cs-term", "модели или без обещания: 30% за 2,5 года — не 30 годовых", modelOr(noPr)],
    ["cs-month", "модели или 24, никогда не 2 годовых", modelOr((o) => o.inputs?.promised_pct === 24)],
    ...["cs-two", "cs-compare", "cs-manager-jev"].map((id): GRow => [id, "модели (две бумаги, сравнение, «менеджер» — не запрос)", (o) => !o.handled]),
    ...["cs-again", "cs-again-jev"].map((id): GRow => [id, "модели или комиссия 0,3 к текущему отчёту; не поиск «ещё раз»", modelOr((o) => o.inputs?.k_pct === 0.3 && noSearch(o))]),
    ["cs-risks", "модели, не поиск «риски»", (o) => !o.handled && noSearch(o)],
    ...["cs-named-prev", "cs-named-prev-jev", "cs-named-k-prev", "cs-named-both-prev", "cs-named-page"].map((id): GRow =>
      [id, "отчёт без суммы и комиссии — ни из реплики, ни прошлых (2 000 000 / 0,3), ни со страницы; хвост «напишите отдельным сообщением»", (o) => checkedNoInputs(o) && noCarry(o)]),
    ["cs-carry", "контроль U.10: сумма в реплике не названа — сумма прошлой проверки 2 000 000 перенесена", (o) => o.handled && posIs(2_000_000)(o) && /как в прошлой проверке/.test(o.text)],
    ["hello-jev", "запрос «Самолёт», не «Привет» (или модели)", modelOr((o) => queryOf(o) === "Самолёт")],
    ["hello-jev2", "запрос «Самолёт БО-П13», не «Здравствуйте» (или модели)", modelOr((o) => queryOf(o) === "Самолёт БО-П13")],
    ["hello-promise-jev", "запрос «РОЛЬФ 1Р07» с обещанием 26, не «Добрый день» (или модели)",
      modelOr((o) => queryOf(o) === "РОЛЬФ 1Р07" && applied(o).promised_pct === 26)],
    ["hello-prev-jev", "запрос «Самолёт», не «Привет» (или модели)", modelOr((o) => queryOf(o) === "Самолёт")],
    ["hello-only-jev", "модели: одно приветствие — не запрос в ISS", (o) => !o.handled && noSearch(o)],
    ...["please-ofz", "hello-ofz", "ask-ofz"].map((id): GRow => [id, "запрос «ОФЗ 26238», не вводное слово (или модели)", modelOr((o) => queryOf(o) === "ОФЗ 26238")]),
    ...["cs-bank", "cs-friend"].map((id): GRow => [id, "ставка банка / чужой покупки не применена как обещанная (отчёт без обещания или модели)", noPr]),
    ["cs-seller", "обещание продавца 26 или модели", modelOr((o) => o.inputs?.promised_pct === 26)],
    ...["cs-named-bare", "cs-named-bare-jev", "cs-named-kk", "cs-named-half", "cs-named-lyam", "cs-named-sotka", "cs-named-pay", "cs-named-broker", "cs-named-ofz"].map((id): GRow =>
      [id, "сумма или комиссия названы в реплике — в inputs нет прошлых 2 000 000 и 0,3, текст не «как в прошлой проверке» (или модели)", modelOr(noPrev)]),
    ...["say-manager", "say-bank", "say-manager-page", "say-manager-q"].map((id): GRow => [id, "модели: «X говорит N%» — не проверка бумаги «X»", (o) => !o.handled && noSearch(o)]),
    ...["ofz-6", "ofz-6-rep", "ofz-6-jev", "ofz-7-jev-rep"].map((id): GRow => [id, "запрос не «ОФЗ 26238» (модели или поиск по введённому номеру)", (o) => queryOf(o) !== "ОФЗ 26238"]),
  ]),
};

const UG2: Check = {
  id: "U.G2", wp: "U", kind: "fixture", guard: true,
  title: "Сумма при готовом отчёте: только «глагол вложения + число с единицей» (дальше конец, знак или предлог) или вся реплика-сумма в ответ на вопрос гейта о сумме; числительные словами, цена за штуку, условия продавца (и через тире), поправка, «или 3», капитал и доля, счёт бумаг, год, валюта (тенге, гривны, «в валюте», у.е.), «на 500 тыс больше / меньше», «ещё», «дополнительно», «каждый месяц», «убыток на сумму…», ответ на вопрос модели о минимальной сумме, сумма вне схемы, отказ («не вложу», «передумал»), прошлое («вложил»), другой инструмент или период («на депозит», «в акции», «в другую облигацию», «за месяц») — модели, никогда неверная сумма",
  run: () => gateCheck([
    ["pos-genitive", "модели или 2 000 000, не 1 000 000", modelOr(posIs(2_000_000))],
    ["pos-2x", "модели или 2 000 000, не 1 000 000", modelOr(posIs(2_000_000))],
    ["pos-gen3", "модели или 3 000 000, не 1 000 000", modelOr(posIs(3_000_000))],
    ...["pos-per-piece-jev", "pos-issue-jev", "pos-year-jev", "pos-usd", "pos-huge", "pos-count", "pos-third-jev", "pos-half", "pos-from", "pos-or", "pos-whole-unasked",
      "pos-more-q", "pos-more-da", "pos-more", "pos-more-jev", "pos-less", "pos-extra", "pos-extra2", "pos-monthly", "pos-quarterly", "pos-tenge", "pos-tenge-jev",
      "pos-uah", "pos-fx", "pos-ue", "pos-loss", "pos-deduct", "pos-min-asked", "pos-min-asked2"]
      .map((id): GRow => [id, "модели, сумма не меняется", (o) => !o.handled && noSum(o)]),
    ["pos-min-jev", "модели или обещание 26 без суммы", modelOr((o) => o.inputs?.promised_pct === 26 && noSum(o))],
    ["pos-min-dash-jev", "модели (тире), сумма 100 000 не применена", (o) => !o.handled && noSum(o)],
    ["pos-entry-jev", "модели (тире), сумма 300 000 не применена", (o) => !o.handled && noSum(o)],
    ["pos-fix-jev", "модели или 3 000 000, не 2 000 000", modelOr(posIs(3_000_000))],
    ["pos-not", "модели или 1 000 000, не 2 000 000", modelOr(posIs(1_000_000))],
    ["pos-no", "модели или 1 000 000, не 2 000 000", modelOr(posIs(1_000_000))],
    ["pos-capital", "модели или 1 000 000, не 3 000 000", modelOr(posIs(1_000_000))],
    ["pos-whole-asked", "2 000 000 или модели", modelOr(posIs(2_000_000))],
    ["pos-ok", "модели или сумма 1 500 000 и обещание 26", modelOr((o) => posIs(1_500_000)(o) && o.inputs?.promised_pct === 26)],
    ...["pos-neg", "pos-neg-ready", "pos-changed", "pos-changed-jev", "pos-wont", "pos-not-this", "pos-past", "pos-deposit", "pos-deposit-jev", "pos-vklad",
      "pos-stocks", "pos-other", "pos-various", "pos-credit", "pos-per-month"]
      .map((id): GRow => [id, "модели: отказ, прошлое, другой инструмент или период — сумма не меняется", (o) => !o.handled && noSum(o)]),
    ["pos-this", "2 000 000 или модели", modelOr(posIs(2_000_000))],
    ["pos-term", "2 000 000 или модели", modelOr(posIs(2_000_000))],
  ]),
};

const UG3: Check = {
  id: "U.G3", wp: "U", kind: "fixture", guard: true,
  title: "Обещание при отчёте: вилка, поправка, «не 26%», два числа, период не при числе, «в мес», «/мес», полгода, доход за срок (дробью, словом, «за пару лет», «в течение»), срок не при числе, надбавка к ставке (КС, ключ, ЦБ — правила и Jev annual_yield), ставка кредита или ипотеки, «а если…», вопрос, обещание по другой названной бумаге, пересказ, тип Jev против правил, «под N%» без глагола продавца или со словами банк / счёт («в банке дают под 18%», «друг купил под 30%»), ставка на часть срока или после налога — модели (или переспрос за срок), никогда неверное годовое; «2% в месяц» → 24 или модели; Jev set_position / set_commission при обещании по другой бумаге («Самолёт, обещали 26%», «проверь рольф, обещали 26», и с суммой) — модели",
  run: () => gateCheck([
    ...["pr-range", "pr-not", "pr-later", "pr-halfyear", "pr-halfyear2", "pr-ks-jev", "pr-key-jev", "pr-key-short", "pr-cb", "pr-cb-jev", "pr-unbound-period", "pr-hypo"]
      .map((id): GRow => [id, "модели, обещание не применено", (o) => !o.handled && noPr(o)]),
    ["pr-fix", "модели или 22, не 26", modelOr((o) => o.inputs?.promised_pct === 22)],
    ["pr-two", "модели или 26, не 20", modelOr((o) => o.inputs?.promised_pct === 26)],
    ["pr-annual-monthly", "22 или модели, никогда не 264", modelOr((o) => o.inputs?.promised_pct === 22)],
    ["pr-term", "обещание не применено (модели или переспрос «доход за весь срок»)", (o) => noPr(o) && (!o.handled || /за весь срок/.test(o.text))],
    ["pr-term2", "обещание не применено (модели или переспрос «доход за весь срок»)", (o) => noPr(o) && (!o.handled || /за весь срок/.test(o.text))],
    ["pr-whatif", "не обещание 10", noPr],
    ["pr-broker", "не обещание 0,3 (комиссия 0,3 или модели)", (o) => noPr(o) && modelOr((x) => x.inputs?.k_pct === 0.3)(o)],
    ["pr-offer", "обещание Самолёта не применено к ОФЗ 26244 (модели или проверка другой бумаги)", (o) => noPr(o) && (!o.handled || o.tools.some((t) => t.tool !== "set_inputs"))],
    ["pr-offer-jev", "обещание Самолёта не применено к ОФЗ 26244", (o) => noPr(o) && !o.handled],
    ["pr-monthly-ok", "обещание 24 (2% в месяц × 12) или модели", modelOr((o) => o.inputs?.promised_pct === 24)],
    ["pr-month-jev", "модели или 26,4, никогда не 2,2", modelOr((o) => o.inputs?.promised_pct === 26.4)],
    ["pr-term-jev", "обещание не применено (30% — за весь срок)", noPr],
    ["pr-retell-jev", "модели: «предложил…, стоит ли?» — не обещание по ОФЗ 26244", (o) => !o.handled && noPr(o)],
    ...["pr-credit", "pr-mortgage", "pr-credit2", "pr-mortgage-jev", "pr-question"].map((id): GRow => [id, "модели: ставка кредита / вопрос — не обещанная доходность", (o) => !o.handled && noPr(o)]),
    ...["pr-term25", "pr-term25-jev", "pr-term6", "pr-term-pair", "pr-term35", "pr-term-during"]
      .map((id): GRow => [id, "обещание не применено (модели или переспрос «доход за весь срок»)", (o) => noPr(o) && (!o.handled || /за весь срок/.test(o.text))]),
    ...["pr-mes", "pr-mes-jev", "pr-mes-slash"].map((id): GRow => [id, "модели или 24, никогда не 2 годовых", modelOr((o) => o.inputs?.promised_pct === 24)]),
    ["pr-nominal-term", "модели или 26 годовых; не переспрос «доход за весь срок (26%)»", (o) => !/за весь срок/.test(o.text) && modelOr((x) => x.inputs?.promised_pct === 26)(o)],
    ...["pr-bank", "pr-bank-jev", "pr-sber", "pr-savings", "pr-friend", "pr-friend-jev", "pr-stocks", "pr-first-year", "pr-first-year-jev", "pr-after-tax"]
      .map((id): GRow => [id, "модели: ставка банка, счёта, чужой покупки, на часть срока, после налога — не обещанная годовая", (o) => !o.handled && noPr(o)]),
    ...["pr-other-pos-jev", "pr-other-k-jev", "pr-other-k-jev2", "pr-other-sum-jev"]
      .map((id): GRow => [id, "модели: Jev выбрал сумму / комиссию, а в реплике обещание по другой бумаге — к ОФЗ 26244 не применено", (o) => !o.handled && noPr(o)]),
  ]),
};

const UG4: Check = {
  id: "U.G4", wp: "U", kind: "fixture", guard: true,
  title: "Комиссия при отчёте: «1,5» после «Напишите сумму или комиссию брокера» — не комиссия 1,5 («0,3» — 0,3); поправка, «не 0,3%», две комиссии, «+», «за 2 сделки», «комиссия за 2 сделки», «2 копейки», 5%, «2 евро», «0,3% в год», «а если…», порог «от 1 млн», не комиссия брокера за сделку (управляющего, за вывод, при погашении, за обслуживание, депозитария, банка, «за покупку и продажу») — модели; «комиссия ноль» → 0, «тариф инвестор, 0,3%» → 0,3 (или модели); комиссия биржи / Мосбиржи (правила, Jev set_position и set_commission) — модели",
  run: () => gateCheck([
    ["k-bare-15", "модели (1,5 — скорее миллионы), не комиссия 1,5", (o) => !o.handled && noK(o)],
    ["k-bare-03", "комиссия 0,3", (o) => o.handled && o.inputs?.k_pct === 0.3],
    ...["k-neg", "k-two", "k-plus", "k-trades", "k-5", "k-eur", "k-hypo", "k-year", "k-trades2", "k-kopeks"].map((id): GRow => [id, "модели, комиссия не применена", (o) => !o.handled && noK(o)]),
    ["k-fix", "модели или 0,05, не 0,3", modelOr((o) => o.inputs?.k_pct === 0.05)],
    ["k-zero", "комиссия 0 или модели", modelOr((o) => o.inputs?.k_pct === 0)],
    ["k-tariff", "комиссия 0,3 или модели, не обещание", (o) => noPr(o) && modelOr((x) => x.inputs?.k_pct === 0.3)(o)],
    ["k-threshold", "модели или комиссия 0,3 без суммы", modelOr((o) => o.inputs?.k_pct === 0.3 && noSum(o))],
    ["k-ok", "сумма 2 000 000 и комиссия 0,3 или модели", modelOr((o) => posIs(2_000_000)(o) && o.inputs?.k_pct === 0.3)],
    ...["k-manager", "k-manager-jev", "k-withdraw", "k-withdraw-jev", "k-maturity", "k-service", "k-depo", "k-bank", "k-round"]
      .map((id): GRow => [id, "модели: не комиссия брокера за сделку (управляющего, вывод, погашение, обслуживание, депозитарий, банк, за круг)", (o) => !o.handled && noK(o)]),
    ["k-broker", "комиссия 0,05 или модели", modelOr((o) => o.inputs?.k_pct === 0.05)],
    ...["k-exchange", "k-exchange-pos-jev", "k-exchange-k-jev", "k-moex"].map((id): GRow => [id, "модели: биржевой сбор — не комиссия брокера", (o) => !o.handled && noK(o)]),
  ]),
};

const UG5: Check = {
  id: "U.G5", wp: "U", kind: "fixture", guard: true,
  title: "Цена предложения (cherk1p6, нет биржевой цены): только одно число 50–150 с «%» / «от номинала» / «по цене N» в ответ на «По какой цене вам предлагают купить?»; ставка «под 26% годовых», купон, сумма рядом, вопрос не о цене, «по цене 1,5», «по цене 250», «15%» — модели, никогда не 26 / 22 / 2 / 1,5 / 250 / 15% номинала",
  run: () => gateCheck([
    ["price-sum-first", "цена 99 или модели, не 2", modelOr((o) => o.inputs?.offer_price_pct === 99)],
    ["price-sum-first-jev", "цена 98,5 или модели, не 2", modelOr((o) => o.inputs?.offer_price_pct === 98.5)],
    ...["price-under", "price-under-q", "price-under-jev", "price-coupon-jev", "price-unasked-jev", "price-small", "price-250", "price-15-jev"]
      .map((id): GRow => [id, "модели, цена не применена", (o) => !o.handled && o.inputs?.offer_price_pct == null]),
    ["price-ok-jev", "цена 98,5 или модели", modelOr((o) => o.inputs?.offer_price_pct === 98.5)],
  ]),
};

const UG6: Check = {
  id: "U.G6", wp: "U", kind: "fixture", guard: true,
  title: "Совет и уточнения: прямая просьба в начале реплики («предложи ты бумагу», «посоветуйте надёжную облигацию», «какую облигацию купить?») — отказ шаблоном; пересказ и сомнение («слышал / читал / видел…, так ли это?», «есть мнение…», «мне предложили…»), названная бумага, другое слово после предмета — не просьба и не шаблон; уточнение до 6 слов с маркером — модели; путь правил: приветствие, «спасибо», «напиши», «погоди» в начале законного вопроса — не шаблон «не по теме» («Привет» целиком — шаблон)",
  run(): Verdict {
    const notAdvice = ["Менеджер в банке сказал, что лучше купить облигации сейчас, пока ставки высокие. Так ли это?", "в банке сказали, что лучше взять облигации",
      "понял, что брать не стоит, спасибо", "посоветуй, что ответить менеджеру", "что посоветуешь делать дальше?", "брокер звонит и спрашивает, что купить",
      "консультант уверяет, что лучше взять сейчас", "посоветуй облигации сбера", "что купить из рольф?", "мне предложили облигацию Самолёт под 26%",
      "посоветуй ОФЗ 26238", "что посоветуешь про Самолёт?", "посоветуй, обещали 26% — это нормально?", "Слышал, что сейчас лучше покупать длинные ОФЗ. Так ли это?",
      "Читал, что лучше купить флоатеры, это так?", "Видел в телеграме, что лучше взять короткие ОФЗ", "есть мнение, что лучше купить ОФЗ, согласен?",
      "слышал, что стоит купить RU000A10ASE2 — так ли это?", "Слышал, что лучше брать короткие облигации", "стоит ли брать облигации?", "подбери слова попроще",
      "посоветуй брокера", "что купить, чтобы обогнать инфляцию?"];
    const advice = ["предложи ты бумагу", "посоветуй облигацию", "какую облигацию купить?", "Здравствуйте, посоветуйте надёжную облигацию", "что лучше купить?",
      "во что вложить?", "дайте совет, какую облигацию взять"];
    const follow: Array<[string, boolean]> = [["ты уверен?", true], ["точно?", true], ["почему так дорого?", true], ["а если ставки вырастут?", true],
      ["не понял", true], ["правда?", true], ["почему инфляция влияет на облигации?", true], ["почему ты считаешь, что этот выпуск хуже остальных?", false], ["привет", false]];
    const t = table([
      ...notAdvice.map((s): Row => { const v = isAdviceRequest(s); return [`isAdviceRequest ${said(s)}`, v, v === false, "false"]; }),
      ...advice.map((s): Row => { const v = isAdviceRequest(s); return [`isAdviceRequest ${said(s)}`, v, v === true, "true"]; }),
      ...follow.map(([s, e]): Row => { const v = isFollowUp(s); return [`isFollowUp ${said(s)}`, v, v === e, String(e)]; }),
    ]);
    const g = gateCheck([
      ...["adv-retell", "adv-heard", "adv-heard-ofz", "adv-heard-no-report", "adv-read", "adv-opinion", "adv-understood", "fu-inflation", "fu-sure"]
        .map((id): GRow => [id, "не шаблон «советов не даю» / «не по теме» — модели", (o) => !o.handled && noTemplate(o)]),
      ["adv-real", "шаблон «советов не даю» (перехват до Jev)", (o) => o.handled && ADVICE_TEMPLATE.test(o.text)],
      ...["off-hello-check", "off-hello-check2", "off-thanks-default", "off-thanks-score", "off-write", "off-wait"]
        .map((id): GRow => [id, "не шаблон «не по теме» (правила) — модели", (o) => !o.handled && noTemplate(o)]),
      ["off-hello", "шаблон «помогаю только с проверкой облигаций» (правила, приветствие целиком)", (o) => o.handled && OFF_TEMPLATE.test(o.text)],
    ]);
    const detail = `функции: ${t.detail} || гейт: ${g.detail}`;
    return t.pass && g.pass ? pass(detail) : fail(detail);
  },
};

const UG7: Check = {
  id: "U.G7", wp: "U", kind: "fixture", guard: true,
  title: `Сложные реплики не разбираются и не занимают процесс: runGate на 40 КБ (пробелы / переводы строк перед «по», «обе», «обещали 5», «под 5%», «посоветуй облигацию очень…») < 200 мс и уходит модели; длиннее ${MAX_PARSE_LEN} симв. и с переводом строки — модели; routeByRules на 40 КБ < 50 мс`,
  run(): Verdict {
    const long = ["long-spaces-po", "long-newlines-obe", "long-promise", "long-under", "long-advice"].map((id) => ({ id, o: G(id) }));
    const okLong = long.every(({ o }) => !o.error && o.ms < 200 && !o.handled);
    const other = ["over-limit", "complex-nl"].map((id) => ({ id, o: G(id) }));
    const okOther = other.every(({ o }) => !o.error && !o.handled && noSum(o) && noK(o) && noPr(o));
    const text = "вложу 1 млн, комиссия 0,3, обещали 26 " + "\n".repeat(40_000) + "?";
    const t0 = performance.now();
    const r = routeByRules(text, false);
    const msRoute = Math.round((performance.now() - t0) * 10) / 10;
    const okRoute = msRoute < 50;
    const detail = long.map(({ id, o }) => `runGate ${said(caseOf(id).said)} → ${o.ms} мс, handled=${o.handled}${o.error ? `, ИСКЛЮЧЕНИЕ ${o.error}` : ""} (ожид. < 200 мс, модели)`).join(" | ") +
      " | " + other.map(({ id, o }) => `${fmtTurn(o)} (ожид. модели, вводы не применены)`).join(" | ") +
      ` | routeByRules(${said(text)}, false) → ${r.intent}/${r.confidence} за ${msRoute} мс (ожид. < 50 мс)${blockedNote()}`;
    return okLong && okOther && okRoute ? pass(detail) : fail(detail);
  },
};

const UG8: Check = {
  id: "U.G8", wp: "U", kind: "unit", guard: true,
  title: "Разбор вводов (moneyIn / parseInputs / promiseByRules / offerPriceIn / isComplex / routeByRules, правила): число верное или «решает модель» (unsure / null) — суммы с единицей и без, год, номер ОФЗ, счёт бумаг, «больше», «ещё», «каждый месяц», валюта, «на сумму» без глагола, вопрос модели о минимальной сумме, «к погашению», обещание в рублях, вилки, «или 3», надбавка к ставке, ставка кредита, период, «в мес», полгода, доход за срок, комиссия в окне и за ней, чужая комиссия, отказ / прошлое / другой инструмент у суммы, «под N%» без продавца, цена вне 50–150; запрос проверки без вводов и приветствия, номер ОФЗ, поправка обещания в проверке, две бумаги; маршрут правил: «не по теме» только приветствие целиком или до трёх слов («Акционерное общество …» — нет), «Проверь ещё раз» — не бумага; «Менеджер / Банк говорит N%» без отчёта — неуверенно; «ОФЗ 262381» — не номер ОФЗ; проверка бумаги с суммой без единицы, «1кк», «полмиллиона», «плачу брокеру» — named, «Проверь ОФЗ 26238» — не named; комиссия биржи — модели",
  async run(): Promise<Verdict> {
    const rows: Row[] = [];
    const money: Array<[string, number | null]> = [["вложу 2 млн", 2_000_000], ["хочу вложить 500 тыс", 500_000], ["куплю на 1 млн", 1_000_000], ["инвестирую 300к", 300_000],
      ["сумма 500 тысяч", 500_000], ["300к", 300_000], ["к 2027 году вложу 2 млн", 2_000_000], ["на 2 млн облигаций", null], ["вложу 2,5 млн", 2_500_000],
      ["вложу 2 млн в долгосрочные облигации", null], ["куплю на сумму 1 млн", 1_000_000], ["вложу 2 млн рублей в ОФЗ", 2_000_000], ["1 млн 200 тыс", null], ["куплю 2 тыс облигаций", null], ["вложу одиннадцать миллионов", null],
      ["вложу в ОФЗ 26238", null], ["300 к", null], ["вложу 300 к концу года", null], ["вложу деньги в 2027", null], ["двадцать два миллиона", null],
      ["вложу миллион двести", null], ["вложу 2 или 3 млн", null], ["вложу 1-2 млн", null], ["вложу $10 000", null], ["вложу 10 тыс долларов", null],
      ["вложу 5000 евро", null], ["вложу 2 000 000", null], ["минимальная сумма 50 тыс, хочу вложить 200 тыс", null], ["вложу около 2 млн", null],
      ["вложу по 2 млн в каждую", null], ["хочу вложить 2 млн из 5", null], ["вложу на 500 тыс больше", null], ["вложу 500 тыс ещё", null],
      ["вкладываю 100 тыс каждый месяц", null], ["хочу вложить 2 млн тенге", null], ["вложу 10 тыс уе", null], ["хочу вложить 2 млн в валюте", null], ["убыток на сумму 100 тыс", null],
      // отказ, прошлое, другой инструмент, период (recheck2 U-G №3); «в долгосрочные облигации» — не обязательно эта бумага
      ["не вложу 2 млн", null], ["хотел вложить 2 млн, но передумал", null], ["вложил 2 млн", null], ["вложу 2 млн, но не в эту", null], ["лучше положу 2 млн на депозит", null],
      ["вложу 2 млн в акции", null], ["вложу 2 млн в другую облигацию", null], ["вкладываю 200 тыс за месяц", null], ["вложу 2 млн в эту облигацию", 2_000_000],
      ["вложу 2 млн на 3 года", 2_000_000], ["вложу 2 млн под 26%", 2_000_000]];
    for (const [s, e] of money) { const v = await rules(() => moneyIn(s)); rows.push([`moneyIn ${said(s)}`, v, v === e, show(e)]); }
    type P = Awaited<ReturnType<typeof parseInputs>>;
    const unsure = (p: P) => p.unsure != null;
    const parsed: Array<[string, "set" | "check", (p: P) => boolean, string, string?]> = [
      ["обещали 18 к погашению", "set", (p) => !p.unsure && p.promise?.annualized === 18 && p.position_size == null, "обещание 18, суммы нет"],
      ["обещают доход 5 тысяч в месяц", "set", unsure, "модели (обещание в рублях)"],
      ["обещали заработать 300 тыс", "set", unsure, "модели (обещание в рублях)"],
      ["обещали 26% годовых с 1 млн", "set", unsure, "модели (сумма рядом с обещанием)"],
      ["вложу 2 млн, комиссия 0,3 или 0,05", "set", unsure, "модели (две комиссии)"],
      ["комиссия не 0,3%", "set", unsure, "модели (поправка комиссии)"],
      ["комиссия 0,3% за 2 сделки", "set", unsure, "модели (два числа в окне комиссии)"],
      ["комиссия 2 евро", "set", (p) => p.k_pct == null, "не комиссия 2% (2 евро — фиксированная плата)"],
      ["комиссия 0,3%, вложу 2 млн", "set", (p) => !p.unsure && p.k_pct === 0.3 && p.position_size === 2_000_000, "комиссия 0,3 и сумма 2 000 000"],
      ["тариф инвестор, 0,3%", "set", (p) => !p.unsure && p.k_pct === 0.3, "комиссия 0,3"],
      ["коммиссия 0,3%", "set", (p) => p.promise == null && (p.unsure != null || p.k_pct === 0.3), "не обещание 0,3"],
      ["у брокера 0,3%", "set", (p) => p.promise == null && p.k_pct == null, "ни обещания, ни комиссии"],
      ["0,3", "set", (p) => p.promise == null && p.k_pct == null, "ни обещания, ни комиссии"],
      ["26", "set", (p) => p.promise == null, "не обещание без слов обещания"],
      ["вложу 2 млн или 3", "set", unsure, "модели (вторая сумма без единицы)"],
      ["вложу 2 млн, 26%", "set", unsure, "модели (число без опоры)"],
      ["обещали 18-26%", "set", unsure, "модели (вилка)"],
      ["предлагали 18%, а теперь 26%", "set", (p) => p.promise == null, "не обещание 18 и не 26"],
      ["обещали доходность на 3% выше депозита", "set", unsure, "модели (надбавка к ставке)"],
      ["обещали ставку ЦБ плюс 3%", "set", unsure, "модели (надбавка к ставке)"],
      ["обещали 18% годовых, выплаты в квартал", "set", (p) => !p.unsure && p.promise?.annualized === 18, "обещание 18, не 72"],
      ["обещали 1% в неделю", "set", unsure, "модели (ставка за неделю правилами к годовым не приводится)"],
      ["обещали 15% за полгода", "set", unsure, "модели (полгода)"],
      ["обещали 50% через 2 года", "set", (p) => p.promise?.annualized == null, "не годовые 50 (доход за срок)"],
      ["обещали 20, потом сказали 26", "set", unsure, "модели (поправка)"],
      ["а если бы обещали 30%?", "set", unsure, "модели (условное)"],
      ["мне предложили облигацию Самолёт под 26%", "set", unsure, "модели (обещание по другой бумаге)"],
      ["вложу 2 млн, обещали 20% годовых, купон платят раз в месяц", "set", (p) => unsure(p) || (p.position_size === 2_000_000 && p.promise?.annualized === 20), "модели или 2 000 000 и 20, не 240"],
      ["2 млн", "set", (p) => p.position_size == null, "без вопроса о сумме — не сумма"],
      ["Проверь RU000A10ASE2 на 1 млн, комиссия 0,3%", "check", (p) => !p.unsure && p.position_size == null && p.k_pct == null && p.named && p.query === "RU000A10ASE2", "без суммы и комиссии, named, запрос «RU000A10ASE2»"],
      ["проверь Самолёт на 2 млн", "check", (p) => !p.unsure && p.position_size == null && p.named && p.query === "Самолёт", "запрос «Самолёт», сумма не разобрана"],
      ["Проверь RU000A10ASE2, договор на 1 млн", "check", (p) => !p.unsure && p.position_size == null && p.query === "RU000A10ASE2", "«договор» — не слово обещания"],
      ["Проверь RU000A10ASE2, обещали 26%", "check", (p) => p.promise?.annualized === 26 && p.query === "RU000A10ASE2" && !p.named, "запрос «RU000A10ASE2», обещание 26"],
      ["Проверь РОЛЬФ 1Р07, обещали 26%", "check", (p) => p.promise?.annualized === 26 && p.query === "РОЛЬФ 1Р07", "запрос «РОЛЬФ 1Р07», обещание 26 (не 1 и не 7)"],
      ["у меня 2 млн, хочу вложить в Самолёт", "check", (p) => p.query === "", "бумагу не выделить — модели"],
      ["Проверь RU000A10ASE2, обещали 20%. Нет, 26%", "check", unsure, "модели (второе число в следующей фразе)"],
      ["Проверь ОФЗ 26244, обещали 15%", "check", (p) => !p.unsure && p.promise?.annualized === 15 && p.query === "ОФЗ 26244", "запрос «ОФЗ 26244», обещание 15 (номер ОФЗ — не кандидат)"],
      ["ВЭБ.РФ 21, обещали 18%", "check", (p) => unsure(p) || p.promise?.annualized === 18, "модели или 18, не 21"],
      ["Сравни RU000A10ASE2 и ОФЗ 26238, что лучше?", "check", unsure, "модели (две бумаги)"],
      ["2 млн", "set", (p) => p.position_size == null, "вопрос модели о минимальной сумме — не сумма вложения", "Какую минимальную сумму покупки вам назвал продавец?"],
      ["2 млн", "set", (p) => p.position_size === 2_000_000, "2 000 000 в ответ на «Напишите сумму…»", LAST_REPORT],
      ["обещали 2% в мес", "set", unsure, "модели («в мес»), не 2 годовых"],
      ["обещали 30% за 2,5 года", "set", (p) => p.promise?.annualized == null, "не годовые 30 (доход за срок)"],
      ["беру кредит под 20%", "set", unsure, "модели (ставка кредита)"],
      ["комиссия 0,3% в год", "set", unsure, "модели (плата за год, не за сделку)"],
      ["комиссия за 2 сделки", "set", (p) => p.k_pct == null, "не комиссия 2%"],
      ["комиссия за вывод 1%", "set", unsure, "модели (не комиссия брокера за сделку)"],
      ["комиссия 0,6% за покупку и продажу", "set", unsure, "модели (комиссия за круг)"],
      ["Проверь RU000A10ASE2, в банке дают под 18%", "check", (p) => !p.unsure && p.promise == null && p.query === "RU000A10ASE2", "запрос «RU000A10ASE2», ставка банка — не обещание"],
      ["Привет! Проверь Самолёт на 2 млн", "check", (p) => !p.unsure && p.query === "Самолёт" && p.named, "запрос «Самолёт» (приветствие снято), сумма не разобрана"],
      ["Привет, что с ОФЗ 26238?", "check", (p) => !p.unsure && p.query === "ОФЗ 26238", "запрос «ОФЗ 26238»"],
      ["Пожалуйста", "check", (p) => p.query === "", "одно вводное слово — запроса нет (модели)"],
      // приёмка U-G 13.10: сумма или комиссия без единицы, жаргоном, словами — named; номер ОФЗ — не сумма; опечатка в номере ОФЗ; биржевой сбор
      ["Проверь RU000A10ASE2, сумма 1 000 000", "check", (p) => !p.unsure && p.named && p.query === "RU000A10ASE2", "named (сумма без единицы), запрос «RU000A10ASE2»"],
      ["Проверь RU000A10ASE2 на 1кк", "check", (p) => unsure(p) || p.named, "named или модели"],
      ["Проверь RU000A10ASE2 на полмиллиона", "check", (p) => unsure(p) || p.named, "named или модели"],
      ["Проверь RU000A10ASE2, плачу брокеру 0,05%", "check", (p) => unsure(p) || p.named, "named или модели"],
      ["Проверь ОФЗ 26238", "check", (p) => !p.unsure && !p.named && p.query === "ОФЗ 26238", "номер ОФЗ — не сумма: не named, запрос «ОФЗ 26238»"],
      ["Проверь ОФЗ 26238, обещали 15%", "check", (p) => !p.unsure && !p.named && p.promise?.annualized === 15, "не named (номер ОФЗ и фраза обещания), обещание 15"],
      ["ОФЗ 262381", "check", (p) => p.query !== "ОФЗ 26238", "запрос не «ОФЗ 26238» (лишняя цифра)"],
      ["комиссия биржи 0,01%", "set", unsure, "модели (биржевой сбор — не комиссия брокера)"],
    ];
    for (const [s, mode, ok, want, last] of parsed) {
      const p = await rules(() => parseInputs(s, mode, last ?? LAST_K_DONE));
      rows.push([`parseInputs(${mode}) ${said(s)}`, { pos: p.position_size, k: p.k_pct, pr: p.promise?.annualized ?? null, unsure: p.unsure, named: p.named, query: p.query }, ok(p), want]);
    }
    for (const [s, e] of [["RU000A10ASE2", null], ["обещали 26%", 26], ["комиссия 0,3%, обещали 18%", 18], ["обещали КС + 2,5%", null], ["26%", null],
      ["обещали 30% за пару лет", null], ["у меня ипотека под 10%", null], ["обещали 26% и вернуть номинал через 3 года", null], ["обещали 2%/мес", null],
      ["в банке дают под 18%", null], ["друг купил под 30%", null], ["в банке предлагают под 18%", null], ["мне предлагают под 26%", 26], ["обещали 26% только первый год", null],
      ["обещали 26% после налогов", null]] as Array<[string, number | null]>) {
      const d = await rules(() => promiseByRules(s));
      rows.push([`promiseByRules ${said(s)}`, d.annualized, d.annualized === e, show(e)]);
    }
    for (const [s, last, e] of [["98,5%", LAST_NO_PRICE, 98.5], ["по цене 99", LAST_NO_PRICE, 99], ["98 от номинала", LAST_NO_PRICE, 98], ["по 99", LAST_NO_PRICE, null],
      ["предлагают под 26% годовых", LAST_NO_PRICE, null], ["98,5%", LAST_REPORT, null], ["по цене 1,5", LAST_NO_PRICE, null], ["по цене 250", LAST_NO_PRICE, null],
      ["15%", LAST_NO_PRICE, null]] as Array<[string, string, number | null]>) {
      const v = offerPriceIn(s, last);
      rows.push([`offerPriceIn ${said(s)}${last === LAST_REPORT ? " (цену не спрашивали)" : ""}`, v, v === e, show(e)]);
    }
    for (const [s, e] of [["вложу 2 млн, комиссия 0,3%", false], ["Минимальная сумма — 100 000", true], ["вложу 2 млн - комиссия 0,3%", true], ["вложу 2 млн\nкомиссия 0,3%", true],
      ["ОФЗ-26243-ПД", false], ["x".repeat(MAX_PARSE_LEN + 1), true]] as Array<[string, boolean]>) {
      const v = isComplex(s);
      rows.push([`isComplex ${said(s)}`, v, v === e, String(e)]);
    }
    // маршрут правил: [реплика, отчёт есть, ожидание]; «не по теме» — уверенно (≥ 0,8) только приветствие целиком или короткий оффтоп
    const route: Array<[string, boolean, (r: ReturnType<typeof routeByRules>) => boolean, string]> = [
      ["Привет! Проверь Самолёт", false, (r) => r.intent !== "out_of_scope", "не out_of_scope"],
      ["спасибо, а почему балл такой низкий?", true, (r) => r.intent !== "out_of_scope", "не out_of_scope"],
      ["напиши подробнее про риски", true, (r) => r.intent !== "out_of_scope", "не out_of_scope"],
      ["погоди, почему?", true, (r) => r.intent !== "out_of_scope", "не out_of_scope"],
      ["оцени риски", true, (r) => r.confidence < 0.8, "неуверенно (не бумага)"],
      ["Проверь ещё раз", true, (r) => r.confidence < 0.8, "неуверенно (не бумага)"],
      ["Проверь Самолёт", false, (r) => r.intent === "check_security" && r.confidence >= 0.8, "check_security ≥ 0,8"],
      ["привет", false, (r) => r.intent === "out_of_scope", "out_of_scope"],
      ["напиши стих", false, (r) => r.intent === "out_of_scope", "out_of_scope"],
      ["Акционерное общество Рольф", false, (r) => r.intent !== "out_of_scope", "не out_of_scope («акционерное» — не «акции»)"],
      ["вложу в акции", false, (r) => r.intent === "out_of_scope", "out_of_scope"],
      ["Менеджер говорит 18 годовых", false, (r) => r.confidence < 0.8, "неуверенно (кто говорит — не бумага)"],
      ["Банк говорит 18%", false, (r) => r.confidence < 0.8, "неуверенно (кто говорит — не бумага)"],
      ["ОФЗ 262381", false, (r) => r.confidence < 0.8, "неуверенно (номер ОФЗ с лишней цифрой)"],
      ["ОФЗ 26238", false, (r) => r.intent === "check_security" && r.confidence >= 0.8, "check_security ≥ 0,8"],
    ];
    for (const [s, rep, ok, want] of route) { const r = routeByRules(s, rep); rows.push([`routeByRules(${rep ? "отчёт" : "без отчёта"}) ${said(s)}`, `${r.intent}/${r.confidence}`, ok(r), want]); }
    return table(rows);
  },
};

export const checks: Check[] = [UG1, UG2, UG3, UG4, UG5, UG6, UG7, UG8];
