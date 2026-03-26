import Firecrawl from "@mendable/firecrawl-js";
import pino from "pino";
import { DEFAULT_MODEL, FAST_MODEL, type AIClient } from "./ai";
import { extractJsonArray, extractJsonObject, firstTextBlock } from "./aiResponse";
import type { PulseEvent } from "./ContentPipeline";
import type Anthropic from "@anthropic-ai/sdk";
import { UnsupportedScrapeDomain } from "../db";
import { withAiLimit, withSearchLimit } from "./RuntimeLimiter";
import { getVoiceProfiles } from "./voiceProfiles";

export type Emotion = "neutral" | "excited" | "skeptical" | "amused" | "serious";

export interface ScriptLine {
  host: string;
  text: string;
  emotion: Emotion;
}

export interface Script {
  topic: string;
  lines: ScriptLine[];
}

export interface HostDefinition {
  name: string;
  personality: string;
  voiceId?: string;
}

export interface SpaceContext {
  spaceName: string;
  description?: string;
  previousTopics?: string[];
  tone?: string;
}

export interface ScriptGeneratorConfig {
  ai: AIClient;
  model?: string;
}

export interface GenerateScriptOptions {
  fastStart?: boolean;
  kind?: "topic" | "filler";
  targetDurationMin?: number;
  recentTopics?: string[];
  progress?: {
    segmentPercent?: number;
    programPercent?: number;
    currentSegmentNumber?: number;
    totalSegments?: number;
  };
}

export interface NextSegmentDecisionContext {
  hasProgramSegment: boolean;
  hasQueuedTopic: boolean;
  queuedTopicCount: number;
  isFirstSegment: boolean;
  segmentPercent?: number;
  programPercent?: number;
  currentSegmentNumber?: number;
  totalSegments?: number;
}

export interface NextSegmentDecision {
  source: "program" | "queue" | "filler";
  reason: string;
}

export interface CallOpportunityContext {
  callerCount: number;
  callerTopics: string[];
  currentTopic: string;
  segmentKind: "filler" | "program" | "queue";
  segmentProgress: number;
  programProgress: number;
}

export interface CallerCandidate {
  id: string;
  callerName: string;
  topicHint: string;
  waitingMinutes: number;
}

export interface CallSelectionContext {
  currentTopic: string;
  spaceDescription: string;
}

interface ClaudeCallOptions {
  maxTokens: number;
  maxToolRounds: number;
  disableTools?: boolean;
  model?: string;
}

type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

interface ToolRegistration {
  definition: Anthropic.Tool;
  handler: ToolHandler;
}

function parseHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function isHostBlocked(host: string): Promise<boolean> {
  return UnsupportedScrapeDomain.isBlockedHost(host);
}

async function markHostUnsupported(host: string, reason?: string): Promise<void> {
  await UnsupportedScrapeDomain.markHost(host, reason);
}

function buildToolRegistry(firecrawl: Firecrawl, log: pino.Logger): Map<string, ToolRegistration> {
  const registry = new Map<string, ToolRegistration>();

  registry.set("web_search", {
    definition: {
      name: "web_search",
      description:
        "Search the web for current information to fact-check claims, get up-to-date details, or verify facts. Use this when you need to confirm something is accurate or get the latest data on a topic.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "The search query to look up",
          },
        },
        required: ["query"],
      },
    },
    handler: async (input) => {
      const query = input.query as string;
      const startMs = Date.now();

      try {
        const data = await withSearchLimit(() => firecrawl.search(query, {
          limit: 5,
          sources: ["web", "news"],
        }));

        const allItems = [...(data.web ?? []), ...(data.news ?? [])] as Array<Record<string, unknown>>;
        const results: string[] = [];

        for (const item of allItems) {
          const url = item.url as string | undefined;
          const title = (item.title as string) ?? "Untitled";
          if (!url) continue;

          let entry = `Title: ${title}\nURL: ${url}`;
          const summary = (item.description ?? item.snippet) as string | undefined;
          const markdown = item.markdown as string | undefined;

          if (summary) entry += `\nSummary: ${summary}`;
          if (markdown) entry += `\nContent: ${markdown.slice(0, 3000)}`; // TODO is this sufficient?
          results.push(entry);
        }

        const elapsedMs = Date.now() - startMs;
        log.info({ query, elapsedMs, resultCount: results.length }, "web_search complete");

        return results.length > 0 ? results.join("\n\n---\n\n") : "No results found.";
      } catch (err) {
        log.error({ err, query }, "web_search failed");
        return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  registry.set("scrape_url", {
    definition: {
      name: "scrape_url",
      description:
        "Fetch the full content of a specific web page. Use this when you have a URL and need the complete article text for detailed discussion. More thorough than web_search for a single known URL.",
      input_schema: {
        type: "object" as const,
        properties: {
          url: {
            type: "string",
            description: "The URL to scrape",
          },
        },
        required: ["url"],
      },
    },
    handler: async (input) => {
      const url = input.url as string;
      const startMs = Date.now();
      const host = parseHost(url);
      if (host && await isHostBlocked(host)) {
        log.warn({ url, host }, "Skipping scrape_url for blocked domain");
        return `Unsupported source domain for scraping: ${url}. Use web_search results or another source URL.`;
      }

      try {
        const result = await withSearchLimit(() => firecrawl.scrape(url, {
          formats: ["markdown"],
          onlyMainContent: true,
        }));

        const elapsedMs = Date.now() - startMs;
        const markdown = result.markdown ?? "";
        const title = result.metadata?.title ?? "Untitled";

        log.info({ url, elapsedMs, contentLength: markdown.length }, "scrape_url complete");

        if (!markdown) return "Could not extract content from this URL.";

        return `Title: ${title}\nURL: ${url}\n\nContent:\n${markdown.slice(0, 5000)}`; // TODO is this sufficient?
      } catch (err) {
        log.error({ err, url }, "scrape_url failed");
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("do not support this site")) {
          if (host) await markHostUnsupported(host, message);
          return `Unsupported source domain for scraping: ${url}. Use web_search results or another source URL.`;
        }
        return `Scrape failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  return registry;
}

export class ScriptGenerator {
  private readonly log: pino.Logger;
  private readonly ai: AIClient;
  private readonly model: string;
  private readonly toolRegistry: Map<string, ToolRegistration>;
  private readonly tools: Anthropic.Tool[];

  constructor(config: ScriptGeneratorConfig) {
    this.log = pino({ name: "ScriptGenerator" });
    this.ai = config.ai;
    this.model = config.model ?? DEFAULT_MODEL;

    const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
    this.toolRegistry = buildToolRegistry(firecrawl, this.log);
    this.tools = [...this.toolRegistry.values()].map((t) => t.definition);
  }

  async generate(
    pulse: PulseEvent,
    hosts: HostDefinition[],
    spaceContext: SpaceContext,
    options: GenerateScriptOptions = {},
  ): Promise<Script> {
    const scriptKind = options.kind ?? "topic";
    this.log.info(
      { topic: pulse.topic, fastStart: options.fastStart === true, kind: scriptKind },
      "Generating dialogue script",
    );

    const fastStart = options.fastStart === true;
    const recentTopics = options.recentTopics ?? [];
    const targetDurationMin = fastStart ? Math.max(1, Math.min(5, Math.round(options.targetDurationMin ?? 3))) : options.targetDurationMin ?? 6;
    const progress = options.progress;
    const progressNotes = progress
      ? [
        "",
        "Progress context (use this to shape pacing/transitions):",
        typeof progress.segmentPercent === "number"
          ? `- Current segment completion: ${Math.round(progress.segmentPercent)}%`
          : "",
        typeof progress.programPercent === "number"
          ? `- Program completion: ${Math.round(progress.programPercent)}%`
          : "",
        typeof progress.currentSegmentNumber === "number" &&
          typeof progress.totalSegments === "number"
          ? `- Program segment position: ${progress.currentSegmentNumber} of ${progress.totalSegments}`
          : "",
      ].filter(Boolean)
      : [];

    const systemPrompt = scriptKind === "filler"
      ? await this.buildSystemPrompt(hosts, spaceContext, [
        `ANGLE: ${pulse.summary || pulse.topic}`,
        "",
        fastStart
          ? `Write a quick, casual opening dialogue that naturally lands around ${targetDurationMin} minutes of spoken audio.`
          : `Write a rich dialogue that naturally lands around ${targetDurationMin} minutes of spoken audio.`,
        `Do not target a fixed number of lines. Let the pacing and conversational flow determine line count for roughly ${targetDurationMin} minutes.`,
        "RULES:",
        "- Jump straight into the topic. No meta-commentary about being on air, doing radio, or what is coming up next.",
        "- Do NOT reference listeners, breaks, segments, or the show itself.",
        "- Do NOT open with 'You know what…' or similar cliché starters.",
        "- Be specific — mention real names, places, products, or events when possible.",
        "- Each host should have a distinct point of view. They can disagree AND agree.",
        "- Let one host go on a mini-tangent while the other reacts with short interjections.",
        "- Mix in quick back-and-forth (\"Right.\" / \"Exactly.\" / \"Wait—\") between longer points.",
        "",
        fastStart
          ? "IMPORTANT: Keep this first segment quick, low-stakes, and avoid factual claims that require verification."
          : "IMPORTANT: Use web_search and scrape_url tools to look up current/recent info so your dialogue is accurate and timely.",
        fastStart
          ? "Avoid specific stats, dates, company performance claims, and hard-news assertions. Keep it to opinions, vibes, and setup."
          : "",
        fastStart
          ? "Wrap by naturally setting up the deeper program segment that follows."
          : "",
        recentTopics.length > 0
          ? `Avoid these topics (already covered): ${recentTopics.join(", ")}`
          : "",
        "",
        `Insert ${fastStart ? "1-2" : "2-4"} checkpoint markers at natural pause points.`,
        'Represent as: {"host":"__CHECKPOINT__","text":"","emotion":"neutral"}',
        "Place between topic shifts or after dramatic moments. NOT at start/end. Space roughly evenly.",
        ...progressNotes,
      ])
      : await this.buildSystemPrompt(hosts, spaceContext, [
        "Generate a natural, conversational radio dialogue between the hosts about the following topic.",
        fastStart
          ? `This is the opening warm-up and must start quickly. Aim for roughly ${targetDurationMin} minutes of spoken audio.`
          : `Aim for roughly ${targetDurationMin} minutes of spoken audio for this segment.`,
        `Do not force a fixed line count. Choose however many lines are needed to hit about ${targetDurationMin} minutes naturally.`,
        "Go deep on the topic — cite specific details, share distinct opinions, and build genuine back-and-forth.",
        "Explore multiple angles and sub-topics within the main topic. Don't just skim the surface.",
        "Make it sound like two friends who happen to be knowledgeable about this topic, NOT like a formal debate or interview.",
        "",
        fastStart
          ? "IMPORTANT: Keep this opening very chill and casual. Avoid claims that need fact-checking."
          : "IMPORTANT: Use the web_search tool to verify any specific facts, statistics, dates, or claims before including them.",
        fastStart
          ? "Do NOT include specific numbers, dates, market-share claims, legal assertions, or 'X beat Y' style factual comparisons."
          : "web_search returns summaries — use scrape_url on the most relevant URL(s) to get full article detail for richer discussion.",
        fastStart
          ? "Use host chemistry, reactions, and playful setup. You may optionally end up by teeing up that you'll dive into the main topic next."
          : "Do NOT guess or hallucinate details — if you're unsure about something, search for it first.",
        "",
        `Topic: ${pulse.topic}`,
        `Summary: ${pulse.summary}`,
        `Urgency: ${pulse.urgency}`,
        pulse.rawContent ? `Additional context: ${pulse.rawContent}` : "",
        pulse.sourceUrl ? `Source: ${pulse.sourceUrl}` : "",
        "",
        `Insert ${fastStart ? "1-2" : "2-4"} checkpoint markers at natural pause points.`,
        'Represent as: {"host":"__CHECKPOINT__","text":"","emotion":"neutral"}',
        "Place between topic shifts or after dramatic moments. NOT at start/end. Space roughly evenly.",
        ...progressNotes,
      ]);

    const lines = await this.callClaude(systemPrompt, {
      maxTokens: fastStart ? 4096 : 8192,
      maxToolRounds: fastStart ? 1 : 8,
      disableTools: fastStart,
    });
    return { topic: pulse.topic, lines };
  }

  async decideNextSegment(context: NextSegmentDecisionContext): Promise<NextSegmentDecision> {
    const fallback: NextSegmentDecision = context.hasProgramSegment
      ? { source: "program", reason: "Program segment available" }
      : context.hasQueuedTopic
        ? { source: "queue", reason: "Queued topic available" }
        : { source: "filler", reason: "No queued or planned segment available" };

    try {
      const response = await withAiLimit(() => this.ai.messages.create({
        model: FAST_MODEL,
        max_tokens: 220,
        temperature: 0.2,
        system: [
          "You are a live radio segment router.",
          "Choose exactly one next source: program, queue, or filler.",
          "Prefer program for continuity unless queue is clearly more timely.",
          "Use filler only if neither program nor queue is available.",
          "Return JSON only: {\"source\":\"program|queue|filler\",\"reason\":\"short reason\"}",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: JSON.stringify(context),
          },
        ],
      }));

      const text = firstTextBlock(response.content);
      const parsed = JSON.parse(extractJsonObject(text)) as Partial<NextSegmentDecision>;
      const source = parsed.source;
      if (source !== "program" && source !== "queue" && source !== "filler") {
        return fallback;
      }
      return {
        source,
        reason: typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : "Model selected route",
      };
    } catch (err) {
      this.log.warn({ err }, "Fast next-segment decision failed; using fallback");
      return fallback;
    }
  }

  async shouldTakeCall(ctx: CallOpportunityContext): Promise<{ takeCall: boolean; reason: string }> {
    const fallback = { takeCall: false, reason: "Decision failed — skipping call" };

    if (process.env.AUTO_TAKE_CALL === 'true') {
      return { takeCall: true, reason: "Auto-take call enabled" };
    }

    try {
      const response = await withAiLimit(() => this.ai.messages.create({
        model: FAST_MODEL,
        max_tokens: 220,
        temperature: 0.2,
        system: [
          "You are a live radio call-in scheduler.",
          "Decide whether NOW is a good time to take a listener call.",
          "Favor taking calls during filler segments or when segment progress is high.",
          "Resist interrupting mid-program unless a caller topic is highly relevant to the current topic.",
          "Return JSON only: {\"takeCall\":true/false,\"reason\":\"short reason\"}",
        ].join("\n"),
        messages: [
          { role: "user", content: JSON.stringify(ctx) },
        ],
      }));

      const text = firstTextBlock(response.content);
      const parsed = JSON.parse(extractJsonObject(text)) as Partial<{ takeCall: boolean; reason: string }>;
      return {
        takeCall: parsed.takeCall === true,
        reason: typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : "Model decision",
      };
    } catch (err) {
      this.log.warn({ err }, "shouldTakeCall decision failed; skipping call");
      return fallback;
    }
  }

  async selectBestCaller(
    callers: CallerCandidate[],
    ctx: CallSelectionContext,
  ): Promise<{ callerId: string; reason: string }> {
    const fallback = {
      callerId: callers[0].id,
      reason: "Fallback: oldest waiting caller",
    };

    try {
      const response = await withAiLimit(() => this.ai.messages.create({
        model: FAST_MODEL,
        max_tokens: 220,
        temperature: 0.2,
        system: [
          "You are a live radio call-in selector.",
          "Pick the best caller to bring on air based on topic relevance and wait time.",
          "Return JSON only: {\"callerId\":\"<id>\",\"reason\":\"short reason\"}",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: JSON.stringify({ callers, ...ctx }),
          },
        ],
      }));

      const text = firstTextBlock(response.content);
      const parsed = JSON.parse(extractJsonObject(text)) as Partial<{ callerId: string; reason: string }>;

      const selectedId = parsed.callerId;
      if (typeof selectedId !== "string" || !callers.some((c) => c.id === selectedId)) {
        return fallback;
      }

      return {
        callerId: selectedId,
        reason: typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : "Model selected caller",
      };
    } catch (err) {
      this.log.warn({ err }, "selectBestCaller failed; using FIFO fallback");
      return fallback;
    }
  }

  async generateIntro(
    spaceName: string,
    hosts: HostDefinition[],
  ): Promise<Script> {
    this.log.info({ spaceName }, "Generating space intro");

    const systemPrompt = await this.buildSystemPrompt(hosts, { spaceName }, [
      `Generate a short, energetic opening intro for the space "${spaceName}".`,
      "The hosts should greet the audience, mention the space name, and hype what is coming up.",
      "Keep it to 3-5 lines. Make it feel like tuning into a live audio space.",
    ]);

    const lines = await this.callClaude(systemPrompt, {
      maxTokens: 8192,
      maxToolRounds: 8,
    });
    return { topic: `Intro: ${spaceName}`, lines };
  }

  async generateGuestIntro(
    guestName: string,
    topic: string,
    hosts: HostDefinition[],
  ): Promise<Script> {
    this.log.info({ guestName, topic }, "Generating guest intro");

    const systemPrompt = await this.buildSystemPrompt(hosts, { spaceName: "the space" }, [
      `A caller named "${guestName}" is joining the show to discuss: "${topic}".`,
      "Generate 1-2 SHORT lines where the hosts welcome the caller on air.",
      "Keep it quick and warm.",
      "End with a direct handoff question to the caller so they know to start speaking.",
      "Do NOT research or look up the caller. This is a live radio call-in, not a guest interview.",
    ]);

    const lines = await this.callClaude(systemPrompt, {
      maxTokens: 512,
      maxToolRounds: 0,
      disableTools: true,
      model: FAST_MODEL,
    });
    const ensured = lines.length > 0
      ? lines
      : [{
          host: hosts[0]?.name ?? "Host",
          text: `Welcome to the show, ${guestName}. You're live — what's your take?`,
          emotion: "neutral" as const,
        }];
    return { topic: `Guest: ${guestName} — ${topic}`, lines: ensured };
  }

  async generateCallTransition(
    callerName: string,
    topicHint: string,
    currentTopic: string,
    hosts: HostDefinition[],
  ): Promise<Script> {
    this.log.info({ callerName, topicHint, currentTopic }, "Generating call transition");

    const systemPrompt = await this.buildSystemPrompt(hosts, { spaceName: "the space" }, [
      `A caller named "${callerName}" is about to join the show.`,
      topicHint
        ? `They want to talk about: "${topicHint}". The current topic is: "${currentTopic}".`
        : `The current topic is: "${currentTopic}".`,
      "Generate 1-2 SHORT lines where the hosts naturally bridge from the current topic to the incoming caller.",
      "Something like 'Oh we've got a caller!' or 'Hold that thought — someone's calling in!'",
      "Keep it quick, energetic, and seamless.",
      "Do NOT research or look up anything. This is a quick live transition.",
    ]);

    const lines = await this.callClaude(systemPrompt, {
      maxTokens: 256,
      maxToolRounds: 0,
      disableTools: true,
      model: FAST_MODEL,
    });
    const ensured = lines.length > 0
      ? lines
      : [{
          host: hosts[0]?.name ?? "Host",
          text: `Oh wait — we've got ${callerName} on the line! Let's bring them in.`,
          emotion: "excited" as const,
        }];
    return { topic: `Transition: ${callerName}`, lines: ensured };
  }

  async generateReactionSegment(
    topic: string,
    reactions: string[],
    hosts: HostDefinition[],
  ): Promise<Script> {
    this.log.info({ topic }, "Generating reaction segment");

    const systemPrompt = await this.buildSystemPrompt(hosts, { spaceName: "the space" }, [
      `The audience has been reacting to the topic: "${topic}".`,
      `Audience reactions/comments: ${reactions.join("; ")}`,
      "Generate 3-5 lines where the hosts discuss audience reactions.",
      "Reference specific reactions and add their own takes.",
    ]);

    const lines = await this.callClaude(systemPrompt, {
      maxTokens: 8192,
      maxToolRounds: 8,
    });
    return { topic: `Reactions: ${topic}`, lines };
  }

  async generateCallResponse(args: {
    callerText: string;
    callerName: string;
    topicHint: string;
    turnCount: number;
    hosts: HostDefinition[];
    spaceContext: SpaceContext;
  }): Promise<ScriptLine[]> {
    const { callerText, callerName, topicHint, turnCount, hosts, spaceContext } = args;
    this.log.info({ callerName, turnCount, textLen: callerText.length }, "Generating call response");

    const isWrappingUp = turnCount >= 6;
    const systemPrompt = await this.buildSystemPrompt(hosts, spaceContext, [
      `A listener named "${callerName}" has called in to discuss: "${topicHint}".`,
      `This is turn ${turnCount + 1} of the live call.`,
      "",
      `The caller just said: "${callerText}"`,
      "",
      "Generate a VERY SHORT host response (1-2 lines, 3 lines MAX).",
      "React directly to what the caller said. Be conversational and warm.",
      "Keep it BRIEF — the caller is waiting to respond. This is a live back-and-forth, not a monologue.",
      "Prefer one host responding with a quick take, not both hosts doing extended commentary.",
      ...(isWrappingUp
        ? [
            "",
            "IMPORTANT: This call is wrapping up. Thank the caller warmly, mention their name,",
            "and smoothly transition back to the regular show.",
          ]
        : []),
    ]);

    return this.callClaude(systemPrompt, {
      maxTokens: 512,
      maxToolRounds: 0,
      disableTools: true,
      model: FAST_MODEL,
    });
  }

  async generateCallIssueResponse(args: {
    callerName: string;
    situation: "no_audio" | "lost_caller" | "connection_error";
    hosts: HostDefinition[];
    spaceContext: SpaceContext;
  }): Promise<ScriptLine[]> {
    const { callerName, situation, hosts, spaceContext } = args;
    this.log.info({ callerName, situation }, "Generating call issue response");

    const situationPrompts: Record<string, string[]> = {
      no_audio: [
        `You're live on air with a caller named "${callerName}" but you can't hear them.`,
        "Generate exactly 1 line gently checking if they're still there.",
        "Keep it very brief — just a quick check-in.",
      ],
      lost_caller: [
        `You were live on air with "${callerName}" but it seems like the connection dropped.`,
        "Generate 1-2 lines wrapping up the call gracefully.",
        "Quick thank-you, move on. Don't dwell on it.",
      ],
      connection_error: [
        `You were about to go live with "${callerName}" but there's a technical issue with the line.`,
        "Generate 1 line acknowledging the connection problem.",
        "Brief and upbeat — move on quickly.",
      ],
    };

    const systemPrompt = await this.buildSystemPrompt(hosts, spaceContext, [
      ...situationPrompts[situation],
      "",
      "Keep it very short — this is a brief interstitial moment, not a segment.",
    ]);

    return this.callClaude(systemPrompt, {
      maxTokens: 256,
      maxToolRounds: 0,
      disableTools: true,
      model: FAST_MODEL,
    });
  }

  private async buildSystemPrompt(
    hosts: HostDefinition[],
    context: SpaceContext,
    instructions: string[],
  ): Promise<string> {
    const voiceProfiles = await getVoiceProfiles();
    const hostDescriptions = hosts
      .map((h) => {
        const profile = h.voiceId ? voiceProfiles.get(h.voiceId) : ""; // TODO optimize
        return profile
          ? `- ${h.name} (${profile}): ${h.personality}`
          : `- ${h.name}: ${h.personality}`;
      })
      .join("\n");

    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const parts = [
      `You are a script writer for "${context.spaceName}", a live audio space.`,
      `TODAY'S DATE: ${today}`,
      "",
      "HOSTS:",
      hostDescriptions,
      "",
      context.description ? `STATION VIBE: ${context.description}` : "",
      context.tone ? `TONE: ${context.tone}` : "",
      "",
      "CRITICAL RULES:",
      "- You are broadcasting LIVE right now. All information must be current and accurate as of today.",
      "- NEVER speak about future events in a speculative way if they have already happened. Use web_search or scrape_url to check.",
      "- If a source mentions something \"expected by end of 2025\" or similar past dates, search to find out what actually happened.",
      "- When citing statistics, company announcements, or claims — verify them with web_search first. Use scrape_url for deeper detail on key articles.",
      "- The dialogue must sound natural and present-tense. Say \"last year\" not \"in 2025\" when referring to past years.",
      "",
      "CONVERSATION DYNAMICS — THIS IS CRITICAL:",
      "Do NOT write rigid A-B-A-B alternation. Real radio hosts talk OVER each other, react in real-time, and riff.",
      "- A host can speak 2-4 lines in a row when they're on a roll or telling a story.",
      "- The other host should interject with SHORT reactions mid-flow: \"Wait, seriously?\", \"No way.\", \"That's wild.\", \"Hold on—\"",
      "- Include moments where one host INTERRUPTS or redirects: \"Okay but here's the thing—\", \"Let me stop you there—\"",
      "- Let hosts AGREE enthusiastically sometimes, not just take opposing sides.",
      "- Mix line lengths: some lines are 1-2 words (\"Exactly.\"), others are 2-3 sentences.",
      "- Hosts should reference what the other JUST said: \"Like you said...\", \"Building on that...\", \"Wait, you think so?\"",
      "- Avoid symmetry. One host might dominate a section, then the other takes over.",
      "- NO ping-pong debating. This is a conversation, not a tennis match.",
      "",
      "INSTRUCTIONS:",
      ...instructions.filter(Boolean),
      "",
      "RESPONSE FORMAT:",
      "After you have done any necessary research, respond with ONLY a JSON array (no markdown fences). Each element is an object with:",
      '  - "host": the host name (string)',
      '  - "text": what they say (string)',
      '  - "emotion": one of "neutral", "excited", "skeptical", "amused", "serious"',
      "",
      `Example: [{"host":"Tobe","text":"So I was reading about this and—","emotion":"excited"},{"host":"Sam","text":"The Klarna thing?","emotion":"neutral"},{"host":"Tobe","text":"Yes! Seven hundred employees replaced. Just like that.","emotion":"serious"},{"host":"Tobe","text":"And the CEO went on record saying it was the best decision they ever made.","emotion":"skeptical"},{"host":"Sam","text":"Okay that's actually insane. Like, you can't just say that out loud.","emotion":"amused"}]`,
      "",
      context.previousTopics && context.previousTopics.length > 0
        ? `PREVIOUS TOPICS (for continuity): ${context.previousTopics.join(", ")}`
        : "",
    ];

    return parts.filter((p) => p !== undefined).join("\n");
  }

  private async callClaude(
    systemPrompt: string,
    options: ClaudeCallOptions,
  ): Promise<ScriptLine[]> {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Generate the dialogue now." },
    ];

    for (let round = 0; round <= options.maxToolRounds; round++) {
      const startMs = Date.now();

      const response = await withAiLimit(() => this.ai.messages.create({
        model: options.model ?? this.model,
        max_tokens: options.maxTokens,
        system: systemPrompt,
        ...(options.disableTools ? {} : { tools: this.tools }),
        messages,
      }));

      const elapsedMs = Date.now() - startMs;
      this.log.info(
        { round, elapsedMs, stopReason: response.stop_reason },
        "Claude API call complete",
      );

      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });

        const toolBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        this.log.info(
          { toolCalls: toolBlocks.map((b) => ({ name: b.name, id: b.id })) },
          "Executing tool calls in parallel",
        );

        // Execute all tool calls in parallel
        const settled = await Promise.allSettled(
          toolBlocks.map(async (block) => {
            const registration = this.toolRegistry.get(block.name);
            if (!registration) {
              return { id: block.id, content: `Unknown tool: ${block.name}`, isError: true };
            }

            const result = await registration.handler(block.input as Record<string, unknown>);
            return { id: block.id, content: result, isError: false };
          }),
        );

        const toolResults: Anthropic.ToolResultBlockParam[] = settled.map((outcome, idx) => {
          if (outcome.status === "fulfilled") {
            return {
              type: "tool_result" as const,
              tool_use_id: outcome.value.id,
              content: outcome.value.content,
              ...(outcome.value.isError && { is_error: true }),
            };
          }
          // Promise rejected — return error to Claude
          const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          this.log.error({ err: outcome.reason, tool: toolBlocks[idx].name }, "Tool execution threw");
          return {
            type: "tool_result" as const,
            tool_use_id: toolBlocks[idx].id,
            content: `Tool error: ${error}`,
            is_error: true,
          };
        });

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // Final response — extract text
      const text = firstTextBlock(response.content);
      return this.parseScriptLines(text);
    }

    this.log.warn(
      { maxToolRounds: options.maxToolRounds },
      "Exceeded max tool rounds, returning empty script",
    );
    return [];
  }

  private parseScriptLines(raw: string): ScriptLine[] {
    const trimmed = raw.trim();

    try {
      const jsonStr = extractJsonArray(trimmed);
      const parsed = JSON.parse(jsonStr) as ScriptLine[];

      if (!Array.isArray(parsed)) return [];

      return parsed.map((line) => ({
        host: String(line.host),
        text: String(line.text),
        emotion: this.validateEmotion(line.emotion),
      }));
    } catch (err) {
      this.log.error({ err, raw: trimmed }, "Failed to parse script from Claude");
      return [];
    }
  }

  private validateEmotion(value: unknown): Emotion {
    const valid: Emotion[] = ["neutral", "excited", "skeptical", "amused", "serious"];
    if (typeof value === "string" && valid.includes(value as Emotion)) {
      return value as Emotion;
    }
    return "neutral";
  }
}
