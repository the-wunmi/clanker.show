import type { ScriptGenerator, ScriptLine } from "../../services/ScriptGenerator";
import type { STTService } from "../../services/STTService";
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
  sttService: STTService;
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
  introLines?: ScriptLine[];
  introAudio?: Buffer[];
}


export interface CallActivityDeps {
  scriptGenerator: ScriptGenerator;
  hosts: Array<{ name: string; personality: string; voiceId?: string }>;
  stationName: string;
  stationDescription?: string;
  getActiveCall: () => ActiveCallState | null;
  getPreSynthesizedIntro: () => Promise<{ lines: ScriptLine[]; audio: Buffer[] } | null>;
  postCallerStatus: (callerId: string, status: CallerStatus) => void;
  sendCallerAudio: (callerId: string, mp3: Buffer) => void;
  waitForUtterance: (timeoutMs: number) => Promise<boolean>;
  resetTurnAudioTracking: () => void;
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

    const prepared: PreparedCall = {
      kind: "call",
      callerId: decision.callerId,
      callerName: decision.callerName,
      topicHint: decision.topicHint,
    };

    const t0 = Date.now();
    try {
      const preSynthesized = await this.deps.getPreSynthesizedIntro();
      const awaitMs = Date.now() - t0;
      if (preSynthesized) {
        prepared.introLines = preSynthesized.lines;
        prepared.introAudio = preSynthesized.audio;
        services.log.info(
          { callerId: decision.callerId, lineCount: preSynthesized.lines.length, awaitMs },
          "Using pre-synthesized intro",
        );
      } else {
        services.log.info({ callerId: decision.callerId, awaitMs }, "No pre-synthesized intro available");
      }
    } catch (err) {
      services.log.warn({ err, callerId: decision.callerId, awaitMs: Date.now() - t0 }, "Pre-synthesized intro failed; will generate on-the-fly");
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

    try {
      // ── Step 1: Host intro ──
      const introStartMs = Date.now();
      if (prepared.introLines && prepared.introAudio && prepared.introAudio.length === prepared.introLines.length) {
        log.info(
          { callerId: call.callerId, lineCount: prepared.introLines.length, source: "pre-synthesized" },
          "PERF call:intro-playback:start",
        );
        for (let idx = 0; idx < prepared.introLines.length; idx++) {
          if (call.disconnected) break;
          const line = prepared.introLines[idx];
          const mp3 = prepared.introAudio[idx];
          await pipeline.pushMp3(mp3);
          this.deps.sendCallerAudio(call.callerId, mp3);
          emitTranscriptLine(line);
          const audioDurationMs = pipeline.computeAudioDurationMs(mp3);
          await sleep(audioDurationMs);
        }
        log.info(
          { callerId: call.callerId, playbackMs: Date.now() - introStartMs, source: "pre-synthesized" },
          "PERF call:intro-playback:end",
        );
      } else {
        log.info({ callerId: call.callerId, source: "on-the-fly" }, "PERF call:intro-llm:start");
        const genStartMs = Date.now();
        const intro = await this.deps.scriptGenerator.generateGuestIntro(
          call.callerName,
          call.topicHint,
          this.deps.hosts,
        );
        const llmMs = Date.now() - genStartMs;
        log.info({ callerId: call.callerId, llmMs, lineCount: intro.lines.length }, "PERF call:intro-llm:end");

        log.info({ callerId: call.callerId, lineCount: intro.lines.length, source: "on-the-fly" }, "PERF call:intro-playback:start");
        for (let idx = 0; idx < intro.lines.length; idx++) {
          if (call.disconnected) break;
          const line = intro.lines[idx];
          const ttsLineT0 = Date.now();
          const mp3 = await pipeline.synthesizeAndPush(line);
          log.info(
            { callerId: call.callerId, lineIndex: idx, ttsLineMs: Date.now() - ttsLineT0, textLen: line.text.length },
            "PERF call:intro-tts:line",
          );
          this.deps.sendCallerAudio(call.callerId, mp3);
          emitTranscriptLine(line);
          const audioDurationMs = pipeline.computeAudioDurationMs(mp3);
          await sleep(audioDurationMs);
        }
        log.info(
          { callerId: call.callerId, totalIntroMs: Date.now() - introStartMs, source: "on-the-fly" },
          "PERF call:intro-playback:end",
        );
      }

      if (call.disconnected) {
        log.info({ callerId: call.callerId }, "Caller disconnected during intro");
        await this.airIssueLines(call, "lost_caller", pipeline, sleep, emitTranscriptLine);
        return { interrupted: false, kind: "call" };
      }

      // ── Step 2: Open STT stream ──
      const sttOpenT0 = Date.now();
      log.info({ callerId: call.callerId }, "PERF call:stt-open:start");
      try {
        await call.sttService.startStream();
        log.info({ callerId: call.callerId, sttOpenMs: Date.now() - sttOpenT0 }, "PERF call:stt-open:end");
      } catch (err) {
        log.error({ err, callerId: call.callerId, sttOpenMs: Date.now() - sttOpenT0 }, "PERF call:stt-open:failed");
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
        const turnStartMs = Date.now();
        log.info(
          { callerId: call.callerId, turn: call.aiTurnCount, callElapsedMs: Date.now() - callStartTime },
          "PERF call:turn:start",
        );

        // Re-open STT if it died during the host response
        try {
          await call.sttService.ensureStream();
        } catch (err) {
          log.warn({ err, callerId: call.callerId, turn: call.aiTurnCount }, "STT reconnect failed at turn start");
        }

        this.deps.resetTurnAudioTracking();
        this.deps.postCallerStatus(call.callerId, "speak");
        const speakNotifiedMs = Date.now();
        log.info(
          { callerId: call.callerId, turn: call.aiTurnCount },
          "PERF call:caller-speak-notified",
        );

        call.callerTurnActive = true;
        call.accumulatedTranscript = [];

        const utteranceWaitT0 = Date.now();
        const gotUtterance = await this.deps.waitForUtterance(30_000);
        call.callerTurnActive = false;
        const utteranceWaitMs = Date.now() - utteranceWaitT0;

        if (call.disconnected) {
          log.info({ callerId: call.callerId, turn: call.aiTurnCount, utteranceWaitMs }, "Caller disconnected during turn");
          break;
        }

        const callerText = call.accumulatedTranscript.join(" ").trim();
        log.info(
          {
            callerId: call.callerId,
            turn: call.aiTurnCount,
            gotUtterance,
            utteranceWaitMs,
            callerTextLen: callerText.length,
            callerText: callerText.slice(0, 200),
            transcriptSegments: call.accumulatedTranscript.length,
            speakToUtteranceMs: Date.now() - speakNotifiedMs,
          },
          "PERF call:utterance-result",
        );

        if (!gotUtterance && !callerText) {
          consecutiveEmptyTurns++;

          if (consecutiveEmptyTurns >= 2) {
            log.info(
              { callerId: call.callerId, consecutiveEmptyTurns },
              "Two consecutive empty turns, ending call",
            );
            await this.airIssueLines(call, "lost_caller", pipeline, sleep, emitTranscriptLine);
            break;
          }

          log.info({ callerId: call.callerId, consecutiveEmptyTurns }, "Empty turn — recovering STT");
          try {
            await call.sttService.ensureStream();
          } catch (err) {
            log.warn({ err, callerId: call.callerId }, "STT reconnect failed during call");
          }
          await this.airIssueLines(call, "no_audio", pipeline, sleep, emitTranscriptLine);
          continue;
        }

        consecutiveEmptyTurns = 0;

        if (!callerText) {
          log.info({ callerId: call.callerId, turn: call.aiTurnCount }, "Utterance received but no text — pushing silence");
          await pipeline.pushSilence(500);
          continue;
        }

        this.deps.postCallerStatus(call.callerId, "listening");

        // ── Host response: LLM generation ──
        const responseLlmT0 = Date.now();
        log.info(
          { callerId: call.callerId, turn: call.aiTurnCount, callerTextLen: callerText.length },
          "PERF call:response-llm:start",
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
        const responseLlmMs = Date.now() - responseLlmT0;
        log.info(
          { callerId: call.callerId, turn: call.aiTurnCount, responseLlmMs, lineCount: responseLines.length },
          "PERF call:response-llm:end",
        );

        // ── Host response: TTS + playback ──
        const responseTtsT0 = Date.now();
        log.info(
          { callerId: call.callerId, turn: call.aiTurnCount, lineCount: responseLines.length },
          "PERF call:response-tts:start",
        );
        for (let idx = 0; idx < responseLines.length; idx++) {
          if (call.disconnected) break;
          const line = responseLines[idx];
          const ttsLineT0 = Date.now();
          const mp3 = await pipeline.synthesizeAndPush(line);
          log.info(
            { callerId: call.callerId, turn: call.aiTurnCount, lineIndex: idx, ttsLineMs: Date.now() - ttsLineT0, textLen: line.text.length },
            "PERF call:response-tts:line",
          );
          this.deps.sendCallerAudio(call.callerId, mp3);
          emitTranscriptLine(line);
          const audioDurationMs = pipeline.computeAudioDurationMs(mp3);
          await sleep(audioDurationMs);
        }
        const responseTtsMs = Date.now() - responseTtsT0;
        const turnTotalMs = Date.now() - turnStartMs;
        log.info(
          { callerId: call.callerId, turn: call.aiTurnCount, responseTtsMs, turnTotalMs },
          "PERF call:response-tts:end",
        );

        log.info(
          {
            callerId: call.callerId,
            turn: call.aiTurnCount,
            turnTotalMs,
            utteranceWaitMs,
            responseLlmMs,
            responseTtsMs,
          },
          "PERF call:turn:end",
        );

        call.aiTurnCount++;
      }

      const callTotalMs = Date.now() - callStartTime;
      log.info(
        { callerId: call.callerId, aiTurns: call.aiTurnCount, callTotalMs },
        "PERF call:end",
      );
    } catch (err) {
      log.error({ err, callerId: call.callerId, callElapsedMs: Date.now() - callStartTime }, "Error during call conversation");
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
