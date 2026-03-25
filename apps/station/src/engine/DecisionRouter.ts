import type {
  ScriptGenerator,
  NextSegmentDecisionContext,
  CallOpportunityContext,
} from "../services/ScriptGenerator";
import type { NextSegmentSource } from "./agentTypes";

export class DecisionRouter {
  constructor(
    private readonly scriptGenerator: ScriptGenerator,
  ) {}

  async selectNextSegmentSource(
    context: NextSegmentDecisionContext,
  ): Promise<{ source: NextSegmentSource; reason: string }> {
    if (!context.hasProgramSegment && !context.hasQueuedTopic) {
      return { source: "filler", reason: "No queued or planned segment available" };
    }
    if (context.hasProgramSegment && !context.hasQueuedTopic) {
      return { source: "program", reason: "Only program segment available" };
    }
    if (!context.hasProgramSegment && context.hasQueuedTopic) {
      return { source: "queue", reason: "Only queued topic available" };
    }

    const decision = await this.scriptGenerator.decideNextSegment(context);
    if (decision.source === "program" || decision.source === "queue" || decision.source === "filler") {
      return decision;
    }
    return { source: "program", reason: "Fallback route" };
  }

  async shouldTakeCall(ctx: CallOpportunityContext): Promise<{ takeCall: boolean; reason: string }> {
    if (ctx.callerCount <= 0) return { takeCall: false, reason: "No callers waiting" };
    if (ctx.segmentProgress < 20 && ctx.segmentKind !== "filler") {
      return { takeCall: false, reason: "Too early in segment" };
    }
    return this.scriptGenerator.shouldTakeCall(ctx);
  }
}
