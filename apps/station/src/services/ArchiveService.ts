import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWriteStream, type WriteStream } from "node:fs";
import { once } from "node:events";
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

interface ActiveArchive {
  stationId: string;
  segmentId: string;
  topic: string;
  filePath: string;
  stream: WriteStream;
  writeChain: Promise<void>;
}

interface SegmentArchiveMeta {
  segmentId: string;
  topic: string;
  sourceUrl?: string;
  programId?: string;
}

export class ArchiveService {
  private readonly log: pino.Logger;
  private readonly archivePath: string;
  private readonly activeArchives = new Map<string, ActiveArchive>();

  constructor(config: ArchiveServiceConfig = {}) {
    this.log = pino({ name: "ArchiveService" });
    this.archivePath =
      config.archivePath ?? process.env.ARCHIVE_PATH ?? "./data/archive";
  }

  async startSegmentArchive(
    stationId: string,
    segment: SegmentArchiveMeta,
  ): Promise<void> {
    if (this.activeArchives.has(segment.segmentId)) {
      this.log.warn({ segmentId: segment.segmentId }, "Archive stream already active");
      return;
    }

    const stationDir = join(this.archivePath, stationId);
    await mkdir(stationDir, { recursive: true });
    const filePath = join(stationDir, `${segment.segmentId}.mp3`);
    const stream = createWriteStream(filePath);
    stream.on("error", (err) => {
      this.log.error({ err, segmentId: segment.segmentId }, "Archive stream error");
      this.activeArchives.delete(segment.segmentId);
    });

    this.activeArchives.set(segment.segmentId, {
      stationId,
      segmentId: segment.segmentId,
      topic: segment.topic,
      filePath,
      stream,
      writeChain: Promise.resolve(),
    });

    this.log.info(
      { stationId, segmentId: segment.segmentId, topic: segment.topic, filePath },
      "Started segment archive stream",
    );
  }

  async appendSegmentAudio(segmentId: string, chunk: Buffer): Promise<void> {
    const archive = this.activeArchives.get(segmentId);
    if (!archive) {
      this.log.warn({ segmentId }, "Cannot append audio, archive session not found");
      return;
    }

    archive.writeChain = archive.writeChain
      .then(async () => {
        const writable = archive.stream.write(chunk);
        if (!writable) {
          await once(archive.stream, "drain");
        }
      })
      .catch((err) => {
        this.log.error({ err, segmentId }, "Failed writing archive chunk");
      });
    await archive.writeChain;
  }

  async finishSegmentArchive(segmentId: string, durationMs: number): Promise<string | null> {
    const archive = this.activeArchives.get(segmentId);
    if (!archive) {
      this.log.warn({ segmentId }, "Cannot finish archive, archive session not found");
      return null;
    }

    this.activeArchives.delete(segmentId);
    await archive.writeChain;
    archive.stream.end();
    await once(archive.stream, "finish");

    try {
      await Segment.update(segmentId, { audioPath: archive.filePath, durationMs });
    } catch (err) {
      this.log.error({ err, segmentId }, "Failed to update segment audio in DB");
    }

    this.log.info(
      { segmentId, topic: archive.topic, filePath: archive.filePath, durationMs },
      "Segment archive stream completed",
    );
    return segmentId;
  }

  async abortSegmentArchive(segmentId: string): Promise<void> {
    const archive = this.activeArchives.get(segmentId);
    if (!archive) return;
    this.activeArchives.delete(segmentId);
    archive.stream.destroy();
    this.log.warn({ segmentId }, "Aborted segment archive stream");
  }

  async abortStationArchives(stationId: string): Promise<void> {
    const aborts: Promise<void>[] = [];
    for (const [segmentId, archive] of this.activeArchives.entries()) {
      if (archive.stationId === stationId) {
        aborts.push(this.abortSegmentArchive(segmentId));
      }
    }
    await Promise.allSettled(aborts);
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
