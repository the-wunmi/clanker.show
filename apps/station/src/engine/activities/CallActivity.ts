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
      // Guest intro
      const intro = await this.deps.scriptGenerator.generateGuestIntro(
        call.callerName,
        call.topicHint,
        this.deps.hosts,
      );

      for (const line of intro.lines) {
        if (call.disconnected) break;
        const mp3 = await pipeline.synthesizeAndPush(line);
        emitTranscriptLine(line);
        const audioDurationMs = pipeline.computeAudioDurationMs(mp3);
        await sleep(audioDurationMs);
      }

      // Back-and-forth loop
      while (
        call.aiTurnCount < CallActivity.MAX_TURNS &&
        Date.now() - callStartTime < CallActivity.MAX_DURATION_MS &&
        !call.disconnected
      ) {
        this.deps.postCallerStatus(call.callerId, "speak");
        call.callerTurnActive = true;
        call.accumulatedTranscript = [];

        const gotUtterance = await this.deps.waitForUtterance(30_000);
        call.callerTurnActive = false;

        if (call.disconnected) break;

        if (!gotUtterance && call.accumulatedTranscript.length === 0) {
          await pipeline.pushSilence(1000);
          continue;
        }

        this.deps.postCallerStatus(call.callerId, "listening");

        const callerText = call.accumulatedTranscript.join(" ");
        if (!callerText.trim()) {
          await pipeline.pushSilence(500);
          continue;
        }

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

        for (const line of responseLines) {
          if (call.disconnected) break;
          const mp3 = await pipeline.synthesizeAndPush(line);
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
}
