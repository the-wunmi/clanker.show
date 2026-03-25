import { RuntimeWatchdogAgent } from "./RuntimeWatchdogAgent";

export class StationOrchestrator {
  constructor(
    private readonly watchdog: RuntimeWatchdogAgent,
  ) {}

  shouldEvaluateCall(args: {
    checkpointReached: boolean;
    hasPendingCallerAccept: boolean;
    hasActiveCall: boolean;
    hasInFlightCheck: boolean;
  }): boolean {
    if (!args.checkpointReached) return false;
    if (args.hasPendingCallerAccept) return false;
    if (args.hasActiveCall) return false;
    if (args.hasInFlightCheck) return false;
    return true;
  }

  shouldPrefetchNext(args: {
    segmentProgress: number;
    hasInFlightNext: boolean;
  }): boolean {
    if (args.hasInFlightNext) return false;
    return args.segmentProgress >= this.watchdog.getPrefetchThreshold();
  }

  shouldEnterCallSegment(args: {
    hasPendingCallerAccept: boolean;
    hasActiveCall: boolean;
  }): boolean {
    return args.hasPendingCallerAccept && args.hasActiveCall;
  }

  onPreparationLatency(ms: number): void {
    this.watchdog.onPrepLatency(ms);
  }

  onLoopError(): void {
    this.watchdog.onLoopError();
  }

  onLoopHealthy(): void {
    this.watchdog.onLoopHealthy();
  }

  getMode(): "normal" | "degraded" {
    return this.watchdog.getMode();
  }
}
