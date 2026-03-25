import type { NextSegmentSource } from "./agentTypes";

export class SegmentExecutorAgent<TPrepared> {
  async prepareNextSegment(args: {
    nextSource: NextSegmentSource;
    prepareProgramSegment: () => Promise<TPrepared | null>;
    prepareQueuedSegment: () => Promise<TPrepared | null>;
    prepareStartupSegment: () => Promise<TPrepared | null>;
    prepareFillerSegment: () => Promise<TPrepared>;
  }): Promise<TPrepared | null> {
    if (args.nextSource === "program") {
      const prepared = await args.prepareProgramSegment();
      if (prepared) return prepared;
    }

    if (args.nextSource === "queue") {
      const prepared = await args.prepareQueuedSegment();
      if (prepared) return prepared;
    }

    const startup = await args.prepareStartupSegment();
    if (startup) return startup;

    return args.prepareFillerSegment();
  }
}
