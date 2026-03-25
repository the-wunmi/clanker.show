import type { ScriptGenerator } from "../../services/ScriptGenerator";
import type { STTService } from "../../services/STTService";
import type { AudioStream } from "../../services/AudioEncoder";
import type {
  Activity,
  ActivityServices,
  PreparedActivity,
  ActivityRunResult,
} from "../Activity";
import type { CallerStatus } from "../types";

// --- Decision + Prepared types ---

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
  sttService: STTService;
  callerEncoder: AudioStream;
  accumulatedTranscript: string[];
  aiTurnCount: number;
  callerTurnActive: boolean;
  resolveUtterance?: () => void;
  disconnected: boolean;
}

export interface PreparedCall extends PreparedActivity {
  kind: "call";
  callerId: string;
  callerName: string;
  topicHint: string;
}

// --- Dependencies ---

export interface CallActivityDeps {
  scriptGenerator: ScriptGenerator;
  hosts: Array<{ name: string; personality: string; voiceId?: string }>;
  stationName: string;
  stationDescription?: string;
  getActiveCall: () => ActiveCallState | null;
  postCallerStatus: (callerId: string, status: CallerStatus) => void;
  sendCallerAudio: (callerId: string, mp3: Buffer) => void;
  waitForUtterance: (timeoutMs: number) => Promise<boolean>;
  cleanupCall: () => void;
}

export class CallActivity implements Activity<CallDecision, PreparedCall> {
  private static readonly MAX_TURNS = 8;
  private static readonly MAX_DURATION_MS = 5 * 60 * 1000;

  kind = "call" as const;

  constructor(private readonly deps: CallActivityDeps) {}

  async prepare(decision: CallDecision, services: ActivityServices): Promise<PreparedCall> {
    services.log.info(
      { callerId: decision.callerId, callerName: decision.callerName },
      "Preparing call activity",
    );

    return {
      kind: "call",
      callerId: decision.callerId,
      callerName: decision.callerName,
      topicHint: decision.topicHint,
    };
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
      "Starting call conversation",
    );

    try {
      // ── Step 1: Host intro ──
      // The hosts introduce the caller before we open the audio line.
      const intro = await this.deps.scriptGenerator.generateGuestIntro(
        call.callerName,
        call.topicHint,
        this.deps.hosts,
      );

      for (const line of intro.lines) {
        if (call.disconnected) break;
        const mp3 = await pipeline.synthesizeAndPush(line);
        this.deps.sendCallerAudio(call.callerId, mp3);
        emitTranscriptLine(line);
        const audioDurationMs = pipeline.computeAudioDurationMs(mp3);
        await sleep(audioDurationMs);
      }

      if (call.disconnected) {
        log.info({ callerId: call.callerId }, "Caller disconnected during intro");
        await this.airIssueLines(call, "lost_caller", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

      // ── Step 2: Open STT stream ──
      // Only now — after the intro has aired — do we start the STT WebSocket.
      // This avoids the stream dying from inactivity while the segment/intro plays.
      try {
        await call.sttService.startStream();
        log.info({ callerId: call.callerId }, "STT stream opened for call");
      } catch (err) {
        log.error({ err, callerId: call.callerId }, "STT failed to start for call");
        await this.airIssueLines(call, "connection_error", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

      // ── Step 3: Back-and-forth conversation ──
      let consecutiveEmptyTurns = 0;

      while (
        call.aiTurnCount < CallActivity.MAX_TURNS &&
        Date.now() - callStartTime < CallActivity.MAX_DURATION_MS &&
        !call.disconnected
      ) {
        log.info(
          { callerId: call.callerId, turn: call.aiTurnCount, elapsedMs: Date.now() - callStartTime },
          "Call turn starting — opening caller mic",
        );

        // Re-open STT if it died during the host response (ElevenLabs closes
        // inactive WebSockets after ~15s of no audio).
        try {
          await call.sttService.ensureStream();
        } catch (err) {
          log.warn({ err, callerId: call.callerId, turn: call.aiTurnCount }, "STT reconnect failed at turn start");
        }

        this.deps.postCallerStatus(call.callerId, "speak");
        call.callerTurnActive = true;
        call.accumulatedTranscript = [];

        const gotUtterance = await this.deps.waitForUtterance(30_000);
        call.callerTurnActive = false;

        if (call.disconnected) {
          log.info({ callerId: call.callerId, turn: call.aiTurnCount }, "Caller disconnected during turn");
          break;
        }

        const callerText = call.accumulatedTranscript.join(" ").trim();
        log.info(
          {
            callerId: call.callerId,
            turn: call.aiTurnCount,
            gotUtterance,
            callerTextLen: callerText.length,
            callerText: callerText.slice(0, 200),
            transcriptSegments: call.accumulatedTranscript.length,
          },
          "Call turn result",
        );

        if (!gotUtterance && !callerText) {
          consecutiveEmptyTurns++;

          if (consecutiveEmptyTurns >= 2) {
            // Two consecutive empty turns — we've lost them
            log.info(
              { callerId: call.callerId, consecutiveEmptyTurns },
              "Two consecutive empty turns, ending call",
            );
            await this.airIssueLines(call, "lost_caller", pipeline, sleep, emitTranscriptLine);
            break;
          }

          // First empty turn — try to recover STT and prompt the caller
          log.info({ callerId: call.callerId, consecutiveEmptyTurns }, "Empty turn — recovering STT");
          try {
            await call.sttService.ensureStream();
          } catch (err) {
            log.warn({ err, callerId: call.callerId }, "STT reconnect failed during call");
          }
          await this.airIssueLines(call, "no_audio", pipeline, sleep, emitTranscriptLine);
          continue;
        }

        // Got audio — reset empty turn counter
        consecutiveEmptyTurns = 0;

        if (!callerText) {
          log.info({ callerId: call.callerId, turn: call.aiTurnCount }, "Utterance received but no text — pushing silence");
          await pipeline.pushSilence(500);
          continue;
        }

        this.deps.postCallerStatus(call.callerId, "listening");

        log.info(
          { callerId: call.callerId, turn: call.aiTurnCount, callerTextLen: callerText.length },
          "Generating host response",
        );
        const silencePromise = pipeline.pushSilence(500);
        const responseLines = await this.deps.scriptGenerator.generateCallResponse({
          callerText,
          callerName: call.callerName,
          topicHint: call.topicHint,
          turnCount: call.aiTurnCount,
          hosts: this.deps.hosts,
          stationContext: {
            stationName: this.deps.stationName,
            description: this.deps.stationDescription,
          },
        });
        await silencePromise;

        log.info(
          { callerId: call.callerId, turn: call.aiTurnCount, responseLineCount: responseLines.length },
          "Airing host response",
        );
        for (const line of responseLines) {
          if (call.disconnected) break;
          const mp3 = await pipeline.synthesizeAndPush(line);
          this.deps.sendCallerAudio(call.callerId, mp3);
          emitTranscriptLine(line);
          const audioDurationMs = pipeline.computeAudioDurationMs(mp3);
          await sleep(audioDurationMs);
        }

        call.aiTurnCount++;
      }

      log.info(
        { callerId: call.callerId, aiTurns: call.aiTurnCount },
        "Call conversation complete",
      );
    } catch (err) {
      log.error({ err, callerId: call.callerId }, "Error during call conversation");
    } finally {
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
