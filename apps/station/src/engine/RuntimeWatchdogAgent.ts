export type RuntimeMode = "normal" | "degraded";

export class RuntimeWatchdogAgent {
  private mode: RuntimeMode = "normal";
  private prepLatencyEwmaMs = 0;
  private errorCount = 0;

  constructor(
    private readonly targetPrepMs = Number(process.env.RUNTIME_TARGET_PREP_MS ?? "9000"),
  ) {}

  onPrepLatency(ms: number): void {
    const alpha = 0.2;
    this.prepLatencyEwmaMs =
      this.prepLatencyEwmaMs === 0
        ? ms
        : alpha * ms + (1 - alpha) * this.prepLatencyEwmaMs;
    this.recomputeMode();
  }

  onLoopError(): void {
    this.errorCount += 1;
    this.recomputeMode();
  }

  onLoopHealthy(): void {
    this.errorCount = Math.max(0, this.errorCount - 1);
    this.recomputeMode();
  }

  getMode(): RuntimeMode {
    return this.mode;
  }

  getPrefetchThreshold(): number {
    return this.mode === "degraded" ? 0.6 : 0.75;
  }

  private recomputeMode(): void {
    if (this.prepLatencyEwmaMs > this.targetPrepMs || this.errorCount >= 3) {
      this.mode = "degraded";
      return;
    }
    this.mode = "normal";
  }
}
