import { Worker } from "worker_threads";
import { EventEmitter } from "events";
import pino from "pino";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  SegmentPayload,
  SpaceConfig,
  SpaceState,
  TranscriptLine,
  CallerStatus,
  EngineEvent,
} from "./types";
import { ArchiveService } from "../services/ArchiveService";
import type { SpaceWithRelations } from "../db";

interface ActiveSpace {
  worker: Worker;
  state: SpaceState;
  listeners: Set<string>;
}

type WorkerFactory = (workerPath: string, space: SpaceWithRelations) => Worker;

interface SpaceManagerDeps {
  archiveService?: ArchiveService;
  workerFactory?: WorkerFactory;
}

export class SpaceManager extends EventEmitter {
  private spaces: Map<string, ActiveSpace> = new Map();
  private log = pino({ name: "SpaceManager" });
  private archiveService: ArchiveService;
  private workerFactory: WorkerFactory;
  private segmentTopics = new Map<string, string>();
  private static readonly MAX_ACTIVE_SPACES = Math.max(
    1,
    Number(process.env.MAX_ACTIVE_SPACES ?? "100"),
  );

  constructor(deps: SpaceManagerDeps = {}) {
    super();
    this.archiveService = deps.archiveService ?? new ArchiveService();
    this.workerFactory = deps.workerFactory ?? ((workerPath, workerData) => new Worker(workerPath, { workerData }));
  }

  private get workerPath(): string {
    return fileURLToPath(new URL("./SpaceWorker.ts", import.meta.url));
  }

  startSpace(
    space: SpaceWithRelations,
    config: SpaceConfig,
  ): void {
    if (this.spaces.size >= SpaceManager.MAX_ACTIVE_SPACES) {
      this.log.warn(
        {
          max: SpaceManager.MAX_ACTIVE_SPACES,
          requestedSpaceId: space.id,
        },
        "Admission control: max active spaces reached",
      );
      this.emit("space-error", space.id, "Max active spaces reached");
      return;
    }

    if (this.spaces.has(space.id)) {
      this.log.warn({ id: space.id }, "Space already running — ignoring start");
      return;
    }

    const worker = this.workerFactory(this.workerPath, space);

    const entry: ActiveSpace = {
      worker,
      state: {
        status: "idle",
        currentTopic: null,
        currentHost: null,
        listenerCount: 0,
        uptime: 0,
      },
      listeners: new Set(),
    };

    this.spaces.set(space.id, entry);

    worker.on("message", (msg: WorkerToMainMessage) => {
      this.handleWorkerMessage(space.id, msg);
    });

    worker.on("error", (err) => {
      this.log.error({ id: space.id, err }, "Worker error");
      this.emit(
        "space-error",
        space.id,
        err instanceof Error ? err.message : String(err),
      );
    });

    worker.on("exit", (code) => {
      this.log.info({ id: space.id, code }, "Worker exited");
      this.spaces.delete(space.id);
      void this.archiveService.abortSpaceArchives(space.id);
    });

    const startMsg: MainToWorkerMessage = {
      type: "start",
      config,
      spaceId: space.id,
    };
    worker.postMessage(startMsg);

    this.log.info({ id: space.id, slug: space.slug }, "Space worker started");
  }

  stopSpace(space: Pick<SpaceWithRelations, "id">): void {
    const entry = this.spaces.get(space.id);
    if (!entry) {
      this.log.warn({ id: space.id }, "No running space to stop");
      return;
    }

    this.log.info({ id: space.id }, "Stopping space");
    this.sendMessage(space.id, { type: "stop" });

    const timeout = setTimeout(() => {
      this.log.warn({ id: space.id }, "Worker did not exit in time — terminating");
      entry.worker.terminate();
    }, 5000);

    entry.worker.once("exit", () => clearTimeout(timeout));
  }

  stopAll(): void {
    this.log.info({ count: this.spaces.size }, "Stopping all running spaces");
    for (const spaceId of this.spaces.keys()) {
      this.stopSpace({ id: spaceId });
    }
  }

  pauseSpace(space: Pick<SpaceWithRelations, "id">): void {
    this.sendMessage(space.id, { type: "pause" });
  }

  resumeSpace(space: Pick<SpaceWithRelations, "id">): void {
    this.sendMessage(space.id, { type: "resume" });
  }

  onListenerChange(space: Pick<SpaceWithRelations, "id">, count: number): void {
    this.sendMessage(space.id, { type: "listener-count", count });
  }

  submitComment(
    spaceId: string,
    comment: { topic: string; content: string; submitter: string },
  ): void {
    this.sendMessage(spaceId, { type: "submit-comment", comment });
  }

  acceptCaller(spaceId: string, callerId: string): void {
    this.sendMessage(spaceId, { type: "accept-caller", callerId });
  }

  forwardCallerAudio(spaceId: string, callerId: string, pcm: Buffer): void {
    const entry = this.spaces.get(spaceId);
    if (!entry) return;
    // Copy into a fresh ArrayBuffer so it can be transferred
    const ab = new ArrayBuffer(pcm.length);
    new Uint8Array(ab).set(pcm);
    entry.worker.postMessage(
      { type: "caller-audio", callerId, pcm: ab } as MainToWorkerMessage,
      [ab],
    );
  }

  notifyCallerConnected(spaceId: string, callerId: string, info: { callerName: string; topicHint: string }): void {
    this.sendMessage(spaceId, {
      type: "caller-connected",
      callerId,
      callerName: info.callerName,
      topicHint: info.topicHint,
    });
  }

  notifyCallerDisconnected(spaceId: string, callerId: string): void {
    this.sendMessage(spaceId, { type: "caller-disconnected", callerId });
  }

  onCallerStatus(spaceId: string, handler: (callerId: string, status: CallerStatus) => void): void {
    this.on(`caller-status:${spaceId}`, handler);
  }

  offCallerStatus(spaceId: string, handler: (callerId: string, status: CallerStatus) => void): void {
    this.off(`caller-status:${spaceId}`, handler);
  }

  onCallerAudio(spaceId: string, handler: (callerId: string, mp3: Buffer) => void): void {
    this.on(`caller-audio-out:${spaceId}`, handler);
  }

  offCallerAudio(spaceId: string, handler: (callerId: string, mp3: Buffer) => void): void {
    this.off(`caller-audio-out:${spaceId}`, handler);
  }

  onEngineEvent(spaceId: string, handler: (event: EngineEvent) => void): void {
    this.on(`engine-event:${spaceId}`, handler);
  }

  offEngineEvent(spaceId: string, handler: (event: EngineEvent) => void): void {
    this.off(`engine-event:${spaceId}`, handler);
  }

  onStreamAudio(spaceId: string, handler: (mp3: Buffer) => void): void {
    this.on(`stream-audio:${spaceId}`, handler);
  }

  offStreamAudio(spaceId: string, handler: (mp3: Buffer) => void): void {
    this.off(`stream-audio:${spaceId}`, handler);
  }

  addStreamListener(spaceId: string): { listenerId: string; count: number } | null {
    const entry = this.spaces.get(spaceId);
    if (!entry) return null;
    const listenerId = randomUUID();
    entry.listeners.add(listenerId);
    return { listenerId, count: entry.listeners.size };
  }

  removeStreamListener(spaceId: string, listenerId: string): number | null {
    const entry = this.spaces.get(spaceId);
    if (!entry) return null;
    entry.listeners.delete(listenerId);
    return entry.listeners.size;
  }

  getSpaceState(spaceId: string): SpaceState | null {
    return this.spaces.get(spaceId)?.state ?? null;
  }

  getCurrentProgramId(spaceId: string): string | undefined {
    return this.spaces.get(spaceId)?.state.currentProgramId;
  }

  onTranscriptLine(
    spaceId: string,
    handler: (line: TranscriptLine) => void,
  ): void {
    this.on(`transcript-line:${spaceId}`, handler);
  }

  onStateChange(
    spaceId: string,
    handler: (state: SpaceState) => void,
  ): void {
    this.on(`state-change:${spaceId}`, handler);
  }

  offTranscriptLine(
    spaceId: string,
    handler: (line: TranscriptLine) => void,
  ): void {
    this.off(`transcript-line:${spaceId}`, handler);
  }

  offStateChange(
    spaceId: string,
    handler: (state: SpaceState) => void,
  ): void {
    this.off(`state-change:${spaceId}`, handler);
  }

  private handleWorkerMessage(
    spaceId: string,
    msg: WorkerToMainMessage,
  ): void {
    const entry = this.spaces.get(spaceId);
    if (!entry) return;

    switch (msg.type) {
      case "state-change":
        entry.state = msg.state;
        this.emit(`state-change:${spaceId}`, msg.state);
        this.emit("state-change", spaceId, msg.state);
        break;

      case "transcript-line":
        this.emit(`transcript-line:${spaceId}`, msg.line);
        this.emit("transcript-line", spaceId, msg.line);
        break;

      case "archive-segment-start":
        this.handleArchiveSegmentStart(spaceId, msg.payload);
        break;

      case "archive-segment-audio":
        this.handleArchiveSegmentAudio(msg.payload.segmentId, Buffer.from(msg.payload.chunk));
        break;

      case "archive-segment-complete":
        this.handleArchiveSegmentComplete(spaceId, msg.segmentId, msg.durationMs);
        break;

      case "caller-status":
        this.emit(`caller-status:${spaceId}`, msg.callerId, msg.status);
        break;

      case "caller-audio-out":
        this.emit(`caller-audio-out:${spaceId}`, msg.callerId, Buffer.from(msg.mp3));
        break;

      case "engine-event":
        this.emit(`engine-event:${spaceId}`, msg.event);
        this.emit("engine-event", spaceId, msg.event);
        break;

      case "stream-audio":
        this.emit(`stream-audio:${spaceId}`, Buffer.from(msg.mp3));
        break;

      case "error":
        this.log.error({ spaceId, error: msg.error }, "Worker reported error");
        this.emit("space-error", spaceId, msg.error);
        break;

      case "ready":
        this.log.info({ spaceId }, "Worker ready");
        break;

      default:
        this.log.warn({ spaceId, msg }, "Unknown message from worker");
    }
  }

  private async handleArchiveSegmentStart(
    spaceId: string,
    payload: SegmentPayload,
  ): Promise<void> {
    try {
      this.segmentTopics.set(payload.segmentId, payload.topic);
      await this.archiveService.startSegmentArchive(spaceId, {
        segmentId: payload.segmentId,
        topic: payload.topic,
        sourceUrl: payload.sourceUrl,
        programId: payload.programId,
      });
    } catch (err) {
      this.log.error({ spaceId, err, segmentId: payload.segmentId }, "Failed to start segment archive");
      this.segmentTopics.delete(payload.segmentId);
      void this.archiveService.abortSegmentArchive(payload.segmentId);
    }
  }

  private async handleArchiveSegmentAudio(
    segmentId: string,
    chunk: Buffer,
  ): Promise<void> {
    try {
      await this.archiveService.appendSegmentAudio(segmentId, chunk);
    } catch (err) {
      this.log.error({ err, segmentId }, "Failed to append segment audio");
      this.segmentTopics.delete(segmentId);
      void this.archiveService.abortSegmentArchive(segmentId);
    }
  }

  private async handleArchiveSegmentComplete(
    spaceId: string,
    segmentId: string,
    durationMs: number,
  ): Promise<void> {
    try {
      const archivedId = await this.archiveService.finishSegmentArchive(segmentId, durationMs);
      if (archivedId) {
        const topic = this.segmentTopics.get(archivedId) ?? "";
        this.segmentTopics.delete(archivedId);
        this.emit("segment-complete", spaceId, archivedId, topic);
      }
    } catch (err) {
      this.log.error({ spaceId, err, segmentId }, "Failed to finalize segment archive");
      this.segmentTopics.delete(segmentId);
      void this.archiveService.abortSegmentArchive(segmentId);
    }
  }

  private sendMessage(spaceId: string, msg: MainToWorkerMessage): void {
    const entry = this.spaces.get(spaceId);
    if (!entry) {
      this.log.warn(
        { spaceId, msgType: msg.type },
        "Cannot send message — space not running",
      );
      return;
    }

    entry.worker.postMessage(msg);
  }
}
