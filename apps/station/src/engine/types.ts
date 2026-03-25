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
  | { type: "accept-caller"; callerId: string }
  | { type: "caller-audio"; callerId: string; pcm: ArrayBuffer }
  | { type: "caller-connected"; callerId: string; callerName: string; topicHint: string }
  | { type: "caller-disconnected"; callerId: string };

export interface SegmentPayload {
  segmentId: string;
  topic: string;
  sourceUrl?: string;
  programId?: string;
}

export interface SegmentAudioChunkPayload {
  segmentId: string;
  chunk: ArrayBuffer;
}

export type CallerStatus = "accepted" | "on-air" | "speak" | "listening" | "ended";

export type WorkerToMainMessage =
  | { type: "state-change"; state: StationState }
  | { type: "transcript-line"; line: TranscriptLine }
  | { type: "archive-segment-start"; payload: SegmentPayload }
  | { type: "archive-segment-audio"; payload: SegmentAudioChunkPayload }
  | { type: "archive-segment-complete"; segmentId: string; durationMs: number }
  | { type: "error"; error: string }
  | { type: "ready" }
  | { type: "caller-status"; callerId: string; status: CallerStatus }
  | { type: "engine-event"; event: EngineEvent };

export interface EngineEvent {
  kind: string;
  detail: Record<string, unknown>;
  timestamp: number;
}

export interface StationState {
  status: "idle" | "live" | "paused";
  currentTopic: string | null;
  currentHost: string | null;
  listenerCount: number;
  uptime: number;
  activeCallerId?: string;
  activeCallerName?: string;
  currentProgramId?: string;
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
