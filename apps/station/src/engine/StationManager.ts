import { Worker } from "worker_threads";
import { EventEmitter } from "events";
import pino from "pino";
import { fileURLToPath } from "node:url";

import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  SegmentPayload,
  StationConfig,
  StationState,
  StationWorkerData,
  TranscriptLine,
  CallerStatus,
  EngineEvent,
} from "./types";
import { ArchiveService } from "../services/ArchiveService";
import type { StationRow } from "../db";

interface ActiveStation {
  worker: Worker;
  state: StationState;
  listeners: Set<string>;
}

type WorkerFactory = (workerPath: string, workerData: StationWorkerData) => Worker;

interface StationManagerDeps {
  archiveService?: ArchiveService;
  workerFactory?: WorkerFactory;
}

export class StationManager extends EventEmitter {
  private stations: Map<string, ActiveStation> = new Map();
  private log = pino({ name: "StationManager" });
  private archiveService: ArchiveService;
  private workerFactory: WorkerFactory;
  private segmentTopics = new Map<string, string>();
  private static readonly MAX_ACTIVE_STATIONS = Math.max(
    1,
    Number(process.env.MAX_ACTIVE_STATIONS ?? "100"),
  );

  constructor(deps: StationManagerDeps = {}) {
    super();
    this.archiveService = deps.archiveService ?? new ArchiveService();
    this.workerFactory = deps.workerFactory ?? ((workerPath, workerData) => new Worker(workerPath, { workerData }));
  }

  private get workerPath(): string {
    return fileURLToPath(new URL("./StationWorker.ts", import.meta.url));
  }

  startStation(
    station: Pick<StationRow, "id" | "slug" | "idleBehavior">,
    config: StationConfig,
  ): void {
    if (this.stations.size >= StationManager.MAX_ACTIVE_STATIONS) {
      this.log.warn(
        {
          max: StationManager.MAX_ACTIVE_STATIONS,
          requestedStationId: station.id,
        },
        "Admission control: max active stations reached",
      );
      this.emit("station-error", station.id, "Max active stations reached");
      return;
    }

    if (this.stations.has(station.id)) {
      this.log.warn({ id: station.id }, "Station already running — ignoring start");
      return;
    }

    const workerData: StationWorkerData = {
      stationId: station.id,
      slug: station.slug,
      idleBehavior: station.idleBehavior ?? "pause",
    };

    const worker = this.workerFactory(this.workerPath, workerData);

    const entry: ActiveStation = {
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

    this.stations.set(station.id, entry);

    worker.on("message", (msg: WorkerToMainMessage) => {
      this.handleWorkerMessage(station.id, msg);
    });

    worker.on("error", (err) => {
      this.log.error({ id: station.id, err }, "Worker error");
      this.emit(
        "station-error",
        station.id,
        err instanceof Error ? err.message : String(err),
      );
    });

    worker.on("exit", (code) => {
      this.log.info({ id: station.id, code }, "Worker exited");
      this.stations.delete(station.id);
      void this.archiveService.abortStationArchives(station.id);
    });

    const startMsg: MainToWorkerMessage = {
      type: "start",
      config,
      stationId: station.id,
    };
    worker.postMessage(startMsg);

    this.log.info({ id: station.id, slug: station.slug }, "Station worker started");
  }

  stopStation(station: Pick<StationRow, "id">): void {
    const entry = this.stations.get(station.id);
    if (!entry) {
      this.log.warn({ id: station.id }, "No running station to stop");
      return;
    }

    this.log.info({ id: station.id }, "Stopping station");
    this.sendMessage(station.id, { type: "stop" });

    const timeout = setTimeout(() => {
      this.log.warn({ id: station.id }, "Worker did not exit in time — terminating");
      entry.worker.terminate();
    }, 5000);

    entry.worker.once("exit", () => clearTimeout(timeout));
  }

  stopAll(): void {
    this.log.info({ count: this.stations.size }, "Stopping all running stations");
    for (const stationId of this.stations.keys()) {
      this.stopStation({ id: stationId });
    }
  }

  pauseStation(station: Pick<StationRow, "id">): void {
    this.sendMessage(station.id, { type: "pause" });
  }

  resumeStation(station: Pick<StationRow, "id">): void {
    this.sendMessage(station.id, { type: "resume" });
  }

  onListenerChange(station: Pick<StationRow, "id">, count: number): void {
    this.sendMessage(station.id, { type: "listener-count", count });
  }

  submitTip(
    stationId: string,
    tip: { topic: string; content: string; submitter: string },
  ): void {
    this.sendMessage(stationId, { type: "submit-tip", tip });
  }

  acceptCaller(stationId: string, callerId: string): void {
    this.sendMessage(stationId, { type: "accept-caller", callerId });
  }

  forwardCallerAudio(stationId: string, callerId: string, pcm: Buffer): void {
    const entry = this.stations.get(stationId);
    if (!entry) return;
    // Copy into a fresh ArrayBuffer so it can be transferred
    const ab = new ArrayBuffer(pcm.length);
    new Uint8Array(ab).set(pcm);
    entry.worker.postMessage(
      { type: "caller-audio", callerId, pcm: ab } as MainToWorkerMessage,
      [ab],
    );
  }

  notifyCallerConnected(stationId: string, callerId: string, info: { callerName: string; topicHint: string }): void {
    this.sendMessage(stationId, {
      type: "caller-connected",
      callerId,
      callerName: info.callerName,
      topicHint: info.topicHint,
    });
  }

  notifyCallerDisconnected(stationId: string, callerId: string): void {
    this.sendMessage(stationId, { type: "caller-disconnected", callerId });
  }

  onCallerStatus(stationId: string, handler: (callerId: string, status: CallerStatus) => void): void {
    this.on(`caller-status:${stationId}`, handler);
  }

  offCallerStatus(stationId: string, handler: (callerId: string, status: CallerStatus) => void): void {
    this.off(`caller-status:${stationId}`, handler);
  }

  onEngineEvent(stationId: string, handler: (event: EngineEvent) => void): void {
    this.on(`engine-event:${stationId}`, handler);
  }

  offEngineEvent(stationId: string, handler: (event: EngineEvent) => void): void {
    this.off(`engine-event:${stationId}`, handler);
  }

  getStationState(stationId: string): StationState | null {
    return this.stations.get(stationId)?.state ?? null;
  }

  getCurrentProgramId(stationId: string): string | undefined {
    return this.stations.get(stationId)?.state.currentProgramId;
  }

  onTranscriptLine(
    stationId: string,
    handler: (line: TranscriptLine) => void,
  ): void {
    this.on(`transcript-line:${stationId}`, handler);
  }

  onStateChange(
    stationId: string,
    handler: (state: StationState) => void,
  ): void {
    this.on(`state-change:${stationId}`, handler);
  }

  offTranscriptLine(
    stationId: string,
    handler: (line: TranscriptLine) => void,
  ): void {
    this.off(`transcript-line:${stationId}`, handler);
  }

  offStateChange(
    stationId: string,
    handler: (state: StationState) => void,
  ): void {
    this.off(`state-change:${stationId}`, handler);
  }

  private handleWorkerMessage(
    stationId: string,
    msg: WorkerToMainMessage,
  ): void {
    const entry = this.stations.get(stationId);
    if (!entry) return;

    switch (msg.type) {
      case "state-change":
        entry.state = msg.state;
        this.emit(`state-change:${stationId}`, msg.state);
        this.emit("state-change", stationId, msg.state);
        break;

      case "transcript-line":
        this.emit(`transcript-line:${stationId}`, msg.line);
        this.emit("transcript-line", stationId, msg.line);
        break;

      case "archive-segment-start":
        this.handleArchiveSegmentStart(stationId, msg.payload);
        break;

      case "archive-segment-audio":
        this.handleArchiveSegmentAudio(msg.payload.segmentId, Buffer.from(msg.payload.chunk));
        break;

      case "archive-segment-complete":
        this.handleArchiveSegmentComplete(stationId, msg.segmentId, msg.durationMs);
        break;

      case "caller-status":
        this.emit(`caller-status:${stationId}`, msg.callerId, msg.status);
        break;

      case "engine-event":
        this.emit(`engine-event:${stationId}`, msg.event);
        this.emit("engine-event", stationId, msg.event);
        break;

      case "error":
        this.log.error({ stationId, error: msg.error }, "Worker reported error");
        this.emit("station-error", stationId, msg.error);
        break;

      case "ready":
        this.log.info({ stationId }, "Worker ready");
        break;

      default:
        this.log.warn({ stationId, msg }, "Unknown message from worker");
    }
  }

  private async handleArchiveSegmentStart(
    stationId: string,
    payload: SegmentPayload,
  ): Promise<void> {
    try {
      this.segmentTopics.set(payload.segmentId, payload.topic);
      await this.archiveService.startSegmentArchive(stationId, {
        segmentId: payload.segmentId,
        topic: payload.topic,
        sourceUrl: payload.sourceUrl,
        programId: payload.programId,
      });
    } catch (err) {
      this.log.error({ stationId, err, segmentId: payload.segmentId }, "Failed to start segment archive");
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
    stationId: string,
    segmentId: string,
    durationMs: number,
  ): Promise<void> {
    try {
      const archivedId = await this.archiveService.finishSegmentArchive(segmentId, durationMs);
      if (archivedId) {
        const topic = this.segmentTopics.get(archivedId) ?? "";
        this.segmentTopics.delete(archivedId);
        this.emit("segment-complete", stationId, archivedId, topic);
      }
    } catch (err) {
      this.log.error({ stationId, err, segmentId }, "Failed to finalize segment archive");
      this.segmentTopics.delete(segmentId);
      void this.archiveService.abortSegmentArchive(segmentId);
    }
  }

  private sendMessage(stationId: string, msg: MainToWorkerMessage): void {
    const entry = this.stations.get(stationId);
    if (!entry) {
      this.log.warn(
        { stationId, msgType: msg.type },
        "Cannot send message — station not running",
      );
      return;
    }

    entry.worker.postMessage(msg);
  }
}
