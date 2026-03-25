import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { Segment } from "../db/index";
import type { ScriptLine } from "./ScriptGenerator";

export interface SegmentData {
  segmentId: string;
  topic: string;
  transcript: ScriptLine[];
  audio: Buffer;
  durationMs: number;
  sourceUrl?: string;
  programId?: string;
}

export interface ArchiveServiceConfig {
  archivePath?: string;
}

export class ArchiveService {
  private readonly log: pino.Logger;
  private readonly archivePath: string;

  constructor(config: ArchiveServiceConfig = {}) {
    this.log = pino({ name: "ArchiveService" });
    this.archivePath =
      config.archivePath ?? process.env.ARCHIVE_PATH ?? "./data/archive";
  }

  async saveSegment(
    stationId: string,
    segment: SegmentData,
  ): Promise<string> {
    const { segmentId } = segment;

    this.log.info(
      { stationId, segmentId, topic: segment.topic, durationMs: segment.durationMs },
      "Saving segment audio",
    );

    const stationDir = join(this.archivePath, stationId);
    await mkdir(stationDir, { recursive: true });

    const filePath = join(stationDir, `${segmentId}.mp3`);
    await writeFile(filePath, segment.audio);
    this.log.info({ filePath, bytes: segment.audio.length }, "Wrote MP3 file");

    try {
      await Segment.update(segmentId, { audioPath: filePath, durationMs: segment.durationMs });
    } catch (err) {
      this.log.error({ err, segmentId }, "Failed to update segment audio in DB");
    }

    this.log.info({ segmentId, filePath }, "Segment audio saved successfully");
    return segmentId;
  }
}
