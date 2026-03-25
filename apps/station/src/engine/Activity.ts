import type pino from "pino";

import type { ScriptLine } from "../services/ScriptGenerator";
import type { AudioPipeline } from "./AudioPipeline";

export interface ActivityServices {
  log: pino.Logger;
  pipeline: AudioPipeline;
  shouldInterrupt: () => boolean;
  sleep: (ms: number) => Promise<void>;
  emitTranscriptLine: (line: ScriptLine) => void;
  onAudioChunkPushed: (chunk: Buffer) => void;
}

export interface PreparedActivity {
  kind: string;
  segmentId?: string;
  topic?: string;
  [key: string]: unknown;
}

export interface ActivityRunResult {
  interrupted: boolean;
  kind: string;
}

export interface Activity<
  TDecision = unknown,
  TPrepared extends PreparedActivity = PreparedActivity,
> {
  kind: string;
  prepare(decision: TDecision, services: ActivityServices): Promise<TPrepared>;
  run(prepared: TPrepared, services: ActivityServices): Promise<ActivityRunResult>;
}

export class ActivityRegistry {
  private readonly activities = new Map<string, Activity>();

  register(activity: Activity): void {
    this.activities.set(activity.kind, activity);
  }

  get(kind: string): Activity | undefined {
    return this.activities.get(kind);
  }

  has(kind: string): boolean {
    return this.activities.has(kind);
  }
}
