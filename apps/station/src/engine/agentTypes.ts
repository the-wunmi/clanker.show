import type { PulseEvent } from "../services/ContentPipeline";

export type NextSegmentSource = "program" | "queue" | "filler";

export interface PreparedSegmentLike {
  topic: string;
  sourceUrl?: string;
  programId?: string;
  kind: "filler" | "program" | "queue";
}

export interface PulseHandlerDeps {
  onFastTrackApproved: (pulse: PulseEvent) => void;
  onBufferTopic: (pulse: PulseEvent) => void;
}
