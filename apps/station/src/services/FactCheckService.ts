import Firecrawl from "@mendable/firecrawl-js";
import pino from "pino";
import type { AIClient } from "./ai";
import { FAST_MODEL } from "./ai";
import {
  extractJsonArray,
  extractJsonObject,
  firstTextBlock,
} from "./aiResponse";
import { TranscriptLine } from "../db/index";
import type { TranscriptLineRow } from "../db/index";
import { withAiLimit, withSearchLimit } from "./RuntimeLimiter";

const BATCH_SIZE = 50;
const CONFIDENCE_THRESHOLD = 0.8;
const DB_UPDATE_CONCURRENCY = 10;

interface TriageEntry {
  index: number;
  has_claim: boolean;
  confidence: number;
  claim: string | null;
}

interface TriageResult {
  flaggedLines: TranscriptLineRow[];
  searchQuery: string | null;
}

interface SearchResult {
  snippets: string;
  sourceUrls: string[];
}

interface VerifyEntry {
  index: number;
  verdict: "verified" | "disputed" | "unverifiable";
  reasoning: string;
  corrected_text: string | null;
}

interface LineStatusUpdate {
  id: string;
  data: {
    factCheckStatus: "queued" | "skipped";
    factCheckClaim?: string | null;
  };
}

export class FactCheckService {
  private readonly log: pino.Logger;
  private ai: AIClient;
  private firecrawl: Firecrawl;
  private activeChecks = new Set<string>();

  constructor(opts: { ai: AIClient }) {
    this.log = pino({ name: "fact-check" });
    this.ai = opts.ai;
    this.firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
  }

  /**
   * Fire-and-forget entry point. Triages all lines in a segment,
   * then verifies flagged claims. Never throws to caller.
   */
  async checkSegment(segmentId: string): Promise<void> {
    if (this.activeChecks.has(segmentId)) return;
    this.activeChecks.add(segmentId);

    try {
      await this.processAllBatches(segmentId);
    } catch (err) {
      this.log.error({ err, segmentId }, "Fact-check pipeline failed");
    } finally {
      this.activeChecks.delete(segmentId);
    }
  }

  /**
   * Load all pending lines, chunk into batches of 50,
   * and run each through the 3-stage pipeline.
   */
  private async processAllBatches(segmentId: string): Promise<void> {
    const lines = await TranscriptLine.findMany({
      where: { segmentId, factCheckStatus: "pending" },
      orderBy: { lineIndex: "asc" },
    });
    if (lines.length === 0) return;

    const batches = this.chunk(lines, BATCH_SIZE);
    this.log.info(
      { segmentId, totalLines: lines.length, batchCount: batches.length },
      "Starting batched fact-check",
    );

    for (let i = 0; i < batches.length; i++) {
      try {
        await this.processBatch(batches[i], i + 1, batches.length);
      } catch (err) {
        this.log.error(
          { err, batch: i + 1, batchCount: batches.length },
          "Batch failed, marking lines as skipped",
        );
        for (const line of batches[i]) {
          await TranscriptLine.update(line.id, { factCheckStatus: "skipped" });
        }
      }
    }
  }

  /**
   * Orchestrates stages 1 → 2 → 3 for a single batch.
   */
  private async processBatch(
    lines: TranscriptLineRow[],
    batchNum: number,
    totalBatches: number,
  ): Promise<void> {
    this.log.info(
      { batch: batchNum, totalBatches, lineCount: lines.length },
      "Processing batch",
    );

    // Stage 1: Triage + query generation
    const { flaggedLines, searchQuery } = await this.triageBatch(lines);

    if (flaggedLines.length === 0 || !searchQuery) {
      this.log.info(
        { batch: batchNum },
        "No flagged claims in batch, skipping search/verify",
      );
      return;
    }

    // Stage 2: Single search for the batch
    const searchResult = await this.searchBatch(searchQuery);

    if (!searchResult.snippets) {
      this.log.info(
        { batch: batchNum },
        "No search results, marking flagged lines as unverifiable",
      );
      for (const line of flaggedLines) {
        await TranscriptLine.updateVerification(
          line.id,
          "unverifiable",
          "No search results found",
          [],
        );
      }
      return;
    }

    // Stage 3: Verify + revise
    await this.verifyBatch(flaggedLines, searchResult, batchNum);
  }

  /**
   * Stage 1: Send lines to AI for triage classification + search query generation.
   * Returns flagged lines and a single search query covering all claims.
   */
  private async triageBatch(lines: TranscriptLineRow[]): Promise<TriageResult> {
    const numbered = lines
      .map((l, i) => `[${i}] (${l.host}): ${l.text}`)
      .join("\n");

    const response = await withAiLimit(() => this.ai.messages.create({
      model: FAST_MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `You are a fact-check triage assistant. For each numbered line below, determine if it contains a specific, verifiable factual claim (dates, statistics, named events, scientific facts, etc.).

Respond with ONLY a JSON object (no markdown fences) with these fields:
{
  "lines": [
    { "index": <number>, "has_claim": <boolean>, "confidence": <0.0-1.0>, "claim": "<extracted claim or null>" }
  ],
  "search_query": "<a single comprehensive search query covering all flagged claims, or null if none>"
}

Rules:
- "confidence" reflects how confident you are that the line contains a verifiable factual claim (0.0 = definitely not, 1.0 = definitely yes)
- Only extract claims that can be verified with a web search. Skip opinions, jokes, greetings, and subjective statements.
- The search_query should be a single query that covers the key factual claims for efficient batch verification.

Lines:
${numbered}`,
        },
      ],
    }));

    const text = firstTextBlock(response.content);

    let parsed: { lines: TriageEntry[]; search_query: string | null };
    try {
      parsed = JSON.parse(extractJsonObject(text));
    } catch {
      this.log.warn({ text }, "Failed to parse triage response");
      return { flaggedLines: [], searchQuery: null };
    }

    const triageEntries = parsed.lines ?? [];
    const flaggedLines: TranscriptLineRow[] = [];
    const updates: LineStatusUpdate[] = [];

    for (const entry of triageEntries) {
      const line = lines[entry.index];
      if (!line) continue;

      if (
        entry.has_claim &&
        entry.confidence >= CONFIDENCE_THRESHOLD &&
        entry.claim
      ) {
        updates.push({
          id: line.id,
          data: {
            factCheckStatus: "queued",
            factCheckClaim: entry.claim,
          },
        });
        flaggedLines.push(line);
      } else {
        updates.push({
          id: line.id,
          data: { factCheckStatus: "skipped", factCheckClaim: null },
        });
      }
    }

    // Mark any lines the AI omitted as skipped
    const mentionedIndices = new Set(triageEntries.map((e) => e.index));
    for (let i = 0; i < lines.length; i++) {
      if (!mentionedIndices.has(i)) {
        updates.push({
          id: lines[i].id,
          data: {
            factCheckStatus: "skipped",
            factCheckClaim: null,
          },
        });
      }
    }

    await this.applyLineStatusUpdates(updates);

    this.log.info(
      { total: lines.length, flagged: flaggedLines.length },
      "Triage complete",
    );

    return { flaggedLines, searchQuery: parsed.search_query };
  }

  /**
   * Stage 2: Single Firecrawl search using the AI-generated query.
   * Follows ContentPipeline pattern for parsing .news/.web arrays with .data fallback.
   */
  private async searchBatch(query: string): Promise<SearchResult> {
    const startMs = Date.now();
    this.log.info({ query }, "Batch search starting");

    const data = await withSearchLimit(() => this.firecrawl.search(query, {
      limit: 8,
      sources: ["web", "news"],
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    }));

    const items: Array<{ url: string; text: string }> = [];

    // Parse .news and .web arrays (ContentPipeline pattern)
    for (const item of (data as any).news ?? []) {
      if (item.url) {
        items.push({
          url: item.url,
          text:
            item.markdown?.slice(0, 500) ??
            item.snippet ??
            item.description ??
            "",
        });
      }
    }

    for (const item of (data as any).web ?? []) {
      if (item.url) {
        items.push({
          url: item.url,
          text: item.markdown?.slice(0, 500) ?? item.description ?? "",
        });
      }
    }

    // Fallback to .data array
    if (items.length === 0) {
      for (const item of (data as any).data ?? []) {
        if (item.url) {
          items.push({
            url: item.url,
            text: item.markdown?.slice(0, 500) ?? item.description ?? "",
          });
        }
      }
    }

    const snippets = items
      .map((r, i) => `[${i + 1}] ${r.url}\n${r.text}`)
      .join("\n\n");

    const sourceUrls = items.map((r) => r.url).filter(Boolean);

    const elapsedMs = Date.now() - startMs;
    this.log.info(
      { query, elapsedMs, resultCount: items.length },
      "Batch search complete",
    );

    return { snippets, sourceUrls };
  }

  /**
   * Stage 3: Send flagged lines + search snippets to AI for verification.
   * Each line gets a verdict, reasoning, and optional corrected text.
   */
  private async verifyBatch(
    flaggedLines: TranscriptLineRow[],
    search: SearchResult,
    batchNum: number,
  ): Promise<void> {
    const numbered = flaggedLines
      .map(
        (l, i) =>
          `[${i}] (${l.host}) claim: "${l.factCheckClaim}"\n    original: "${l.text}"`,
      )
      .join("\n");

    const response = await withAiLimit(() => this.ai.messages.create({
      model: FAST_MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `You are a fact-checker. Evaluate whether each claim below is supported by the search results.

Claims to verify:
${numbered}

Search results:
${search.snippets}

Respond with ONLY a JSON array (no markdown fences). For each claim:
{ "index": <number>, "verdict": "verified" | "disputed" | "unverifiable", "reasoning": "<brief explanation>", "corrected_text": "<if disputed, a corrected version of the original statement preserving the speaker's style and tone, otherwise null>" }`,
        },
      ],
    }));

    const text = firstTextBlock(response.content);

    let results: VerifyEntry[];
    try {
      results = JSON.parse(extractJsonArray(text));
    } catch {
      this.log.warn(
        { batch: batchNum, text },
        "Failed to parse verification response",
      );
      for (const line of flaggedLines) {
        await TranscriptLine.updateVerification(
          line.id,
          "error",
          "Parse error",
          search.sourceUrls,
        );
      }
      return;
    }

    const processedIndices = new Set<number>();
    const verifyUpdates: Array<() => Promise<unknown>> = [];

    for (const r of results) {
      const line = flaggedLines[r.index];
      if (!line) continue;

      const verdict = (
        ["verified", "disputed", "unverifiable"].includes(r.verdict)
          ? r.verdict
          : "unverifiable"
      ) as "verified" | "disputed" | "unverifiable";

      verifyUpdates.push(() =>
        TranscriptLine.updateVerification(
          line.id,
          verdict,
          r.reasoning,
          search.sourceUrls,
          verdict === "disputed" ? r.corrected_text : null,
        ),
      );

      processedIndices.add(r.index);

      this.log.info(
        {
          lineId: line.id,
          claim: line.factCheckClaim,
          verdict,
          reasoning: r.reasoning,
        },
        "Line verified",
      );
    }

    // Lines the AI omitted → mark as unverifiable
    for (let i = 0; i < flaggedLines.length; i++) {
      if (!processedIndices.has(i)) {
        verifyUpdates.push(() =>
          TranscriptLine.updateVerification(
            flaggedLines[i].id,
            "unverifiable",
            "Omitted from verification response",
            search.sourceUrls,
          ),
        );
      }
    }

    await this.applyVerificationUpdates(verifyUpdates);
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private async applyLineStatusUpdates(updates: LineStatusUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    for (let i = 0; i < updates.length; i += DB_UPDATE_CONCURRENCY) {
      const group = updates.slice(i, i + DB_UPDATE_CONCURRENCY);
      const settled = await Promise.allSettled(
        group.map((u) => TranscriptLine.update(u.id, u.data)),
      );
      for (let j = 0; j < settled.length; j++) {
        const outcome = settled[j];
        if (outcome.status === "rejected") {
          this.log.error(
            { err: outcome.reason, lineId: group[j].id },
            "Failed to update fact-check line status",
          );
        }
      }
    }
  }

  private async applyVerificationUpdates(updates: Array<() => Promise<unknown>>): Promise<void> {
    if (updates.length === 0) return;
    for (let i = 0; i < updates.length; i += DB_UPDATE_CONCURRENCY) {
      const group = updates.slice(i, i + DB_UPDATE_CONCURRENCY);
      const settled = await Promise.allSettled(group.map((fn) => fn()));
      for (let j = 0; j < settled.length; j++) {
        const outcome = settled[j];
        if (outcome.status === "rejected") {
          this.log.error(
            { err: outcome.reason },
            "Failed to persist verification update",
          );
        }
      }
    }
  }
}
