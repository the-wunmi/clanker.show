import pino from "pino";

import type { ScriptLine } from "../services/ScriptGenerator";
import type { TTSService } from "../services/TTSService";
import type { AudioEncoder, AudioStream } from "../services/AudioEncoder";
import type { IcecastPublisher } from "../services/IcecastPublisher";
import { SegmentAudioBatcher, type ScriptBatch } from "./SegmentAudioBatcher";
import type { StationConfigHost } from "./types";

export interface AudioPipelineConfig {
  ttsService: TTSService;
  audioEncoder: AudioEncoder;
  icecastPublisher: IcecastPublisher;
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
  readonly icecastPublisher: IcecastPublisher;
  private readonly mp3BitrateKbps: number;
  private readonly batcher: SegmentAudioBatcher;
  private readonly hosts: StationConfigHost[];

  constructor(config: AudioPipelineConfig) {
    this.ttsService = config.ttsService;
    this.audioEncoder = config.audioEncoder;
    this.icecastPublisher = config.icecastPublisher;
    this.mp3BitrateKbps = config.mp3BitrateKbps;
    this.batcher = new SegmentAudioBatcher(config.batchMaxChars, config.batchMaxLines);
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
    await this.icecastPublisher.pushAudio(mp3);
  }

  async pushSilence(durationMs: number): Promise<void> {
    await this.icecastPublisher.pushSilence(durationMs);
  }

  set broadcasting(value: boolean) {
    this.icecastPublisher.broadcasting = value;
  }

  createCallerStream(): AudioStream {
    const stream = this.audioEncoder.createStream();
    stream.readable.on("data", (chunk: Buffer) => {
      void this.icecastPublisher.pushAudio(chunk);
    });
    return stream;
  }

  computeAudioDurationMs(mp3: Buffer): number {
    return (mp3.length * 8) / this.mp3BitrateKbps;
  }

  /**
   * Synthesize a single line and push to Icecast. Returns the MP3 buffer.
   * Used during call conversations where batching is not needed.
   */
  async synthesizeAndPush(line: ScriptLine): Promise<Buffer> {
    const pcm = await this.ttsService.synthesize(
      line.text,
      this.resolveVoiceId(line.host),
      line.emotion,
    );
    const mp3 = await this.audioEncoder.encode(pcm);
    await this.icecastPublisher.pushAudio(mp3);
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
    shouldEvaluateCall: (args: { checkpointReached: boolean; hasInFlightCheck: boolean }) => boolean;
    evaluateCallOpportunity: (segmentProgress: number) => Promise<void>;
    shouldPrefetchNext: (segmentProgress: number) => boolean;
    triggerPrefetch: (segmentProgress: number) => void;
    onLineSpoken: (lineIndex: number, line: ScriptLine) => void;
  }): Promise<{ interrupted: boolean }> {
    let pendingTts = args.initialTts;
    let pendingEncode: Promise<Buffer> | null = null;
    let i = 0;
    let stageOnePrefetchTriggered = false;
    let prefetchTriggered = false;

    const callCheckPoints = this.computeCallCheckPoints(args.scriptLines.length);
    let nextCallCheck = 0;
    let callCheckPromise: Promise<void> | null = null;

    this.icecastPublisher.broadcasting = true;

    while (i < args.scriptLines.length) {
      if (args.shouldInterrupt()) {
        this.log.info({ lineIndex: i }, "Segment streaming interrupted");
        return { interrupted: true };
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
          { host: batchHost, pcmBytes: pcmBuffer.length, audioDurMs, batchLines: batchEnd - i + 1 },
          "TTS batch ready",
        );
        mp3Buffer = await this.audioEncoder.encode(pcmBuffer);
      }

      const pushTime = Date.now();
      await this.icecastPublisher.pushAudio(mp3Buffer);
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

      const segmentProgress = Math.min(1, nextBatchStart / args.scriptLines.length);
      args.onSegmentProgress(segmentProgress);

      if (!stageOnePrefetchTriggered && segmentProgress >= 0.45) {
        stageOnePrefetchTriggered = true;
        args.onStageOnePrefetch();
      }

      if (
        args.shouldEvaluateCall({
          checkpointReached:
            nextCallCheck < callCheckPoints.length &&
            nextBatchStart >= callCheckPoints[nextCallCheck],
          hasInFlightCheck: Boolean(callCheckPromise),
        })
      ) {
        nextCallCheck++;
        callCheckPromise = args.evaluateCallOpportunity(segmentProgress)
          .catch((err) => this.log.warn({ err }, "Call opportunity check failed"))
          .finally(() => { callCheckPromise = null; });
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

  private computeCallCheckPoints(lineCount: number): number[] {
    if (lineCount <= 16) {
      return [Math.floor(lineCount * 0.5)];
    }
    if (lineCount <= 40) {
      return [Math.floor(lineCount * 0.33), Math.floor(lineCount * 0.66)];
    }
    return [
      Math.floor(lineCount * 0.25),
      Math.floor(lineCount * 0.5),
      Math.floor(lineCount * 0.75),
    ];
  }
}
