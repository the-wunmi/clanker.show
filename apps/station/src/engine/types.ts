export type MainToWorkerMessage =
  | { type: "start"; config: SpaceConfig; spaceId: string }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "listener-count"; count: number }
  | {
      type: "submit-comment";
      comment: { topic: string; content: string; submitter: string };
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
  | { type: "state-change"; state: SpaceState }
  | { type: "transcript-line"; line: TranscriptLine }
  | { type: "archive-segment-start"; payload: SegmentPayload }
  | { type: "archive-segment-audio"; payload: SegmentAudioChunkPayload }
  | { type: "archive-segment-complete"; segmentId: string; durationMs: number }
  | { type: "stream-audio"; mp3: ArrayBuffer }
  | { type: "error"; error: string }
  | { type: "ready" }
  | { type: "caller-status"; callerId: string; status: CallerStatus }
  | { type: "caller-audio-out"; callerId: string; mp3: ArrayBuffer }
  | { type: "engine-event"; event: EngineEvent };

export interface EngineEvent {
  kind: string;
  detail: Record<string, unknown>;
  timestamp: number;
}

export interface ActiveSpeaker {
  callerId: string;
  callerName: string;
}

export interface SpaceState {
  status: "idle" | "live" | "paused";
  currentTopic: string | null;
  currentHost: string | null;
  listenerCount: number;
  uptime: number;
  activeSpeakers?: ActiveSpeaker[];
  currentProgramId?: string;
}

export interface TranscriptLine {
  host: string;
  text: string;
  emotion: string;
  timestamp: number;
}

export interface SpaceConfigHost {
  name: string;
  personality: string;
  voiceId: string;
  style: number;
}

export interface SpaceConfig {
  hosts: SpaceConfigHost[];
  sources: Array<{
    type: "firecrawl_search";
    query: string;
  }>;
  description?: string;
  topicFilter?: string;
  language?: string;
  segmentLength?: number;
  category?: string;
  maxSpeakers?: number;
  durationMin?: number;
  idleBehavior?: "always_on" | "pause";
}
