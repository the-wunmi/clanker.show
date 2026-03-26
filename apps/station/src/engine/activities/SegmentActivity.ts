import type pino from "pino";

import type { ScriptLine } from "../../services/ScriptGenerator";
import type { ScriptGenerator } from "../../services/ScriptGenerator";
import type { ProgramPlanner } from "../../services/ProgramPlanner";
import type { PulseEvent } from "../../services/ContentPipeline";
import type { FactCheckService } from "../../services/FactCheckService";
import type {
  Activity,
  ActivityServices,
  PreparedActivity,
  ActivityRunResult,
} from "../Activity";
import type { WorkerArchiveBridge } from "../WorkerArchiveBridge";
import { Segment, TranscriptLine } from "../../db/index";
import type { AudioPipeline } from "../AudioPipeline";


function reviewScript(lines: ScriptLine[], kind: "filler" | "topic"): ScriptLine[] {
  const cleaned = lines
    .map((line) => ({ ...line, text: line.text.trim() }))
    .filter((line) => line.host === "__CHECKPOINT__" || (line.host && line.text.length > 0));

  if (cleaned.length > 0) return cleaned;

  return [
    {
      host: "Host",
      emotion: kind === "filler" ? "neutral" : "serious",
      text: kind === "filler"
        ? "Let us reset and jump back in with a fresh topic."
        : "We are gathering the details and will continue shortly.",
    },
  ];
}


export interface SegmentDecision {
  kind: "segment";
  source: "program" | "queue" | "filler" | "startup";
}

export interface PreparedSegment extends PreparedActivity {
  kind: "segment";
  segmentId: string;
  topic: string;
  sourceUrl?: string;
  programId?: string;
  segmentKind: "filler" | "program" | "queue";
  scriptLines: ScriptLine[];
  lineRowIds: string[];
  checkpointPositions: number[];
  firstTts: Promise<Buffer> | null;
}


export interface SegmentActivityDeps {
  stationId: string;
  scriptGenerator: ScriptGenerator;
  programPlanner: ProgramPlanner;
  factCheckService: FactCheckService | null;
  archiveBridge: WorkerArchiveBridge;
  hosts: Array<{ name: string; personality: string; voiceId?: string }>;
  stationContext: { stationName: string; description?: string; previousTopics?: string[] };
  topicQueue: PulseEvent[];
  recentTopics: string[];
  recentPulses: PulseEvent[];
  firstSegmentGenerated: boolean;
  setFirstSegmentGenerated: (v: boolean) => void;
  hasPushedFirstAudio: boolean;
  setHasPushedFirstAudio: (v: boolean) => void;
  pendingFactChecks: string[];
  planningProgramPromise: Promise<void> | null;
  ensureProgramPlanning: () => void;
  resolveTargetSegmentMinutes: (fastStart?: boolean) => number;
  buildGenerationProgressContext: () => {
    segmentPercent?: number;
    programPercent?: number;
    currentSegmentNumber?: number;
    totalSegments?: number;
  };
  createContextualFillerPulse: (topicFallback: string) => PulseEvent;
  // Segment airing callbacks
  onSegmentProgress: (segmentProgress: number) => void;
  onStageOnePrefetch: () => void;
  onApproachingCheckpoint: (segmentProgress: number) => void;
  onCheckpoint: (segmentProgress: number) => Promise<{ lines: ScriptLine[]; audio: Buffer[] } | null>;
  shouldPrefetchNext: (segmentProgress: number) => boolean;
  triggerPrefetch: (segmentProgress: number) => void;
}

export class SegmentActivity implements Activity<SegmentDecision, PreparedSegment> {
  kind = "segment" as const;

  constructor(private readonly deps: SegmentActivityDeps) {}

  async prepare(decision: SegmentDecision, services: ActivityServices): Promise<PreparedSegment> {
    const { source } = decision;
    const { log, pipeline } = services;

    log.info({ source }, "Preparing segment");

    if (source === "program") {
      const result = await this.prepareProgramSegment(log, pipeline);
      if (result) return result;
    }

    if (source === "queue") {
      const result = await this.prepareQueuedSegment(log, pipeline);
      if (result) return result;
    }

    if (source === "startup" || !this.deps.firstSegmentGenerated) {
      const result = await this.prepareStartupSegment(log, pipeline);
      if (result) return result;
    }

    return this.prepareFillerSegment(log, pipeline);
  }

  async run(prepared: PreparedSegment, services: ActivityServices): Promise<ActivityRunResult> {
    const { log, pipeline, shouldInterrupt, sleep, emitTranscriptLine, onAudioChunkPushed } = services;

    log.info(
      { topic: prepared.topic, segmentId: prepared.segmentId, lineCount: prepared.scriptLines.length },
      "Airing segment",
    );

    this.deps.archiveBridge.beginSegment({
      segmentId: prepared.segmentId,
      topic: prepared.topic,
      sourceUrl: prepared.sourceUrl,
      programId: prepared.programId,
    });

    const result = await pipeline.streamSegment({
      scriptLines: prepared.scriptLines,
      initialTts: prepared.firstTts,
      shouldInterrupt,
      sleep,
      onBatchHost: () => {},
      onAudioChunkPushed: (chunk) => {
        onAudioChunkPushed(chunk);
        if (!this.deps.hasPushedFirstAudio) {
          this.deps.setHasPushedFirstAudio(true);
          this.flushDeferredFactChecks();
        }
      },
      onSegmentProgress: this.deps.onSegmentProgress,
      onStageOnePrefetch: this.deps.onStageOnePrefetch,
      checkpointPositions: prepared.checkpointPositions,
      onApproachingCheckpoint: this.deps.onApproachingCheckpoint,
      onCheckpoint: this.deps.onCheckpoint,
      shouldPrefetchNext: this.deps.shouldPrefetchNext,
      triggerPrefetch: this.deps.triggerPrefetch,
      onLineSpoken: (lineIndex, line) => {
        emitTranscriptLine(line);
        if (lineIndex >= 0 && lineIndex < prepared.lineRowIds.length) {
          TranscriptLine.update(prepared.lineRowIds[lineIndex], { spokenAt: new Date() }).catch(
            (err) => log.error({ err, lineId: prepared.lineRowIds[lineIndex] }, "Failed to mark line as spoken"),
          );
        }
      },
    });

    pipeline.broadcasting = false;

    if (!result.interrupted) {
      this.deps.archiveBridge.completeActiveSegment();
    }

    return { interrupted: result.interrupted, kind: "segment" };
  }

  async loadResumable(pipeline: AudioPipeline): Promise<PreparedSegment | null> {
    const latest = (
      await Segment.findMany({
        where: { stationId: this.deps.stationId },
        take: 1,
        orderBy: { createdAt: "desc" },
      })
    )[0];
    if (!latest) return null;

    const lines = await TranscriptLine.findMany({
      where: { segmentId: latest.id },
      orderBy: { lineIndex: "asc" },
    });
    if (lines.length === 0) return null;

    const resumeFrom = lines.findIndex((line) => !line.spokenAt);
    if (resumeFrom === -1) return null;

    const remaining = lines.slice(resumeFrom);
    const scriptLines: ScriptLine[] = remaining.map((line) => ({
      host: line.host,
      text: line.text,
      emotion: (line.emotion as ScriptLine["emotion"]) ?? "neutral",
    }));
    const lineRowIds = remaining.map((line) => line.id);

    this.deps.setFirstSegmentGenerated(true);

    return {
      kind: "segment",
      topic: latest.topic ?? "resumed",
      sourceUrl: latest.sourceUrl ?? undefined,
      programId: latest.programId ?? undefined,
      segmentKind: latest.programId ? "program" : "filler",
      scriptLines,
      segmentId: latest.id,
      lineRowIds,
      checkpointPositions: [],
      firstTts: scriptLines.length > 0 ? pipeline.batchTTS(scriptLines, 0) : null,
    };
  }

  private async prepareProgramSegment(
    log: pino.Logger,
    pipeline: AudioPipeline,
  ): Promise<PreparedSegment | null> {
    const programSegment = this.deps.programPlanner.getNextSegment();
    if (!programSegment) return null;

    const pulse: PulseEvent = {
      topic: programSegment.topic,
      summary: programSegment.angle,
      urgency: "interesting",
      sourceUrl: "",
      rawContent: programSegment.angle,
    };
    const script = await this.deps.scriptGenerator.generate(
      pulse,
      this.deps.hosts,
      this.deps.stationContext,
      {
        fastStart: !this.deps.firstSegmentGenerated,
        targetDurationMin: Math.max(
          2,
          programSegment.estimatedMinutes || this.deps.resolveTargetSegmentMinutes(),
        ),
        progress: this.deps.buildGenerationProgressContext(),
      },
    );
    const reviewedLines = reviewScript(script.lines, "topic");
    const programId = this.deps.programPlanner.getActiveProgram()?.id ?? null;
    const prepared = await this.savePreparedSegment({
      log,
      pipeline,
      topic: programSegment.topic,
      sourceUrl: null,
      programId,
      kind: "program",
      scriptLines: reviewedLines,
    });
    await this.deps.programPlanner.advanceSegment();
    return prepared;
  }

  private async prepareQueuedSegment(
    log: pino.Logger,
    pipeline: AudioPipeline,
  ): Promise<PreparedSegment | null> {
    if (this.deps.topicQueue.length === 0) return null;
    const pulse = this.deps.topicQueue.shift()!;
    const script = await this.deps.scriptGenerator.generate(
      pulse,
      this.deps.hosts,
      this.deps.stationContext,
      {
        fastStart: !this.deps.firstSegmentGenerated,
        targetDurationMin: this.deps.resolveTargetSegmentMinutes(!this.deps.firstSegmentGenerated),
        progress: this.deps.buildGenerationProgressContext(),
      },
    );
    const reviewedLines = reviewScript(script.lines, "topic");
    const programId = this.deps.programPlanner.getActiveProgram()?.id ?? null;
    return this.savePreparedSegment({
      log,
      pipeline,
      topic: pulse.topic,
      sourceUrl: pulse.sourceUrl || null,
      programId,
      kind: "queue",
      scriptLines: reviewedLines,
    });
  }

  private async prepareStartupSegment(
    log: pino.Logger,
    pipeline: AudioPipeline,
  ): Promise<PreparedSegment | null> {
    if (this.deps.programPlanner.getActiveProgram()) return null;

    this.deps.ensureProgramPlanning();

    if (!this.deps.firstSegmentGenerated) {
      const quickScript = await this.deps.scriptGenerator.generate(
        this.deps.createContextualFillerPulse("startup"),
        this.deps.hosts,
        this.deps.stationContext,
        {
          fastStart: true,
          kind: "filler",
          targetDurationMin: this.deps.resolveTargetSegmentMinutes(true),
          recentTopics: this.deps.recentTopics,
          progress: this.deps.buildGenerationProgressContext(),
        },
      );
      const reviewedLines = reviewScript(quickScript.lines, "filler");
      return this.savePreparedSegment({
        log,
        pipeline,
        topic: "startup",
        programId: null,
        kind: "filler",
        scriptLines: reviewedLines,
      });
    }

    if (this.deps.planningProgramPromise) {
      await this.deps.planningProgramPromise;
      if (this.deps.programPlanner.getActiveProgram()) {
        return this.prepareProgramSegment(log, pipeline);
      }
    }

    return null;
  }

  private async prepareFillerSegment(
    log: pino.Logger,
    pipeline: AudioPipeline,
  ): Promise<PreparedSegment> {
    const filler = await this.deps.scriptGenerator.generate(
      this.deps.createContextualFillerPulse("filler"),
      this.deps.hosts,
      this.deps.stationContext,
      {
        fastStart: !this.deps.firstSegmentGenerated,
        kind: "filler",
        targetDurationMin: this.deps.resolveTargetSegmentMinutes(!this.deps.firstSegmentGenerated),
        recentTopics: this.deps.recentTopics,
        progress: this.deps.buildGenerationProgressContext(),
      },
    );
    const reviewedLines = reviewScript(filler.lines, "filler");
    const programId = this.deps.programPlanner.getActiveProgram()?.id ?? null;
    return this.savePreparedSegment({
      log,
      pipeline,
      topic: "filler",
      programId,
      kind: "filler",
      scriptLines: reviewedLines,
    });
  }

  private async savePreparedSegment(args: {
    log: pino.Logger;
    pipeline: AudioPipeline;
    topic: string;
    sourceUrl?: string | null;
    programId?: string | null;
    kind: "filler" | "program" | "queue";
    scriptLines: ScriptLine[];
  }): Promise<PreparedSegment> {
    // Separate checkpoint markers from content lines
    const contentLines: ScriptLine[] = [];
    const checkpointPositions: number[] = [];
    for (const line of args.scriptLines) {
      if (line.host === "__CHECKPOINT__") {
        checkpointPositions.push(contentLines.length);
      } else {
        contentLines.push(line);
      }
    }

    args.log.info(
      { topic: args.topic, contentLines: contentLines.length, checkpoints: checkpointPositions.length },
      "Extracted AI checkpoints from script",
    );

    const segmentRow = await Segment.create({
      stationId: this.deps.stationId,
      programId: args.programId ?? null,
      topic: args.topic,
      durationMs: 0,
      ...(args.sourceUrl !== undefined && args.sourceUrl !== null
        ? { sourceUrl: args.sourceUrl }
        : {}),
    });

    const lineRows = await TranscriptLine.bulkCreate(segmentRow.id, contentLines);
    this.scheduleFactCheck(segmentRow.id);
    this.deps.setFirstSegmentGenerated(true);

    args.log.info(
      { segmentId: segmentRow.id, topic: args.topic, lines: contentLines.length, checkpoints: checkpointPositions.length },
      "Segment script saved to DB",
    );

    const firstTts =
      contentLines.length > 0
        ? args.pipeline.batchTTS(contentLines, 0)
        : null;

    if (args.topic !== "filler" && args.topic !== "startup") {
      this.deps.recentTopics.push(args.topic);
      if (this.deps.recentTopics.length > 10) this.deps.recentTopics.shift();
    }

    return {
      kind: "segment",
      topic: args.topic,
      sourceUrl: args.sourceUrl ?? undefined,
      programId: args.programId ?? undefined,
      segmentKind: args.kind,
      scriptLines: contentLines,
      segmentId: segmentRow.id,
      lineRowIds: lineRows.map((r) => r.id),
      checkpointPositions,
      firstTts,
    };
  }

  private scheduleFactCheck(segmentId: string): void {
    if (!this.deps.factCheckService) return;
    if (this.deps.hasPushedFirstAudio) {
      void this.deps.factCheckService.checkSegment(segmentId);
      return;
    }
    this.deps.pendingFactChecks.push(segmentId);
    setTimeout(() => {
      const idx = this.deps.pendingFactChecks.indexOf(segmentId);
      if (idx === -1) return;
      this.deps.pendingFactChecks.splice(idx, 1);
      if (this.deps.factCheckService) {
        void this.deps.factCheckService.checkSegment(segmentId);
      }
    }, 15_000);
  }

  private flushDeferredFactChecks(): void {
    if (!this.deps.hasPushedFirstAudio) return;
    while (this.deps.pendingFactChecks.length > 0) {
      const id = this.deps.pendingFactChecks.shift();
      if (id && this.deps.factCheckService) {
        void this.deps.factCheckService.checkSegment(id);
      }
    }
  }
}
