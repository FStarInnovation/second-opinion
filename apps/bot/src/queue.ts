/**
 * Очереди ходов (план WP-TG §4.4, §9): ходы одного чата — строго по очереди, разных чатов — параллельно, но всего в работе
 * не больше concurrency. У чата, кроме хода в работе, ждут не больше perChatPending ходов; следующий сразу получает "busy"
 * и не выполняется. run никогда не отклоняется: исключение задачи гасится, слот освобождается в finally.
 */

interface Lane { admitted: boolean; pending: (() => void)[] }

export class ChatQueues {
  private readonly concurrency: number;
  private readonly perChatPending: number;
  private readonly lanes = new Map<string, Lane>();
  /** задачи, ждущие общего слота (FIFO) */
  private readonly ready: (() => void)[] = [];
  private active = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(o: { concurrency: number; perChatPending: number }) {
    this.concurrency = Math.max(1, Math.floor(o.concurrency) || 1);
    this.perChatPending = Math.max(0, Math.floor(o.perChatPending) || 0);
  }

  /** Выполнить job в очереди ключа: "done" — выполнена (или упала), "busy" — очередь ключа полна, job не вызывалась */
  async run(key: string, job: () => Promise<void>): Promise<"done" | "busy"> {
    let lane = this.lanes.get(key);
    if (!lane) { lane = { admitted: false, pending: [] }; this.lanes.set(key, lane); }
    if (lane.admitted) {
      if (lane.pending.length >= this.perChatPending) return "busy";
      await new Promise<void>((res) => { lane!.pending.push(res); });
    } else lane.admitted = true;
    // очередь ключа пройдена — общий слот: свободный берётся сразу, иначе его передаст завершившаяся задача (active не меняется)
    if (this.active < this.concurrency) this.active++;
    else await new Promise<void>((res) => { this.ready.push(res); });
    try {
      await job();
    } catch {
      /* исключение задачи не роняет очередь: ядро пишет свои ошибки в журнал само */
    } finally {
      const nextReady = this.ready.shift();
      if (nextReady) nextReady(); // слот переходит ожидающей задаче
      else this.active--;
      const nextOwn = lane.pending.shift();
      if (nextOwn) nextOwn();
      else { lane.admitted = false; if (this.lanes.get(key) === lane) this.lanes.delete(key); }
      this.wakeIdle();
    }
    return "done";
  }

  /** Разрешается, когда ни одной задачи нет ни в работе, ни в ожидании */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((res) => { this.idleWaiters.push(res); });
  }

  /** Сколько задач сейчас выполняется */
  inFlight(): number { return this.active; }

  private isIdle(): boolean { return this.active === 0 && this.ready.length === 0 && this.lanes.size === 0; }

  private wakeIdle(): void {
    if (!this.isIdle() || !this.idleWaiters.length) return;
    const ws = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of ws) w();
  }
}
