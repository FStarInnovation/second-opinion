"use client";
/**
 * Яндекс Метрика — выключена по умолчанию: layout.tsx рендерит <Metrika>, только если задан NEXT_PUBLIC_YM_ID
 * (номер счётчика; NEXT_PUBLIC_* подставляется при next build — задать в apps/web/.env до сборки). Номер в репозиторий не пишем.
 *
 * Просмотры: счётчик с defer:true (без автоматического хита), хит — на первый показ и на каждую навигацию app router
 * (usePathname/useSearchParams; useSearchParams — внутри Suspense). Из адреса хита убираем m — свободный текст вопроса
 * с главной (/chat?m=…), он не должен уходить в Метрику.
 * Вебвизор: поля ввода помечены ym-hide-content ym-disable-keys (главная, чат, поля отчёта) — то, что вводит пользователь,
 * не записывается.
 * Цели: элементы с data-goal (форма — по submit, ссылка или кнопка — по click), один слушатель на документ:
 *   check_submit — форма «Проверить бумагу» на главной; chat_open — «Открыть чат», примеры вопросов, «Обсудить с ассистентом»;
 *   login_click — «Войти в кабинет» в шапке (@so/blocks SiteHeader). Из кода — reachGoal(name).
 */
import { Suspense, useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export type Goal = "check_submit" | "chat_open" | "login_click";

type Ym = ((id: number, method: string, ...args: unknown[]) => void) & { a?: unknown[]; l?: number };
declare global {
  interface Window { ym?: Ym }
}

const TAG = "https://mc.yandex.ru/metrika/tag.js";
/** Номер счётчика после init; 0 — счётчика нет, reachGoal ничего не делает */
let counter = 0;

/** Цель Метрики; без счётчика (нет NEXT_PUBLIC_YM_ID) — ничего не делает */
export function reachGoal(name: Goal | string): void {
  if (counter && typeof window !== "undefined") window.ym?.(counter, "reachGoal", name);
}

/** Официальный сниппет Метрики: очередь вызовов до загрузки tag.js, сам tag.js — один раз, затем init */
function init(id: number): void {
  if (counter === id) return;
  if (!window.ym) {
    const stub: Ym = function () {
      (stub.a = stub.a || []).push(arguments); // как в сниппете Метрики: tag.js разбирает очередь объектов arguments
    } as Ym;
    stub.l = Date.now();
    window.ym = stub;
  }
  if (!document.querySelector(`script[src="${TAG}"]`)) {
    const s = document.createElement("script");
    s.async = true;
    s.src = TAG;
    document.head.appendChild(s);
  }
  window.ym(id, "init", { defer: true, clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: true });
  counter = id;
}

/** Цели по data-goal: форма — по submit, остальное — по click (клик внутри формы не считается) */
function listenGoals(): () => void {
  const goalEl = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>("[data-goal]") : null);
  const onSubmit = (e: Event) => {
    const el = goalEl(e.target);
    if (el?.tagName === "FORM" && el.dataset.goal) reachGoal(el.dataset.goal);
  };
  const onClick = (e: Event) => {
    const el = goalEl(e.target);
    if (el && el.tagName !== "FORM" && el.dataset.goal) reachGoal(el.dataset.goal);
  };
  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("click", onClick, true);
  return () => {
    document.removeEventListener("submit", onSubmit, true);
    document.removeEventListener("click", onClick, true);
  };
}

function Tracker({ id }: { id: number }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const prev = useRef<string | null>(null);
  // Эффекты одного компонента идут по порядку: сначала init, потом хит
  useEffect(() => {
    init(id);
    return listenGoals();
  }, [id]);
  useEffect(() => {
    const sp = new URLSearchParams(search.toString());
    sp.delete("m");
    const qs = sp.toString();
    const url = `${window.location.origin}${pathname}${qs ? `?${qs}` : ""}`;
    window.ym?.(id, "hit", url, { referer: prev.current ?? document.referrer });
    prev.current = url;
  }, [id, pathname, search]);
  return null;
}

export function Metrika({ id }: { id: string }) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return (
    <>
      <Suspense fallback={null}>
        <Tracker id={n} />
      </Suspense>
      <noscript>
        <div>
          <img src={`https://mc.yandex.ru/watch/${n}`} style={{ position: "absolute", left: "-9999px" }} alt="" />
        </div>
      </noscript>
    </>
  );
}
