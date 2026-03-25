import type { MessagePort } from "worker_threads";
import type { SegmentPayload } from "./types";

interface ArchiveSegmentMeta {
  segmentId: string;
  topic: string;
  sourceUrl?: string;
  programId?: string;
}

export class WorkerArchiveBridge {
  private activeSegmentId: string | null = null;
  private activeBytes = 0;

  constructor(
    private readonly port: MessagePort,
    private readonly bitrateKbps: number,
  ) {}

  beginSegment(meta: ArchiveSegmentMeta): void {
    this.activeSegmentId = meta.segmentId;
    this.activeBytes = 0;
    const payload: SegmentPayload = {
      segmentId: meta.segmentId,
      topic: meta.topic,
      sourceUrl: meta.sourceUrl,
      programId: meta.programId,
    };
    this.port.postMessage({ type: "archive-segment-start", payload });
  }

  appendChunk(chunk: Buffer): void {
    if (!this.activeSegmentId) return;
    const array = new Uint8Array(chunk.length);
    array.set(chunk);
    this.port.postMessage(
      {
        type: "archive-segment-audio",
        payload: { segmentId: this.activeSegmentId, chunk: array.buffer },
      },
      [array.buffer],
    );
    this.activeBytes += chunk.length;
  }

  completeActiveSegment(): void {
    if (!this.activeSegmentId) return;
    const durationMs = Math.round((this.activeBytes * 8) / this.bitrateKbps);
    this.port.postMessage({
      type: "archive-segment-complete",
      segmentId: this.activeSegmentId,
      durationMs,
    });
    this.activeSegmentId = null;
    this.activeBytes = 0;
  }
}
