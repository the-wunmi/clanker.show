import pino from "pino";

import type {
  ScriptGenerator,
  CallerCandidate,
  NextSegmentDecisionContext,
  CallOpportunityContext,
} from "../services/ScriptGenerator";
import type { ProgramPlanner } from "../services/ProgramPlanner";
import type { PulseEvent } from "../services/ContentPipeline";
import type { RuntimeWatchdogAgent } from "./RuntimeWatchdogAgent";
import type { SegmentDecision } from "./activities/SegmentActivity";
import type { CallDecision } from "./activities/CallActivity";
import type { AdDecision } from "./activities/AdActivity";


export type DirectorDecision = SegmentDecision | CallDecision | AdDecision;


export interface DirectorContext {
  // Program state
  hasProgramSegment: boolean;
  hasQueuedTopic: boolean;
  queuedTopicCount: number;
  isFirstSegment: boolean;
  segmentPercent: number;
  programPercent: number;
  currentSegmentNumber?: number;
  totalSegments?: number;

  // Call state
  pendingCallerAcceptId: string | null;
  activeCallerId: string | null;
  pendingCallerName: string | null;
  pendingCallerTopicHint: string | null;

  // General
  currentTopic: string | null;
  segmentsSinceLastAd: number;

  // Resumable segment from DB
  hasResumableSegment: boolean;
}


export interface DirectorDeps {
  scriptGenerator: ScriptGenerator;
  programPlanner: ProgramPlanner;
  watchdog: RuntimeWatchdogAgent;
  checkCallQueue: () => Promise<CallerCandidate[]>;
  getPendingCallerAccept: () => { callerId: string; callerName: string; topicHint: string; acceptedAtMs: number } | null;
  getActiveCallerId: () => string | null;
}

export class Director {
  private readonly log = pino({ name: "Director" });
  private segmentsSinceLastAd = 0;
  private planningProgramPromise: Promise<void> | null = null;

  constructor(private readonly deps: DirectorDeps) {}

  /**
   * Main decision function. Returns what to do next.
   * Pure decision — never mutates state directly.
   */
  async decide(ctx: DirectorContext): Promise<DirectorDecision> {
    this.log.info(
      {
        hasProgramSegment: ctx.hasProgramSegment,
        hasQueuedTopic: ctx.hasQueuedTopic,
        queuedTopicCount: ctx.queuedTopicCount,
        pendingCaller: ctx.pendingCallerAcceptId,
        activeCaller: ctx.activeCallerId,
        segmentsSinceLastAd: ctx.segmentsSinceLastAd,
      },
      "Director deciding next action",
    );

    // Priority 1: If a caller is connected and pending, enter call
    if (ctx.pendingCallerAcceptId && ctx.activeCallerId && ctx.pendingCallerAcceptId === ctx.activeCallerId) {
      this.log.info({ callerId: ctx.activeCallerId }, "Director: entering call");
      this.segmentsSinceLastAd++;
      return {
        kind: "call",
        callerId: ctx.activeCallerId,
        callerName: ctx.pendingCallerName ?? "Anonymous",
        topicHint: ctx.pendingCallerTopicHint ?? "",
      };
    }

    // Priority 2: Decide segment source (program/queue/filler)
    const source = await this.selectSegmentSource(ctx);
    this.segmentsSinceLastAd++;

    return { kind: "segment", source };
  }

  /**
   * Evaluate whether to take a call at a checkpoint during airing.
   */
  async evaluateCallOpportunity(args: {
    segmentKind: "filler" | "program" | "queue";
    segmentProgress: number;
    programProgress: number;
    currentTopic: string;
    spaceDescription: string;
  }): Promise<{ selectedCaller: CallerCandidate | null; reason: string }> {
    const callers = await this.deps.checkCallQueue();
    if (callers.length === 0) {
      return { selectedCaller: null, reason: "No callers waiting" };
    }

    const callCtx: CallOpportunityContext = {
      callerCount: callers.length,
      callerTopics: callers.map((c) => c.topicHint).filter(Boolean),
      currentTopic: args.currentTopic,
      segmentKind: args.segmentKind,
      segmentProgress: Math.round(args.segmentProgress * 100),
      programProgress: Math.round(args.programProgress * 100),
    };

    // Quick guard: too early in a non-filler segment
    if (callCtx.segmentProgress < 20 && args.segmentKind !== "filler") {
      return { selectedCaller: null, reason: "Too early in segment" };
    }

    const decision = await this.deps.scriptGenerator.shouldTakeCall(callCtx);
    if (!decision.takeCall) {
      return { selectedCaller: null, reason: decision.reason };
    }

    if (callers.length === 1) {
      return { selectedCaller: callers[0], reason: "Single caller available" };
    }

    const selection = await this.deps.scriptGenerator.selectBestCaller(callers, {
      currentTopic: args.currentTopic,
      spaceDescription: args.spaceDescription,
    });
    const selected = callers.find((c) => c.id === selection.callerId) ?? callers[0];
    return { selectedCaller: selected, reason: selection.reason };
  }

  /**
   * Boundary transition logic: evaluate call opportunity at boundary, handle pending callers.
   */
  async handleBoundary(args: {
    topic: string;
    segmentKind: "filler" | "program" | "queue";
    pendingCallerAccept: { callerId: string; callerName: string; topicHint: string; acceptedAtMs: number } | null;
    activeCallerId: string | null;
    callConnectGraceMs: number;
    callAcceptTtlMs: number;
    evaluateCallOpportunityAtBoundary: () => Promise<void>;
    waitForAcceptedCallerConnection: (timeoutMs: number) => Promise<boolean>;
    expirePendingCallerAccept: (reason: string) => Promise<void>;
  }): Promise<{ action: "continue" | "enter_call" }> {
    const { pendingCallerAccept, activeCallerId } = args;

    // No pending or active calls — evaluate new opportunity
    if (!pendingCallerAccept && !activeCallerId) {
      await args.evaluateCallOpportunityAtBoundary();
      return { action: "continue" };
    }

    const getAgeMs = () => (pendingCallerAccept ? Date.now() - pendingCallerAccept.acceptedAtMs : 0);

    // Pending caller but not yet connected
    if (pendingCallerAccept && !activeCallerId) {
      if (getAgeMs() >= args.callAcceptTtlMs) {
        await args.expirePendingCallerAccept("accepted_ttl_exceeded_before_connect");
        return { action: "continue" };
      }

      const remainingTtlMs = Math.max(0, args.callAcceptTtlMs - getAgeMs());
      const graceMs = Math.min(args.callConnectGraceMs, remainingTtlMs);
      if (graceMs > 0) {
        this.log.info(
          { callerId: pendingCallerAccept.callerId, graceMs, remainingTtlMs },
          "Waiting briefly for accepted caller to connect",
        );
        await args.waitForAcceptedCallerConnection(graceMs);
      }

      // Check again after wait
      if (!args.activeCallerId) {
        if (getAgeMs() >= args.callAcceptTtlMs) {
          await args.expirePendingCallerAccept("accepted_ttl_exceeded_after_grace");
        } else {
          this.log.warn(
            { callerId: pendingCallerAccept.callerId, acceptedForMs: getAgeMs() },
            "Accepted caller still not connected; continuing broadcast",
          );
        }
        return { action: "continue" };
      }
    }

    // Both pending and active — check match
    if (pendingCallerAccept && activeCallerId) {
      if (pendingCallerAccept.callerId !== activeCallerId) {
        this.log.warn(
          { pendingCallerId: pendingCallerAccept.callerId, activeCallerId },
          "Pending/active caller mismatch; skipping call segment",
        );
        return { action: "continue" };
      }

      this.log.info({ callerId: activeCallerId }, "Entering live call segment");
      return { action: "enter_call" };
    }

    return { action: "continue" };
  }

  /**
   * Ensure program planning is in progress.
   */
  ensureProgramPlanning(
    planner: ProgramPlanner | null,
    setPromise: (p: Promise<void> | null) => void,
  ): void {
    if (!planner) return;
    if (this.planningProgramPromise || planner.getActiveProgram()) return;

    const next = (async () => {
      const program = await planner.planNextProgram();
      if (program.segments.length > 0) {
        this.log.info(
          { programId: program.id, segments: program.segments.length },
          "Program planned by Director",
        );
      }
    })()
      .catch((err) => {
        this.log.error({ err }, "Director program planning failed");
      })
      .finally(() => {
        this.planningProgramPromise = null;
        setPromise(null);
      });

    this.planningProgramPromise = next;
    setPromise(next);
  }

  /**
   * Handle content pulse from ContentPipeline.
   */
  async handlePulse(
    planner: ProgramPlanner | null,
    pulse: PulseEvent,
    onFastTrackApproved: (pulse: PulseEvent) => void,
  ): Promise<void> {
    if (!planner) return;
    if (pulse.urgency === "breaking") {
      const result = await planner.fastTrackTopic(pulse);
      if (result.approved) {
        onFastTrackApproved(pulse);
      } else {
        this.log.info({ topic: pulse.topic }, "Breaking topic rejected by quick gate");
      }
      return;
    }
    planner.bufferTopic(pulse);
  }

  shouldPrefetchNext(args: {
    segmentProgress: number;
    hasInFlightNext: boolean;
  }): boolean {
    if (args.hasInFlightNext) return false;
    return args.segmentProgress >= this.deps.watchdog.getPrefetchThreshold();
  }

  getSegmentsSinceLastAd(): number {
    return this.segmentsSinceLastAd;
  }

  resetAdCounter(): void {
    this.segmentsSinceLastAd = 0;
  }

  private async selectSegmentSource(
    ctx: DirectorContext,
  ): Promise<"program" | "queue" | "filler" | "startup"> {
    // If it's the first segment and no program exists yet, do startup
    if (ctx.isFirstSegment) {
      return "startup";
    }

    // If resumable segment exists, treat as program continuation
    if (ctx.hasResumableSegment) {
      return "program";
    }

    // If neither available, filler
    if (!ctx.hasProgramSegment && !ctx.hasQueuedTopic) {
      return "filler";
    }

    // If only one available, pick that
    if (ctx.hasProgramSegment && !ctx.hasQueuedTopic) {
      return "program";
    }
    if (!ctx.hasProgramSegment && ctx.hasQueuedTopic) {
      return "queue";
    }

    // Both available — ask the AI
    try {
      const decision = await this.deps.scriptGenerator.decideNextSegment({
        hasProgramSegment: ctx.hasProgramSegment,
        hasQueuedTopic: ctx.hasQueuedTopic,
        queuedTopicCount: ctx.queuedTopicCount,
        isFirstSegment: ctx.isFirstSegment,
        segmentPercent: ctx.segmentPercent,
        programPercent: ctx.programPercent,
        currentSegmentNumber: ctx.currentSegmentNumber,
        totalSegments: ctx.totalSegments,
      });

      if (decision.source === "program" || decision.source === "queue" || decision.source === "filler") {
        this.log.info(
          { source: decision.source, reason: decision.reason },
          "AI segment source decision",
        );
        return decision.source;
      }
    } catch (err) {
      this.log.warn({ err }, "AI segment decision failed; using fallback");
    }

    return "program";
  }
}
