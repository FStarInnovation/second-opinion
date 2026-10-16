/**
 * Heartbeat и сторож (план WP-TG §7): «active» ≠ «работает». main.ts вызывает beat() после каждого getUpdates (и раз в 30 с
 * при SO_TG=0), check() — раз в 30 с. Отметка старше staleMs (120 с) → exit(1), systemd поднимает бота заново.
 * Файл и часы внедряются: здесь нет ни fs, ни таймеров.
 */

export function makeHeartbeat(o: {
  file: string; staleMs: number; now(): number; exit(code: number): void;
  write(file: string): void; mtime(file: string): number | null;
}): { beat(): void; check(): void } {
  const startedAt = o.now();
  let exited = false;
  return {
    beat() {
      try { o.write(o.file); } catch { /* не записали — сторож это увидит */ }
    },
    check() {
      if (exited) return;
      let last: number | null = null;
      try { last = o.mtime(o.file); } catch { last = null; }
      if (o.now() - (last ?? startedAt) > o.staleMs) {
        exited = true;
        o.exit(1);
      }
    },
  };
}
