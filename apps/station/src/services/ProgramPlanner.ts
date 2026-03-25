import pino from "pino";
import {
  EditorialBoard,
  type TopicProposal,
} from "./EditorialBoard";
import { DEFAULT_MODEL, type AIClient } from "./ai";
import { extractJsonArray, firstTextBlock } from "./aiResponse";
import { Program, RundownSegment, EditorialDecision } from "../db/index";
import type { PulseEvent } from "./ContentPipeline";
import { withAiLimit } from "./RuntimeLimiter";
import { getVoiceProfiles } from "./voiceProfiles";

export interface ProgramConfig {
  ai: AIClient;
  stationId: string;
  stationName: string;
  stationDescription?: string;
  searchQueries?: string[];
  hosts?: Array<{ name: string; personality: string; voiceId?: string }>;
  durationMin: number;
  useFullEditorial: boolean;
}

export interface ProgramSegment {
  topic: string;
  angle: string;
  estimatedMinutes: number;
  order: number;
  status: "planned" | "live" | "completed" | "skipped";
}

export interface ActiveProgram {
  id: string;
  title: string;
  segments: ProgramSegment[];
  currentSegmentIndex: number;
  startedAt: number;
  status: "planning" | "approved" | "live" | "completed";
}

export class ProgramPlanner {
  private readonly log: pino.Logger;
  private readonly board: EditorialBoard;
  private readonly ai: AIClient;
  private readonly config: ProgramConfig;
  private activeProgram: ActiveProgram | null = null;
  private topicBuffer: TopicProposal[] = [];
  private programCounter = 0;
  private static readonly MAX_TOPIC_BUFFER = Math.max(
    20,
    Number(process.env.PROGRAM_TOPIC_BUFFER_MAX ?? "200"),
  );

  constructor(config: ProgramConfig, board?: EditorialBoard) {
    this.log = pino({ name: "ProgramPlanner" });
    this.config = config;
    this.board = board ?? new EditorialBoard({ ai: config.ai });
    this.ai = config.ai;
  }

  async generateSeedTopics(): Promise<TopicProposal[]> {
    this.log.info("Generating seed topics from station config");

    const queries = this.config.searchQueries ?? [];
    const voiceProfiles = await getVoiceProfiles();
    const hostInfo = this.config.hosts
      ?.map((h) => {
        const profile = h.voiceId ? voiceProfiles.get(h.voiceId) : ""; // TODO optimize
        return profile
          ? `${h.name} (${profile}): ${h.personality}`
          : `${h.name}: ${h.personality}`;
      })
      .join("\n") ?? "";

    const systemPrompt =
      "You are a program director for a live AI radio station.\n" +
      `Station: "${this.config.stationName}"\n` +
      (this.config.stationDescription
        ? `Description: ${this.config.stationDescription}\n`
        : "") +
      (hostInfo ? `Hosts:\n${hostInfo}\n` : "") +
      "\n" +
      "Generate 8-12 compelling, specific topic proposals for the next broadcast program.\n" + // TODO confirm this not a lot
      "Each topic should be a real, current-feeling subject that fits the station's identity.\n" +
      `You need enough topics to fill an approximately ${this.config.durationMin}-minute program, so be generous with ideas.\n` +
      (queries.length > 0
        ? `The station covers these areas: ${queries.join(", ")}\n`
        : "") +
      "\n" +
      "Respond with ONLY a JSON array (no markdown fences). Each element:\n" +
      '{ "topic": "concise title", "summary": "2-3 sentence description with specific details", "urgency": "trending" | "interesting" }';

    try {
      const response = await withAiLimit(() => this.ai.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: "Generate topics for the next program." }],
      }));

      const text = firstTextBlock(response.content);
      const jsonStr = extractJsonArray(text);

      const parsed = JSON.parse(jsonStr) as Array<{
        topic: string;
        summary: string;
        urgency: "trending" | "interesting";
      }>;

      const proposals: TopicProposal[] = parsed.map((t) => ({
        topic: t.topic,
        summary: t.summary,
        sourceUrl: "",
        urgency: t.urgency ?? "interesting",
        isSeed: true,
      }));

      this.log.info(
        { count: proposals.length },
        "Seed topics generated",
      );

      return proposals;
    } catch (err) {
      this.log.error({ err }, "Failed to generate seed topics");
      // Fallback: use station description as a single topic
      if (this.config.stationDescription) {
        return [
          {
            topic: this.config.stationName,
            summary: this.config.stationDescription,
            sourceUrl: "",
            urgency: "interesting",
            isSeed: true,
          },
        ];
      }
      return [];
    }
  }

  bufferTopic(pulse: PulseEvent): void {
    this.log.info({ topic: pulse.topic }, "Buffering topic for next program");

    const proposal: TopicProposal = {
      topic: pulse.topic,
      summary: pulse.summary,
      sourceUrl: pulse.sourceUrl,
      rawContent: pulse.rawContent,
      urgency: pulse.urgency,
    };

    this.topicBuffer.push(proposal);
    if (this.topicBuffer.length > ProgramPlanner.MAX_TOPIC_BUFFER) {
      this.topicBuffer.shift();
      this.log.warn(
        { max: ProgramPlanner.MAX_TOPIC_BUFFER },
        "Topic buffer reached max size, dropping oldest",
      );
    }
  }

  async planNextProgram(): Promise<ActiveProgram> {
    this.log.info(
      { buffered: this.topicBuffer.length },
      "Planning next program from buffered topics",
    );

    if (this.topicBuffer.length === 0) {
      this.log.info("No topics in buffer — generating seed topics");
      const seedTopics = await this.generateSeedTopics();
      for (const seed of seedTopics) {
        this.topicBuffer.push(seed);
      }
      if (this.topicBuffer.length === 0) {
        this.log.warn("Seed topic generation failed — creating minimal program");
        this.programCounter += 1;
        const title = `${this.config.stationName} — Program ${this.programCounter}`;
        const segments: ProgramSegment[] = [{
          topic: this.config.stationName,
          angle: this.config.stationDescription ?? "General discussion",
          estimatedMinutes: this.config.durationMin,
          order: 1,
          status: "planned",
        }];

        const row = await Program.create({
          stationId: this.config.stationId,
          title,
          description: "Minimal fallback program",
          durationMin: this.config.durationMin,
          status: "approved",
        });
        await RundownSegment.bulkCreate(row.id, segments);

        const program: ActiveProgram = {
          id: row.id,
          title,
          segments,
          currentSegmentIndex: 0,
          startedAt: 0,
          status: "approved",
        };
        this.activeProgram = program;
        return program;
      }
    }

    const candidates = [...this.topicBuffer];
    this.topicBuffer = [];

    const approvedTopics: TopicProposal[] = [];

    // Seed topics skip editorial review — they come from the station's own config
    const seedCandidates = candidates.filter((c) => c.isSeed);
    const normalCandidates = candidates.filter((c) => !c.isSeed);

    approvedTopics.push(...seedCandidates);
    if (seedCandidates.length > 0) {
      this.log.info(
        { count: seedCandidates.length },
        "Seed topics auto-approved (skip editorial)",
      );
    }

    if (normalCandidates.length > 0) {
      if (this.config.useFullEditorial) {
        const reviews = await Promise.all(
          normalCandidates.map(async (proposal) => {
            const consensus = await this.board.review(proposal);
            return { proposal, consensus };
          }),
        );

        for (const { proposal, consensus } of reviews) {
          // Persist each editor's verdict (fire-and-forget)
          Promise.all(
            consensus.verdicts.map((verdict) =>
              EditorialDecision.create({
                stationId: this.config.stationId,
                topic: proposal.topic,
                sourceUrl: proposal.sourceUrl || null,
                editorName: verdict.editorName,
                verdict: verdict.verdict,
                reasoning: verdict.reasoning,
                score: verdict.score,
              }),
            ),
          ).catch((err) =>
            this.log.error({ err, topic: proposal.topic }, "Failed to persist editorial verdicts"),
          );

          if (consensus.approved) {
            approvedTopics.push(proposal);
            this.log.info(
              { topic: proposal.topic, rounds: consensus.rounds },
              "Topic approved by editorial board",
            );
          } else {
            this.log.info(
              { topic: proposal.topic },
              "Topic rejected by editorial board",
            );
          }
        }
      } else {
        const gates = await Promise.all(
          normalCandidates.map(async (proposal) => {
            const gate = await this.board.quickGate(proposal);
            return { proposal, gate };
          }),
        );

        for (const { proposal, gate } of gates) {
          // Persist gate decision (fire-and-forget)
          EditorialDecision.create({
            stationId: this.config.stationId,
            topic: proposal.topic,
            sourceUrl: proposal.sourceUrl || null,
            editorName: "editorial-gate",
            verdict: gate.approved ? "approve" : "reject",
            reasoning: gate.reason,
            score: gate.score,
          }).catch((err) =>
            this.log.error({ err, topic: proposal.topic }, "Failed to persist gate decision"),
          );

          if (gate.approved) {
            approvedTopics.push(proposal);
            this.log.info(
              { topic: proposal.topic, score: gate.score },
              "Topic passed quick gate",
            );
          } else {
            this.log.info(
              { topic: proposal.topic, score: gate.score },
              "Topic failed quick gate",
            );
          }
        }
      }
    }

    if (approvedTopics.length === 0) {
      this.log.warn("No topics approved — falling back to seed topics");
      const seedTopics = await this.generateSeedTopics();
      if (seedTopics.length > 0) {
        // Seed topics skip editorial review — they come from station config
        approvedTopics.push(...seedTopics);
      } else {
        this.programCounter += 1;
        const title = `${this.config.stationName} — Program ${this.programCounter}`;
        const segments: ProgramSegment[] = [{
          topic: this.config.stationName,
          angle: this.config.stationDescription ?? "General discussion",
          estimatedMinutes: this.config.durationMin,
          order: 1,
          status: "planned",
        }];

        const row = await Program.create({
          stationId: this.config.stationId,
          title,
          description: "Fallback program (no topics approved)",
          durationMin: this.config.durationMin,
          status: "approved",
        });
        await RundownSegment.bulkCreate(row.id, segments);

        const program: ActiveProgram = {
          id: row.id,
          title,
          segments,
          currentSegmentIndex: 0,
          startedAt: 0,
          status: "approved",
        };
        this.activeProgram = program;
        return program;
      }
    }

    const rundownResult = await this.board.planRundown(
      approvedTopics,
      this.config.durationMin,
      {
        name: this.config.stationName,
        description: this.config.stationDescription,
      },
    );

    this.programCounter += 1;
    const segments: ProgramSegment[] = rundownResult.rundown.map((item) => ({
      topic: item.topic,
      angle: item.angle,
      estimatedMinutes: item.estimatedMinutes,
      order: item.order,
      status: "planned" as const,
    }));

    segments.sort((a, b) => a.order - b.order);

    const title = `${this.config.stationName} — Program ${this.programCounter}`;
    const totalMinutes = Math.max(
      this.config.durationMin,
      segments.reduce((sum, s) => sum + s.estimatedMinutes, 0),
    );

    const row = await Program.create({
      stationId: this.config.stationId,
      title,
      description: `${segments.length} segments, ${totalMinutes} min estimated`,
      durationMin: totalMinutes,
      status: "approved",
    });
    await RundownSegment.bulkCreate(row.id, segments);

    const program: ActiveProgram = {
      id: row.id,
      title,
      segments,
      currentSegmentIndex: 0,
      startedAt: 0,
      status: "approved",
    };

    this.activeProgram = program;

    this.log.info(
      {
        programId: program.id,
        segmentCount: segments.length,
        dropped: rundownResult.dropped,
      },
      "Program planned and approved",
    );

    return program;
  }

  getNextSegment(): ProgramSegment | null {
    if (!this.activeProgram) return null;
    if (this.activeProgram.status === "completed") return null;

    const { segments, currentSegmentIndex } = this.activeProgram;
    if (currentSegmentIndex >= segments.length) return null;

    const segment = segments[currentSegmentIndex];

    if (this.activeProgram.status === "approved") {
      this.activeProgram.status = "live";
      this.activeProgram.startedAt = Date.now();
    }

    segment.status = "live";
    return segment;
  }

  peekNextSegment(): ProgramSegment | null {
    if (!this.activeProgram) return null;
    if (this.activeProgram.status === "completed") return null;

    const { segments, currentSegmentIndex } = this.activeProgram;
    if (currentSegmentIndex >= segments.length) return null;
    return segments[currentSegmentIndex];
  }

  async advanceSegment(): Promise<void> {
    if (!this.activeProgram) {
      this.log.warn("No active program to advance");
      return;
    }

    const { segments, currentSegmentIndex } = this.activeProgram;
    if (currentSegmentIndex < segments.length) {
      segments[currentSegmentIndex].status = "completed";
    }

    this.activeProgram.currentSegmentIndex += 1;

    if (this.activeProgram.currentSegmentIndex >= segments.length) {
      this.log.info(
        { programId: this.activeProgram.id },
        "All segments completed — auto-completing program",
      );
      await this.completeProgram();
    } else {
      this.log.info(
        {
          programId: this.activeProgram.id,
          nextSegment: this.activeProgram.currentSegmentIndex,
          topic: segments[this.activeProgram.currentSegmentIndex].topic,
        },
        "Advanced to next segment",
      );
    }
  }

  getActiveProgram(): ActiveProgram | null {
    return this.activeProgram;
  }

  async completeProgram(): Promise<void> {
    if (!this.activeProgram) {
      this.log.warn("No active program to complete");
      return;
    }

    this.log.info(
      { programId: this.activeProgram.id },
      "Completing program",
    );

    for (const segment of this.activeProgram.segments) {
      if (segment.status === "planned") {
        segment.status = "skipped";
      }
    }

    try {
      await Program.update(this.activeProgram.id, { status: "completed" });
      await RundownSegment.replaceForProgram(this.activeProgram.id, this.activeProgram.segments); // TODO do we have to?
    } catch (err) {
      this.log.error({ err, programId: this.activeProgram.id }, "Failed to update program status in DB");
    }

    this.activeProgram.status = "completed";
    this.activeProgram = null;
  }

  async fastTrackTopic(
    pulse: PulseEvent,
  ): Promise<{ approved: boolean; segment?: ProgramSegment }> {
    this.log.info(
      { topic: pulse.topic },
      "Fast-tracking breaking topic through quick gate",
    );

    const proposal: TopicProposal = {
      topic: pulse.topic,
      summary: pulse.summary,
      sourceUrl: pulse.sourceUrl,
      rawContent: pulse.rawContent,
      urgency: pulse.urgency,
    };

    const gate = await this.board.quickGate(proposal);

    // Persist fast-track gate decision (fire-and-forget)
    EditorialDecision.create({
      stationId: this.config.stationId,
      topic: proposal.topic,
      sourceUrl: proposal.sourceUrl || null,
      editorName: "editorial-gate",
      verdict: gate.approved ? "approve" : "reject",
      reasoning: gate.reason,
      score: gate.score,
    }).catch((err) =>
      this.log.error({ err, topic: proposal.topic }, "Failed to persist fast-track gate decision"),
    );

    if (!gate.approved) {
      this.log.info(
        { topic: pulse.topic, score: gate.score, reason: gate.reason },
        "Breaking topic rejected by quick gate",
      );
      return { approved: false };
    }

    const segment: ProgramSegment = {
      topic: pulse.topic,
      angle: gate.reason,
      estimatedMinutes: 5,
      order: 0,
      status: "planned",
    };

    if (this.activeProgram && this.activeProgram.status === "live") {
      const insertIndex = this.activeProgram.currentSegmentIndex + 1;
      this.activeProgram.segments.splice(insertIndex, 0, segment);

      for (let i = insertIndex; i < this.activeProgram.segments.length; i++) {
        this.activeProgram.segments[i].order = i + 1;
      }

      this.log.info(
        {
          topic: pulse.topic,
          programId: this.activeProgram.id,
          insertedAt: insertIndex,
        },
        "Breaking topic inserted into live program",
      );
    }

    return { approved: true, segment };
  }
}
