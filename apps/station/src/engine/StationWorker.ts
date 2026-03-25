import { workerData, parentPort, type MessagePort } from "worker_threads";
import pino from "pino";

import type {
  MainToWorkerMessage,
  StationConfig,
  StationState,
  StationWorkerData,
  CallerStatus,
} from "./types";
import { SegmentAudioBatcher } from "./SegmentAudioBatcher";
import { WorkerArchiveBridge } from "./WorkerArchiveBridge";
import { RuntimeWatchdogAgent } from "./RuntimeWatchdogAgent";
import { StationOrchestrator } from "./StationOrchestrator";
import { DecisionRouter } from "./DecisionRouter";
import { ProgramPlannerAgent } from "./ProgramPlannerAgent";
import { CallOrchestratorAgent } from "./CallOrchestratorAgent";
import { SegmentExecutorAgent } from "./SegmentExecutorAgent";
import { EditorialCriticAgent } from "./EditorialCriticAgent";
import { RuntimeMetrics } from "./RuntimeMetrics";
import type { NextSegmentSource } from "./agentTypes";

import type { AudioStream } from "../services/AudioEncoder";

import {
  ContentPipeline,
  type PulseEvent,
  type ContentSource,
} from "../services/ContentPipeline";
import { ScriptGenerator, type ScriptLine, type CallerCandidate } from "../services/ScriptGenerator";
import { TTSService } from "../services/TTSService";
import { AudioEncoder } from "../services/AudioEncoder";
import { IcecastPublisher } from "../services/IcecastPublisher";
import { ProgramPlanner } from "../services/ProgramPlanner";
import { STTService, type TranscriptEvent } from "../services/STTService";
import { createAIClient, type AIClient } from "../services/ai";
import { FactCheckService } from "../services/FactCheckService";
import { initDb } from "../db/connection";
import { Segment, TranscriptLine, CallQueue } from "../db/index";

interface PreparedSegment {
  topic: string;
  sourceUrl?: string;
  programId?: string;
  kind: "filler" | "program" | "queue";
  scriptLines: ScriptLine[];
  segmentId: string;
  lineRowIds: string[];
  firstTts: Promise<Buffer> | null;
}

interface ActiveCall {
  callerId: string;
  callerName: string;
  topicHint: string;
  sttService: STTService;
  callerEncoder: AudioStream;
  accumulatedTranscript: string[];
  aiTurnCount: number;
  callerTurnActive: boolean;
  resolveUtterance?: () => void;
  disconnected: boolean;
}

type RuntimeHost = { name: string; personality: string; voiceId?: string };
type RuntimeStationContext = {
  stationName: string;
  description?: string;
  previousTopics?: string[];
};
interface WorkerServiceFactories {
  createContentPipeline(ai: AIClient): ContentPipeline;
  createScriptGenerator(ai: AIClient): ScriptGenerator;
  createFactCheckService(ai: AIClient): FactCheckService;
  createTtsService(): TTSService;
  createAudioEncoder(): AudioEncoder;
  createIcecastPublisher(): IcecastPublisher;
  createProgramPlanner(args: {
    ai: AIClient;
    stationId: string;
    stationName: string;
    stationDescription?: string;
    searchQueries: string[];
    hosts: Array<{ name: string; personality: string }>;
    durationMin: number;
    useFullEditorial: boolean;
  }): ProgramPlanner;
}

const defaultServiceFactories: WorkerServiceFactories = {
  createContentPipeline: (ai) => new ContentPipeline({ ai }),
  createScriptGenerator: (ai) => new ScriptGenerator({ ai }),
  createFactCheckService: (ai) => new FactCheckService({ ai }),
  createTtsService: () => new TTSService(),
  createAudioEncoder: () => new AudioEncoder(),
  createIcecastPublisher: () => new IcecastPublisher(),
  createProgramPlanner: (args) => new ProgramPlanner(args),
};

class StationWorkerRuntime {
  private static readonly FACT_CHECK_START_DELAY_MS = 15_000;
  private static readonly PCM_SAMPLE_RATE = 16000;
  private static readonly MP3_BITRATE_KBPS = 128;
  private static readonly MAX_RECENT_PULSES = 20;
  private static readonly NEXT_SEGMENT_PREFETCH_AT = 0.7;

  private readonly log: pino.Logger;
  private readonly topicQueue: PulseEvent[] = [];
  private readonly recentTopics: string[] = [];
  private readonly recentPulses: PulseEvent[] = [];
  private readonly pendingFactChecks: string[] = [];
  private readonly batcher = new SegmentAudioBatcher(
    Math.max(120, Number(process.env.TTS_BATCH_MAX_CHARS ?? "220")),
    Math.max(1, Number(process.env.TTS_BATCH_MAX_LINES ?? "2")),
  );
  private readonly archiveBridge: WorkerArchiveBridge;
  private readonly watchdog = new RuntimeWatchdogAgent();
  private readonly orchestrator = new StationOrchestrator(this.watchdog);
  private readonly plannerAgent: ProgramPlannerAgent;
  private readonly callAgent = new CallOrchestratorAgent();
  private readonly segmentExecutor = new SegmentExecutorAgent<PreparedSegment>();
  private readonly criticAgent = new EditorialCriticAgent();
  private readonly metrics: RuntimeMetrics;
  private decisionRouter: DecisionRouter | null = null;

  private state: StationState = {
    status: "idle",
    currentTopic: null,
    currentHost: null,
    listenerCount: 0,
    uptime: 0,
  };

  private running = false;
  private paused = false;
  private startedAt = 0;
  private startingPromise: Promise<void> | null = null;

  private contentPipeline: ContentPipeline | null = null;
  private scriptGenerator: ScriptGenerator | null = null;
  private ttsService: TTSService | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private icecastPublisher: IcecastPublisher | null = null;
  private programPlanner: ProgramPlanner | null = null;
  private factCheckService: FactCheckService | null = null;
  private pulseHandler: ((pulse: PulseEvent) => void) | null = null;

  private firstSegmentGenerated = false;
  private planningProgramPromise: Promise<void> | null = null;
  private hasPushedFirstAudio = false;
  private currentSegmentProgress = 0;
  private currentProgramProgress = 0;

  private activeCall: ActiveCall | null = null;
  private pendingCallerAccept: { callerId: string; callerName: string; topicHint: string } | null = null;

  constructor(
    private readonly data: StationWorkerData,
    private readonly port: MessagePort,
    private readonly factories: WorkerServiceFactories = defaultServiceFactories,
  ) {
    this.log = pino({ name: `worker:${data.slug}` });
    this.archiveBridge = new WorkerArchiveBridge(
      this.port,
      StationWorkerRuntime.MP3_BITRATE_KBPS,
    );
    this.plannerAgent = new ProgramPlannerAgent();
    this.metrics = new RuntimeMetrics();
  }

  run(): void {
    this.port.on("message", this.onMessage);
    this.port.postMessage({ type: "ready" });
    this.log.info(
      { stationId: this.data.stationId, slug: this.data.slug },
      "Worker ready",
    );
  }

  private readonly onMessage = (msg: MainToWorkerMessage): void => {
    switch (msg.type) {
      case "start":
        this.start(msg.config, msg.stationId);
        break;

      case "stop":
        this.stop();
        break;

      case "pause":
        this.pause();
        break;

      case "resume":
        this.resume();
        break;

      case "listener-count":
        this.handleListenerCount(msg.count);
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
        this.handleCallerConnected(msg.callerId, msg.callerName, msg.topicHint);
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

  private postState(): void {
    this.state.uptime = this.running ? Date.now() - this.startedAt : 0;
    this.port.postMessage({ type: "state-change", state: { ...this.state } });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private resolveVoiceId(hostName: string, config: StationConfig): string {
    const host = config.hosts.find((h) => h.name === hostName);
    return host?.voiceId ?? config.hosts[0]?.voiceId ?? "default";
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

  private startFactCheck(segmentId: string): void {
    if (!this.factCheckService) return;
    void this.factCheckService.checkSegment(segmentId);
  }

  private flushDeferredFactChecks(): void {
    if (!this.hasPushedFirstAudio) return;
    while (this.pendingFactChecks.length > 0) {
      const id = this.pendingFactChecks.shift();
      if (id) this.startFactCheck(id);
    }
  }

  private scheduleFactCheck(segmentId: string): void {
    if (this.hasPushedFirstAudio) {
      this.startFactCheck(segmentId);
      return;
    }

    this.pendingFactChecks.push(segmentId);
    setTimeout(() => {
      const idx = this.pendingFactChecks.indexOf(segmentId);
      if (idx === -1) return;
      this.pendingFactChecks.splice(idx, 1);
      this.startFactCheck(segmentId);
    }, StationWorkerRuntime.FACT_CHECK_START_DELAY_MS);
  }

  private ensureProgramPlanning(): void {
    this.plannerAgent.ensureProgramPlanning(
      this.programPlanner,
      this.planningProgramPromise,
      (nextPromise) => {
        this.planningProgramPromise = nextPromise;
      },
    );
  }

  private batchTTS(
    lines: ScriptLine[],
    startIndex: number,
    config: StationConfig,
  ): Promise<Buffer> {
    if (!this.ttsService) {
      return Promise.reject(new Error("TTS service not initialized"));
    }
    const batch = this.batcher.build(lines, startIndex);
    return this.ttsService.synthesize(
      batch.text,
      this.resolveVoiceId(batch.host, config),
      batch.emotion,
    );
  }

  private async savePreparedSegment(args: {
    stationId: string;
    topic: string;
    sourceUrl?: string | null;
    programId?: string | null;
    kind: "filler" | "program" | "queue";
    scriptLines: ScriptLine[];
  }): Promise<PreparedSegment> {
    const segmentRow = await Segment.create({
      stationId: args.stationId,
      programId: args.programId ?? null,
      topic: args.topic,
      durationMs: 0,
      ...(args.sourceUrl !== undefined ? { sourceUrl: args.sourceUrl } : {}),
    });

    const lineRows = await TranscriptLine.bulkCreate(
      segmentRow.id,
      args.scriptLines,
    );
    this.scheduleFactCheck(segmentRow.id);
    this.firstSegmentGenerated = true;

    this.log.info(
      { segmentId: segmentRow.id, topic: args.topic, lines: args.scriptLines.length },
      "Segment script saved to DB",
    );

    const firstTts =
      args.scriptLines.length > 0
        ? this.batchTTS(args.scriptLines, 0, this.currentConfig!)
        : null;

    if (args.topic !== "filler" && args.topic !== "startup") {
      this.recentTopics.push(args.topic);
      if (this.recentTopics.length > 10) this.recentTopics.shift();
    }

    return {
      topic: args.topic,
      sourceUrl: args.sourceUrl ?? undefined,
      programId: args.programId ?? undefined,
      kind: args.kind,
      scriptLines: args.scriptLines,
      segmentId: segmentRow.id,
      lineRowIds: lineRows.map((r) => r.id),
      firstTts,
    };
  }

  private rememberPulse(pulse: PulseEvent): void {
    this.recentPulses.push({ ...pulse });
    if (this.recentPulses.length > StationWorkerRuntime.MAX_RECENT_PULSES) {
      this.recentPulses.shift();
    }
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

  private postCallerStatus(callerId: string, status: CallerStatus): void {
    this.port.postMessage({ type: "caller-status", callerId, status });
  }

  private computeCallCheckPoints(lineCount: number): number[] {
    return this.callAgent.computeCallCheckPoints(lineCount);
  }

  private async checkCallQueue(): Promise<CallerCandidate[]> {
    const rows = await CallQueue.findMany({
      where: { stationId: this.data.stationId, status: "waiting" },
      orderBy: { createdAt: "asc" },
    });

    const now = Date.now();
    return rows.map((row) => ({
      id: row.id,
      callerName: row.callerName ?? "Anonymous",
      topicHint: row.topicHint ?? "",
      waitingMinutes: Math.round((now - (row.createdAt ? new Date(row.createdAt).getTime() : now)) / 60_000),
    }));
  }

  private async evaluateCallOpportunity(
    segmentKind: "filler" | "program" | "queue",
    segmentProgress: number,
  ): Promise<void> {
    if (!this.scriptGenerator || !this.decisionRouter) return;

    const callers = await this.checkCallQueue();
    if (callers.length === 0) return;

    const result = await this.callAgent.evaluateOpportunity({
      router: this.decisionRouter,
      scriptGenerator: this.scriptGenerator,
      callers,
      currentTopic: this.state.currentTopic ?? "general",
      segmentKind,
      segmentProgress,
      programProgress: this.currentProgramProgress,
      stationDescription: this.currentConfig?.description ?? "",
    });
    this.metrics.recordDecision();
    this.log.info(
      { selectedCallerId: result.selectedCaller?.id, reason: result.reason, callerCount: callers.length },
      "evaluateCallOpportunity decision",
    );
    if (!result.selectedCaller) return;
    await this.acceptAndNotifyCaller(
      result.selectedCaller.id,
      result.selectedCaller.callerName,
      result.selectedCaller.topicHint,
    );
  }

  private async acceptAndNotifyCaller(callerId: string, callerName: string, topicHint: string): Promise<void> {
    this.log.info({ callerId, callerName }, "Accepting caller for next segment break");
    await CallQueue.update(callerId, { status: "accepted", acceptedAt: new Date() });
    this.pendingCallerAccept = { callerId, callerName, topicHint };
    this.postCallerStatus(callerId, "accepted");
  }

  private handleAcceptCaller(callerId: string): void {
    this.log.info({ callerId }, "Caller manually accepted — queuing for next segment break");
    this.acceptAndNotifyCaller(callerId, "", "").catch((err) => {
      this.log.error({ err, callerId }, "Failed to accept caller");
    });
  }

  private async handleCallerConnected(callerId: string, callerName: string, topicHint: string): Promise<void> {
    if (this.activeCall) {
      this.log.warn({ callerId }, "Another call is already active, rejecting");
      return;
    }

    this.log.info({ callerId, callerName, topicHint }, "Caller connected");

    const sttService = new STTService();
    await sttService.startStream();

    const callerEncoder = this.audioEncoder!.createStream();

    // Pipe caller encoder MP3 output to Icecast
    callerEncoder.readable.on("data", (chunk: Buffer) => {
      void this.icecastPublisher?.pushAudio(chunk);
    });

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

    // Update pending info
    if (this.pendingCallerAccept?.callerId === callerId) {
      this.pendingCallerAccept.callerName = callerName;
      this.pendingCallerAccept.topicHint = topicHint;
    }

    // STT event handlers
    sttService.on("transcript", (event: TranscriptEvent) => {
      if (!this.activeCall || this.activeCall.callerId !== callerId) return;
      if (event.isFinal && event.text) {
        this.activeCall.accumulatedTranscript.push(event.text);
        // Emit as transcript line (caller speaking)
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

    this.state.activeCallerId = callerId;
    this.state.activeCallerName = callerName;
    this.postState();
  }

  private handleCallerAudio(callerId: string, pcm: Buffer): void {
    if (!this.activeCall || this.activeCall.callerId !== callerId) return;
    if (!this.activeCall.callerTurnActive) return;

    // Forward to streaming encoder (for Icecast broadcast) and STT
    this.activeCall.callerEncoder.write(pcm);
    this.activeCall.sttService.sendAudio(pcm);
  }

  private handleCallerDisconnected(callerId: string): void {
    if (!this.activeCall || this.activeCall.callerId !== callerId) return;
    this.log.info({ callerId }, "Caller disconnected");
    this.activeCall.disconnected = true;

    // Resolve any pending utterance wait
    if (this.activeCall.resolveUtterance) {
      this.activeCall.resolveUtterance();
      this.activeCall.resolveUtterance = undefined;
    }
  }

  private cleanupCall(): void {
    if (!this.activeCall) return;
    const { callerId, sttService, callerEncoder } = this.activeCall;

    sttService.close();
    callerEncoder.close();

    CallQueue.update(callerId, { status: "ended", endedAt: new Date() }).catch((err) => {
      this.log.error({ err, callerId }, "Failed to update call end status");
    });

    this.postCallerStatus(callerId, "ended");

    this.state.activeCallerId = undefined;
    this.state.activeCallerName = undefined;
    this.postState();

    this.activeCall = null;
    this.pendingCallerAccept = null;
    this.log.info({ callerId }, "Call cleaned up");
  }

  private async waitForUtterance(timeoutMs: number): Promise<boolean> {
    if (!this.activeCall) return false;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.activeCall) {
          this.activeCall.resolveUtterance = undefined;
        }
        resolve(false);
      }, timeoutMs);

      this.activeCall!.resolveUtterance = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  }

  private async runCallSegment(): Promise<void> {
    const call = this.activeCall;
    if (!call || !this.scriptGenerator || !this.ttsService || !this.audioEncoder || !this.icecastPublisher) return;

    const config = this.currentConfig!;
    const hosts = config.hosts.map((h) => ({
      name: h.name,
      personality: h.personality,
      voiceId: h.voiceId,
    }));
    const stationContext = {
      stationName: this.data.slug,
      description: config.description,
    };

    const MAX_TURNS = 8;
    const MAX_DURATION_MS = 5 * 60 * 1000;
    const callStartTime = Date.now();

    this.icecastPublisher.broadcasting = true;

    try {
      // 1. Generate and broadcast guest intro
      const intro = await this.scriptGenerator.generateGuestIntro(
        call.callerName,
        call.topicHint,
        hosts,
      );

      for (const line of intro.lines) {
        if (call.disconnected) break;
        const pcm = await this.ttsService.synthesize(
          line.text,
          this.resolveVoiceId(line.host, config),
          line.emotion,
        );
        const mp3 = await this.audioEncoder.encode(pcm);
        await this.icecastPublisher.pushAudio(mp3);

        this.port.postMessage({
          type: "transcript-line",
          line: { host: line.host, text: line.text, emotion: line.emotion, timestamp: Date.now() },
        });

        const audioDurationMs = (mp3.length * 8) / 128;
        await this.sleep(audioDurationMs);
      }

      // 2. Conversation loop
      while (
        call.aiTurnCount < MAX_TURNS &&
        Date.now() - callStartTime < MAX_DURATION_MS &&
        !call.disconnected &&
        this.running
      ) {
        // Signal caller to speak
        this.postCallerStatus(call.callerId, "speak");
        call.callerTurnActive = true;
        call.accumulatedTranscript = [];

        // Wait for caller to finish speaking (utterance-end or timeout)
        const gotUtterance = await this.waitForUtterance(30_000);

        call.callerTurnActive = false;

        if (call.disconnected) break;

        // If no speech detected, give them another chance
        if (!gotUtterance && call.accumulatedTranscript.length === 0) {
          await this.icecastPublisher.pushSilence(1000);
          continue;
        }

        // Signal listening
        this.postCallerStatus(call.callerId, "listening");

        const callerText = call.accumulatedTranscript.join(" ");
        if (!callerText.trim()) {
          await this.icecastPublisher.pushSilence(500);
          continue;
        }

        // Push silence while generating response
        const silencePromise = this.icecastPublisher.pushSilence(500);

        // Generate AI response
        const responseLines = await this.scriptGenerator.generateCallResponse({
          callerText,
          callerName: call.callerName,
          topicHint: call.topicHint,
          turnCount: call.aiTurnCount,
          hosts,
          stationContext,
        });

        await silencePromise;

        // TTS and broadcast AI response
        for (const line of responseLines) {
          if (call.disconnected || !this.running) break;

          const pcm = await this.ttsService.synthesize(
            line.text,
            this.resolveVoiceId(line.host, config),
            line.emotion,
          );
          const mp3 = await this.audioEncoder.encode(pcm);
          await this.icecastPublisher.pushAudio(mp3);

          this.port.postMessage({
            type: "transcript-line",
            line: { host: line.host, text: line.text, emotion: line.emotion, timestamp: Date.now() },
          });

          const audioDurationMs = (mp3.length * 8) / 128;
          await this.sleep(audioDurationMs);
        }

        call.aiTurnCount++;
      }
    } catch (err) {
      this.log.error({ err, callerId: call.callerId }, "Error during call segment");
    } finally {
      this.icecastPublisher.broadcasting = false;
      this.cleanupCall();
    }
  }

  private currentConfig: StationConfig | null = null;

  private buildGenerationProgressContext(): {
    segmentPercent?: number;
    programPercent?: number;
    currentSegmentNumber?: number;
    totalSegments?: number;
  } {
    const activeProgram = this.programPlanner?.getActiveProgram();
    if (!activeProgram) {
      return {
        segmentPercent: this.currentSegmentProgress * 100,
      };
    }

    const totalSegments = activeProgram.segments.length;
    const currentSegmentNumber = Math.min(
      activeProgram.currentSegmentIndex + 1,
      totalSegments,
    );

    return {
      segmentPercent: this.currentSegmentProgress * 100,
      programPercent: this.currentProgramProgress * 100,
      currentSegmentNumber,
      totalSegments,
    };
  }

  private async prepareNextSegment(
    stationId: string,
    hosts: RuntimeHost[],
    stationContext: RuntimeStationContext,
  ): Promise<PreparedSegment | null> {
    const config = this.currentConfig;
    if (!config || !this.scriptGenerator || !this.programPlanner) return null;

    const nextProgramSegment = this.programPlanner.peekNextSegment();
    const hasQueuedTopic = this.topicQueue.length > 0;
    const nextSource = await this.selectNextSegmentSource(
      Boolean(nextProgramSegment),
      hasQueuedTopic,
    );

    return this.segmentExecutor.prepareNextSegment({
      nextSource,
      prepareProgramSegment: () => this.prepareProgramSegment(stationId, hosts, stationContext),
      prepareQueuedSegment: () => this.prepareQueuedSegment(stationId, hosts, stationContext),
      prepareStartupSegment: () => this.maybePrepareStartupSegment(stationId, hosts, stationContext),
      prepareFillerSegment: () => this.prepareFillerSegment(stationId, hosts, stationContext),
    });
  }

  private async selectNextSegmentSource(
    hasProgramSegment: boolean,
    hasQueuedTopic: boolean,
  ): Promise<NextSegmentSource> {
    if (!this.decisionRouter || !this.scriptGenerator) {
      return hasProgramSegment ? "program" : hasQueuedTopic ? "queue" : "filler";
    }

    const decision = await this.decisionRouter.selectNextSegmentSource({
      hasProgramSegment,
      hasQueuedTopic,
      queuedTopicCount: this.topicQueue.length,
      isFirstSegment: !this.firstSegmentGenerated,
      ...this.buildGenerationProgressContext(),
    });
    this.metrics.recordDecision();

    let source: NextSegmentSource = "filler";
    if (decision.source === "queue" && hasQueuedTopic) {
      source = "queue";
    } else if (decision.source === "program" && hasProgramSegment) {
      source = "program";
    } else if (hasProgramSegment) {
      source = "program";
    } else if (hasQueuedTopic) {
      source = "queue";
    }

    this.log.info(
      {
        source,
        decision: decision.source,
        reason: decision.reason,
        hasProgramSegment,
        queuedTopicCount: this.topicQueue.length,
      },
      "Next segment source selected",
    );
    return source;
  }

  private async prepareProgramSegment(
    stationId: string,
    hosts: RuntimeHost[],
    stationContext: RuntimeStationContext,
  ): Promise<PreparedSegment | null> {
    const programSegment = this.programPlanner?.getNextSegment();
    if (!programSegment || !this.scriptGenerator || !this.programPlanner) return null;

    const pulse: PulseEvent = {
      topic: programSegment.topic,
      summary: programSegment.angle,
      urgency: "interesting",
      sourceUrl: "",
      rawContent: programSegment.angle,
    };
    const script = await this.scriptGenerator.generate(pulse, hosts, stationContext, {
      fastStart: !this.firstSegmentGenerated,
      targetDurationMin: Math.max(2, programSegment.estimatedMinutes || this.resolveTargetSegmentMinutes()),
      progress: this.buildGenerationProgressContext(),
    });
    const reviewedLines = this.criticAgent.reviewScript(script.lines, "topic");
    const programId = this.programPlanner.getActiveProgram()?.id ?? null;
    const prepared = await this.savePreparedSegment({
      stationId,
      topic: programSegment.topic,
      sourceUrl: null,
      programId,
      kind: "program",
      scriptLines: reviewedLines,
    });
    await this.programPlanner.advanceSegment();
    return prepared;
  }

  private async prepareQueuedSegment(
    stationId: string,
    hosts: RuntimeHost[],
    stationContext: RuntimeStationContext,
  ): Promise<PreparedSegment | null> {
    if (!this.scriptGenerator || this.topicQueue.length === 0) return null;
    const pulse = this.topicQueue.shift()!;
    const script = await this.scriptGenerator.generate(pulse, hosts, stationContext, {
      fastStart: !this.firstSegmentGenerated,
      targetDurationMin: this.resolveTargetSegmentMinutes(!this.firstSegmentGenerated),
      progress: this.buildGenerationProgressContext(),
    });
    const reviewedLines = this.criticAgent.reviewScript(script.lines, "topic");
    const programId = this.programPlanner?.getActiveProgram()?.id ?? null;
    return this.savePreparedSegment({
      stationId,
      topic: pulse.topic,
      sourceUrl: pulse.sourceUrl || null,
      programId,
      kind: "queue",
      scriptLines: reviewedLines,
    });
  }

  private async maybePrepareStartupSegment(
    stationId: string,
    hosts: RuntimeHost[],
    stationContext: RuntimeStationContext,
  ): Promise<PreparedSegment | null> {
    if (!this.scriptGenerator || !this.programPlanner) return null;
    if (this.programPlanner.getActiveProgram()) return null;

    this.ensureProgramPlanning();
    if (!this.firstSegmentGenerated) {
      const quickScript = await this.scriptGenerator.generate(
        this.createContextualFillerPulse("startup"),
        hosts,
        stationContext,
        {
          fastStart: true,
          kind: "filler",
          targetDurationMin: this.resolveTargetSegmentMinutes(true),
          recentTopics: this.recentTopics,
          progress: this.buildGenerationProgressContext(),
        },
      );
      const reviewedLines = this.criticAgent.reviewScript(quickScript.lines, "filler");
      return this.savePreparedSegment({
        stationId,
        topic: "startup",
        programId: null,
        kind: "filler",
        scriptLines: reviewedLines,
      });
    }

    if (this.planningProgramPromise) {
      await this.planningProgramPromise;
      if (this.programPlanner.getActiveProgram()) {
        return this.prepareNextSegment(stationId, hosts, stationContext);
      }
    }

    return null;
  }

  private async prepareFillerSegment(
    stationId: string,
    hosts: RuntimeHost[],
    stationContext: RuntimeStationContext,
  ): Promise<PreparedSegment> {
    const filler = await this.scriptGenerator!.generate(
      this.createContextualFillerPulse("filler"),
      hosts,
      stationContext,
      {
        fastStart: !this.firstSegmentGenerated,
        kind: "filler",
        targetDurationMin: this.resolveTargetSegmentMinutes(!this.firstSegmentGenerated),
        recentTopics: this.recentTopics,
        progress: this.buildGenerationProgressContext(),
      },
    );
    const reviewedLines = this.criticAgent.reviewScript(filler.lines, "filler");
    const programId = this.programPlanner?.getActiveProgram()?.id ?? null;
    return this.savePreparedSegment({
      stationId,
      topic: "filler",
      programId,
      kind: "filler",
      scriptLines: reviewedLines,
    });
  }

  private async loadResumablePreparedSegment(
    stationId: string,
    config: StationConfig,
  ): Promise<PreparedSegment | null> {
    const latest = (await Segment.findMany({ where: { stationId }, take: 1, orderBy: { createdAt: "desc" } }))[0];
    if (!latest) return null;

    const lines = await TranscriptLine.findMany({ where: { segmentId: latest.id }, orderBy: { lineIndex: "asc" } });
    if (lines.length === 0) return null;

    const resumeFrom = lines.findIndex((line) => !line.spokenAt);
    if (resumeFrom === -1) return null;

    const remaining = lines.slice(resumeFrom);
    const scriptLines: ScriptLine[] = remaining.map((line) => ({
      host: line.host,
      text: line.text,
      emotion: (line.emotion as ScriptLine["emotion"]) ?? "neutral",
    }));
    const lineRowIds = remaining.map((line) => line.id);

    this.firstSegmentGenerated = true;
    this.log.info(
      {
        stationId,
        segmentId: latest.id,
        topic: latest.topic ?? "resumed",
        resumeFromLine: resumeFrom,
        remainingLines: scriptLines.length,
      },
      "Resuming partially spoken segment from transcript cursor",
    );

    return {
      topic: latest.topic ?? "resumed",
      sourceUrl: latest.sourceUrl ?? undefined,
      programId: latest.programId ?? undefined,
      kind: latest.programId ? "program" : "filler",
      scriptLines,
      segmentId: latest.id,
      lineRowIds,
      firstTts: scriptLines.length > 0 ? this.batchTTS(scriptLines, 0, config) : null,
    };
  }

  private async broadcastLoop(stationId: string): Promise<void> {
    const config = this.currentConfig;
    if (!config || !this.icecastPublisher || !this.audioEncoder) return;

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

    const resumable = await this.loadResumablePreparedSegment(stationId, config);
    let nextPreparedPromise: Promise<PreparedSegment | null> | null = resumable
      ? Promise.resolve(resumable)
      : this.prepareNextSegment(stationId, hosts, stationContext);

    while (this.running) {
      if (this.paused) {
        await this.icecastPublisher.pushSilence(1000);
        await this.sleep(1000);
        continue;
      }

      try {
        if (!nextPreparedPromise) {
          nextPreparedPromise = this.prepareNextSegment(
            stationId,
            hosts,
            stationContext,
          );
        }

        const prepStartMs = Date.now();
        const prepared = await nextPreparedPromise;
        const prepElapsedMs = Date.now() - prepStartMs;
        nextPreparedPromise = null;
        this.metrics.recordPrepLatency(prepElapsedMs);
        this.orchestrator.onPreparationLatency(prepElapsedMs);

        this.log.info(
          {
            prepElapsedMs,
            topic: prepared?.topic,
            lines: prepared?.scriptLines.length,
            mode: this.orchestrator.getMode(),
          },
          "Segment preparation complete",
        );

        if (!prepared || prepared.scriptLines.length === 0) {
          await this.sleep(1000);
          continue;
        }

        this.state.currentTopic = prepared.topic !== "filler" ? prepared.topic : null;
        this.postState();

        const { scriptLines, segmentId, lineRowIds } = prepared;
        this.archiveBridge.beginSegment({
          segmentId,
          topic: prepared.topic,
          sourceUrl: prepared.sourceUrl,
          programId: prepared.programId,
        });

        let pendingTts = prepared.firstTts;
        let pendingEncode: Promise<Buffer> | null = null;
        let i = 0;
        let stageOnePrefetchTriggered = false;
        let prefetchTriggered = false;

        const callCheckPoints = this.computeCallCheckPoints(scriptLines.length);
        let nextCallCheck = 0;
        let callCheckPromise: Promise<void> | null = null;

        this.icecastPublisher.broadcasting = true;

        while (i < scriptLines.length) {
          if (!this.running || this.paused) break;

          const batch = this.batcher.build(scriptLines, i);
          const batchHost = batch.host;
          const batchEnd = batch.endIndex;

          this.state.currentHost = batchHost;
          this.postState();

          let mp3Buffer: Buffer;
          if (pendingEncode) {
            const encodeStart = Date.now();
            mp3Buffer = await pendingEncode;
            pendingEncode = null;
            this.log.info(
              { host: batchHost, mp3Bytes: mp3Buffer.length, encodeMs: Date.now() - encodeStart },
              "MP3 encode complete (overlapped)",
            );
          } else {
            const ttsWaitStart = Date.now();
            const pcmBuffer = await pendingTts!;
            const ttsWaitMs = Date.now() - ttsWaitStart;
            const audioDurMs = Math.round(
              (pcmBuffer.length / 2 / StationWorkerRuntime.PCM_SAMPLE_RATE) * 1000,
            );
            this.log.info(
              {
                host: batchHost,
                pcmBytes: pcmBuffer.length,
                audioDurMs,
                ttsWaitMs,
                batchLines: batchEnd - i + 1,
              },
              "TTS batch ready",
            );

            const encodeStart = Date.now();
            mp3Buffer = await this.audioEncoder.encode(pcmBuffer);
            this.log.info(
              { host: batchHost, mp3Bytes: mp3Buffer.length, encodeMs: Date.now() - encodeStart },
              "MP3 encode complete",
            );
          }

          const pushTime = Date.now();
          await this.icecastPublisher.pushAudio(mp3Buffer);
          this.archiveBridge.appendChunk(mp3Buffer);
          if (!this.hasPushedFirstAudio) {
            this.hasPushedFirstAudio = true;
            this.flushDeferredFactChecks();
          }

          const audioDurationMs =
            (mp3Buffer.length * 8) / StationWorkerRuntime.MP3_BITRATE_KBPS;

          const nextBatchStart = batchEnd + 1;
          if (nextBatchStart < scriptLines.length) {
            pendingTts = this.batchTTS(scriptLines, nextBatchStart, config);
            pendingEncode = pendingTts.then((pcm) => {
              const durMs = Math.round(
                (pcm.length / 2 / StationWorkerRuntime.PCM_SAMPLE_RATE) * 1000,
              );
              this.log.info(
                {
                  host: scriptLines[nextBatchStart].host,
                  pcmBytes: pcm.length,
                  audioDurMs: durMs,
                },
                "TTS batch ready (prefetch)",
              );
              return this.audioEncoder!.encode(pcm);
            });
          } else {
            pendingTts = null;
            pendingEncode = null;
          }

          const segmentProgress = Math.min(1, nextBatchStart / scriptLines.length);
          this.currentSegmentProgress = segmentProgress;

          // W1 prefetch: keep planning/research warm before heavy generation kicks in.
          if (!stageOnePrefetchTriggered && segmentProgress >= 0.45) {
            stageOnePrefetchTriggered = true;
            this.ensureProgramPlanning();
          }

          const activeProgram = this.programPlanner?.getActiveProgram();
          if (activeProgram && activeProgram.segments.length > 0) {
            this.currentProgramProgress = Math.min(
              1,
              (activeProgram.currentSegmentIndex + segmentProgress) /
                activeProgram.segments.length,
            );
          } else {
            this.currentProgramProgress = segmentProgress;
          }

          if (
            this.orchestrator.shouldEvaluateCall({
              checkpointReached:
                nextCallCheck < callCheckPoints.length &&
                nextBatchStart >= callCheckPoints[nextCallCheck],
              hasPendingCallerAccept: Boolean(this.pendingCallerAccept),
              hasActiveCall: Boolean(this.activeCall),
              hasInFlightCheck: Boolean(callCheckPromise),
            })
          ) {
            nextCallCheck++;
            callCheckPromise = this.evaluateCallOpportunity(prepared.kind, segmentProgress)
              .catch((err) => this.log.warn({ err }, "Call opportunity check failed"))
              .finally(() => { callCheckPromise = null; });
          }

          if (
            !prefetchTriggered &&
            this.orchestrator.shouldPrefetchNext({
              segmentProgress,
              hasInFlightNext: nextPreparedPromise !== null,
            })
          ) {
            prefetchTriggered = true;
            this.metrics.recordPrefetch();
            nextPreparedPromise = this.prepareNextSegment(
              stationId,
              hosts,
              stationContext,
            );
            this.log.info(
              {
                topic: prepared.topic,
                segmentProgress: Math.round(segmentProgress * 100),
                programProgress: Math.round(this.currentProgramProgress * 100),
              },
              "Triggered next segment prefetch",
            );
          }

          const elapsed = Date.now() - pushTime;
          const remaining = audioDurationMs - elapsed;
          if (remaining > 0) await this.sleep(remaining);

          for (let k = i; k <= batchEnd; k++) {
            const line = scriptLines[k];
            this.port.postMessage({
              type: "transcript-line",
              line: {
                host: line.host,
                text: line.text,
                emotion: line.emotion,
                timestamp: Date.now(),
              },
            });

            TranscriptLine.update(lineRowIds[k], { spokenAt: new Date() }).catch((err) => {
              this.log.error(
                { err, lineId: lineRowIds[k] },
                "Failed to mark line as spoken",
              );
            });
          }
          i = nextBatchStart;
        }

        this.icecastPublisher.broadcasting = false;
        this.currentSegmentProgress = 0;

        this.archiveBridge.completeActiveSegment();

        // Check for pending call-in between segments
        if (this.orchestrator.shouldEnterCallSegment({
          hasPendingCallerAccept: Boolean(this.pendingCallerAccept),
          hasActiveCall: Boolean(this.activeCall),
        })) {
          const call = this.activeCall;
          if (!call) continue;
          this.postCallerStatus(call.callerId, "on-air");
          await this.runCallSegment();
        }
        this.orchestrator.onLoopHealthy();
      } catch (err) {
        this.archiveBridge.completeActiveSegment();
        this.metrics.recordLoopError();
        this.orchestrator.onLoopError();
        const message = err instanceof Error ? err.message : String(err);
        this.log.error({ err }, "Error in broadcast loop");
        this.port.postMessage({ type: "error", error: message });
        nextPreparedPromise = null;
        await this.sleep(5000);
      }
    }
  }

  private start(config: StationConfig, stationId: string): void {
    if (this.running || this.startingPromise) {
      this.log.warn({ stationId }, "Worker already starting or running");
      return;
    }

    this.startingPromise = this.startInternal(config, stationId).finally(() => {
      this.startingPromise = null;
    });
  }

  private async startInternal(
    config: StationConfig,
    stationId: string,
  ): Promise<void> {
    this.log.info({ stationId }, "Starting station worker");
    this.currentConfig = config;

    try {
      await initDb();
      const ai = createAIClient();

      this.contentPipeline = this.factories.createContentPipeline(ai);
      this.scriptGenerator = this.factories.createScriptGenerator(ai);
      this.decisionRouter = new DecisionRouter(this.scriptGenerator);
      this.factCheckService = this.factories.createFactCheckService(ai);
      this.ttsService = this.factories.createTtsService();
      this.audioEncoder = this.factories.createAudioEncoder();
      this.icecastPublisher = this.factories.createIcecastPublisher();
      this.programPlanner = this.factories.createProgramPlanner({
        ai,
        stationId,
        stationName: this.data.slug,
        stationDescription: config.description,
        searchQueries: config.sources.map((s) => s.query),
        hosts: config.hosts.map((h) => ({
          name: h.name,
          personality: h.personality,
        })),
        durationMin: this.resolveAverageProgramMinutes(),
        useFullEditorial: config.sources.length > 0,
      });

      this.contentPipeline.start(config.sources as ContentSource[]);
      await this.icecastPublisher.connect(`/station-${this.data.slug}`);

      this.pulseHandler = async (pulse: PulseEvent) => {
        this.rememberPulse(pulse);
        this.log.info(
          { topic: pulse.topic, urgency: pulse.urgency },
          "New topic from content pipeline",
        );

        await this.plannerAgent.handlePulse(
          this.programPlanner,
          pulse,
          (approvedPulse) => {
            this.topicQueue.push(approvedPulse);
          },
        );
      };
      this.contentPipeline.on("pulse", this.pulseHandler);

      this.running = true;
      this.paused = false;
      this.startedAt = Date.now();
      this.firstSegmentGenerated = false;
      this.planningProgramPromise = null;
      this.hasPushedFirstAudio = false;
      this.pendingFactChecks.length = 0;
      this.metrics.start();

      this.state.status = "live";
      this.postState();

      await this.broadcastLoop(stationId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err }, "Fatal error starting station worker");
      this.port.postMessage({ type: "error", error: message });
    }
  }

  private stop(): void {
    this.log.info("Stopping station worker");
    this.running = false;
    this.paused = false;

    if (this.contentPipeline && this.pulseHandler) {
      this.contentPipeline.off("pulse", this.pulseHandler);
      this.pulseHandler = null;
    }
    if (this.activeCall) this.cleanupCall();
    this.pendingCallerAccept = null;
    this.contentPipeline?.stop();
    this.icecastPublisher?.disconnect();
    this.pendingFactChecks.length = 0;
    this.topicQueue.length = 0;
    this.recentPulses.length = 0;
    this.metrics.stop();

    this.state.status = "idle";
    this.state.currentTopic = null;
    this.state.currentHost = null;
    this.postState();

    setTimeout(() => process.exit(0), 500);
  }

  private pause(): void {
    this.log.info("Pausing station worker");
    this.paused = true;
    this.state.status = "paused";
    this.postState();
  }

  private resume(): void {
    this.log.info("Resuming station worker");
    this.paused = false;
    this.state.status = "live";
    this.postState();
  }

  private handleListenerCount(count: number): void {
    this.state.listenerCount = count;

    // if (this.data.idleBehavior === "pause") {
    //   if (count === 0 && this.running && !this.paused) {
    //     this.log.info("No listeners — pausing (idle_behavior=pause)");
    //     this.pause();
    //   } else if (count > 0 && this.running && this.paused) {
    //     this.log.info("Listeners returned — resuming");
    //     this.resume();
    //   }
    // }

    this.postState();
  }
}

if (!parentPort) {
  throw new Error("StationWorker must run inside a worker thread");
}

const runtime = new StationWorkerRuntime(
  workerData as StationWorkerData,
  parentPort,
);
runtime.run();
