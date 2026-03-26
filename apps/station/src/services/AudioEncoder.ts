import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import pino from "pino";
import { withEncodeLimit } from "./RuntimeLimiter";

export interface AudioStream {
  write(pcm: Buffer): void;
  readable: Readable;
  close(): void;
}

export interface AudioEncoderConfig {
  ffmpegPath?: string;
  bitrate?: number;
  outputSampleRate?: number;
}

export class AudioEncoder {
  private readonly log: pino.Logger;
  private readonly ffmpegPath: string;
  private readonly bitrate: number;
  private readonly outputSampleRate: number;

  private static readonly INPUT_FORMAT = "s16le";
  private static readonly INPUT_SAMPLE_RATE = 16000;
  private static readonly INPUT_CHANNELS = 1;

  constructor(config: AudioEncoderConfig = {}) {
    this.log = pino({ name: "AudioEncoder" });
    this.ffmpegPath = config.ffmpegPath ?? "ffmpeg";
    this.bitrate = config.bitrate ?? 128;
    this.outputSampleRate = config.outputSampleRate ?? 44100;
  }

  async encode(pcm: Buffer): Promise<Buffer> {
    const startMs = Date.now();
    this.log.info({ pcmBytes: pcm.length }, "ffmpeg encode starting");

    return withEncodeLimit(() => new Promise<Buffer>((resolve, reject) => {
      const args = this.buildFfmpegArgs();
      const proc = spawn(this.ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });

      const mp3Chunks: Buffer[] = [];
      let stderrOutput = "";

      proc.stdout.on("data", (chunk: Buffer) => mp3Chunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          this.log.error({ code, stderr: stderrOutput.slice(-500) }, "ffmpeg exited with non-zero code");
          reject(new Error(`ffmpeg exited with code ${code}`));
          return;
        }
        const mp3 = Buffer.concat(mp3Chunks);
        const elapsedMs = Date.now() - startMs;
        this.log.info({ elapsedMs, pcmBytes: pcm.length, mp3Bytes: mp3.length }, "ffmpeg encode complete");
        resolve(mp3);
      });

      proc.on("error", (err) => {
        this.log.error({ err }, "Failed to spawn ffmpeg");
        reject(err);
      });

      proc.stdin.write(pcm);
      proc.stdin.end();
    }));
  }

  createStream(): AudioStream {
    this.log.info("Creating streaming encoder");

    const args = this.buildFfmpegArgs();
    const proc = spawn(this.ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });

    proc.stderr.on("data", (chunk: Buffer) => {
      this.log.trace(chunk.toString().trim());
    });

    proc.on("error", (err) => {
      this.log.error({ err }, "Streaming ffmpeg process error");
    });

    proc.on("close", (code) => {
      this.log.info({ code }, "Streaming ffmpeg process exited");
    });

    const readable = proc.stdout as Readable;

    return {
      write(pcm: Buffer): void {
        if (proc.stdin.writable) {
          proc.stdin.write(pcm);
        }
      },
      readable,
      close(): void {
        proc.stdin.end();
        // Let ffmpeg flush its internal buffers and exit naturally.
        // Safety timeout kills the process if it doesn't exit within 2s.
        const killTimeout = setTimeout(() => {
          proc.kill("SIGTERM");
        }, 2000);
        proc.on("close", () => clearTimeout(killTimeout));
      },
    };
  }

  generateSilence(durationMs: number): Buffer {
    const sampleRate = AudioEncoder.INPUT_SAMPLE_RATE;
    const bytesPerSample = 2;
    const numSamples = Math.floor((sampleRate * durationMs) / 1000);
    return Buffer.alloc(numSamples * bytesPerSample, 0);
  }

  private buildFfmpegArgs(): string[] {
    return [
      "-hide_banner",
      "-loglevel", "warning",
      "-f", AudioEncoder.INPUT_FORMAT,
      "-ar", String(AudioEncoder.INPUT_SAMPLE_RATE),
      "-ac", String(AudioEncoder.INPUT_CHANNELS),
      "-i", "pipe:0",
      "-ar", String(this.outputSampleRate),
      "-b:a", `${this.bitrate}k`,
      "-f", "mp3",
      "pipe:1",
    ];
  }
}
