import type {
  Activity,
  ActivityServices,
  PreparedActivity,
  ActivityRunResult,
} from "../Activity";
import type { ScriptGenerator, ScriptLine } from "../../services/ScriptGenerator";

// --- Decision + Prepared types ---

export interface AdDecision {
  kind: "ad";
  adId: string;
  adText: string;
  sponsorName: string;
}

export interface PreparedAd extends PreparedActivity {
  kind: "ad";
  adId: string;
  scriptLines: ScriptLine[];
}

// --- Dependencies ---

export interface AdActivityDeps {
  scriptGenerator: ScriptGenerator;
  hosts: Array<{ name: string; personality: string; voiceId?: string }>;
  stationName: string;
  onAdAired?: (adId: string) => void;
}

export class AdActivity implements Activity<AdDecision, PreparedAd> {
  kind = "ad" as const;

  constructor(private readonly deps: AdActivityDeps) {}

  async prepare(decision: AdDecision, services: ActivityServices): Promise<PreparedAd> {
    services.log.info({ adId: decision.adId, sponsor: decision.sponsorName }, "Preparing ad break");

    // Generate a natural-sounding ad read using the hosts
    const scriptLines: ScriptLine[] = [
      {
        host: this.deps.hosts[0]?.name ?? "Host",
        text: `Quick break — this segment is brought to you by ${decision.sponsorName}.`,
        emotion: "neutral",
      },
      {
        host: this.deps.hosts[0]?.name ?? "Host",
        text: decision.adText,
        emotion: "neutral",
      },
      {
        host: this.deps.hosts[1]?.name ?? this.deps.hosts[0]?.name ?? "Host",
        text: `Thanks to ${decision.sponsorName}. Alright, back to the show.`,
        emotion: "neutral",
      },
    ];

    return {
      kind: "ad",
      adId: decision.adId,
      scriptLines,
    };
  }

  async run(prepared: PreparedAd, services: ActivityServices): Promise<ActivityRunResult> {
    const { log, pipeline, shouldInterrupt, sleep, emitTranscriptLine } = services;

    log.info({ adId: prepared.adId, lineCount: prepared.scriptLines.length }, "Airing ad break");

    pipeline.broadcasting = true;

    try {
      for (const line of prepared.scriptLines) {
        if (shouldInterrupt()) {
          log.info({ adId: prepared.adId }, "Ad break interrupted");
          return { interrupted: true, kind: "ad" };
        }

        const mp3 = await pipeline.synthesizeAndPush(line);
        emitTranscriptLine(line);
        const audioDurationMs = pipeline.computeAudioDurationMs(mp3);
        await sleep(audioDurationMs);
      }

      this.deps.onAdAired?.(prepared.adId);
      log.info({ adId: prepared.adId }, "Ad break complete");
    } finally {
      pipeline.broadcasting = false;
    }

    return { interrupted: false, kind: "ad" };
  }
}
