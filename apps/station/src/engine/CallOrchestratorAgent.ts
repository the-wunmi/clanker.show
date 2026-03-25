import type { ScriptGenerator, CallerCandidate } from "../services/ScriptGenerator";
import type { DecisionRouter } from "./DecisionRouter";

export class CallOrchestratorAgent {
  computeCallCheckPoints(lineCount: number): number[] {
    if (lineCount <= 16) {
      return [Math.floor(lineCount * 0.5)];
    }
    if (lineCount <= 40) {
      return [Math.floor(lineCount * 0.33), Math.floor(lineCount * 0.66)];
    }
    return [
      Math.floor(lineCount * 0.25),
      Math.floor(lineCount * 0.5),
      Math.floor(lineCount * 0.75),
    ];
  }

  async evaluateOpportunity(args: {
    router: DecisionRouter;
    scriptGenerator: ScriptGenerator;
    callers: CallerCandidate[];
    currentTopic: string;
    segmentKind: "filler" | "program" | "queue";
    segmentProgress: number;
    programProgress: number;
    stationDescription: string;
  }): Promise<{ selectedCaller: CallerCandidate | null; reason: string }> {
    if (args.callers.length === 0) {
      return { selectedCaller: null, reason: "No callers waiting" };
    }

    const decision = await args.router.shouldTakeCall({
      callerCount: args.callers.length,
      callerTopics: args.callers.map((c) => c.topicHint).filter(Boolean),
      currentTopic: args.currentTopic,
      segmentKind: args.segmentKind,
      segmentProgress: Math.round(args.segmentProgress * 100),
      programProgress: Math.round(args.programProgress * 100),
    });

    if (!decision.takeCall) {
      return { selectedCaller: null, reason: decision.reason };
    }

    if (args.callers.length === 1) {
      return { selectedCaller: args.callers[0], reason: "Single caller available" };
    }

    const selection = await args.scriptGenerator.selectBestCaller(args.callers, {
      currentTopic: args.currentTopic,
      stationDescription: args.stationDescription,
    });
    const selected = args.callers.find((c) => c.id === selection.callerId) ?? args.callers[0];
    return { selectedCaller: selected, reason: selection.reason };
  }
}
