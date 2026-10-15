/**
 * WP-TG (apps/web) — Telegram-бот на том же движке решений. Харнес по docs/PLAN_telegram_bot_2026-10-14.md §6.
 *
 * Сводит группы apps/web/audit/tg/checks-{static,server,parity,units,vm}.ts в один список в порядке плана:
 * TG.1 … TG.23 (TG.6-tg сразу после TG.6), затем guard TG.G1 … TG.G6. До шага 1а ожидается 24 RED (проверки утверждают
 * желаемое поведение §6) и 6 guard GREEN; после шага 1а TG.22 зеленеет (23 RED).
 *
 * Модулей бота, @so/present и lib/channel.ts ещё нет: группы грузят их динамическим import по вычисляемому пути
 * (tg/types.ts tryImport), нет модуля → RED «нет модуля …; ожидаемо до шага N», а не ERROR. Сценарии с сервером идут
 * в дочерних процессах (tg/scenarios.ts, окружение §6 «Как устроен»); серверные модули в процессе харнеса не импортируются.
 *
 * Состав сверяется с планом при загрузке: если группа потеряла проверку, на её месте стоит заглушка, которая даёт ERROR
 * («дефект харнеса»), а не роняет весь харнес; лишняя проверка идёт в конец списка; дубль id ловит harness.ts (exit 2).
 */
import type { Check } from "../lib";
import { checks as STATIC } from "../tg/checks-static";
import { checks as SERVER } from "../tg/checks-server";
import { checks as PARITY } from "../tg/checks-parity";
import { checks as UNITS } from "../tg/checks-units";
import { checks as VM } from "../tg/checks-vm";

/** Порядок плана §6: таблица RED, затем таблица guard */
const ORDER = [
  "TG.1", "TG.2", "TG.3", "TG.4", "TG.5", "TG.6", "TG.6-tg", "TG.7", "TG.8", "TG.9", "TG.10", "TG.11", "TG.12", "TG.13",
  "TG.14", "TG.15", "TG.16", "TG.17", "TG.18", "TG.19", "TG.20", "TG.21", "TG.22", "TG.23",
  "TG.G1", "TG.G2", "TG.G3", "TG.G4", "TG.G5", "TG.G6",
] as const;

function assemble(groups: Check[][]): Check[] {
  const all = groups.flat();
  const out: Check[] = [];
  for (const id of ORDER) {
    const found = all.filter((c) => c.id === id);
    if (found.length) { out.push(...found); continue; }
    out.push({
      id, wp: "TG", kind: "static", guard: id.startsWith("TG.G"), title: `${id}: проверки нет ни в одной группе apps/web/audit/tg/checks-*.ts`,
      run: () => { throw new Error(`дефект харнеса: проверка ${id} из плана §6 не определена ни в одной группе WP-TG`); },
    });
  }
  out.push(...all.filter((c) => !(ORDER as readonly string[]).includes(c.id)));
  return out;
}

export const checks: Check[] = assemble([STATIC, SERVER, PARITY, UNITS, VM]);
