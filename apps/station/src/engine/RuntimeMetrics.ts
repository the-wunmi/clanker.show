import pino from "pino";

export class RuntimeMetrics {
  private readonly log = pino({ name: "RuntimeMetrics" });
  private decisions = 0;
  private prefetchTriggers = 0;
  private loopErrors = 0;
  private prepEwmaMs = 0;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setInterval(() => {
      this.log.info(
        {
          decisions: this.decisions,
          prefetchTriggers: this.prefetchTriggers,
          loopErrors: this.loopErrors,
          prepEwmaMs: Math.round(this.prepEwmaMs),
        },
        "runtime-metrics",
      );
    }, 15_000);
  }

  stop(): void {
    if (!this.snapshotTimer) return;
    clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  recordDecision(): void {
    this.decisions += 1;
  }

  recordPrefetch(): void {
    this.prefetchTriggers += 1;
  }

  recordLoopError(): void {
    this.loopErrors += 1;
  }

  recordPrepLatency(ms: number): void {
    const alpha = 0.2;
    this.prepEwmaMs = this.prepEwmaMs === 0
      ? ms
      : alpha * ms + (1 - alpha) * this.prepEwmaMs;
  }
}
