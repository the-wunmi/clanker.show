export type MainToWorkerMessage =
  | { type: "start"; config: StationConfig; stationId: string }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "listener-count"; count: number }
  | {
      type: "submit-tip";
      tip: { topic: string; content: string; submitter: string };
    }
  | { type: "accept-caller"; callerId: string };

export interface SegmentPayload {
  segmentId: string;
  topic: string;
  transcript: Array<{ host: string; text: string; emotion: "neutral" | "excited" | "skeptical" | "amused" | "serious" }>;
  audio: Buffer;
  durationMs: number;
  sourceUrl?: string;
  programId?: string;
}

export type WorkerToMainMessage =
  | { type: "state-change"; state: StationState }
  | { type: "transcript-line"; line: TranscriptLine }
  | { type: "archive-segment"; payload: SegmentPayload }
  | { type: "error"; error: string }
  | { type: "ready" };

export interface StationState {
  status: "idle" | "live" | "paused";
  currentTopic: string | null;
  currentHost: string | null;
  listenerCount: number;
  uptime: number;
}

export interface TranscriptLine {
  host: string;
  text: string;
  emotion: string;
  timestamp: number;
}

export interface StationConfigHost {
  name: string;
  personality: string;
  voiceId: string;
  style: number;
}

export interface StationConfig {
  hosts: StationConfigHost[];
  sources: Array<{
    type: "firecrawl_search";
    query: string;
  }>;
  description?: string;
  topicFilter?: string;
  language?: string;
  segmentLength?: number;
}

export interface StationWorkerData {
  stationId: string;
  slug: string;
  idleBehavior: string;
}
