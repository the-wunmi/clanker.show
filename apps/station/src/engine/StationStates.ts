import type { Transition } from "./StateMachine";
import type { ActivityRunResult, PreparedActivity } from "./Activity";

export type StationState =
  | "idle"
  | "booting"
  | "deciding"
  | "preparing"
  | "airing"
  | "boundary"
  | "paused"
  | "error"
  | "stopping";

export type StationEvent =
  | "BOOT"
  | "BOOT_DONE"
  | "DECIDED"
  | "PREPARED"
  | "AIRED"
  | "BOUNDARY_DONE"
  | "PAUSE"
  | "RESUME"
  | "ERROR"
  | "RECOVER"
  | "STOP";

export interface StationMachineContext {
  currentDecision: import("./Director").DirectorDecision | null;
  currentPrepared: PreparedActivity | null;
  currentResult: ActivityRunResult | null;
  errorMessage: string | null;
  errorRecoveryTimer: ReturnType<typeof setTimeout> | null;
}

export function createInitialContext(): StationMachineContext {
  return {
    currentDecision: null,
    currentPrepared: null,
    currentResult: null,
    errorMessage: null,
    errorRecoveryTimer: null,
  };
}

export const STATION_TRANSITIONS: Transition<StationState, StationEvent, StationMachineContext>[] = [
  // Boot sequence
  { from: "idle", event: "BOOT", to: "booting" },
  { from: "booting", event: "BOOT_DONE", to: "deciding" },

  // Core cycle: deciding -> preparing -> airing -> boundary -> deciding
  { from: "deciding", event: "DECIDED", to: "preparing" },
  { from: "preparing", event: "PREPARED", to: "airing" },
  { from: "airing", event: "AIRED", to: "boundary" },
  { from: "boundary", event: "BOUNDARY_DONE", to: "deciding" },

  // Pause from any active state
  { from: ["deciding", "preparing", "airing", "boundary"], event: "PAUSE", to: "paused" },
  { from: "paused", event: "RESUME", to: "deciding" },

  // Error from any active state
  { from: ["booting", "deciding", "preparing", "airing", "boundary"], event: "ERROR", to: "error" },
  { from: "error", event: "RECOVER", to: "deciding" },

  // Stop from anywhere
  { from: ["idle", "booting", "deciding", "preparing", "airing", "boundary", "paused", "error"], event: "STOP", to: "stopping" },
];
