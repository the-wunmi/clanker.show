import { workerData, parentPort, type MessagePort } from "worker_threads";
import pino from "pino";

import type {
  MainToWorkerMessage,
  StationConfig,
  StationState as ExternalStationState,
  StationWorkerData,
  CallerStatus,
  EngineEvent,
} from "./types";
import type { PulseEvent, ContentSource } from "../services/ContentPipeline";
import type { ScriptLine, CallerCandidate } from "../services/ScriptGenerator";
import type { TranscriptEvent } from "../services/STTService";

import { StateMachine } from "./StateMachine";
import {
  STATION_TRANSITIONS,
  createInitialContext,
  type StationState,
  type StationEvent,
  type StationMachineContext,
} from "./StationStates";
import { ActivityRegistry } from "./Activity";
import { AudioPipeline } from "./AudioPipeline";
import { Director, type DirectorContext } from "./Director";
import { SegmentActivity, type PreparedSegment, type SegmentActivityDeps } from "./activities/SegmentActivity";
import { CallActivity, type ActiveCallState } from "./activities/CallActivity";
import { AdActivity } from "./activities/AdActivity";
import { WorkerArchiveBridge } from "./WorkerArchiveBridge";
import { RuntimeWatchdogAgent } from "./RuntimeWatchdogAgent";
import { RuntimeMetrics } from "./RuntimeMetrics";

import { ContentPipeline } from "../services/ContentPipeline";
import { ScriptGenerator } from "../services/ScriptGenerator";
import { TTSService } from "../services/TTSService";
import { AudioEncoder } from "../services/AudioEncoder";
import { StreamBroadcaster } from "../services/StreamBroadcaster";
import { ProgramPlanner } from "../services/ProgramPlanner";
import { STTService } from "../services/STTService";
import { FactCheckService } from "../services/FactCheckService";
import { createAIClient } from "../services/ai";
import { initDb } from "../db/connection";
import { CallQueue, type CallQueueWithSession } from "../db/index";

// ─── Constants ───────────────────────────────────────────────────────────────

const MP3_BITRATE_KBPS = 128;
const MAX_RECENT_PULSES = 20;
const CALL_CONNECT_GRACE_MS = Math.max(0, Number(process.env.CALL_CONNECT_GRACE_MS ?? "12000"));
const CALL_ACCEPT_TTL_MS = Math.max(CALL_CONNECT_GRACE_MS, Number(process.env.CALL_ACCEPT_TTL_MS ?? "90000"));
const TTS_BATCH_MAX_CHARS = Math.max(120, Number(process.env.TTS_BATCH_MAX_CHARS ?? "220"));
const TTS_BATCH_MAX_LINES = Math.max(1, Number(process.env.TTS_BATCH_MAX_LINES ?? "2"));

// ─── Pending caller accept state ─────────────────────────────────────────────

interface PendingCallerAcceptState {
  callerId: string;
  callerName: string;
  topicHint: string;
  acceptedAtMs: number;
}

// ─── Main runtime class ──────────────────────────────────────────────────────

class StationWorkerRuntime {
  private readonly log: pino.Logger;
  private readonly registry = new ActivityRegistry();
  private readonly watchdog = new RuntimeWatchdogAgent();
  private readonly archiveBridge: WorkerArchiveBridge;
  private readonly metrics = new RuntimeMetrics();

  // Mutable state
  private readonly topicQueue: PulseEvent[] = [];
  private readonly recentTopics: string[] = [];
  private readonly recentPulses: PulseEvent[] = [];
  private readonly pendingFactChecks: string[] = [];

  private externalState: ExternalStationState = {
    status: "idle",
    currentTopic: null,
    currentHost: null,
    listenerCount: 0,
    uptime: 0,
  };

  private running = false;
  private paused = false;
  private startedAt = 0;
  private firstSegmentGenerated = false;
  private hasPushedFirstAudio = false;
  private planningProgramPromise: Promise<void> | null = null;
  private currentSegmentProgress = 0;
  private currentProgramProgress = 0;
  private currentConfig: StationConfig | null = null;

  // Call management
  private activeCall: ActiveCallState | null = null;
  private pendingCallerAccept: PendingCallerAcceptState | null = null;

  private preSynthesizedIntroPromise: Promise<{ lines: ScriptLine[]; audio: Buffer[] } | null> | null = null;
  private preSynthesizedTransitionPromise: Promise<{ lines: ScriptLine[]; audio: Buffer[] } | null> | null = null;

  // Initialized services (set during boot)
  private contentPipeline: ContentPipeline | null = null;
  private scriptGenerator: ScriptGenerator | null = null;
  private programPlanner: ProgramPlanner | null = null;
  private factCheckService: FactCheckService | null = null;
  private pipeline: AudioPipeline | null = null;
  private director: Director | null = null;
  private pulseHandler: ((pulse: PulseEvent) => void) | null = null;

  // Prefetch
  private nextPreparedPromise: Promise<PreparedSegment | null> | null = null;

  // State machine
  private machine!: StateMachine<StationState, StationEvent, StationMachineContext>;

  constructor(
    private readonly data: StationWorkerData,
    private readonly port: MessagePort,
  ) {
    this.log = pino({ name: `worker:${data.slug}` });
    this.archiveBridge = new WorkerArchiveBridge(this.port, MP3_BITRATE_KBPS);
  }

  // ─── Entry point ─────────────────────────────────────────────────────

  run(): void {
    this.machine = new StateMachine<StationState, StationEvent, StationMachineContext>({
      initial: "idle",
      context: createInitialContext(),
      transitions: STATION_TRANSITIONS,
      log: this.log,
      stateActions: {
        booting: { onEntry: () => this.onBoot() },
        deciding: { onEntry: () => this.onDeciding() },
        preparing: { onEntry: () => this.onPreparing() },
        airing: { onEntry: () => this.onAiring() },
        boundary: { onEntry: () => this.onBoundary() },
        paused: { onEntry: () => this.onPaused() },
        error: { onEntry: () => this.onError() },
        stopping: { onEntry: () => this.onStopping() },
      },
    });

    this.port.on("message", this.onMessage);
    this.port.postMessage({ type: "ready" });
    this.log.info({ stationId: this.data.stationId, slug: this.data.slug }, "Worker ready");
  }

  // ─── Message handler ─────────────────────────────────────────────────

  private readonly onMessage = (msg: MainToWorkerMessage): void => {
    switch (msg.type) {
      case "start":
        this.currentConfig = msg.config;
        void this.machine.send("BOOT");
        break;
      case "stop":
        void this.machine.send("STOP");
        break;
      case "pause":
        if (this.running && !this.paused) {
          this.paused = true;
          void this.machine.send("PAUSE");
        }
        break;
      case "resume":
        if (this.running && this.paused) {
          this.paused = false;
          void this.machine.send("RESUME");
        }
        break;
      case "listener-count":
        this.externalState.listenerCount = msg.count;
        this.postState();
        break;
      case "submit-tip":
        this.contentPipeline?.submitTip({
          topic: msg.tip.topic,
          summary: msg.tip.content,
          urgency: "interesting",
          sourceUrl: "",
          rawContent: msg.tip.content,
        });
        break;
      case "accept-caller":
        this.handleAcceptCaller(msg.callerId);
        break;
      case "caller-connected":
        void this.handleCallerConnected(msg.callerId, msg.callerName, msg.topicHint);
        break;
      case "caller-audio":
        this.handleCallerAudio(msg.callerId, Buffer.from(msg.pcm));
        break;
      case "caller-disconnected":
        this.handleCallerDisconnected(msg.callerId);
        break;
      default:
        this.log.warn({ msg }, "Unknown message type");
    }
  };

  // ─── State machine onEntry actions ───────────────────────────────────

  private async onBoot(): Promise<void> {
    const config = this.currentConfig;
    if (!config) return;

    try {
      await initDb();
      const ai = createAIClient();

      this.contentPipeline = new ContentPipeline({ ai });
      this.scriptGenerator = new ScriptGenerator({ ai });
      this.factCheckService = new FactCheckService({ ai });

      const ttsService = new TTSService();
      const audioEncoder = new AudioEncoder();
      const broadcaster = new StreamBroadcaster({
        audioEncoder,
        onAudio: (mp3) => this.postStreamAudio(mp3),
      });

      this.programPlanner = new ProgramPlanner({
        ai,
        stationId: this.data.stationId,
        stationName: this.data.slug,
        stationDescription: config.description,
        searchQueries: config.sources.map((s) => s.query),
        hosts: config.hosts.map((h) => ({ name: h.name, personality: h.personality, voiceId: h.voiceId })),
        durationMin: this.resolveAverageProgramMinutes(),
        useFullEditorial: config.sources.length > 0,
      });

      this.pipeline = new AudioPipeline({
        ttsService,
        audioEncoder,
        broadcaster,
        mp3BitrateKbps: MP3_BITRATE_KBPS,
        batchMaxChars: TTS_BATCH_MAX_CHARS,
        batchMaxLines: TTS_BATCH_MAX_LINES,
        hosts: config.hosts,
      });

      this.director = new Director({
        scriptGenerator: this.scriptGenerator,
        programPlanner: this.programPlanner,
        watchdog: this.watchdog,
        checkCallQueue: () => this.checkCallQueue(),
        getPendingCallerAccept: () => this.pendingCallerAccept,
        getActiveCallerId: () => this.activeCall?.callerId ?? null,
      });

      // Register activities
      this.registerActivities(config);

      this.contentPipeline.start(config.sources as ContentSource[]);

      // Wire pulse handler
      this.pulseHandler = (pulse: PulseEvent) => {
        this.rememberPulse(pulse);
        this.log.info({ topic: pulse.topic, urgency: pulse.urgency }, "New topic from content pipeline");
        void this.director!.handlePulse(
          this.programPlanner,
          pulse,
          (approvedPulse) => this.topicQueue.push(approvedPulse),
        );
      };
      this.contentPipeline.on("pulse", this.pulseHandler);

      this.running = true;
      this.paused = false;
      this.startedAt = Date.now();
      this.firstSegmentGenerated = false;
      this.hasPushedFirstAudio = false;
      this.pendingFactChecks.length = 0;
      this.metrics.start();

      this.externalState.status = "live";
      this.postState();

      await this.machine.send("BOOT_DONE");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err }, "Fatal error during boot");
      this.port.postMessage({ type: "error", error: message });
      this.machine.context.errorMessage = message;
      await this.machine.send("ERROR");
    }
  }

  private async onDeciding(): Promise<void> {
    if (!this.director || !this.running || this.paused) return;

    try {
      const ctx = this.buildDirectorContext();
      this.emitEngineEvent("deciding", {
        hasProgramSegment: ctx.hasProgramSegment,
        hasQueuedTopic: ctx.hasQueuedTopic,
        isFirstSegment: ctx.isFirstSegment,
        pendingCallerAcceptId: ctx.pendingCallerAcceptId,
        activeCallerId: ctx.activeCallerId,
      });

      const decision = await this.director.decide(ctx);
      this.metrics.recordDecision();

      this.emitEngineEvent("decided", {
        kind: decision.kind,
        ...(decision.kind === "call" ? { callerId: decision.callerId, callerName: decision.callerName } : {}),
        ...(decision.kind === "segment" ? { source: decision.source } : {}),
      });
      this.machine.context.currentDecision = decision;

      await this.machine.send("DECIDED");
    } catch (err) {
      this.log.error({ err }, "Error in deciding state");
      this.machine.context.errorMessage = err instanceof Error ? err.message : String(err);
      await this.machine.send("ERROR");
    }
  }

  private async onPreparing(): Promise<void> {
    const decision = this.machine.context.currentDecision;
    if (!decision || !this.pipeline) return;

    try {
      const activity = this.registry.get(decision.kind);
      if (!activity) {
        this.log.error({ kind: decision.kind }, "No activity registered for decision kind");
        await this.machine.send("ERROR");
        return;
      }

      const services = this.buildActivityServices();
      const prepStartMs = Date.now();

      const prepared = await activity.prepare(decision, services);
      this.machine.context.currentPrepared = prepared;

      const prepElapsedMs = Date.now() - prepStartMs;
      this.metrics.recordPrepLatency(prepElapsedMs);
      this.watchdog.onPrepLatency(prepElapsedMs);

      this.log.info(
        { kind: prepared.kind, prepElapsedMs, topic: prepared.topic },
        "Activity prepared",
      );

      await this.machine.send("PREPARED");
    } catch (err) {
      this.log.error({ err }, "Error in preparing state");
      this.archiveBridge.completeActiveSegment();
      this.machine.context.errorMessage = err instanceof Error ? err.message : String(err);
      await this.machine.send("ERROR");
    }
  }

  private async onAiring(): Promise<void> {
    const prepared = this.machine.context.currentPrepared;
    if (!prepared) return;

    try {
      const activity = this.registry.get(prepared.kind);
      if (!activity) {
        await this.machine.send("ERROR");
        return;
      }

      // Update external state
      if (prepared.kind === "segment" && prepared.topic) {
        this.externalState.currentTopic = prepared.topic !== "filler" ? prepared.topic : null;
        this.postState();
      }

      const services = this.buildActivityServices();
      const result = await activity.run(prepared, services);
      this.machine.context.currentResult = result;

      if (result.interrupted) {
        this.currentSegmentProgress = 0;

        // If interrupted because a call transition played at a checkpoint,
        // advance to boundary. The caller may or may not have connected yet —
        // the boundary handler will wait for the connection if needed.
        if (this.pendingCallerAccept) {
          this.log.info(
            {
              callerId: this.pendingCallerAccept.callerId,
              callerConnected: Boolean(this.activeCall),
            },
            "Segment interrupted for call transition",
          );
          this.archiveBridge.completeActiveSegment();
          await this.machine.send("AIRED");
          return;
        }

        // Interrupted by pause/stop — stay in current state until handler resolves it
        return;
      }

      this.currentSegmentProgress = 0;
      this.watchdog.onLoopHealthy();

      await this.machine.send("AIRED");
    } catch (err) {
      this.log.error({ err }, "Error in airing state");
      this.archiveBridge.completeActiveSegment();
      this.machine.context.errorMessage = err instanceof Error ? err.message : String(err);
      this.metrics.recordLoopError();
      this.watchdog.onLoopError();
      await this.machine.send("ERROR");
    }
  }

  private async onBoundary(): Promise<void> {
    if (!this.director) return;

    try {
      const prepared = this.machine.context.currentPrepared;
      const segmentKind = prepared?.kind === "segment"
        ? (prepared as PreparedSegment).segmentKind
        : "filler";
      const topic = prepared?.topic ?? "unknown";

      this.emitEngineEvent("boundary:start", {
        topic,
        segmentKind,
        pendingCallerAcceptId: this.pendingCallerAccept?.callerId ?? null,
        activeCallerId: this.activeCall?.callerId ?? null,
      });

      const result = await this.director.handleBoundary({
        topic,
        segmentKind: segmentKind as "filler" | "program" | "queue",
        pendingCallerAccept: this.pendingCallerAccept,
        activeCallerId: this.activeCall?.callerId ?? null,
        callConnectGraceMs: CALL_CONNECT_GRACE_MS,
        callAcceptTtlMs: CALL_ACCEPT_TTL_MS,
        evaluateCallOpportunityAtBoundary: async () => {
          const evalResult = await this.director!.evaluateCallOpportunity({
            segmentKind: segmentKind as "filler" | "program" | "queue",
            segmentProgress: 1,
            programProgress: this.currentProgramProgress,
            currentTopic: this.externalState.currentTopic ?? "general",
            stationDescription: this.currentConfig?.description ?? "",
          });
          if (evalResult.selectedCaller) {
            await this.acceptAndNotifyCaller(
              evalResult.selectedCaller.id,
              evalResult.selectedCaller.callerName,
              evalResult.selectedCaller.topicHint,
            );
          }
        },
        waitForAcceptedCallerConnection: (timeoutMs) =>
          this.waitForAcceptedCallerConnection(timeoutMs),
        expirePendingCallerAccept: (reason) =>
          this.expirePendingCallerAccept(reason),
      });

      this.emitEngineEvent("boundary:done", { action: result.action });

      if (result.action === "enter_call" && this.activeCall) {
        this.postCallerStatus(this.activeCall.callerId, "on-air");
        // The next deciding phase will pick up the active call
      }

      await this.machine.send("BOUNDARY_DONE");
    } catch (err) {
      this.log.error({ err }, "Error in boundary state");
      this.machine.context.errorMessage = err instanceof Error ? err.message : String(err);
      await this.machine.send("ERROR");
    }
  }

  private async onPaused(): Promise<void> {
    this.externalState.status = "paused";
    this.postState();

    // Push silence while paused
    while (this.paused && this.running) {
      await this.pipeline?.pushSilence(1000);
      await this.sleep(1000);
    }
  }

  private async onError(): Promise<void> {
    const message = this.machine.context.errorMessage ?? "Unknown error";
    this.log.error({ error: message }, "Entered error state");
    this.port.postMessage({ type: "error", error: message });
    this.archiveBridge.completeActiveSegment();
    this.metrics.recordLoopError();

    // Auto-recover after 5s
    this.machine.context.errorRecoveryTimer = setTimeout(() => {
      this.machine.context.errorRecoveryTimer = null;
      if (this.running && !this.paused) {
        void this.machine.send("RECOVER");
      }
    }, 5000);
  }

  private onStopping(): void {
    this.log.info("Stopping station worker");
    this.running = false;
    this.paused = false;

    if (this.machine.context.errorRecoveryTimer) {
      clearTimeout(this.machine.context.errorRecoveryTimer);
      this.machine.context.errorRecoveryTimer = null;
    }

    if (this.contentPipeline && this.pulseHandler) {
      this.contentPipeline.off("pulse", this.pulseHandler);
      this.pulseHandler = null;
    }
    if (this.activeCall) this.cleanupCall();
    this.pendingCallerAccept = null;
    this.contentPipeline?.stop();
    this.pipeline?.broadcaster.disconnect();
    this.pendingFactChecks.length = 0;
    this.topicQueue.length = 0;
    this.recentPulses.length = 0;
    this.metrics.stop();

    this.externalState.status = "idle";
    this.externalState.currentTopic = null;
    this.externalState.currentHost = null;
    this.postState();

    setTimeout(() => process.exit(0), 500);
  }

  // ─── Activity registration ───────────────────────────────────────────

  private registerActivities(config: StationConfig): void {
    const hosts = config.hosts.map((h) => ({
      name: h.name,
      personality: h.personality,
      voiceId: h.voiceId,
    }));
    const stationContext = {
      stationName: this.data.slug,
      description: config.description,
      previousTopics: this.recentTopics,
    };

    const segmentDeps: SegmentActivityDeps = {
      stationId: this.data.stationId,
      scriptGenerator: this.scriptGenerator!,
      programPlanner: this.programPlanner!,
      factCheckService: this.factCheckService,
      archiveBridge: this.archiveBridge,
      hosts,
      stationContext,
      topicQueue: this.topicQueue,
      recentTopics: this.recentTopics,
      recentPulses: this.recentPulses,
      firstSegmentGenerated: this.firstSegmentGenerated,
      setFirstSegmentGenerated: (v) => { this.firstSegmentGenerated = v; },
      hasPushedFirstAudio: this.hasPushedFirstAudio,
      setHasPushedFirstAudio: (v) => { this.hasPushedFirstAudio = v; },
      pendingFactChecks: this.pendingFactChecks,
      planningProgramPromise: this.planningProgramPromise,
      ensureProgramPlanning: () => this.ensureProgramPlanning(),
      resolveTargetSegmentMinutes: (fastStart) => this.resolveTargetSegmentMinutes(fastStart),
      buildGenerationProgressContext: () => this.buildGenerationProgressContext(),
      createContextualFillerPulse: (topic) => this.createContextualFillerPulse(topic),
      onSegmentProgress: (segmentProgress) => {
        this.currentSegmentProgress = segmentProgress;
        const activeProgram = this.programPlanner?.getActiveProgram();
        if (activeProgram && activeProgram.segments.length > 0) {
          this.currentProgramProgress = Math.min(
            1,
            (activeProgram.currentSegmentIndex + segmentProgress) / activeProgram.segments.length,
          );
        } else {
          this.currentProgramProgress = segmentProgress;
        }
      },
      onStageOnePrefetch: () => this.ensureProgramPlanning(),
      onApproachingCheckpoint: (segmentProgress) => {
        // Fires at ~50% of the way to the next checkpoint.
        // Evaluate calls and accept + start pre-gen so transition is ready by checkpoint time.
        if (this.pendingCallerAccept || this.activeCall) return;

        const prepared = this.machine.context.currentPrepared;
        const segmentKind = prepared?.kind === "segment"
          ? (prepared as PreparedSegment).segmentKind
          : "filler";
        this.emitEngineEvent("call:evaluating", { segmentProgress, segmentKind });
        this.director!.evaluateCallOpportunity({
          segmentKind: segmentKind as "filler" | "program" | "queue",
          segmentProgress,
          programProgress: this.currentProgramProgress,
          currentTopic: this.externalState.currentTopic ?? "general",
          stationDescription: this.currentConfig?.description ?? "",
        }).then((evalResult) => {
          this.metrics.recordDecision();
          this.emitEngineEvent("call:evaluated", {
            selectedCallerId: evalResult.selectedCaller?.id ?? null,
            reason: evalResult.reason,
          });
          if (evalResult.selectedCaller) {
            this.acceptAndNotifyCaller(
              evalResult.selectedCaller.id,
              evalResult.selectedCaller.callerName,
              evalResult.selectedCaller.topicHint,
            ).catch((err) => this.log.error({ err }, "acceptAndNotifyCaller failed from lookahead"));
          }
        }).catch((err) => this.log.warn({ err }, "Call opportunity check failed"));
      },
      onCheckpoint: async (segmentProgress) => {
        // Fires at the actual AI checkpoint. If a transition was pre-generated, inject it.
        // Transcript lines are emitted by AudioPipeline via onLineSpoken(-1, line).
        if (this.pendingCallerAccept && this.preSynthesizedTransitionPromise) {
          const transition = await this.preSynthesizedTransitionPromise;
          if (transition) {
            this.emitEngineEvent("call:transition-played", {
              callerId: this.pendingCallerAccept.callerId,
              lineCount: transition.lines.length,
              segmentProgress,
            });
            return transition;
          }
        }

        return null;
      },
      shouldPrefetchNext: (segmentProgress) =>
        this.director!.shouldPrefetchNext({
          segmentProgress,
          hasInFlightNext: this.nextPreparedPromise !== null,
        }),
      triggerPrefetch: (segmentProgress) => {
        this.metrics.recordPrefetch();
        const segActivity = this.registry.get("segment") as SegmentActivity;
        this.nextPreparedPromise = segActivity.prepare(
          { kind: "segment", source: "program" },
          this.buildActivityServices(),
        ).catch((err) => {
          this.log.error({ err }, "Prefetch preparation failed");
          return null;
        });
        this.log.info(
          { segmentProgress: Math.round(segmentProgress * 100) },
          "Triggered next segment prefetch",
        );
      },
    };

    this.registry.register(new SegmentActivity(segmentDeps));
    this.registry.register(new CallActivity({
      scriptGenerator: this.scriptGenerator!,
      hosts,
      stationName: this.data.slug,
      stationDescription: config.description,
      getActiveCall: () => this.activeCall,
      getPreSynthesizedIntro: async () => {
        if (!this.preSynthesizedIntroPromise) return null;
        return this.preSynthesizedIntroPromise;
      },
      postCallerStatus: (callerId, status) => this.postCallerStatus(callerId, status),
      sendCallerAudio: (callerId, mp3) => this.sendCallerAudio(callerId, mp3),
      waitForUtterance: (timeoutMs) => this.waitForUtterance(timeoutMs),
      resetTurnAudioTracking: () => {
        this.callerTurnFirstAudioMs = 0;
        this.callerTurnFirstAudioLogged = false;
      },
      cleanupCall: () => this.cleanupCall(),
    }));
    this.registry.register(new AdActivity({
      scriptGenerator: this.scriptGenerator!,
      hosts,
      stationName: this.data.slug,
      onAdAired: () => this.director?.resetAdCounter(),
    }));
  }

  // ─── Build helpers ───────────────────────────────────────────────────

  private buildActivityServices() {
    return {
      log: this.log,
      pipeline: this.pipeline!,
      shouldInterrupt: () =>
        !this.running ||
        this.paused,
      sleep: (ms: number) => this.sleep(ms),
      emitTranscriptLine: (line: ScriptLine) => {
        this.port.postMessage({
          type: "transcript-line",
          line: { host: line.host, text: line.text, emotion: line.emotion, timestamp: Date.now() },
        });
      },
      onAudioChunkPushed: (chunk: Buffer) => {
        this.archiveBridge.appendChunk(chunk);
      },
    };
  }

  private buildDirectorContext(): DirectorContext {
    const nextProgramSegment = this.programPlanner?.peekNextSegment();
    const hasQueuedTopic = this.topicQueue.length > 0;
    const progress = this.buildGenerationProgressContext();

    return {
      hasProgramSegment: Boolean(nextProgramSegment),
      hasQueuedTopic,
      queuedTopicCount: this.topicQueue.length,
      isFirstSegment: !this.firstSegmentGenerated,
      segmentPercent: progress.segmentPercent ?? 0,
      programPercent: progress.programPercent ?? 0,
      currentSegmentNumber: progress.currentSegmentNumber,
      totalSegments: progress.totalSegments,
      pendingCallerAcceptId: this.pendingCallerAccept?.callerId ?? null,
      activeCallerId: this.activeCall?.callerId ?? null,
      pendingCallerName: this.pendingCallerAccept?.callerName ?? null,
      pendingCallerTopicHint: this.pendingCallerAccept?.topicHint ?? null,
      currentTopic: this.externalState.currentTopic,
      segmentsSinceLastAd: this.director?.getSegmentsSinceLastAd() ?? 0,
      hasResumableSegment: false,
    };
  }

  // ─── Caller management ───────────────────────────────────────────────

  private async checkCallQueue(): Promise<CallerCandidate[]> {
    const currentProgramId = this.programPlanner?.getActiveProgram()?.id;

    const rows = await CallQueue.findMany({
      where: { stationId: this.data.stationId, status: "waiting" },
      include: { session: true },
      orderBy: { createdAt: "asc" },
    }) as CallQueueWithSession[];

    const now = Date.now();
    const results: CallerCandidate[] = [];

    for (const row of rows) {
      // End callers from a previous program — their queue entry is stale
      if (currentProgramId && row.programId && row.programId !== currentProgramId) {
        CallQueue.update(row.id, { status: "ended", endedAt: new Date() }).catch((err) => {
          this.log.error({ err, callerId: row.id }, "Failed to end stale caller");
        });
        continue;
      }

      results.push({
        id: row.id,
        callerName: row.session?.name ?? "Anonymous",
        topicHint: row.topicHint ?? "",
        waitingMinutes: Math.round((now - (row.createdAt ? new Date(row.createdAt).getTime() : now)) / 60_000),
      });
    }

    return results;
  }

  private async acceptAndNotifyCaller(callerId: string, callerName: string, topicHint: string): Promise<void> {
    this.emitEngineEvent("call:accepted", { callerId, callerName, topicHint });
    await CallQueue.update(callerId, { status: "accepted", acceptedAt: new Date() });
    this.pendingCallerAccept = { callerId, callerName, topicHint, acceptedAtMs: Date.now() };
    this.postCallerStatus(callerId, "accepted");

    // Pre-generate transition AND intro in parallel while waiting for the caller to connect
    if (callerName && this.scriptGenerator && this.pipeline && this.currentConfig) {
      const hosts = this.currentConfig.hosts.map((h) => ({
        name: h.name,
        personality: h.personality,
        voiceId: h.voiceId,
      }));
      const currentTopic = this.externalState.currentTopic ?? "general";
      this.log.info({ callerId, callerName, topicHint }, "PERF pregen:start — generating transition + intro in parallel");

      // Pre-generate call transition (bridge from current topic to caller)
      const transitionT0 = Date.now();
      this.log.info({ callerId, callerName, topicHint, currentTopic }, "PERF transition:llm:start");
      this.preSynthesizedTransitionPromise = this.scriptGenerator
        .generateCallTransition(callerName, topicHint, currentTopic, hosts)
        .then(async (transition) => {
          const llmMs = Date.now() - transitionT0;
          this.log.info({ callerId, llmMs, lineCount: transition.lines.length }, "PERF transition:llm:end");

          const ttsT0 = Date.now();
          this.log.info({ callerId, lineCount: transition.lines.length }, "PERF transition:tts:start");
          const audio = await Promise.all(
            transition.lines.map(async (line, i) => {
              const lineT0 = Date.now();
              const pcm = await this.pipeline!.ttsService.synthesize(
                line.text,
                this.pipeline!.resolveVoiceId(line.host),
                line.emotion,
              );
              const mp3 = await this.pipeline!.audioEncoder.encode(pcm);
              this.log.info({ callerId, lineIndex: i, ttsLineMs: Date.now() - lineT0, textLen: line.text.length }, "PERF transition:tts:line");
              return mp3;
            }),
          );
          const ttsMs = Date.now() - ttsT0;
          const totalMs = Date.now() - transitionT0;
          this.log.info({ callerId, ttsMs, totalMs, lineCount: transition.lines.length }, "PERF transition:tts:end — transition ready");
          return { lines: transition.lines, audio };
        })
        .catch((err) => {
          this.log.warn({ err, callerId, elapsedMs: Date.now() - transitionT0 }, "PERF transition:failed");
          return null;
        });

      // Pre-generate guest intro (welcome the caller on air)
      const introT0 = Date.now();
      this.log.info({ callerId, callerName, topicHint }, "PERF intro:llm:start");
      this.preSynthesizedIntroPromise = this.scriptGenerator
        .generateGuestIntro(callerName, topicHint, hosts)
        .then(async (intro) => {
          const llmMs = Date.now() - introT0;
          this.log.info({ callerId, llmMs, lineCount: intro.lines.length }, "PERF intro:llm:end");

          const ttsT0 = Date.now();
          this.log.info({ callerId, lineCount: intro.lines.length }, "PERF intro:tts:start");
          const audio = await Promise.all(
            intro.lines.map(async (line, i) => {
              const lineT0 = Date.now();
              const pcm = await this.pipeline!.ttsService.synthesize(
                line.text,
                this.pipeline!.resolveVoiceId(line.host),
                line.emotion,
              );
              const mp3 = await this.pipeline!.audioEncoder.encode(pcm);
              this.log.info({ callerId, lineIndex: i, ttsLineMs: Date.now() - lineT0, textLen: line.text.length }, "PERF intro:tts:line");
              return mp3;
            }),
          );
          const ttsMs = Date.now() - ttsT0;
          const totalMs = Date.now() - introT0;
          this.log.info({ callerId, ttsMs, totalMs, lineCount: intro.lines.length }, "PERF intro:tts:end — intro ready");
          return { lines: intro.lines, audio };
        })
        .catch((err) => {
          this.log.warn({ err, callerId, elapsedMs: Date.now() - introT0 }, "PERF intro:failed");
          return null;
        });
    }
  }

  private handleAcceptCaller(callerId: string): void {
    this.emitEngineEvent("call:manual-accept", { callerId });
    this.acceptAndNotifyCaller(callerId, "", "").catch((err) => {
      this.log.error({ err, callerId }, "Failed to accept caller");
    });
  }

  private async handleCallerConnected(callerId: string, callerName: string, topicHint: string): Promise<void> {
    if (this.activeCall) {
      this.emitEngineEvent("call:rejected", { callerId, reason: "another_call_active", activeCallerId: this.activeCall.callerId });
      return;
    }

    this.emitEngineEvent("call:connected", { callerId, callerName, topicHint, machineState: this.machine.current() });

    // Create STT service but don't start the stream yet — it will be started
    // in CallActivity.run() after the host intro airs, so the WebSocket doesn't
    // die from inactivity while the current segment finishes and the intro plays.
    const sttService = new STTService();
    const callerEncoder = this.pipeline!.createCallerStream();

    // Reset audio stats for new call
    this.callerAudioReceivedBytes = 0;
    this.callerAudioDroppedBytes = 0;
    this.callerAudioForwardedBytes = 0;
    this.lastCallerAudioLogMs = 0;

    this.activeCall = {
      callerId,
      callerName,
      topicHint,
      sttService,
      callerEncoder,
      accumulatedTranscript: [],
      aiTurnCount: 0,
      callerTurnActive: false,
      disconnected: false,
    };

    if (this.pendingCallerAccept?.callerId === callerId) {
      this.pendingCallerAccept.callerName = callerName;
      this.pendingCallerAccept.topicHint = topicHint;
    }

    sttService.on("transcript", (event: TranscriptEvent) => {
      if (!this.activeCall || this.activeCall.callerId !== callerId) return;
      if (event.isFinal && event.text) {
        const sttLatencyMs = this.callerTurnFirstAudioMs > 0 ? Date.now() - this.callerTurnFirstAudioMs : -1;
        this.log.info(
          { callerId, turn: this.activeCall.aiTurnCount, textLen: event.text.length, sttLatencyMs, text: event.text.slice(0, 120) },
          "PERF stt:committed-transcript",
        );
        this.activeCall.accumulatedTranscript.push(event.text);
        this.port.postMessage({
          type: "transcript-line",
          line: {
            host: `Caller: ${callerName}`,
            text: event.text,
            emotion: "neutral",
            timestamp: Date.now(),
          },
        });
      }
    });

    sttService.on("utterance-end", () => {
      if (!this.activeCall || this.activeCall.callerId !== callerId) return;
      if (this.activeCall.resolveUtterance) {
        this.activeCall.resolveUtterance();
        this.activeCall.resolveUtterance = undefined;
      }
    });

    this.externalState.activeCallerId = callerId;
    this.externalState.activeCallerName = callerName;
    this.postState();
  }

  private callerAudioReceivedBytes = 0;
  private callerAudioDroppedBytes = 0;
  private callerAudioForwardedBytes = 0;
  private lastCallerAudioLogMs = 0;
  private callerTurnFirstAudioMs = 0;
  private callerTurnFirstAudioLogged = false;

  private handleCallerAudio(callerId: string, pcm: Buffer): void {
    if (!this.activeCall || this.activeCall.callerId !== callerId) return;

    this.callerAudioReceivedBytes += pcm.length;

    if (!this.activeCall.callerTurnActive) {
      this.callerAudioDroppedBytes += pcm.length;
      const now = Date.now();
      if (now - this.lastCallerAudioLogMs > 5000) {
        this.lastCallerAudioLogMs = now;
        this.log.info(
          {
            callerId,
            receivedBytes: this.callerAudioReceivedBytes,
            droppedBytes: this.callerAudioDroppedBytes,
            forwardedBytes: this.callerAudioForwardedBytes,
            reason: "callerTurnActive=false",
          },
          "Caller audio stats (turn inactive)",
        );
      }
      return;
    }

    if (!this.callerTurnFirstAudioLogged) {
      this.callerTurnFirstAudioMs = Date.now();
      this.callerTurnFirstAudioLogged = true;
      this.log.info(
        { callerId, turn: this.activeCall.aiTurnCount, bytes: pcm.length },
        "PERF caller:first-audio-in-turn",
      );
    }

    this.callerAudioForwardedBytes += pcm.length;
    this.activeCall.callerEncoder.write(pcm);
    this.activeCall.sttService.sendAudio(pcm);
  }

  private handleCallerDisconnected(callerId: string): void {
    if (!this.activeCall || this.activeCall.callerId !== callerId) return;
    this.emitEngineEvent("call:disconnected", { callerId, machineState: this.machine.current() });
    this.activeCall.disconnected = true;
    if (this.activeCall.resolveUtterance) {
      this.activeCall.resolveUtterance();
      this.activeCall.resolveUtterance = undefined;
    }
  }

  private cleanupCall(): void {
    if (!this.activeCall) return;
    const { callerId, sttService, callerEncoder } = this.activeCall;

    this.log.info(
      {
        callerId,
        aiTurns: this.activeCall.aiTurnCount,
        totalAudioReceived: this.callerAudioReceivedBytes,
        totalAudioDropped: this.callerAudioDroppedBytes,
        totalAudioForwarded: this.callerAudioForwardedBytes,
        transcriptSegments: this.activeCall.accumulatedTranscript.length,
      },
      "Call audio summary at cleanup",
    );

    sttService.close();
    callerEncoder.close();

    CallQueue.update(callerId, { status: "ended", endedAt: new Date() }).catch((err) => {
      this.log.error({ err, callerId }, "Failed to update call end status");
    });

    this.postCallerStatus(callerId, "ended");

    this.externalState.activeCallerId = undefined;
    this.externalState.activeCallerName = undefined;
    this.postState();

    this.activeCall = null;
    this.pendingCallerAccept = null;
    this.preSynthesizedIntroPromise = null;
    this.preSynthesizedTransitionPromise = null;
    this.emitEngineEvent("call:cleaned-up", { callerId });
  }

  private async waitForUtterance(timeoutMs: number): Promise<boolean> {
    if (!this.activeCall) return false;
    const waitStartMs = Date.now();
    this.log.info(
      { callerId: this.activeCall.callerId, timeoutMs, forwardedBytes: this.callerAudioForwardedBytes },
      "Waiting for caller utterance",
    );
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.activeCall) this.activeCall.resolveUtterance = undefined;
        this.log.warn(
          {
            callerId: this.activeCall?.callerId,
            waitedMs: Date.now() - waitStartMs,
            forwardedBytes: this.callerAudioForwardedBytes,
            droppedBytes: this.callerAudioDroppedBytes,
          },
          "Utterance wait timed out",
        );
        resolve(false);
      }, timeoutMs);

      this.activeCall!.resolveUtterance = () => {
        clearTimeout(timer);
        this.log.info(
          {
            callerId: this.activeCall?.callerId,
            waitedMs: Date.now() - waitStartMs,
            transcriptLen: this.activeCall?.accumulatedTranscript.length,
          },
          "Utterance received",
        );
        resolve(true);
      };
    });
  }

  private async waitForAcceptedCallerConnection(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (
      this.running &&
      Date.now() < deadline &&
      this.pendingCallerAccept &&
      !this.activeCall
    ) {
      await this.sleep(250);
    }
    return Boolean(this.pendingCallerAccept && this.activeCall);
  }

  private async expirePendingCallerAccept(reason: string): Promise<void> {
    if (!this.pendingCallerAccept || this.activeCall) return;
    const pending = this.pendingCallerAccept;
    this.log.warn(
      { callerId: pending.callerId, reason, acceptedForMs: Date.now() - pending.acceptedAtMs },
      "Expiring accepted caller and returning to waiting queue",
    );
    this.pendingCallerAccept = null;
    try {
      await CallQueue.update(pending.callerId, { status: "waiting", acceptedAt: null });
    } catch (err) {
      this.log.error({ err, callerId: pending.callerId }, "Failed to reset expired accepted caller");
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private postState(): void {
    this.externalState.uptime = this.running ? Date.now() - this.startedAt : 0;
    this.externalState.currentProgramId = this.programPlanner?.getActiveProgram()?.id ?? undefined;
    this.port.postMessage({ type: "state-change", state: { ...this.externalState } });
  }

  private postCallerStatus(callerId: string, status: CallerStatus): void {
    this.port.postMessage({ type: "caller-status", callerId, status });
  }

  private sendCallerAudio(callerId: string, mp3: Buffer): void {
    const ab = new ArrayBuffer(mp3.length);
    new Uint8Array(ab).set(mp3);
    this.port.postMessage(
      { type: "caller-audio-out", callerId, mp3: ab },
      [ab],
    );
  }

  private postStreamAudio(mp3: Buffer): void {
    const ab = new ArrayBuffer(mp3.length);
    new Uint8Array(ab).set(mp3);
    this.port.postMessage({ type: "stream-audio", mp3: ab }, [ab]);
  }

  private emitEngineEvent(kind: string, detail: Record<string, unknown> = {}): void {
    const event: EngineEvent = { kind, detail, timestamp: Date.now() };
    this.port.postMessage({ type: "engine-event", event });
    this.log.info({ engineEvent: kind, ...detail }, `engine:${kind}`);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private resolveAverageProgramMinutes(): number {
    const raw = Number(process.env.AVERAGE_PROGRAM_MINUTES ?? "30");
    if (!Number.isFinite(raw)) return 30;
    return Math.max(10, Math.min(240, Math.round(raw)));
  }

  private resolveTargetSegmentMinutes(fastStart = false): number {
    const averageProgramMinutes = this.resolveAverageProgramMinutes();
    if (fastStart) {
      return Math.max(2, Math.min(4, Math.round(averageProgramMinutes / 12)));
    }
    const activeProgram = this.programPlanner?.getActiveProgram();
    if (activeProgram && activeProgram.segments.length > 0) {
      const estimated = averageProgramMinutes / activeProgram.segments.length;
      return Math.max(3, Math.min(15, Math.round(estimated)));
    }
    return Math.max(4, Math.min(10, Math.round(averageProgramMinutes / 6)));
  }

  private buildGenerationProgressContext(): {
    segmentPercent?: number;
    programPercent?: number;
    currentSegmentNumber?: number;
    totalSegments?: number;
  } {
    const activeProgram = this.programPlanner?.getActiveProgram();
    if (!activeProgram) {
      return { segmentPercent: this.currentSegmentProgress * 100 };
    }
    const totalSegments = activeProgram.segments.length;
    const currentSegmentNumber = Math.min(activeProgram.currentSegmentIndex + 1, totalSegments);
    return {
      segmentPercent: this.currentSegmentProgress * 100,
      programPercent: this.currentProgramProgress * 100,
      currentSegmentNumber,
      totalSegments,
    };
  }

  private ensureProgramPlanning(): void {
    this.director?.ensureProgramPlanning(this.programPlanner, (p) => {
      this.planningProgramPromise = p;
    });
  }

  private rememberPulse(pulse: PulseEvent): void {
    this.recentPulses.push({ ...pulse });
    if (this.recentPulses.length > MAX_RECENT_PULSES) this.recentPulses.shift();
  }

  private createContextualFillerPulse(topicFallback: string): PulseEvent {
    for (let i = this.recentPulses.length - 1; i >= 0; i--) {
      const pulse = this.recentPulses[i];
      if (!this.recentTopics.includes(pulse.topic)) {
        return {
          topic: pulse.topic || topicFallback,
          summary: pulse.summary || pulse.rawContent || topicFallback,
          urgency: pulse.urgency || "interesting",
          sourceUrl: pulse.sourceUrl || "",
          rawContent: pulse.rawContent || pulse.summary || "",
        };
      }
    }

    const sourceQueries = (this.currentConfig?.sources ?? [])
      .map((source) => source.query.trim())
      .filter((query) => query.length > 0)
      .slice(0, 4);

    if (sourceQueries.length > 0) {
      const joined = sourceQueries.join("; ");
      return {
        topic: sourceQueries[0],
        summary: `Quick takes while tracking: ${joined}`,
        urgency: "interesting",
        sourceUrl: "",
        rawContent: `Source tracks: ${joined}`,
      };
    }

    return {
      topic: topicFallback,
      summary: "Casual opener while waiting for the next vetted topic.",
      urgency: "interesting",
      sourceUrl: "",
      rawContent: "No fresh pulse available yet.",
    };
  }
}

// ─── Worker thread bootstrap ─────────────────────────────────────────────────

if (!parentPort) {
  throw new Error("StationWorker must run inside a worker thread");
}

const runtime = new StationWorkerRuntime(
  workerData as StationWorkerData,
  parentPort,
);
runtime.run();
