import pino from "pino";
import type { ProgramPlanner } from "../services/ProgramPlanner";
import type { PulseEvent } from "../services/ContentPipeline";

export class ProgramPlannerAgent {
  private readonly log = pino({ name: "ProgramPlannerAgent" });

  ensureProgramPlanning(
    planner: ProgramPlanner | null,
    currentPromise: Promise<void> | null,
    setPromise: (p: Promise<void> | null) => void,
  ): void {
    if (!planner) return;
    if (currentPromise || planner.getActiveProgram()) return;

    const next = (async () => {
      const program = await planner.planNextProgram();
      if (program.segments.length > 0) {
        this.log.info(
          { programId: program.id, segments: program.segments.length },
          "Program planned by ProgramPlannerAgent",
        );
      }
    })()
      .catch((err) => {
        this.log.error({ err }, "ProgramPlannerAgent planning failed");
      })
      .finally(() => setPromise(null));

    setPromise(next);
  }

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
}
