import pino from "pino";
import type { AudioEncoder } from "./AudioEncoder";

export interface StreamBroadcasterConfig {
  audioEncoder: AudioEncoder;
  onAudio: (mp3: Buffer) => void;
}

export class StreamBroadcaster {
  private readonly log = pino({ name: "StreamBroadcaster" });
  private readonly audioEncoder: AudioEncoder;
  private readonly onAudio: (mp3: Buffer) => void;
  private readonly silenceCache = new Map<number, Buffer>();
  private writeChain: Promise<void> = Promise.resolve();
  private _broadcasting = false;

  constructor(config: StreamBroadcasterConfig) {
    this.audioEncoder = config.audioEncoder;
    this.onAudio = config.onAudio;
  }

  get connected(): boolean {
    return true;
  }

  set broadcasting(value: boolean) {
    this._broadcasting = value;
  }

  async connect(_streamKey: string): Promise<void> {
    // No-op for websocket fanout transport.
  }

  async pushAudio(mp3Buffer: Buffer): Promise<void> {
    this.writeChain = this.writeChain
      .then(async () => {
        this.onAudio(mp3Buffer);
      })
      .catch((err) => {
        this.log.warn({ err }, "Failed to publish stream audio");
      });
    return this.writeChain;
  }

  async pushSilence(durationMs: number): Promise<void> {
    try {
      let mp3 = this.silenceCache.get(durationMs);
      if (!mp3) {
        const pcm = this.audioEncoder.generateSilence(durationMs);
        mp3 = await this.audioEncoder.encode(pcm);
        this.silenceCache.set(durationMs, mp3);
      }
      await this.pushAudio(mp3);
    } catch (err) {
      this.log.warn({ err, durationMs }, "Failed to publish silence");
    }
  }

  disconnect(): void {
    this.silenceCache.clear();
    this._broadcasting = false;
  }
}
