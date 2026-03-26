import pino from "pino";

import type { ScriptLine } from "../services/ScriptGenerator";
import type { TTSService } from "../services/TTSService";
import type { AudioEncoder } from "../services/AudioEncoder";
import type { StreamBroadcaster } from "../services/StreamBroadcaster";
import { SegmentAudioBatcher, type ScriptBatch } from "./SegmentAudioBatcher";
import type { StationConfigHost } from "./types";

export interface AudioPipelineConfig {
  ttsService: TTSService;
  audioEncoder: AudioEncoder;
  broadcaster: StreamBroadcaster;
  mp3BitrateKbps: number;
  batchMaxChars: number;
  batchMaxLines: number;
  hosts: StationConfigHost[];
}

export class AudioPipeline {
  private static readonly PCM_SAMPLE_RATE = 16000;

  private readonly log = pino({ name: "AudioPipeline" });
  readonly ttsService: TTSService;
  readonly audioEncoder: AudioEncoder;
  readonly broadcaster: StreamBroadcaster;
  private readonly mp3BitrateKbps: number;
  private readonly batcher: SegmentAudioBatcher;
  private readonly hosts: StationConfigHost[];

  constructor(config: AudioPipelineConfig) {
    this.ttsService = config.ttsService;
    this.audioEncoder = config.audioEncoder;
    this.broadcaster = config.broadcaster;
    this.mp3BitrateKbps = config.mp3BitrateKbps;
    this.batcher = new SegmentAudioBatcher(
      config.batchMaxChars,
      config.batchMaxLines,
    );
    this.hosts = config.hosts;
  }

  resolveVoiceId(hostName: string): string {
    const host = this.hosts.find((h) => h.name === hostName);
    return host?.voiceId ?? this.hosts[0]?.voiceId ?? "default";
  }

  buildBatch(lines: ScriptLine[], startIndex: number): ScriptBatch {
    return this.batcher.build(lines, startIndex);
  }

  batchTTS(lines: ScriptLine[], startIndex: number): Promise<Buffer> {
    const batch = this.batcher.build(lines, startIndex);
    return this.ttsService.synthesize(
      batch.text,
      this.resolveVoiceId(batch.host),
      batch.emotion,
    );
  }

  async encodePcm(pcm: Buffer): Promise<Buffer> {
    return this.audioEncoder.encode(pcm);
  }

  async pushMp3(mp3: Buffer): Promise<void> {
    await this.broadcaster.pushAudio(mp3);
  }

  async pushSilence(durationMs: number): Promise<void> {
    await this.broadcaster.pushSilence(durationMs);
  }

  set broadcasting(value: boolean) {
    this.broadcaster.broadcasting = value;
  }

  computeAudioDurationMs(mp3: Buffer): number {
    return (mp3.length * 8) / this.mp3BitrateKbps;
  }

  /**
   * Synthesize a single line and broadcast. Returns the MP3 buffer.
   * Used during call conversations where batching is not needed.
   */
  async synthesizeAndPush(line: ScriptLine): Promise<Buffer> {
    const pcm = await this.ttsService.synthesize(
      line.text,
      this.resolveVoiceId(line.host),
      line.emotion,
    );
    const mp3 = await this.audioEncoder.encode(pcm);
    await this.broadcaster.pushAudio(mp3);
    return mp3;
  }

  /**
   * Streams a prepared segment's script lines with overlapped TTS/encoding.
   * Extracted verbatim from StationSegmentAiringRunner.
   */
  async streamSegment(args: {
    scriptLines: ScriptLine[];
    initialTts: Promise<Buffer> | null;
    shouldInterrupt: () => boolean;
    sleep: (ms: number) => Promise<void>;
    onBatchHost: (host: string) => void;
    onAudioChunkPushed: (chunk: Buffer) => void;
    onSegmentProgress: (progress: number) => void;
    onStageOnePrefetch: () => void;
    checkpointPositions?: number[];
    onApproachingCheckpoint?: (segmentProgress: number) => void;
    onCheckpoint?: (segmentProgress: number) => Promise<{ lines: ScriptLine[]; audio: Buffer[] } | null>;
    shouldPrefetchNext: (segmentProgress: number) => boolean;
    triggerPrefetch: (segmentProgress: number) => void;
    onLineSpoken: (lineIndex: number, line: ScriptLine) => void;
  }): Promise<{ interrupted: boolean }> {
    let pendingTts = args.initialTts;
    let pendingEncode: Promise<Buffer> | null = null;
    let i = 0;
    let stageOnePrefetchTriggered = false;
    let prefetchTriggered = false;

    const aiCheckpoints = args.checkpointPositions ?? [];
    let nextAiCheckpoint = 0;

    // Compute lookahead positions: midpoint between previous checkpoint (or 0) and next checkpoint.
    // Firing onApproachingCheckpoint here gives pre-gen time before the actual checkpoint.
    const lookaheadPositions: number[] = [];
    for (let cp = 0; cp < aiCheckpoints.length; cp++) {
      const prev = cp === 0 ? 0 : aiCheckpoints[cp - 1];
      lookaheadPositions.push(Math.floor((prev + aiCheckpoints[cp]) / 2));
    }
    let nextLookahead = 0;

    this.broadcaster.broadcasting = true;

    while (i < args.scriptLines.length) {
      if (args.shouldInterrupt()) {
        this.log.info({ lineIndex: i }, "Segment streaming interrupted");
        return { interrupted: true };
      }

      // AI checkpoint handling — play transition if ready
      if (nextAiCheckpoint < aiCheckpoints.length && i >= aiCheckpoints[nextAiCheckpoint]) {
        nextAiCheckpoint++;
        await this.broadcaster.pushSilence(500);

        const progress = Math.min(1, i / args.scriptLines.length);

        if (args.onCheckpoint) {
          const injection = await args.onCheckpoint(progress);
          if (injection && injection.lines.length > 0 && injection.audio.length === injection.lines.length) {
            this.log.info(
              { lineIndex: i, injectedLines: injection.lines.length },
              "Playing call transition at AI checkpoint",
            );
            for (let j = 0; j < injection.lines.length; j++) {
              await this.broadcaster.pushAudio(injection.audio[j]);
              args.onAudioChunkPushed(injection.audio[j]);
              args.onLineSpoken(-1, injection.lines[j]);
              const audioDurMs = (injection.audio[j].length * 8) / this.mp3BitrateKbps;
              await args.sleep(audioDurMs);
            }
            return { interrupted: true };
          }
        }
      }

      const batch = this.batcher.build(args.scriptLines, i);
      const batchHost = batch.host;
      const batchEnd = batch.endIndex;

      args.onBatchHost(batchHost);

      let mp3Buffer: Buffer;
      if (pendingEncode) {
        mp3Buffer = await pendingEncode;
        pendingEncode = null;
      } else {
        const pcmBuffer = await pendingTts!;
        const audioDurMs = Math.round(
          (pcmBuffer.length / 2 / AudioPipeline.PCM_SAMPLE_RATE) * 1000,
        );
        this.log.info(
          {
            host: batchHost,
            pcmBytes: pcmBuffer.length,
            audioDurMs,
            batchLines: batchEnd - i + 1,
          },
          "TTS batch ready",
        );
        mp3Buffer = await this.audioEncoder.encode(pcmBuffer);
      }

      const pushTime = Date.now();
      await this.broadcaster.pushAudio(mp3Buffer);
      args.onAudioChunkPushed(mp3Buffer);

      const audioDurationMs = (mp3Buffer.length * 8) / this.mp3BitrateKbps;
      const nextBatchStart = batchEnd + 1;

      if (nextBatchStart < args.scriptLines.length) {
        pendingTts = this.batchTTS(args.scriptLines, nextBatchStart);
        pendingEncode = pendingTts.then((pcm) => this.audioEncoder.encode(pcm));
      } else {
        pendingTts = null;
        pendingEncode = null;
      }

      const segmentProgress = Math.min(
        1,
        nextBatchStart / args.scriptLines.length,
      );
      args.onSegmentProgress(segmentProgress);

      if (!stageOnePrefetchTriggered && segmentProgress >= 0.45) {
        stageOnePrefetchTriggered = true;
        args.onStageOnePrefetch();
      }

      // Lookahead: approaching the next checkpoint — evaluate calls early
      if (
        args.onApproachingCheckpoint &&
        nextLookahead < lookaheadPositions.length &&
        nextBatchStart >= lookaheadPositions[nextLookahead]
      ) {
        nextLookahead++;
        args.onApproachingCheckpoint(segmentProgress);
      }

      if (!prefetchTriggered && args.shouldPrefetchNext(segmentProgress)) {
        prefetchTriggered = true;
        args.triggerPrefetch(segmentProgress);
      }

      const elapsed = Date.now() - pushTime;
      const remaining = audioDurationMs - elapsed;
      if (remaining > 0) await args.sleep(remaining);

      for (let k = i; k <= batchEnd; k++) {
        args.onLineSpoken(k, args.scriptLines[k]);
      }
      i = nextBatchStart;
    }

    return { interrupted: false };
  }
}
