/** Deterministic deadlines for testing timeouts that must survive socket activity. */
export class ManualTimers {
  now = 0;
  readonly pending = new Map<
    NodeJS.Timeout,
    { at: number; callback: () => void }
  >();
  readonly scheduler = {
    setTimeout: (callback: () => void, ms: number): NodeJS.Timeout => {
      const timer = {} as NodeJS.Timeout;
      this.pending.set(timer, { at: this.now + ms, callback });
      return timer;
    },
    clearTimeout: (timer: NodeJS.Timeout): void => {
      this.pending.delete(timer);
    },
  };

  advance(ms: number): void {
    this.now += ms;
    for (const [timer, task] of [...this.pending]) {
      if (task.at > this.now) continue;
      this.pending.delete(timer);
      task.callback();
    }
  }
}
