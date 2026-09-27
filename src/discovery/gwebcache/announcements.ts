import { GWEBCACHE_REPORT_DELAY_SEC } from "../../const";

type AnnouncementDependencies = {
  now: () => number;
  connected: () => boolean;
  eligible: () => boolean;
  nextAnnouncementAt: () => number;
  send: () => Promise<void>;
  onError: (error: unknown) => void;
  scheduler: {
    setTimeout: (callback: () => void, ms: number) => NodeJS.Timeout;
    clearTimeout: (timer: NodeJS.Timeout) => void;
  };
};

/** Schedule announcements only after an uninterrupted hour on the network. */
export class CacheAnnouncements {
  private connectedSince?: number;
  private lastAttemptAt?: number;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private sending = false;

  constructor(private readonly deps: AnnouncementDependencies) {}

  refresh(): void {
    if (this.stopped) return;
    if (!this.deps.connected()) {
      this.connectedSince = undefined;
      if (this.timer) this.deps.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    const now = this.deps.now();
    this.connectedSince ??= now;
    if (this.timer || this.sending) return;
    const interval = GWEBCACHE_REPORT_DELAY_SEC * 1000;
    const due = Math.max(
      this.connectedSince + interval,
      this.lastAttemptAt === undefined ? 0 : this.lastAttemptAt + interval,
      this.deps.nextAnnouncementAt() * 1000,
    );
    this.timer = this.deps.scheduler.setTimeout(
      () => {
        this.timer = undefined;
        void this.announce()
          .catch(this.deps.onError)
          .finally(() => this.refresh());
      },
      Math.max(1, due - now),
    );
  }

  async announce(): Promise<void> {
    const now = this.deps.now();
    if (
      this.stopped ||
      this.sending ||
      !this.deps.connected() ||
      !this.isDue(now)
    )
      return;
    // Even an ineligible node must not reschedule an already-due timer in a tight loop.
    this.lastAttemptAt = now;
    if (!this.deps.eligible()) return;
    this.sending = true;
    try {
      await this.deps.send();
    } finally {
      this.sending = false;
    }
  }

  private isDue(now: number): boolean {
    const interval = GWEBCACHE_REPORT_DELAY_SEC * 1000;
    return (
      this.connectedSince !== undefined &&
      now >= this.connectedSince + interval &&
      now >= this.deps.nextAnnouncementAt() * 1000 &&
      (this.lastAttemptAt === undefined ||
        now >= this.lastAttemptAt + interval)
    );
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) this.deps.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
