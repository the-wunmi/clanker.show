import pino from "pino";
import { DEFAULT_MODEL, type AIClient } from "./ai";
import { extractJsonObject, firstTextBlock } from "./aiResponse";
import { withAiLimit } from "./RuntimeLimiter";

export interface EditorPersona {
  name: string;
  role: string;
  perspective: string;
}

export interface TopicProposal {
  topic: string;
  summary: string;
  sourceUrl: string;
  rawContent?: string;
  urgency: "breaking" | "trending" | "interesting";
  isSeed?: boolean;
}

export interface EditorialVerdict {
  editorName: string;
  verdict: "approve" | "reject" | "revise";
  reasoning: string;
  score: number;
  suggestedAngle?: string;
}

export interface EditorialConsensus {
  approved: boolean;
  topic: string;
  angle: string;
  verdicts: EditorialVerdict[];
  rounds: number;
}

export interface EditorialBoardConfig {
  ai: AIClient;
  editors?: EditorPersona[];
  consensusThreshold?: number;
  maxRounds?: number;
}

const DEFAULT_EDITORS: EditorPersona[] = [
  {
    name: "Morgan",
    role: "News Director",
    perspective:
      "Evaluates stories for newsworthiness, factual significance, and timeliness. " +
      "Prioritizes stories that matter, not just stories that trend. " +
      "Asks: Is this important? Is it accurate? Will it age well?",
  },
  {
    name: "River",
    role: "Audience Editor",
    perspective:
      "Evaluates stories for listener engagement, relatability, and discussion potential. " +
      "Prioritizes stories that spark conversation. " +
      "Asks: Will listeners care? Can the hosts make this entertaining? Is there a debate to be had?",
  },
];

export class EditorialBoard {
  private readonly log: pino.Logger;
  private readonly ai: AIClient;
  private readonly editors: EditorPersona[];
  private readonly consensusThreshold: number;
  private readonly maxRounds: number;

  constructor(config: EditorialBoardConfig) {
    this.log = pino({ name: "EditorialBoard" });
    this.ai = config.ai;
    this.editors = config.editors ?? DEFAULT_EDITORS;
    this.consensusThreshold = config.consensusThreshold ?? 0.7;
    this.maxRounds = config.maxRounds ?? 3;
  }

  async review(proposal: TopicProposal): Promise<EditorialConsensus> {
    this.log.info({ topic: proposal.topic }, "Starting editorial review");

    let currentAngle = "";
    let allVerdicts: EditorialVerdict[] = [];

    for (let round = 1; round <= this.maxRounds; round++) {
      this.log.info({ round, topic: proposal.topic }, "Deliberation round");

      const verdicts = await Promise.all(
        this.editors.map((editor) =>
          this.evaluateTopic(editor, proposal, currentAngle),
        ),
      );

      allVerdicts = verdicts;

      const allApproved = verdicts.every((v) => v.verdict === "approve");
      if (allApproved) {
        const angle = this.pickBestAngle(verdicts);
        this.log.info(
          { topic: proposal.topic, rounds: round, angle },
          "Consensus reached — all approved",
        );
        return {
          approved: true,
          topic: proposal.topic,
          angle,
          verdicts,
          rounds: round,
        };
      }

      const anyReject = verdicts.find((v) => v.verdict === "reject");
      if (anyReject) {
        const otherVerdicts = verdicts.filter(
          (v) => v.editorName !== anyReject.editorName,
        );
        const highScoreOverride = otherVerdicts.some((v) => v.score > 0.9);

        if (highScoreOverride) {
          const overridingEditor = otherVerdicts.find((v) => v.score > 0.9)!;
          this.log.info(
            {
              topic: proposal.topic,
              overriddenBy: overridingEditor.editorName,
              score: overridingEditor.score,
              rounds: round,
            },
            "Rejection overridden by high-confidence approval",
          );
          return {
            approved: true,
            topic: proposal.topic,
            angle:
              overridingEditor.suggestedAngle ?? proposal.summary,
            verdicts,
            rounds: round,
          };
        }

        this.log.info(
          {
            topic: proposal.topic,
            rejectedBy: anyReject.editorName,
            reasoning: anyReject.reasoning,
            rounds: round,
          },
          "Topic rejected",
        );
        return {
          approved: false,
          topic: proposal.topic,
          angle: "",
          verdicts,
          rounds: round,
        };
      }

      const reviseVerdict = verdicts.find((v) => v.verdict === "revise");
      if (reviseVerdict && round < this.maxRounds) {
        currentAngle = await this.generateRevisedAngle(
          proposal,
          verdicts,
        );
        this.log.info(
          { topic: proposal.topic, revisedAngle: currentAngle, round },
          "Revised angle generated, re-evaluating",
        );
        continue;
      }
    }

    this.log.info(
      { topic: proposal.topic, rounds: this.maxRounds },
      "Max rounds reached without consensus — rejecting",
    );
    return {
      approved: false,
      topic: proposal.topic,
      angle: "",
      verdicts: allVerdicts,
      rounds: this.maxRounds,
    };
  }

  async quickGate(
    proposal: TopicProposal,
  ): Promise<{ approved: boolean; score: number; reason: string }> {
    this.log.info({ topic: proposal.topic }, "Quick gate evaluation");

    const editorPerspectives = this.editors
      .map((e) => `${e.name} (${e.role}): ${e.perspective}`)
      .join("\n\n");

    const systemPrompt =
      "You are a senior editorial gatekeeper at a live audio space. " +
      "You combine the perspectives of multiple editors:\n\n" +
      editorPerspectives +
      "\n\n" +
      "Quickly evaluate whether this topic is worth broadcasting. " +
      "Consider newsworthiness, accuracy potential, and audience engagement.\n\n" +
      "Respond with ONLY a JSON object:\n" +
      '{\n  "score": 0.0 to 1.0,\n  "reason": "brief explanation"\n}';

    const userContent =
      `Topic: ${proposal.topic}\n` +
      `Summary: ${proposal.summary}\n` +
      `Urgency: ${proposal.urgency}\n` +
      `Source: ${proposal.sourceUrl}` +
      (proposal.rawContent ? `\nAdditional context: ${proposal.rawContent}` : "");

    try {
      const response = await withAiLimit(() => this.ai.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }));

      const text = firstTextBlock(response.content);
      const parsed = JSON.parse(extractJsonObject(text)) as {
        score: number;
        reason: string;
      };

      const approved = parsed.score > 0.6;
      this.log.info(
        { topic: proposal.topic, score: parsed.score, approved },
        "Quick gate result",
      );

      return { approved, score: parsed.score, reason: parsed.reason };
    } catch (err) {
      this.log.error({ err, topic: proposal.topic }, "Quick gate failed");
      return {
        approved: false,
        score: 0,
        reason: "Editorial gate evaluation failed",
      };
    }
  }

  async planRundown(
    topics: TopicProposal[],
    programDuration: number,
    spaceContext: { name: string; description?: string },
  ): Promise<{
    rundown: Array<{
      topic: string;
      angle: string;
      estimatedMinutes: number;
      order: number;
    }>;
    dropped: string[];
  }> {
    this.log.info(
      { topicCount: topics.length, programDuration, space: spaceContext.name },
      "Planning program rundown",
    );

    const topicList = topics
      .map(
        (t, i) =>
          `[${i + 1}] "${t.topic}" — ${t.summary} (urgency: ${t.urgency})`,
      )
      .join("\n");

    const systemPrompt =
      `You are a program director at "${spaceContext.name}", a live audio space.` +
      (spaceContext.description
        ? ` Space vibe: ${spaceContext.description}`
        : "") +
      "\n\n" +
      "Plan a program rundown from the approved topics below. Decide:\n" +
      "- Which topics to lead with (most important/engaging first)\n" +
      "- How many minutes to spend on each topic (minimum 5 minutes per topic — go deep, not shallow)\n" +
      "- Which topics to drop if there are too many\n" +
      "- A compelling editorial angle for each included topic\n" +
      "- The total program length: you decide based on the topics available, but minimum 30 minutes\n\n" +
      `Suggested program duration: ${programDuration} minutes (you can go longer if the topics warrant it).\n` +
      "Each segment should be substantial — at least 5 minutes of real discussion. No 2-minute throwaway segments.\n" +
      "Leave 2-3 minutes buffer for transitions and banter.\n\n" +
      "Respond with ONLY a JSON object:\n" +
      "{\n" +
      '  "rundown": [\n' +
      '    { "topic": "...", "angle": "...", "estimatedMinutes": N, "order": N }\n' +
      "  ],\n" +
      '  "dropped": ["topic that was cut", ...]\n' +
      "}";

    try {
      const response = await withAiLimit(() => this.ai.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          { role: "user", content: `Available topics:\n${topicList}` },
        ],
      }));

      const text = firstTextBlock(response.content);
      const jsonStr = extractJsonObject(text);

      const parsed = JSON.parse(jsonStr) as {
        rundown: Array<{
          topic: string;
          angle: string;
          estimatedMinutes: number;
          order: number;
        }>;
        dropped: string[];
      };

      this.log.info(
        {
          included: parsed.rundown.length,
          dropped: parsed.dropped.length,
        },
        "Rundown planned",
      );

      return parsed;
    } catch (err) {
      this.log.error({ err }, "Failed to plan rundown");
      return {
        rundown: topics.map((t, i) => ({
          topic: t.topic,
          angle: t.summary,
          estimatedMinutes: Math.floor(programDuration / topics.length),
          order: i + 1,
        })),
        dropped: [],
      };
    }
  }

  private async evaluateTopic(
    editor: EditorPersona,
    proposal: TopicProposal,
    currentAngle: string,
  ): Promise<EditorialVerdict> {
    const systemPrompt =
      `You are ${editor.name}, a ${editor.role} at a live audio space.\n` +
      `${editor.perspective}\n\n` +
      "Evaluate the following topic proposal for broadcast.\n\n" +
      "Respond with ONLY a JSON object:\n" +
      "{\n" +
      '  "verdict": "approve" | "reject" | "revise",\n' +
      '  "reasoning": "why",\n' +
      '  "score": 0.0 to 1.0,\n' +
      '  "suggestedAngle": "optional — how should the hosts approach this"\n' +
      "}";

    const userContent =
      `Topic: ${proposal.topic}\n` +
      `Summary: ${proposal.summary}\n` +
      `Urgency: ${proposal.urgency}\n` +
      `Source: ${proposal.sourceUrl}` +
      (proposal.rawContent ? `\nAdditional context: ${proposal.rawContent}` : "") +
      (currentAngle ? `\n\nPreviously suggested angle: ${currentAngle}` : "");

    try {
      const response = await withAiLimit(() => this.ai.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }));

      const text = firstTextBlock(response.content);
      const jsonStr = extractJsonObject(text);
      const parsed = JSON.parse(jsonStr) as {
        verdict: "approve" | "reject" | "revise";
        reasoning: string;
        score: number;
        suggestedAngle?: string;
      };

      return {
        editorName: editor.name,
        verdict: this.validateVerdict(parsed.verdict),
        reasoning: parsed.reasoning,
        score: Math.max(0, Math.min(1, parsed.score)),
        suggestedAngle: parsed.suggestedAngle,
      };
    } catch (err) {
      this.log.error(
        { err, editor: editor.name, topic: proposal.topic },
        "Editor evaluation failed",
      );
      return {
        editorName: editor.name,
        verdict: "reject",
        reasoning: "Evaluation failed due to an error",
        score: 0,
      };
    }
  }

  private async generateRevisedAngle(
    proposal: TopicProposal,
    verdicts: EditorialVerdict[],
  ): Promise<string> {
    const feedback = verdicts
      .map(
        (v) =>
          `${v.editorName} (${v.verdict}): ${v.reasoning}` +
          (v.suggestedAngle ? ` | Suggested angle: ${v.suggestedAngle}` : ""),
      )
      .join("\n");

    const systemPrompt =
      "You are a mediator in an editorial meeting at a live audio space. " +
      "Two editors have reviewed a topic and disagree. " +
      "Synthesize their feedback into a single revised editorial angle that addresses both perspectives.\n\n" +
      "Respond with ONLY a plain text string — the revised angle. No JSON, no quotes, just the angle.";

    const userContent =
      `Topic: ${proposal.topic}\n` +
      `Summary: ${proposal.summary}\n\n` +
      `Editor feedback:\n${feedback}`;

    try {
      const response = await withAiLimit(() => this.ai.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }));

      return firstTextBlock(response.content).trim();
    } catch (err) {
      this.log.error({ err, topic: proposal.topic }, "Failed to generate revised angle");
      const firstAngle = verdicts.find((v) => v.suggestedAngle)?.suggestedAngle;
      return firstAngle ?? proposal.summary;
    }
  }

  private pickBestAngle(verdicts: EditorialVerdict[]): string {
    const sorted = [...verdicts].sort((a, b) => b.score - a.score);
    return sorted[0]?.suggestedAngle ?? "";
  }

  private validateVerdict(
    value: unknown,
  ): "approve" | "reject" | "revise" {
    const valid = ["approve", "reject", "revise"];
    if (typeof value === "string" && valid.includes(value)) {
      return value as "approve" | "reject" | "revise";
    }
    return "reject";
  }

}
