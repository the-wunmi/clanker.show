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

export interface CallerState {
  callerId: string;
  callerName: string;
  topicHint: string;
  disconnected: boolean;
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
  spaceName: string;
  spaceDescription?: string;
  getActiveCalls: () => Map<string, CallerState>;
  getFirstCaller: () => CallerState | null;
  getSharedAgent: () => ElevenLabsAgentService | null;
  getConversationId: () => string | null;
  setConversationId: (id: string | null) => void;
  getSessionEnded: () => boolean;
  setSessionEnded: (ended: boolean) => void;
  getSessionEndReason: () => string | null;
  setSessionEndReason: (reason: string | null) => void;
  getMaxSpeakers: () => number;
  getPreSynthesizedTransition: () => Promise<{ lines: ScriptLine[]; audio: Buffer[] } | null>;
  postCallerStatus: (callerId: string, status: CallerStatus) => void;
  sendCallerAudio: (callerId: string, mp3: Buffer) => void;
  broadcastAgentAudio: (pcm: Buffer) => Promise<void>;
  getCurrentShowContext: () => string;
  getAgentIdForHost: (hostName: string) => string;
  cleanupAllCallers: () => void;
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
    const activeCalls = this.deps.getActiveCalls();
    const firstCaller = this.deps.getFirstCaller();

    if (!firstCaller || activeCalls.size === 0) {
      log.warn({ callerId: prepared.callerId }, "No active callers when entering call activity");
      return { interrupted: false, kind: "call" };
    }

    // Post on-air status to all current callers
    for (const [cid] of activeCalls) {
      this.deps.postCallerStatus(cid, "on-air");
    }
    pipeline.broadcasting = true;

    const callStartTime = Date.now();

    log.info(
      { callerId: firstCaller.callerId, callerName: firstCaller.callerName, callerCount: activeCalls.size },
      "PERF call:start",
    );

    let contextualUpdateTimer: ReturnType<typeof setInterval> | null = null;

    try {
      // Play transition for the first caller
      if (prepared.transitionLines && prepared.transitionAudio && prepared.transitionAudio.length === prepared.transitionLines.length) {
        const transitionStartMs = Date.now();
        log.info(
          { callerId: firstCaller.callerId, lineCount: prepared.transitionLines.length },
          "PERF call:transition-playback:start",
        );
        for (let idx = 0; idx < prepared.transitionLines.length; idx++) {
          if (this.allCallersDisconnected()) break;
          const line = prepared.transitionLines[idx];
          const mp3 = prepared.transitionAudio[idx];
          await pipeline.pushMp3(mp3);
          // Send to all active callers
          for (const [cid] of this.deps.getActiveCalls()) {
            this.deps.sendCallerAudio(cid, mp3);
          }
          emitTranscriptLine(line);
          const audioDurationMs = pipeline.computeAudioDurationMs(mp3);
          await sleep(audioDurationMs);
        }
        log.info(
          { callerId: firstCaller.callerId, playbackMs: Date.now() - transitionStartMs },
          "PERF call:transition-playback:end",
        );
      }

      if (this.allCallersDisconnected()) {
        log.info({ callerId: firstCaller.callerId }, "All callers disconnected during transition");
        await this.airIssueLines(firstCaller, "lost_caller", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

      // Start shared agent session
      const primaryHost = this.deps.hosts[0];
      if (!primaryHost) {
        log.error({ callerId: firstCaller.callerId }, "No hosts configured");
        await this.airIssueLines(firstCaller, "connection_error", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

      let agentId: string;
      try {
        agentId = this.deps.getAgentIdForHost(primaryHost.name);
      } catch {
        log.error({ callerId: firstCaller.callerId, hostName: primaryHost.name }, "No agent ID for host");
        await this.airIssueLines(firstCaller, "connection_error", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

      const agentService = this.deps.getSharedAgent();
      if (!agentService) {
        log.error({ callerId: firstCaller.callerId }, "No shared agent service available");
        await this.airIssueLines(firstCaller, "connection_error", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

      const callerNames = [...this.deps.getActiveCalls().values()].map(c => c.callerName);
      const agentStartT0 = Date.now();
      log.info({ callerId: firstCaller.callerId, agentId }, "PERF call:agent-start:start");
      try {
        const conversationId = await agentService.startSession({
          agentId,
          dynamicVariables: {
            caller_name: firstCaller.callerName,
            caller_topic: firstCaller.topicHint,
            station_name: this.deps.spaceName,
            show_context: this.deps.getCurrentShowContext(),
            ...(callerNames.length > 1
              ? { active_callers: callerNames.join(", ") }
              : {}),
          },
        });
        this.deps.setConversationId(conversationId);
        log.info(
          { callerId: firstCaller.callerId, conversationId, agentStartMs: Date.now() - agentStartT0 },
          "PERF call:agent-start:end",
        );
      } catch (err) {
        log.error({ err, callerId: firstCaller.callerId, agentStartMs: Date.now() - agentStartT0 }, "PERF call:agent-start:failed");
        await this.airIssueLines(firstCaller, "connection_error", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

      // Wire shared agent events
      agentService.on("agent-audio", (pcm: Buffer) => {
        this.deps.broadcastAgentAudio(pcm).catch((err) => {
          log.warn({ err }, "Failed to broadcast agent audio");
        });
      });

      agentService.on("user-transcript", (text: string) => {
        emitTranscriptLine({
          host: `Caller`,
          text,
          emotion: "neutral",
        });
      });

      agentService.on("agent-response", (text: string) => {
        emitTranscriptLine({
          host: primaryHost.name,
          text,
          emotion: "neutral",
        });
      });

      agentService.on("session-ended", (reason: string) => {
        log.info({ reason }, "Agent session ended");
        this.deps.setSessionEnded(true);
        this.deps.setSessionEndReason(reason);
      });

      agentService.on("error", (err: Error) => {
        log.error({ err }, "Agent session error");
        this.deps.setSessionEnded(true);
        this.deps.setSessionEndReason("error");
      });

      // Agent session is live — send "speak" to ALL callers
      for (const [cid] of this.deps.getActiveCalls()) {
        this.deps.postCallerStatus(cid, "speak");
      }

      // Contextual updates with time warnings
      contextualUpdateTimer = setInterval(() => {
        if (this.allCallersDisconnected() || this.deps.getSessionEnded()) return;

        const elapsedMs = Date.now() - callStartTime;
        const remainingMs = CallActivity.MAX_DURATION_MS - elapsedMs;

        const currentCallers = this.deps.getActiveCalls();
        const callerCount = currentCallers.size;

        if (remainingMs < 60_000) {
          agentService.sendContextualUpdate(
            `WRAP UP NOW. You have less than 1 minute left. Thank the caller${callerCount > 1 ? "s" : ""} and say goodbye immediately.`,
          );
        } else if (remainingMs < 120_000) {
          agentService.sendContextualUpdate(
            `Start wrapping up the conversation. You have about 1-2 minutes left on air. ${callerCount} caller${callerCount > 1 ? "s" : ""} on stage.`,
          );
        } else {
          agentService.sendUserActivity();
        }
      }, 30_000);

      // Wait for all callers to disconnect, session end, or timeout
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          const elapsed = Date.now() - callStartTime;
          if (this.allCallersDisconnected() || this.deps.getSessionEnded() || elapsed >= CallActivity.MAX_DURATION_MS) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 500);
      });

      const callTotalMs = Date.now() - callStartTime;
      log.info(
        {
          callerId: firstCaller.callerId,
          conversationId: this.deps.getConversationId(),
          callTotalMs,
          allDisconnected: this.allCallersDisconnected(),
          sessionEnded: this.deps.getSessionEnded(),
        },
        "PERF call:end",
      );

      if (this.allCallersDisconnected()) {
        await this.airIssueLines(firstCaller, "lost_caller", pipeline, sleep, emitTranscriptLine);
      } else {
        const reason = this.deps.getSessionEndReason();
        if (reason === "error" || reason === "ws_closed") {
          await this.airIssueLines(firstCaller, "connection_error", pipeline, sleep, emitTranscriptLine);
        }
      }
    } catch (err) {
      log.error({ err, callerId: firstCaller.callerId, callElapsedMs: Date.now() - callStartTime }, "Error during call conversation");
    } finally {
      if (contextualUpdateTimer) clearInterval(contextualUpdateTimer);
      this.deps.getSharedAgent()?.endSession();
      pipeline.broadcasting = false;
      this.deps.cleanupAllCallers();
    }

    return { interrupted: false, kind: "call" };
  }

  /** Notify agent that a new caller joined mid-conversation. */
  onCallerAdded(caller: CallerState): void {
    const agent = this.deps.getSharedAgent();
    if (!agent || this.deps.getSessionEnded()) return;

    // Only post "speak" if the agent session is live (conversationId set).
    // If the session hasn't started yet (caller joined during transition/startup),
    // post "on-air" — they'll be upgraded to "speak" by the run() loop after
    // the agent session starts.
    if (this.deps.getConversationId()) {
      agent.sendContextualUpdate(
        `A new caller has joined the conversation: ${caller.callerName}${caller.topicHint ? `, topic: ${caller.topicHint}` : ""}. There are now ${this.deps.getActiveCalls().size} callers on stage.`,
      );
      this.deps.postCallerStatus(caller.callerId, "speak");
    } else {
      this.deps.postCallerStatus(caller.callerId, "on-air");
    }
  }

  /** Notify agent that a caller left. */
  onCallerRemoved(callerId: string, callerName: string): void {
    const agent = this.deps.getSharedAgent();
    if (!agent || this.deps.getSessionEnded()) return;

    const remaining = this.deps.getActiveCalls().size;
    agent.sendContextualUpdate(
      `${callerName} has left the conversation. ${remaining} caller${remaining !== 1 ? "s" : ""} remaining on stage.`,
    );
  }

  private allCallersDisconnected(): boolean {
    const calls = this.deps.getActiveCalls();
    if (calls.size === 0) return true;
    for (const caller of calls.values()) {
      if (!caller.disconnected) return false;
    }
    return true;
  }

  /**
   * Generate and air in-character host lines for a call issue.
   */
  private async airIssueLines(
    caller: CallerState,
    situation: "no_audio" | "lost_caller" | "connection_error",
    pipeline: ActivityServices["pipeline"],
    sleep: ActivityServices["sleep"],
    emitTranscriptLine: ActivityServices["emitTranscriptLine"],
  ): Promise<void> {
    try {
      const lines = await this.deps.scriptGenerator.generateCallIssueResponse({
        callerName: caller.callerName,
        situation,
        hosts: this.deps.hosts,
        spaceContext: {
          spaceName: this.deps.spaceName,
          description: this.deps.spaceDescription,
        },
      });

      for (const line of lines) {
        const mp3 = await pipeline.synthesizeAndPush(line);
        // Send issue audio to all remaining callers
        for (const [cid] of this.deps.getActiveCalls()) {
          this.deps.sendCallerAudio(cid, mp3);
        }
        emitTranscriptLine(line);
        const audioDurationMs = pipeline.computeAudioDurationMs(mp3);
        await sleep(audioDurationMs);
      }
    } catch {
      await pipeline.pushSilence(1000);
    }
  }
}
