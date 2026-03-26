import type { ScriptGenerator, ScriptLine } from "../../services/ScriptGenerator";
import type { ElevenLabsAgentService } from "../../services/ElevenLabsAgentService";
import type {
  Activity,
  ActivityServices,
  PreparedActivity,
  ActivityRunResult,
} from "../Activity";
import type { CallerStatus } from "../types";


export interface CallDecision {
  kind: "call";
  callerId: string;
  callerName: string;
  topicHint: string;
}

export interface ActiveCallState {
  callerId: string;
  callerName: string;
  topicHint: string;
  agentService: ElevenLabsAgentService;
  conversationId: string | null;
  disconnected: boolean;
  sessionEnded: boolean;
  /** Why the session ended — "agent_end_call" is graceful, anything else is unexpected */
  sessionEndReason: string | null;
}

export interface PreparedCall extends PreparedActivity {
  kind: "call";
  callerId: string;
  callerName: string;
  topicHint: string;
  transitionLines?: ScriptLine[];
  transitionAudio?: Buffer[];
}


export interface CallActivityDeps {
  scriptGenerator: ScriptGenerator;
  hosts: Array<{ name: string; personality: string; voiceId?: string }>;
  stationName: string;
  stationDescription?: string;
  getActiveCall: () => ActiveCallState | null;
  getPreSynthesizedTransition: () => Promise<{ lines: ScriptLine[]; audio: Buffer[] } | null>;
  postCallerStatus: (callerId: string, status: CallerStatus) => void;
  sendCallerAudio: (callerId: string, mp3: Buffer) => void;
  broadcastAgentAudio: (mp3: Buffer) => Promise<void>;
  getCurrentShowContext: () => string;
  getAgentIdForHost: (hostName: string) => string;
  cleanupCall: () => void;
}

export class CallActivity implements Activity<CallDecision, PreparedCall> {
  private static readonly MAX_DURATION_MS = 5 * 60 * 1000;

  kind = "call" as const;

  constructor(private readonly deps: CallActivityDeps) {}

  async prepare(decision: CallDecision, services: ActivityServices): Promise<PreparedCall> {
    services.log.info(
      { callerId: decision.callerId, callerName: decision.callerName },
      "Preparing call activity",
    );

    const prepared: PreparedCall = {
      kind: "call",
      callerId: decision.callerId,
      callerName: decision.callerName,
      topicHint: decision.topicHint,
    };

    // Await pre-synthesized transition (e.g., "We've got Sarah on the line!")
    const t0 = Date.now();
    try {
      const preSynthesized = await this.deps.getPreSynthesizedTransition();
      const awaitMs = Date.now() - t0;
      if (preSynthesized) {
        prepared.transitionLines = preSynthesized.lines;
        prepared.transitionAudio = preSynthesized.audio;
        services.log.info(
          { callerId: decision.callerId, lineCount: preSynthesized.lines.length, awaitMs },
          "Using pre-synthesized transition",
        );
      } else {
        services.log.info({ callerId: decision.callerId, awaitMs }, "No pre-synthesized transition available");
      }
    } catch (err) {
      services.log.warn({ err, callerId: decision.callerId, awaitMs: Date.now() - t0 }, "Pre-synthesized transition failed");
    }

    return prepared;
  }

  async run(prepared: PreparedCall, services: ActivityServices): Promise<ActivityRunResult> {
    const { log, pipeline, sleep, emitTranscriptLine } = services;
    const call = this.deps.getActiveCall();

    if (!call) {
      log.warn({ callerId: prepared.callerId }, "No active call when entering call activity");
      return { interrupted: false, kind: "call" };
    }

    this.deps.postCallerStatus(call.callerId, "on-air");
    pipeline.broadcasting = true;

    const callStartTime = Date.now();

    log.info(
      { callerId: call.callerId, callerName: call.callerName },
      "PERF call:start",
    );

    let contextualUpdateTimer: ReturnType<typeof setInterval> | null = null;

    try {
            if (prepared.transitionLines && prepared.transitionAudio && prepared.transitionAudio.length === prepared.transitionLines.length) {
        const transitionStartMs = Date.now();
        log.info(
          { callerId: call.callerId, lineCount: prepared.transitionLines.length },
          "PERF call:transition-playback:start",
        );
        for (let idx = 0; idx < prepared.transitionLines.length; idx++) {
          if (call.disconnected) break;
          const line = prepared.transitionLines[idx];
          const mp3 = prepared.transitionAudio[idx];
          await pipeline.pushMp3(mp3);
          this.deps.sendCallerAudio(call.callerId, mp3);
          emitTranscriptLine(line);
          const audioDurationMs = pipeline.computeAudioDurationMs(mp3);
          await sleep(audioDurationMs);
        }
        log.info(
          { callerId: call.callerId, playbackMs: Date.now() - transitionStartMs },
          "PERF call:transition-playback:end",
        );
      }

      if (call.disconnected) {
        log.info({ callerId: call.callerId }, "Caller disconnected during transition");
        await this.airIssueLines(call, "lost_caller", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

            const primaryHost = this.deps.hosts[0];
      if (!primaryHost) {
        log.error({ callerId: call.callerId }, "No hosts configured");
        await this.airIssueLines(call, "connection_error", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

      let agentId: string;
      try {
        agentId = this.deps.getAgentIdForHost(primaryHost.name);
      } catch {
        log.error({ callerId: call.callerId, hostName: primaryHost.name }, "No agent ID for host");
        await this.airIssueLines(call, "connection_error", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

      const agentStartT0 = Date.now();
      log.info({ callerId: call.callerId, agentId }, "PERF call:agent-start:start");
      try {
        const conversationId = await call.agentService.startSession({
          agentId,
          dynamicVariables: {
            caller_name: call.callerName,
            caller_topic: call.topicHint,
            station_name: this.deps.stationName,
            show_context: this.deps.getCurrentShowContext(),
          },
        });
        call.conversationId = conversationId;
        log.info(
          { callerId: call.callerId, conversationId, agentStartMs: Date.now() - agentStartT0 },
          "PERF call:agent-start:end",
        );
      } catch (err) {
        log.error({ err, callerId: call.callerId, agentStartMs: Date.now() - agentStartT0 }, "PERF call:agent-start:failed");
        await this.airIssueLines(call, "connection_error", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

            // Agent outputs MP3 directly → batch and forward to broadcaster + caller
      call.agentService.on("agent-audio", (mp3: Buffer) => {
        this.deps.broadcastAgentAudio(mp3).catch((err) => {
          log.warn({ err }, "Failed to broadcast agent audio");
        });
      });

      call.agentService.on("user-transcript", (text: string) => {
        emitTranscriptLine({
          host: `Caller: ${call.callerName}`,
          text,
          emotion: "neutral",
        });
      });

      call.agentService.on("agent-response", (text: string) => {
        emitTranscriptLine({
          host: primaryHost.name,
          text,
          emotion: "neutral",
        });
      });

      call.agentService.on("session-ended", (reason: string) => {
        log.info({ callerId: call.callerId, reason }, "Agent session ended");
        call.sessionEnded = true;
        call.sessionEndReason = reason;
      });

      call.agentService.on("error", (err: Error) => {
        log.error({ err, callerId: call.callerId }, "Agent session error");
        call.sessionEnded = true;
        call.sessionEndReason = "error";
      });

      // Agent session is live — conversation is fluid, caller can speak anytime.
      // Send "speak" so the frontend shows the green "ON AIR — Speak!" indicator.
      // This also gates handleCallerAudio to start forwarding mic audio.
      this.deps.postCallerStatus(call.callerId, "speak");

            contextualUpdateTimer = setInterval(() => {
        if (call.disconnected || call.sessionEnded) return;

        const elapsedMs = Date.now() - callStartTime;
        const remainingMs = CallActivity.MAX_DURATION_MS - elapsedMs;

        if (remainingMs < 60_000) {
          call.agentService.sendContextualUpdate(
            "WRAP UP NOW. You have less than 1 minute left. Thank the caller and say goodbye immediately.",
          );
        } else if (remainingMs < 120_000) {
          call.agentService.sendContextualUpdate(
            "Start wrapping up the conversation. You have about 1-2 minutes left on air.",
          );
        } else {
          call.agentService.sendUserActivity();
        }
      }, 30_000);

            await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          const elapsed = Date.now() - callStartTime;
          if (call.disconnected || call.sessionEnded || elapsed >= CallActivity.MAX_DURATION_MS) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 500);
      });

      const callTotalMs = Date.now() - callStartTime;
      log.info(
        {
          callerId: call.callerId,
          conversationId: call.conversationId,
          callTotalMs,
          disconnected: call.disconnected,
          sessionEnded: call.sessionEnded,
        },
        "PERF call:end",
      );

      if (call.disconnected) {
        // Caller dropped — air "lost caller" filler
        await this.airIssueLines(call, "lost_caller", pipeline, sleep, emitTranscriptLine);
      } else if (call.sessionEndReason === "error" || call.sessionEndReason === "ws_closed") {
        // Agent died unexpectedly — air "connection error" filler
        await this.airIssueLines(call, "connection_error", pipeline, sleep, emitTranscriptLine);
      }
      // "agent_end_call" and "server_ended" are graceful — no filler needed
    } catch (err) {
      log.error({ err, callerId: call.callerId, callElapsedMs: Date.now() - callStartTime }, "Error during call conversation");
    } finally {
      if (contextualUpdateTimer) clearInterval(contextualUpdateTimer);
      call.agentService.endSession();
      pipeline.broadcasting = false;
      this.deps.cleanupCall();
    }

    return { interrupted: false, kind: "call" };
  }

  /**
   * Generate and air in-character host lines for a call issue (no audio,
   * lost caller, connection error). Keeps the broadcast seamless.
   */
  private async airIssueLines(
    call: ActiveCallState,
    situation: "no_audio" | "lost_caller" | "connection_error",
    pipeline: ActivityServices["pipeline"],
    sleep: ActivityServices["sleep"],
    emitTranscriptLine: ActivityServices["emitTranscriptLine"],
  ): Promise<void> {
    try {
      const lines = await this.deps.scriptGenerator.generateCallIssueResponse({
        callerName: call.callerName,
        situation,
        hosts: this.deps.hosts,
        stationContext: {
          stationName: this.deps.stationName,
          description: this.deps.stationDescription,
        },
      });

      for (const line of lines) {
        const mp3 = await pipeline.synthesizeAndPush(line);
        this.deps.sendCallerAudio(call.callerId, mp3);
        emitTranscriptLine(line);
        const audioDurationMs = pipeline.computeAudioDurationMs(mp3);
        await sleep(audioDurationMs);
      }
    } catch {
      // If even the issue response fails, push brief silence so there's no dead air
      await pipeline.pushSilence(1000);
    }
  }
}
