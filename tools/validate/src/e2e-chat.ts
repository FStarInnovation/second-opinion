/**
 * E2E ассистентного слоя (Э3) без ключей: сервер apps/web в режиме SO_OFFLINE=1 MOCK_LLM=1.
 * Проверяет критерий приёмки Э3: сценарии веток проходят в чате, а числа в чате тождественны странице
 * прямого пути (/check) и эталонам golden. Плюс отсутствие чисел о бумаге в тексте ассистента.
 *   tsx src/e2e-chat.ts [--base http://localhost:3000] [--shots <dir>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("--base", "http://localhost:3000");
const SHOTS = path.resolve(arg("--shots", path.join(here, "../../../apps/web/.e2e-shots")));
fs.mkdirSync(SHOTS, { recursive: true });
const goldenDir = path.join(here, "../../../packages/engine/golden/expected");
const golden = (name: string) => JSON.parse(fs.readFileSync(path.join(goldenDir, name + ".json"), "utf8"));

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "ok   " : "FAIL "} ${name}${detail ? "  — " + detail : ""}`); };
const norm = (s: string) => s.replace(/[\s  ]+/g, " ").trim();

async function send(page: Page, text: string) {
  const before = await page.locator('[data-role="assistant"]').count();
  await page.fill(".so-composer__input", text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll('[data-role="assistant"]').length > n, before, { timeout: 20_000 });
  // ждём завершения ответа: исчезла кнопка «Стоп» / появился текст
  await page.waitForFunction(() => {
    const last = [...document.querySelectorAll('[data-role="assistant"]')].pop();
    return !!last && (last.querySelector(".so-msg__text")?.textContent ?? "").length > 0 && !last.querySelector(".so-tool--pending");
  }, undefined, { timeout: 20_000 });
  await page.waitForTimeout(150);
  const last = page.locator('[data-role="assistant"]').last();
  return {
    text: norm(await last.locator(".so-msg__text").allInnerTexts().then((a) => a.join(" "))),
    tools: await last.locator("[data-tool]").evaluateAll((els) => els.map((e) => e.getAttribute("data-tool"))),
    block: (sel: string) => last.locator(sel),
  };
}

/** Числа о бумаге в тексте ассистента: проценты и суммы, кроме введённых пользователем. */
function foreignNumbers(text: string, userNumbers: string[]): string[] {
  const compact = text.replace(/(\d)[ \u00a0](?=\d{3})/g, "$1"); // «5 000 000» → «5000000»
  const found = compact.match(/\d+[.,]?\d*\s*(%|₽|руб)/g) ?? [];
  return found.filter((n) => !userNumbers.some((u) => n.replace(/\s/g, "").startsWith(u.replace(/\s/g, ""))));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
const page = await ctx.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/fonts|ERR_FAILED/.test(m.text())) errors.push(m.text()); });

/* ───── Сценарий 1: РОЛЬФ, «обещали 26%» → сумма → комиссия → вопрос ───── */
await page.goto(BASE + "/chat");
await page.waitForSelector(".so-composer__input");
let r = await send(page, "Проверь РОЛЬФ 1Р07, обещали 26%");
const rolf = golden("rolf").report;
ok("РОЛЬФ: отчёт нарисован блоками", (await r.block('[data-report="bond_report@1"]').count()) === 1, r.tools.join(","));
const claim = norm(await r.block("[data-block=claim]").innerText());
ok("РОЛЬФ: строка «Обещали…» = эталону", claim === norm(rolf.claim.line), claim);
const score = await r.block("[data-score]").innerText();
ok("РОЛЬФ: Truth Score = эталону", score === String(rolf.truth_score.score), score);
const flags = await r.block("[data-flag]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-flag"))));
ok("РОЛЬФ: топ-3 флагов = эталону", JSON.stringify(flags) === JSON.stringify(rolf.truth_score.top3), JSON.stringify(flags));
ok("РОЛЬФ: в тексте нет чужих чисел", foreignNumbers(r.text, ["26"]).length === 0, r.text);
await page.screenshot({ path: path.join(SHOTS, "chat-rolf.png"), fullPage: true });

r = await send(page, "вложу 5 млн");
const liq = norm(await r.block("[data-block=liquidity]").innerText());
ok("Сумма 5 млн: ликвидность пересчитана на позицию", /5 000 000 ₽/.test(liq), liq.slice(0, 120));
ok("Сумма: в тексте нет чужих чисел", foreignNumbers(r.text, ["5000000"]).length === 0, r.text);

r = await send(page, "комиссия брокера 0,3%");
const fees = norm(await r.block("[data-block=fees]").innerText());
ok("Комиссия 0,3%: блок комиссий учёл k", /0,3%/.test(fees) && /после комиссии и налога/.test(fees), fees.slice(0, 160));
// паритет с прямым путём: та же бумага, те же вводы → те же числа
const direct = await ctx.newPage();
await direct.route(/fonts\./, (rt) => rt.abort());
await direct.goto(`${BASE}/check?q=RU000A10ASE2&promised=26&pos=5000000&k=0.3`);
const feesDirect = norm(await direct.locator("[data-block=fees]").innerText());
ok("Паритет чат ≡ страница: блок комиссий", feesDirect === fees, feesDirect === fees ? "" : `\n  чат:      ${fees}\n  страница: ${feesDirect}`);
const liqDirect = norm(await direct.locator("[data-block=liquidity]").innerText());
const liqChat = norm(await r.block("[data-block=liquidity]").innerText());
ok("Паритет чат ≡ страница: блок ликвидности", liqDirect === liqChat);
await direct.close();

r = await send(page, "почему такой низкий балл?");
ok("Вопрос по отчёту: текст без инструментов и без чисел", r.tools.length === 0 && foreignNumbers(r.text, []).length === 0, r.text.slice(0, 120));

r = await send(page, "что такое НКД?");
ok("Термин: карточка глоссария", (await r.block('[data-tool="explain_term"][data-term="nkd"]').count()) === 1);

/* ───── Сценарий 2: Черкизово → выбор → выпуск ───── */
await page.goto(BASE + "/chat");
await page.waitForSelector(".so-composer__input");
r = await send(page, "Черкизово");
const pick = golden("pick-cherkizovo");
const rows = await r.block("[data-block=pick] [data-secid]").count();
ok("Черкизово: список выпусков = эталону", rows === pick.candidates.length, `${rows} vs ${pick.candidates.length}`);
await page.screenshot({ path: path.join(SHOTS, "chat-pick.png"), fullPage: true });
r = await send(page, "RU000A1094F2");
const c17 = golden("cherk1p7").report;
const variant = await r.block("[data-block=yield]").getAttribute("data-variant");
ok("ЧеркизБ1P7: флоатер — три сценария", variant === "scenarios", String(variant));
ok("ЧеркизБ1P7: Truth Score = эталону", (await r.block("[data-score]").innerText()) === String(c17.truth_score.score));

/* ───── Сценарий 3: ЧеркизБ1P6 — нет цены → цена предложения ───── */
await page.goto(BASE + "/chat");
await page.waitForSelector(".so-composer__input");
r = await send(page, "RU000A105M67");
ok("ЧеркизБ1P6: форма цены показана", (await r.block("[data-block=ask_price]").count()) === 1);
ok("ЧеркизБ1P6: ассистент спросил цену", /по какой цене/i.test(r.text), r.text.slice(0, 100));
await page.screenshot({ path: path.join(SHOTS, "chat-noprice.png"), fullPage: true });
r = await send(page, "предлагают по 98,5");
ok("Цена предложения: отчёт пересобран, доходность появилась", (await r.block('[data-block=yield][data-variant="single"]').count()) === 1);
const priceLine = norm(await r.block("[data-block=price_line]").innerText());
ok("Цена предложения: строка цены от 98,5%", /98,50%/.test(priceLine), priceLine.slice(0, 120));
const directNp = await ctx.newPage();
await directNp.route(/fonts\./, (rt) => rt.abort());
await directNp.goto(`${BASE}/check?q=RU000A105M67&price=98.5`);
ok("Паритет чат ≡ страница: доходность от цены предложения",
  norm(await directNp.locator("[data-block=yield]").innerText()) === norm(await r.block("[data-block=yield]").innerText()));
await directNp.close();

/* ───── Сценарий 4: не по теме, не найдена ───── */
await page.goto(BASE + "/chat");
await page.waitForSelector(".so-composer__input");
r = await send(page, "привет, что купить чтобы разбогатеть?");
ok("Не по теме: отказ без инструментов", r.tools.length === 0 && /только с проверкой облигаций/.test(r.text));
r = await send(page, "RU000A10E2A5");
ok("Не найдена: экран «Не нашли»", (await r.block("[data-block=notfound]").count()) === 1);

/* ───── мобильная ширина: чат без горизонтального скролла ───── */
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE + "/chat");
await page.waitForSelector(".so-composer__input");
r = await send(page, "RU000A10ASE2");
const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
ok("390px: нет горизонтального скролла", sw[0] <= sw[1] + 1, sw.join(" > "));
await page.screenshot({ path: path.join(SHOTS, "chat-390.png"), fullPage: true });

ok("Нет ошибок в консоли страницы", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failures ? `\nE2E CHAT FAILED: ${failures}` : `\nE2E CHAT OK — скриншоты: ${path.relative(process.cwd(), SHOTS)}`);
process.exit(failures ? 1 : 0);
