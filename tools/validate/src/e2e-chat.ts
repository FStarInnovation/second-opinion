/**
 * E2E ассистентного слоя (Э3) без ключей: сервер apps/web в режиме SO_OFFLINE=1 MOCK_LLM=1.
 * Проверяет критерий приёмки Э3: сценарии веток проходят в чате, а числа в чате тождественны странице
 * прямого пути (/check) и эталонам golden. Плюс отсутствие чисел о бумаге в тексте ассистента
 * и переход «отчёт → ассистент» (/check → /chat?q=…, поле inputs тела /api/chat).
 *   tsx src/e2e-chat.ts [--base http://localhost:3000] [--shots <dir>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { CONFIG } from "@so/engine/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("--base", "http://localhost:3000");
// Защита от живого сервера (10.10.2026: запуск без --base ушёл в чужой `next dev` на :3000 с ключами и потратил
// бюджет). Сценарии — только против MOCK; живой сервер — лишь с явным --allow-live.
{
  const h = (await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null)) as { mode?: string } | null;
  if (!process.argv.includes("--allow-live") && h?.mode !== "mock") {
    console.error(`e2e-chat: ${BASE} отвечает mode=${h?.mode ?? "нет ответа"} — не MOCK. Сценарии тратят бюджет живых ключей: ` +
      "запустите сервер с SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0 (и --base на его порт) или передайте --allow-live.");
    process.exit(2);
  }
}
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

/** POST /api/chat как клиент AI SDK (id, messages с parts, inputs) → статус, вызовы инструментов и отчёт из UI-потока (SSE). */
type ReportJson = { inputs: Record<string, unknown>; liquidity: { line: string }; yield: { main_pct: number | null } };
async function chatApi(id: string, text: string, inputs?: unknown) {
  const res = await fetch(BASE + "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id, trigger: "submit-message", messages: [{ id: "u_" + id, role: "user", parts: [{ type: "text", text }] }],
      ...(inputs !== undefined ? { inputs } : {}),
    }),
  });
  const events = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  const tools = events.filter((e) => e.type === "tool-input-available").map((e) => ({ name: e.toolName as string, input: e.input }));
  const results = events.filter((e) => e.type === "tool-output-available").map((e) => e.output?.result);
  const report = results.find((r) => r?.kind === "report")?.report as ReportJson | undefined;
  return { status: res.status, tools, report };
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

/* ───── Сценарий 5: переход «отчёт → ассистент» — /check → /chat?q=…, вводы полем inputs тела /api/chat ───── */
const sid = (n: string) => `e2e_c2c_${n}_${Date.now().toString(36)}`;
const s1 = sid("a");
let api = await chatApi(s1, "Проверь RU000A1038V6, обещали 15%", { position_size: 1_000_000, k_pct: 0.3 });
const ai = api.report?.inputs;
ok("inputs: отчёт собран с вводами /check (позиция, комиссия) и «обещали» из текста",
  api.status === 200 && ai?.position_size === 1_000_000 && ai?.k_pct === 0.3 && ai?.promised_pct === 15, `${api.status} ${JSON.stringify(ai)}`);
ok("inputs: строка ликвидности — на 1 000 000", /1 000 000/.test(norm(api.report?.liquidity.line ?? "")), api.report?.liquidity.line);
ok("inputs: инструмент гейта показывает применённые вводы",
  api.tools.some((t) => t.name === "build_bond_report" && (t.input as { inputs?: Record<string, unknown> }).inputs?.position_size === 1_000_000), JSON.stringify(api.tools));
api = await chatApi(s1, "Проверь RU000A1038V6", { position_size: 5_000_000 });
ok("inputs при уже собранном отчёте — игнорируются", api.status === 200 && api.report?.inputs.position_size === CONFIG.positionDefault,
  JSON.stringify(api.report?.inputs));
api = await chatApi(sid("b"), "Проверь RU000A1038V6", { position_size: "abc", k_pct: 0.3 });
ok("невалидный inputs — игнорируется без 400", api.status === 200 && api.report?.inputs.position_size === CONFIG.positionDefault && api.report?.inputs.k_pct == null,
  `${api.status} ${JSON.stringify(api.report?.inputs)}`);
api = await chatApi(sid("c"), "Проверь RU000A105M67", { offer_price_pct: 98.5 });
const npApi = (await (await fetch(`${BASE}/api/report?q=RU000A105M67&price=98.5`)).json()) as { report?: ReportJson };
ok("price из /check: отчёт по цене предложения тот же, что на странице",
  api.report?.inputs.offer_price_pct === 98.5 && api.report?.yield.main_pct != null && api.report?.yield.main_pct === npApi.report?.yield.main_pct,
  `${api.report?.yield.main_pct} vs ${npApi.report?.yield.main_pct}`);

// Браузер: ввод на /check → кнопка → /chat с автоотправкой, те же блоки
await page.goto(BASE + "/check?q=RU000A1038V6");
await page.waitForSelector("[data-block=chat_link] a");
await page.click('[data-preset="1000000"]');
await page.fill("#in-k", "0,3");
await page.fill("#in-pr", "15");
const chatLink = page.locator("[data-block=chat_link] a");
const href = await chatLink.getAttribute("href");
ok("/check: ссылка «Обсудить с ассистентом» несёт бумагу и актуальные вводы", href === "/chat?q=RU000A1038V6&promised=15&pos=1000000&k=0.3", String(href));
const onCheck = Object.fromEntries(await Promise.all(["claim", "yield", "liquidity", "fees"].map(async (b) =>
  [b, norm(await page.locator(`[data-block=${b}]`).innerText())] as const)));
await chatLink.click();
await page.waitForURL(/\/chat\?q=/);
await page.waitForFunction(() => {
  const last = [...document.querySelectorAll('[data-role="assistant"]')].pop();
  return !!last && (last.querySelector(".so-msg__text")?.textContent ?? "").length > 0 && !last.querySelector(".so-tool--pending");
}, undefined, { timeout: 20_000 });
await page.waitForTimeout(300);
const users = await page.locator('[data-role="user"]').allInnerTexts();
ok("/chat: первое сообщение отправлено само и один раз", users.length === 1 && norm(users[0]) === "Проверь RU000A1038V6, обещали 15%", JSON.stringify(users));
const reply = page.locator('[data-role="assistant"]').last();
const inChat = Object.fromEntries(await Promise.all(["claim", "yield", "liquidity", "fees"].map(async (b) =>
  [b, norm(await reply.locator(`[data-block=${b}]`).innerText())] as const)));
ok("/chat: «При позиции 1 000 000 ₽» и «С комиссией брокера 0,3%»",
  /При позиции 1 000 000 ₽/.test(inChat.liquidity) && /С комиссией брокера 0,3%/.test(inChat.fees), `${inChat.liquidity.slice(0, 60)} | ${inChat.fees.slice(0, 60)}`);
const diff = Object.keys(onCheck).filter((b) => onCheck[b] !== inChat[b]);
ok("Паритет /check ≡ /chat после перехода: «Обещали», доходность, ликвидность, комиссии", diff.length === 0,
  diff.map((b) => `\n  ${b} чат:      ${inChat[b]}\n  ${b} страница: ${onCheck[b]}`).join(""));
await page.screenshot({ path: path.join(SHOTS, "chat-from-check.png"), fullPage: true });

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
