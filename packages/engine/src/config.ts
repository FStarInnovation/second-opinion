/**
 * Веса, пороги и сетки методики (сводная постановка, разделы метрик и red flags).
 * Любое изменение — сначала в постановку, потом сюда. Модуль без зависимостей от Node.
 */
export const CONFIG = {
  tax: 0.13,
  positionDefault: 500_000,
  positionPresets: [100_000, 500_000, 1_000_000, 5_000_000] as const,
  kGrid: [0, 0.1, 0.3, 0.5, 1] as const,
  kMax: 3,
  scenarios: {
    down: { delta: -2.5, capYears: 1 }, // Δ = −2,5 п.п. × min(t, 1)
    higherLonger: { up: 1.5, to: -1.5, breakAt: 1, flatAt: 2 },
  },
  flags: {
    premiumBp: 600, premiumHighBp: 1000, premiumPts: 20, premiumHighPts: 30,
    illiqTurnover: 1_000_000, illiqTrades: 10, illiqPts: 15,
    spreadPct: 1, spreadPts: 10,
    notTradedPts: 40,
    longDurYears: 5, longDurPts: 5,
    callPts: 10, callSoonDays: 30, callSoonPts: 15,
    resetPts: 5, fxPts: 5, floatPts: 5,
    gapPp: 2, gapHighPp: 5, gapPts: 20, gapHighPts: 30,
    qualPts: 10, listPts: 10, defaultPts: 40,
    structuredPts: 30, perpetualPts: 40, // П31–П32, веса подтверждены владельцем продукта 09.10.2026
  },
  grades: [
    [85, "Прозрачный продукт"],
    [70, "Есть оговорки"],
    [50, "Много рисков"],
    [0, "Высокий риск"],
  ] as const,
  /** windowDays — окно запроса №4 (П13): 35 календарных дней, из них последние ≤20 торговых */
  liq: { goodTurnover: 10e6, midTurnover: 1e6, dayShare: 0.2, windowDays: 35 },
  fxShock: 0.1,
  controlWarnPp: 0.5,
  controlFailPp: 5,
};

export const gradeOf = (score: number): string =>
  CONFIG.grades.find(([min]) => score >= min)![1];
