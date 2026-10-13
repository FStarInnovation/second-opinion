/**
 * Проверка живости. Наружу (через Caddy) — только { ok }: ни модели, ни провайдеров, ни бюджета, и Jev не вызывается.
 * Подробности (режим, модель, Jev, бюджет) — только запросу с самого сервера: deploy/heidi/deploy.sh
 * (curl http://127.0.0.1:3000/api/health) и защита e2e-тестов (tools/validate/src/e2e-chat.ts читает поле mode).
 * Проверка Jev — один крошечный decision-запрос; удачный результат кэшируется на 5 минут, сбой — на 30 секунд;
 * стоимость идёт в дневной бюджет. Значения ключей не уходят никуда.
 *
 * ВАЖНО: «локальность» определяется по заголовкам, а их подделает любой, кто достучится до Next напрямую, минуя Caddy.
 * Поэтому Next должен слушать только loopback: `next start -H 127.0.0.1 -p 3000` (apps/web/package.json, скрипт start)
 * или порт 3000 закрыт снаружи. Сокета обработчик не видит, а X-Forwarded-For от клиента Next не перезаписывает (??=).
 */
import { isMock, provider, modelLabel } from "@/lib/model";
import { jevProvider, jevDecide, type JevProvider } from "@/lib/jev";
import { budgetState, spend } from "@/lib/budget";
import { estimateCost } from "@/lib/usage-log";

export const dynamic = "force-dynamic";

/* ───── «запрос с самого сервера» ─────
 * Caddy (reverse_proxy) каждому внешнему запросу ставит X-Forwarded-For = адрес клиента и передаёт внешний Host
 * (домен или IP сервера). Next, если X-Forwarded-For нет, подставляет адрес сокета, а X-Forwarded-Host — из Host.
 * Локальный запрос: все адреса пересылки (если они есть) — loopback, и Host / X-Forwarded-Host — loopback.
 * Запроса нет вовсе — не локальный: по умолчанию подробностей нет. */
const LOOPBACK_IP = /^(127(\.\d{1,3}){3}|::1|::ffff:127(\.\d{1,3}){3}|0:0:0:0:0:0:0:1)$/i;
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d{1,5})?$/i;
const list = (...vs: Array<string | null | undefined>) => vs.flatMap((v) => (v ?? "").split(",")).map((s) => s.trim()).filter(Boolean);

function fromServerItself(req: Request | undefined): boolean {
  if (!req) return false;
  const h = req.headers;
  if (h.get("forwarded")) return false; // заголовок RFC 7239 ставит только прокси
  const addrs = list(h.get("x-forwarded-for"), h.get("x-real-ip")).map((a) => a.replace(/^\[(.*)\]$/, "$1"));
  if (!addrs.every((a) => LOOPBACK_IP.test(a))) return false;
  let urlHost = "";
  try { urlHost = new URL(req.url).host; } catch { /* относительный URL — только заголовки */ }
  const hosts = list(h.get("host") ?? urlHost, h.get("x-forwarded-host"));
  return hosts.length > 0 && hosts.every((x) => LOOPBACK_HOST.test(x));
}

/* ───── проверка Jev: кэш на провайдера (удача — 5 минут, сбой — 30 секунд), один запрос в полёте ───── */
interface JevStatus { ok: boolean; ms: number; error?: string; checked_at: string }
const JEV_TTL_MS = 5 * 60_000;
/** Сбой держим недолго: после временной ошибки Jev deploy.sh и оператор не должны 5 минут видеть ok:false */
const JEV_FAIL_TTL_MS = 30_000;
const jevCache = new Map<JevProvider, { at: number; status: JevStatus }>();
const jevInflight = new Map<JevProvider, Promise<JevStatus>>();

async function probeJev(): Promise<JevStatus> {
  const t0 = Date.now();
  const at = () => new Date().toISOString();
  try {
    const r = await jevDecide(
      { message: "проверь RU000A10ASE2" },
      { kind: { type: "choice", instructions: "Что хочет пользователь?", criteria: { check_security: "Просит проверить конкретную облигацию.", other: "Что-то другое." } } },
    );
    // вызов Jev — в дневной бюджет, как вызовы гейта
    spend(r.usage?.cost ?? estimateCost("jev", r.usage?.input_tokens ?? 0) ?? 0);
    const a = r.answers?.kind;
    return { ok: a?.type === "choice" && a.choice === "check_security", ms: Date.now() - t0, checked_at: at() };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e instanceof Error ? e.message : e).slice(0, 200), checked_at: at() };
  }
}

async function jevStatus(p: JevProvider): Promise<JevStatus & { cached: boolean }> {
  const hit = jevCache.get(p);
  if (hit && Date.now() - hit.at < (hit.status.ok ? JEV_TTL_MS : JEV_FAIL_TTL_MS)) return { ...hit.status, cached: true };
  let run = jevInflight.get(p);
  if (!run) {
    run = probeJev()
      .then((status) => { jevCache.set(p, { at: Date.now(), status }); return status; })
      .finally(() => jevInflight.delete(p));
    jevInflight.set(p, run);
  }
  return { ...(await run), cached: false };
}

export async function GET(req?: Request) {
  const init = { headers: { "cache-control": "no-store" } };
  if (!fromServerItself(req)) return Response.json({ ok: true }, init);
  const jev = jevProvider();
  const jevInfo = jev ? { provider: jev, ...(await jevStatus(jev)) } : null;
  const b = budgetState();
  return Response.json({
    ok: true, mode: isMock() ? "mock" : provider(), model: modelLabel(), jev: jevInfo,
    budget: { day: b.day, spent_usd: Math.round(b.spent * 1e4) / 1e4, limit_usd: b.limit, messages: b.messages, exhausted: b.exhausted },
  }, init);
}
