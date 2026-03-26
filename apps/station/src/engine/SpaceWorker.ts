import { workerData, parentPort, type MessagePort } from "worker_threads";
import pino from "pino";

import type {
  MainToWorkerMessage,
  SpaceConfig,
  SpaceState as ExternalSpaceState,
  CallerStatus,
  EngineEvent,
} from "./types";
import type { PulseEvent, ContentSource } from "../services/ContentPipeline";
import type { ScriptLine, CallerCandidate } from "../services/ScriptGenerator";

import { StateMachine } from "./StateMachine";
import {
  SPACE_TRANSITIONS,
  createInitialContext,
  type SpaceState,
  type SpaceEvent,
  type SpaceMachineContext,
} from "./SpaceStates";
import { ActivityRegistry } from "./Activity";
import { AudioPipeline } from "./AudioPipeline";
import { Director, type DirectorContext } from "./Director";
import { SegmentActivity, type PreparedSegment, type SegmentActivityDeps } from "./activities/SegmentActivity";
import { CallActivity, type CallerState } from "./activities/CallActivity";
import { CallAudioStreamer } from "./CallAudioStreamer";
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
import { ElevenLabsAgentService } from "../services/ElevenLabsAgentService";
import { FactCheckService } from "../services/FactCheckService";
import { createAIClient } from "../services/ai";
import { initDb } from "../db/connection";
import { CallQueue, type CallQueueWithSession, SpaceWithRelations } from "../db/index";


const MP3_BITRATE_KBPS = 128;
const MAX_RECENT_PULSES = 20;
const CALL_CONNECT_GRACE_MS = Math.max(0, Number(process.env.CALL_CONNECT_GRACE_MS ?? "12000"));
const CALL_ACCEPT_TTL_MS = Math.max(CALL_CONNECT_GRACE_MS, Number(process.env.CALL_ACCEPT_TTL_MS ?? "90000"));
const TTS_BATCH_MAX_CHARS = Math.max(120, Number(process.env.TTS_BATCH_MAX_CHARS ?? "220"));
const TTS_BATCH_MAX_LINES = Math.max(1, Number(process.env.TTS_BATCH_MAX_LINES ?? "2"));
const BACKLOG_THROTTLE_THRESHOLD = Math.max(5, Number(process.env.BACKLOG_THROTTLE_THRESHOLD ?? "15"));


interface TransitionEnvelope {
  promise: Promise<{ lines: ScriptLine[]; audio: Buffer[] } | null>;
  consumedBy: "checkpoint" | "call-activity" | null;
}

interface PendingCallerAcceptState {
  callerId: string;
  callerName: string;
  topicHint: string;
  acceptedAtMs: number;
}


class SpaceWorkerRuntime {
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

  private externalState: ExternalSpaceState = {
    status: "idle",
    currentTopic: null,
    currentHost: null,
    listenerCount: 0,
    uptime: 0,
  };

  private running = false;
  private paused = false;
  private idlePaused = false;
  private startedAt = 0;
  private firstSegmentGenerated = false;
  private hasPushedFirstAudio = false;
  private planningProgramPromise: Promise<void> | null = null;
  private currentSegmentProgress = 0;
  private currentProgramProgress = 0;
  private currentConfig: SpaceConfig | null = null;

  // Call management — multi-caller
  private readonly activeCalls = new Map<string, CallerState>();
  private readonly pendingCallerAccepts = new Map<string, PendingCallerAcceptState>();
  private readonly callerStatuses = new Map<string, CallerStatus>();
  private resumeAfterCall = false;

  // Shared agent session state (one agent for all active callers)
  private sharedAgentService: ElevenLabsAgentService | null = null;
  private sharedConversationId: string | null = null;
  private sharedSessionEnded = false;
  private sharedSessionEndReason: string | null = null;

  private preSynthesizedTransition: TransitionEnvelope | null = null;

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
  private machine!: StateMachine<SpaceState, SpaceEvent, SpaceMachineContext>;

  constructor(
    private readonly space: SpaceWithRelations,
    private readonly port: MessagePort,
  ) {
    this.log = pino({ name: `worker:${space.slug}` });
    this.archiveBridge = new WorkerArchiveBridge(this.port, MP3_BITRATE_KBPS);
  }


  run(): void {
    this.machine = new StateMachine<SpaceState, SpaceEvent, SpaceMachineContext>({
      initial: "idle",
      context: createInitialContext(),
      transitions: SPACE_TRANSITIONS,
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
    this.log.info({ spaceId: this.space.id, slug: this.space.slug }, "Worker ready");
  }


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
          this.idlePaused = false;
          this.paused = false;
          void this.machine.send("RESUME");
        }
        break;
      case "listener-count": {
        const prevCount = this.externalState.listenerCount;
        this.externalState.listenerCount = msg.count;
        this.postState();

        const idleBehavior = this.currentConfig?.idleBehavior ?? "pause";

        // N→0: pause when no listeners (unless always_on)
        if (prevCount > 0 && msg.count === 0 && idleBehavior !== "always_on" && this.running && !this.paused) {
          this.idlePaused = true;
          this.paused = true;
          this.contentPipeline?.stop();
          void this.machine.send("PAUSE");
          this.log.info("Idle pause: no listeners connected, pausing engine");
        }

        // 0→N: resume from idle pause
        if (prevCount === 0 && msg.count > 0 && this.idlePaused && this.running) {
          this.idlePaused = false;
          this.paused = false;
          if (this.currentConfig) {
            this.contentPipeline?.start(this.currentConfig.sources as ContentSource[]);
          }
          void this.machine.send("RESUME");
          this.log.info({ listenerCount: msg.count }, "Idle resume: listeners connected, resuming engine");
        }
        break;
      }
      case "submit-comment":
        this.contentPipeline?.submitComment({
          topic: msg.comment.topic,
          summary: msg.comment.content,
          urgency: "interesting",
          sourceUrl: "",
          rawContent: msg.comment.content,
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
        spaceId: this.space.id,
        spaceName: this.space.slug,
        spaceDescription: config.description,
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
        getPendingCallerAccept: () => this.getFirstPendingCallerAccept(),
        getActiveCallerId: () => this.getFirstActiveCallerId(),
        getActiveCallerCount: () => this.activeCalls.size,
        getMaxSpeakers: () => this.resolveMaxSpeakers(),
      });


      // Register activities
      this.registerActivities(config);

      this.contentPipeline.start(config.sources as ContentSource[]);

      // Wire pulse handler
      this.pulseHandler = (pulse: PulseEvent) => {
        this.rememberPulse(pulse);

        // Backpressure: skip pulse when the combined backlog is too large
        const backlog = this.topicQueue.length + (this.programPlanner?.getBufferSize() ?? 0);
        if (backlog >= BACKLOG_THROTTLE_THRESHOLD) {
          this.log.info(
            { topic: pulse.topic, backlog, threshold: BACKLOG_THROTTLE_THRESHOLD },
            "Backlog throttle: skipping pulse (buffer full)",
          );
          return;
        }

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
      this.resumeAfterCall = false; // consumed by ctx.hasResumableSegment
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
        // advance to boundary.
        const firstPending = this.getFirstPendingCallerAccept();
        if (firstPending) {
          this.log.info(
            {
              callerId: firstPending.callerId,
              callerConnected: this.activeCalls.size > 0,
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

      const firstPending = this.getFirstPendingCallerAccept();
      const firstActiveId = this.getFirstActiveCallerId();

      this.emitEngineEvent("boundary:start", {
        topic,
        segmentKind,
        pendingCallerAcceptId: firstPending?.callerId ?? null,
        activeCallerId: firstActiveId,
      });

      const result = await this.director.handleBoundary({
        topic,
        segmentKind: segmentKind as "filler" | "program" | "queue",
        pendingCallerAccept: firstPending,
        activeCallerId: firstActiveId,
        callConnectGraceMs: CALL_CONNECT_GRACE_MS,
        callAcceptTtlMs: CALL_ACCEPT_TTL_MS,
        evaluateCallOpportunityAtBoundary: async () => {
          const evalResult = await this.director!.evaluateCallOpportunity({
            segmentKind: segmentKind as "filler" | "program" | "queue",
            segmentProgress: 1,
            programProgress: this.currentProgramProgress,
            currentTopic: this.externalState.currentTopic ?? "general",
            spaceDescription: this.currentConfig?.description ?? "",
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

      if (result.action === "enter_call" && this.activeCalls.size > 0) {
        for (const [cid] of this.activeCalls) {
          this.postCallerStatus(cid, "on-air");
        }
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
    this.log.info("Stopping space worker");
    this.running = false;
    this.paused = false;
    this.idlePaused = false;

    if (this.machine.context.errorRecoveryTimer) {
      clearTimeout(this.machine.context.errorRecoveryTimer);
      this.machine.context.errorRecoveryTimer = null;
    }

    if (this.contentPipeline && this.pulseHandler) {
      this.contentPipeline.off("pulse", this.pulseHandler);
      this.pulseHandler = null;
    }
    if (this.activeCalls.size > 0) this.cleanupAllCallers();
    this.pendingCallerAccepts.clear();
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


  private registerActivities(config: SpaceConfig): void {
    const hosts = config.hosts.map((h) => ({
      name: h.name,
      personality: h.personality,
      voiceId: h.voiceId,
    }));
    const spaceContext = {
      spaceName: this.space.slug,
      description: config.description,
      previousTopics: this.recentTopics,
    };

    const segmentDeps: SegmentActivityDeps = {
      spaceId: this.space.id,
      scriptGenerator: this.scriptGenerator!,
      programPlanner: this.programPlanner!,
      factCheckService: this.factCheckService,
      archiveBridge: this.archiveBridge,
      hosts,
      spaceContext,
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
        if (this.pendingCallerAccepts.size > 0 || this.activeCalls.size >= this.resolveMaxSpeakers()) return;

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
          spaceDescription: this.currentConfig?.description ?? "",
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
        // Fires at the actual AI checkpoint. If a transition was pre-generated
        // and hasn't been consumed yet, claim it for the checkpoint path.
        const firstPending = this.getFirstPendingCallerAccept();
        if (firstPending && this.preSynthesizedTransition?.consumedBy === null) {
          this.preSynthesizedTransition.consumedBy = "checkpoint";
          const transition = await this.preSynthesizedTransition.promise;
          if (transition) {
            this.emitEngineEvent("call:transition-played", {
              callerId: firstPending.callerId,
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
      spaceName: this.space.slug,
      spaceDescription: config.description,
      getActiveCalls: () => this.activeCalls,
      getFirstCaller: () => {
        const first = this.activeCalls.values().next();
        return first.done ? null : first.value;
      },
      getSharedAgent: () => this.sharedAgentService,
      getConversationId: () => this.sharedConversationId,
      setConversationId: (id) => { this.sharedConversationId = id; },
      getSessionEnded: () => this.sharedSessionEnded,
      setSessionEnded: (ended) => { this.sharedSessionEnded = ended; },
      getSessionEndReason: () => this.sharedSessionEndReason,
      setSessionEndReason: (reason) => { this.sharedSessionEndReason = reason; },
      getMaxSpeakers: () => this.resolveMaxSpeakers(),
      getPreSynthesizedTransition: async () => {
        if (!this.preSynthesizedTransition || this.preSynthesizedTransition.consumedBy !== null) return null;
        this.preSynthesizedTransition.consumedBy = "call-activity";
        return this.preSynthesizedTransition.promise;
      },
      postCallerStatus: (callerId, status) => this.postCallerStatus(callerId, status),
      sendCallerAudio: (callerId, mp3) => this.sendCallerAudio(callerId, mp3),
      broadcastAgentAudio: async (pcm: Buffer) => {
        this.pushAgentPcm(pcm);
      },
      getCurrentShowContext: () => {
        const currentTopic = this.externalState.currentTopic ?? "general";
        const recent = this.recentTopics.slice(-5).join(", ");
        return `Current topic: ${currentTopic}. Recent topics: ${recent || "none yet"}.`;
      },
      getAgentIdForHost: (hostName: string) => {
        const id = this.space.hosts.find((h) => h.name === hostName)?.agentId;
        if (!id) throw new Error(`No agent ID for host: ${hostName}`);
        return id;
      },
      cleanupAllCallers: () => this.cleanupAllCallers(),
    }));
    this.registry.register(new AdActivity({
      scriptGenerator: this.scriptGenerator!,
      hosts,
      spaceName: this.space.slug,
      onAdAired: () => this.director?.resetAdCounter(),
    }));
  }


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

    const firstPending = this.getFirstPendingCallerAccept();
    const firstActiveId = this.getFirstActiveCallerId();

    return {
      hasProgramSegment: Boolean(nextProgramSegment),
      hasQueuedTopic,
      queuedTopicCount: this.topicQueue.length,
      isFirstSegment: !this.firstSegmentGenerated,
      segmentPercent: progress.segmentPercent ?? 0,
      programPercent: progress.programPercent ?? 0,
      currentSegmentNumber: progress.currentSegmentNumber,
      totalSegments: progress.totalSegments,
      pendingCallerAcceptId: firstPending?.callerId ?? null,
      activeCallerId: firstActiveId,
      activeCallerCount: this.activeCalls.size,
      maxSpeakers: this.resolveMaxSpeakers(),
      pendingCallerName: firstPending?.callerName ?? null,
      pendingCallerTopicHint: firstPending?.topicHint ?? null,
      currentTopic: this.externalState.currentTopic,
      segmentsSinceLastAd: this.director?.getSegmentsSinceLastAd() ?? 0,
      hasResumableSegment: this.resumeAfterCall,
    };
  }


  private static readonly CALLER_HEARTBEAT_STALE_MS = 15_000;
  private async checkCallQueue(): Promise<CallerCandidate[]> {
    const currentProgramId = this.programPlanner?.getActiveProgram()?.id;
    const heartbeatCutoff = new Date(Date.now() - SpaceWorkerRuntime.CALLER_HEARTBEAT_STALE_MS);

    const [rows] = await Promise.all([
      CallQueue.findMany({
        where: {
          spaceId: this.space.id,
          status: "waiting",
          OR: [
            { lastSeenAt: { gte: heartbeatCutoff } },
            { lastSeenAt: null },
          ],
        },
        include: { session: true },
        orderBy: { createdAt: "asc" },
      }),
      CallQueue.endStale(this.space.id, heartbeatCutoff),
    ]) as [CallQueueWithSession[], unknown];

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
    this.pendingCallerAccepts.set(callerId, { callerId, callerName, topicHint, acceptedAtMs: Date.now() });
    this.postCallerStatus(callerId, "accepted");

    // Pre-generate transition while waiting for the caller to connect
    if (callerName && this.scriptGenerator && this.pipeline && this.currentConfig) {
      const hosts = this.currentConfig.hosts.map((h) => ({
        name: h.name,
        personality: h.personality,
        voiceId: h.voiceId,
      }));
      const currentTopic = this.externalState.currentTopic ?? "general";
      this.log.info({ callerId, callerName, topicHint }, "PERF pregen:start — generating transition");

      const transitionT0 = Date.now();
      this.log.info({ callerId, callerName, topicHint, currentTopic }, "PERF transition:llm:start");
      const transitionPromise = this.scriptGenerator
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

      this.preSynthesizedTransition = { promise: transitionPromise, consumedBy: null };
    }
  }

  private handleAcceptCaller(callerId: string): void {
    this.emitEngineEvent("call:manual-accept", { callerId });
    this.acceptAndNotifyCaller(callerId, "", "").catch((err) => {
      this.log.error({ err, callerId }, "Failed to accept caller");
    });
  }

  private async handleCallerConnected(callerId: string, callerName: string, topicHint: string): Promise<void> {
    const maxSpeakers = this.resolveMaxSpeakers();
    if (this.activeCalls.size >= maxSpeakers) {
      this.emitEngineEvent("call:rejected", { callerId, reason: "max_speakers_reached", activeCallerCount: this.activeCalls.size, maxSpeakers });
      return;
    }

    const isFirstCaller = this.activeCalls.size === 0;
    this.emitEngineEvent("call:connected", { callerId, callerName, topicHint, machineState: this.machine.current(), isFirstCaller });

    const callerState: CallerState = {
      callerId,
      callerName,
      topicHint,
      disconnected: false,
    };
    this.activeCalls.set(callerId, callerState);

    if (this.pendingCallerAccepts.has(callerId)) {
      const pending = this.pendingCallerAccepts.get(callerId)!;
      pending.callerName = callerName;
      pending.topicHint = topicHint;
    }

    if (isFirstCaller) {
      // Create shared agent service — session will be started in CallActivity.run()
      this.sharedAgentService = new ElevenLabsAgentService();
      this.sharedConversationId = null;
      this.sharedSessionEnded = false;
      this.sharedSessionEndReason = null;

      // Reset audio stats for new call session
      this.callerAudioReceivedBytes = 0;
      this.callerAudioDroppedBytes = 0;
      this.callerAudioForwardedBytes = 0;

      // Start persistent streaming encoders for call audio
      if (this.pipeline) {
        this.callStreamer = new CallAudioStreamer({
          audioEncoder: this.pipeline.audioEncoder,
          onAgentMp3: (mp3) => {
            this.pipeline!.pushMp3(mp3).catch((err) =>
              this.log.warn({ err }, "Failed to broadcast agent audio"),
            );
            // Send agent audio to ALL active callers
            for (const [cid] of this.activeCalls) {
              this.sendCallerAudio(cid, mp3);
            }
          },
          onCallerMp3: (_callerId, mp3) => {
            this.pipeline!.pushMp3(mp3).catch((err) =>
              this.log.warn({ err }, "Failed to broadcast caller audio"),
            );
          },
        });
        this.callStreamer.start();
        this.callStreamer.addCaller(callerId);
      }
    } else {
      // Additional caller joining an active session
      this.callStreamer?.addCaller(callerId);

      // Notify the running CallActivity that a new caller joined
      const callActivity = this.registry.get("call") as CallActivity | undefined;
      if (callActivity) {
        callActivity.onCallerAdded(callerState);
      }
    }

    this.updateActiveSpeakers();
    this.postState();
  }

  private callerAudioReceivedBytes = 0;
  private callerAudioDroppedBytes = 0;
  private callerAudioForwardedBytes = 0;

  // Echo suppression — don't forward caller audio to the agent while the
  // agent is speaking, otherwise the agent hears its own voice echoed back
  // from the caller's mic and interrupts itself.
  private static readonly ECHO_SUPPRESS_MS = 350;
  private lastAgentAudioMs = 0;

  // Persistent streaming encoder for call audio
  private callStreamer: CallAudioStreamer | null = null;

  private pushAgentPcm(pcmChunk: Buffer): void {
    this.lastAgentAudioMs = Date.now();
    this.callStreamer?.pushAgentPcm(pcmChunk);
  }

  private handleCallerAudio(callerId: string, pcm: Buffer): void {
    if (!this.activeCalls.has(callerId)) return;

    this.callerAudioReceivedBytes += pcm.length;

    // Don't process any caller audio until the caller status is "speak" —
    // the agent session isn't started yet and broadcasting would leak mic noise.
    const status = this.callerStatuses.get(callerId);
    if (status !== "speak") {
      this.callerAudioDroppedBytes += pcm.length;
      return;
    }

    // Echo suppression: don't forward caller audio to the agent while the
    // agent is actively speaking (or just finished), to prevent the agent
    // from hearing its own voice echoed back and interrupting itself.
    const agentSpeaking = (Date.now() - this.lastAgentAudioMs) < SpaceWorkerRuntime.ECHO_SUPPRESS_MS;
    if (!agentSpeaking) {
      this.callerAudioForwardedBytes += pcm.length;
      this.sharedAgentService?.sendAudio(pcm);
    } else {
      this.callerAudioDroppedBytes += pcm.length;
    }

    // Broadcast caller audio to listeners via persistent streamer
    this.callStreamer?.pushCallerPcm(callerId, pcm);
  }

  private handleCallerDisconnected(callerId: string): void {
    const caller = this.activeCalls.get(callerId);
    if (!caller) return;

    this.emitEngineEvent("call:disconnected", { callerId, machineState: this.machine.current(), remainingCallers: this.activeCalls.size - 1 });
    caller.disconnected = true;

    // Clean up this individual caller
    this.cleanupCaller(callerId);
  }

  /** Clean up a single caller (remove from maps, close their stream). */
  private cleanupCaller(callerId: string): void {
    const caller = this.activeCalls.get(callerId);
    if (!caller) return;

    this.callStreamer?.removeCaller(callerId);
    this.activeCalls.delete(callerId);

    CallQueue.update(callerId, { status: "ended", endedAt: new Date() }).catch((err) => {
      this.log.error({ err, callerId }, "Failed to update call end status");
    });

    // Post "ended" status then remove from tracking map
    this.postCallerStatus(callerId, "ended");
    this.callerStatuses.delete(callerId);

    // Notify the running CallActivity that a caller left
    const callActivity = this.registry.get("call") as CallActivity | undefined;
    if (callActivity) {
      callActivity.onCallerRemoved(callerId, caller.callerName);
    }

    this.updateActiveSpeakers();
    this.postState();

    // If all callers have left, end the shared session
    if (this.activeCalls.size === 0) {
      this.endSharedSession();
    }
  }

  /** Clean up ALL callers and the shared agent session. Called by CallActivity when done. */
  private cleanupAllCallers(): void {
    if (this.callStreamer) {
      this.callStreamer.close();
      this.callStreamer = null;
    }

    this.log.info(
      {
        callerCount: this.activeCalls.size,
        conversationId: this.sharedConversationId,
        totalAudioReceived: this.callerAudioReceivedBytes,
        totalAudioDropped: this.callerAudioDroppedBytes,
        totalAudioForwarded: this.callerAudioForwardedBytes,
      },
      "Call audio summary at cleanup",
    );

    // End each caller's DB status
    for (const [callerId] of this.activeCalls) {
      CallQueue.update(callerId, { status: "ended", endedAt: new Date() }).catch((err) => {
        this.log.error({ err, callerId }, "Failed to update call end status");
      });
      this.postCallerStatus(callerId, "ended");
    }

    this.activeCalls.clear();
    this.callerStatuses.clear();
    this.pendingCallerAccepts.clear();
    this.preSynthesizedTransition = null;

    this.endSharedSession();

    this.updateActiveSpeakers();
    this.postState();

    this.resumeAfterCall = true;
    this.emitEngineEvent("call:cleaned-up", { callerCount: 0 });
  }

  private endSharedSession(): void {
    if (this.sharedAgentService) {
      this.sharedAgentService.endSession();
      this.sharedAgentService = null;
    }
    this.sharedConversationId = null;
    this.sharedSessionEnded = false;
    this.sharedSessionEndReason = null;
  }

  private async waitForAcceptedCallerConnection(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (
      this.running &&
      Date.now() < deadline &&
      this.pendingCallerAccepts.size > 0 &&
      this.activeCalls.size === 0
    ) {
      await this.sleep(250);
    }
    return this.pendingCallerAccepts.size > 0 && this.activeCalls.size > 0;
  }

  private async expirePendingCallerAccept(reason: string): Promise<void> {
    if (this.pendingCallerAccepts.size === 0 || this.activeCalls.size > 0) return;
    // Expire the first pending accept
    const firstPending = this.getFirstPendingCallerAccept();
    if (!firstPending) return;

    this.log.warn(
      { callerId: firstPending.callerId, reason, acceptedForMs: Date.now() - firstPending.acceptedAtMs },
      "Expiring accepted caller — marking as ended (caller never connected)",
    );
    this.pendingCallerAccepts.delete(firstPending.callerId);
    this.preSynthesizedTransition = null;
    try {
      await CallQueue.update(firstPending.callerId, { status: "ended", endedAt: new Date() });
    } catch (err) {
      this.log.error({ err, callerId: firstPending.callerId }, "Failed to end expired accepted caller");
    }
  }


  private postState(): void {
    this.externalState.uptime = this.running ? Date.now() - this.startedAt : 0;
    this.externalState.currentProgramId = this.programPlanner?.getActiveProgram()?.id ?? undefined;
    this.port.postMessage({ type: "state-change", state: { ...this.externalState } });
  }

  private postCallerStatus(callerId: string, status: CallerStatus): void {
    this.callerStatuses.set(callerId, status);
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

  // ── Helpers ──────────────────────────────────────────────────────────

  private resolveMaxSpeakers(): number {
    return Math.max(1, Math.min(10, this.currentConfig?.maxSpeakers ?? 1));
  }

  private getFirstPendingCallerAccept(): PendingCallerAcceptState | null {
    const first = this.pendingCallerAccepts.values().next();
    return first.done ? null : first.value;
  }

  private getFirstActiveCallerId(): string | null {
    const first = this.activeCalls.keys().next();
    return first.done ? null : first.value;
  }

  private updateActiveSpeakers(): void {
    if (this.activeCalls.size === 0) {
      this.externalState.activeSpeakers = undefined;
    } else {
      this.externalState.activeSpeakers = [...this.activeCalls.values()].map((c) => ({
        callerId: c.callerId,
        callerName: c.callerName,
      }));
    }
  }

  private resolveAverageProgramMinutes(): number {
    if (this.currentConfig?.durationMin != null) {
      return Math.max(10, Math.min(240, Math.round(this.currentConfig.durationMin)));
    }
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


if (!parentPort) {
  throw new Error("SpaceWorker must run inside a worker thread");
}

const runtime = new SpaceWorkerRuntime(
  workerData as SpaceWithRelations,
  parentPort,
);
runtime.run();
