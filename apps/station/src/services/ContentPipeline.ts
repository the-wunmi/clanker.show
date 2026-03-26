import { EventEmitter } from "node:events";
import Firecrawl from "@mendable/firecrawl-js";
import pino from "pino";
import { DEFAULT_MODEL, type AIClient } from "./ai";
import { firstTextBlock } from "./aiResponse";
import { withAiLimit, withSearchLimit } from "./RuntimeLimiter";

export interface PulseEvent {
  topic: string;
  summary: string;
  urgency: "breaking" | "trending" | "interesting";
  sourceUrl: string;
  rawContent?: string;
}

export interface ContentSource {
  type: "firecrawl_search";
  query: string;
}

interface FirecrawlResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

export interface ContentPipelineConfig {
  ai: AIClient;
}

export class ContentPipeline extends EventEmitter {
  private readonly log: pino.Logger;
  private readonly ai: AIClient;
  private readonly firecrawl: Firecrawl;
  private readonly recentTopics: Set<string> = new Set();
  private static readonly MAX_RECENT = 20;
  private static readonly MAX_CONCURRENT_FETCHES = Number(process.env.CONTENT_PIPELINE_CONCURRENCY ?? "1");
  private static readonly FETCH_INTERVAL_MS = Number(process.env.CONTENT_PIPELINE_INTERVAL_MS ?? "90000");
  private static readonly FETCH_JITTER_MS = Number(process.env.CONTENT_PIPELINE_JITTER_MS ?? "10000");
  private running = false;
  private generation = 0;
  private sources: ContentSource[] = [];
  private sourceCursor = 0;
  private activeFetches = 0;

  constructor(config: ContentPipelineConfig) {
    super();
    this.log = pino({ name: "ContentPipeline" });
    this.ai = config.ai;
    this.firecrawl = new Firecrawl({
      apiKey: process.env.FIRECRAWL_API_KEY,
    });
  }

  start(sources: ContentSource[]): void {
    this.log.info({ count: sources.length }, "Starting content pipeline");
    this.generation += 1;
    this.running = true;
    this.sources = [...sources];
    this.sourceCursor = 0;

    const maxConcurrent = Number.isFinite(ContentPipeline.MAX_CONCURRENT_FETCHES)
      ? Math.max(1, Math.floor(ContentPipeline.MAX_CONCURRENT_FETCHES))
      : 1;
    const workers = Math.min(maxConcurrent, this.sources.length);

    for (let i = 0; i < workers; i++) {
      void this.runWorkerLoop(this.generation);
    }
  }

  submitComment(comment: PulseEvent): void {
    this.log.info({ topic: comment.topic }, "Comment submitted");
    if (this.isDuplicate(comment.topic)) {
      this.log.info({ topic: comment.topic }, "Comment is a duplicate, ignoring");
      return;
    }
    this.trackTopic(comment.topic);
    this.emit("pulse", comment);
  }

  stop(): void {
    this.generation += 1;
    this.running = false;
    this.sources = [];
    this.sourceCursor = 0;
    this.log.info(
      { activeFetches: this.activeFetches },
      "Stopping content pipeline",
    );
  }

  monitorReactions(topic: string): { topic: string; reactions: string[] } {
    this.log.info({ topic }, "monitorReactions called (stub)");
    return { topic, reactions: [] };
  }

  private async fetchOnce(
    source: ContentSource,
    generation: number,
  ): Promise<void> {
    const key = `${source.type}:${source.query}`;
    if (!this.running || this.generation !== generation) return;

    try {
      const results = await this.firecrawlSearch(source.query);
      if (results.length === 0) {
        this.log.info({ key }, "No search results returned");
        return;
      }

      const pulse = await this.extractBestTopic(results, source.query);
      if (!pulse) {
        this.log.info({ key }, "No interesting topic extracted");
        return;
      }
      if (this.isDuplicate(pulse.topic)) {
        this.log.info({ key, topic: pulse.topic }, "Duplicate topic, skipping");
        return;
      }

      this.trackTopic(pulse.topic);
      this.log.info({ source, pulse }, "New topic from pipeline");
      if (this.running && this.generation === generation) {
        this.emit("pulse", pulse);
      }
    } catch (err) {
      this.log.error({ err, key }, "Fetch failed");
    }
  }

  private getNextSource(): ContentSource | null {
    if (this.sources.length === 0) return null;
    const source = this.sources[this.sourceCursor];
    this.sourceCursor = (this.sourceCursor + 1) % this.sources.length;
    return source;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async runWorkerLoop(generation: number): Promise<void> {
    this.activeFetches += 1;
    try {
      while (this.running && this.generation === generation) {
        const source = this.getNextSource();
        if (!source) break;

        await this.fetchOnce(source, generation);

        const interval = Number.isFinite(ContentPipeline.FETCH_INTERVAL_MS)
          ? Math.max(1_000, Math.floor(ContentPipeline.FETCH_INTERVAL_MS))
          : 90_000;
        const jitterCap = Number.isFinite(ContentPipeline.FETCH_JITTER_MS)
          ? Math.max(0, Math.floor(ContentPipeline.FETCH_JITTER_MS))
          : 10_000;
        const jitter = Math.floor(Math.random() * jitterCap);
        await this.sleep(interval + jitter);
      }
    } finally {
      this.activeFetches -= 1;
    }
  }

  private async firecrawlSearch(query: string): Promise<FirecrawlResult[]> {
    const startMs = Date.now();
    this.log.info({ query }, "Firecrawl search starting");

    const data = await withSearchLimit(() => this.firecrawl.search(query, {
      limit: 4,
      sources: ["web", "news"],
      tbs: "qdr:d",
    }));

    const results: FirecrawlResult[] = [];

    for (const item of data.news ?? []) {
      if ("url" in item && "title" in item && item.url && item.title) {
        results.push({
          title: item.title,
          url: item.url,
          snippet: ("snippet" in item && (item.snippet as string)) || "",
          content: ("markdown" in item && (item.markdown as string)) || undefined,
        });
      }
    }

    for (const item of data.web ?? []) {
      if ("url" in item && "title" in item && item.url && item.title) {
        results.push({
          title: item.title,
          url: item.url,
          snippet:
            ("description" in item && (item.description as string)) || "",
          content: ("markdown" in item && (item.markdown as string)) || undefined,
        });
      }
    }

    const elapsedMs = Date.now() - startMs;
    this.log.info({ query, elapsedMs, resultCount: results.length }, "Firecrawl search complete");
    return results;
  }

  private async extractBestTopic(
    results: FirecrawlResult[],
    originalQuery: string,
  ): Promise<PulseEvent | null> {
    const resultsText = results
      .map(
        (r, i) => {
          let entry = `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`;
          if (r.content) {
            // Truncate content to avoid blowing up the prompt
            const truncated = r.content.slice(0, 4000); // TODO is this sufficient?
            entry += `\n    Content: ${truncated}`;
          }
          return entry;
        },
      )
      .join("\n\n");

    const recentList = [...this.recentTopics].join(", ") || "(none)";

    const claudeStartMs = Date.now();
    const response = await withAiLimit(() => this.ai.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 512,
      system: `You are a news editor for a live internet radio station. Given search results, pick the single most interesting and discussion-worthy topic. Avoid topics that overlap with recently discussed ones.\n\nRecently discussed: ${recentList}`,
      messages: [
        {
          role: "user",
          content: `Search query: "${originalQuery}"\n\nResults:\n${resultsText}\n\nRespond with ONLY a JSON object (no markdown fences) with these fields:\n- topic (string): a concise topic title\n- summary (string): 2-3 sentence summary\n- urgency ("breaking" | "trending" | "interesting")\n- sourceUrl (string): the best URL from the results\n- rawContent (string | null): any extra detail for discussion\n\nIf nothing is interesting enough, respond with: null`,
        },
      ],
    }));
    const claudeElapsedMs = Date.now() - claudeStartMs;
    this.log.info({ claudeElapsedMs, originalQuery }, "Claude topic extraction complete");

    const text = firstTextBlock(response.content);
    const trimmed = text.trim();

    if (trimmed === "null" || trimmed === "") return null;

    try {
      const pulse = JSON.parse(trimmed) as PulseEvent;
      // Enrich rawContent with scraped article body if available
      if (!pulse.rawContent || pulse.rawContent === "null") {
        const matchedResult = results.find((r) => r.url === pulse.sourceUrl);
        if (matchedResult?.content) {
          pulse.rawContent = matchedResult.content.slice(0, 5000); // TODO is this sufficient?
        }
      }
      return pulse;
    } catch {
      this.log.warn(
        { raw: trimmed },
        "Failed to parse Claude response as JSON",
      );
      return null;
    }
  }

  private isDuplicate(topic: string): boolean {
    const normalised = topic.toLowerCase().trim();
    for (const existing of this.recentTopics) {
      if (existing.toLowerCase().trim() === normalised) return true;
    }
    return false;
  }

  private trackTopic(topic: string): void {
    this.recentTopics.add(topic);
    if (this.recentTopics.size > ContentPipeline.MAX_RECENT) {
      const oldest = this.recentTopics.values().next().value;
      if (oldest !== undefined) this.recentTopics.delete(oldest);
    }
  }
}
