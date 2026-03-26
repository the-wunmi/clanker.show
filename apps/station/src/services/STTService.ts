import { EventEmitter } from "events";
import pino from "pino";

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  confidence: number;
}

const BASE_URL = "https://api.elevenlabs.io";
const WS_BASE = "wss://api.elevenlabs.io";

export class STTService extends EventEmitter {
  private static readonly FLUSH_INTERVAL_MS = 100;
  private static readonly MAX_PREOPEN_BUFFER_BYTES = 320_000; // ~10s at 16kHz PCM16 mono

  private readonly log = pino({ name: "ElevenLabsSTT" });
  private ws: WebSocket | null = null;
  private closed = false;
  private audioBuffer: Buffer[] = [];
  private preOpenBuffer: Buffer[] = [];
  private preOpenBufferBytes = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  async startStream(): Promise<void> {
    this.log.info("Starting STT stream — fetching token");
    const tokenStartMs = Date.now();
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is not set");
    }

    // Get a single-use token so we can authenticate via query param
    const tokenRes = await fetch(
      `${BASE_URL}/v1/single-use-token/realtime_scribe`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey },
      },
    );
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(
        `Failed to get ElevenLabs STT token: ${tokenRes.status} ${body}`,
      );
    }
    const { token } = (await tokenRes.json()) as { token: string };
    this.log.info({ tokenElapsedMs: Date.now() - tokenStartMs }, "STT token acquired, opening WebSocket");

    const params = new URLSearchParams({
      token,
      model_id: "scribe_v2_realtime",
      audio_format: "pcm_16000",
      commit_strategy: "vad",
      vad_silence_threshold_secs: "1.5",
      language_code: "en",
    });

    const url = `${WS_BASE}/v1/speech-to-text/realtime?${params}`;
    const ws = new WebSocket(url);

    // Wait for the WebSocket to actually open before returning,
    // so callers can start sending audio immediately after await.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("STT WebSocket open timed out after 10s"));
      }, 10_000);

      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        this.log.info(
          { wsElapsedMs: Date.now() - tokenStartMs },
          "ElevenLabs STT stream opened and ready",
        );
        this.flushPreOpenAudio();
        resolve();
      }, { once: true });

      ws.addEventListener("error", (event) => {
        clearTimeout(timeout);
        reject(new Error(`STT WebSocket failed to open: ${String(event)}`));
      }, { once: true });
    });

    ws.addEventListener("message", (event) => {
      try {
        const data =
          typeof event.data === "string"
            ? JSON.parse(event.data)
            : JSON.parse(event.data.toString());

        switch (data.message_type) {
          case "session_started":
            this.log.info(
              { sessionId: data.session_id },
              "ElevenLabs STT session started",
            );
            break;

          case "partial_transcript": {
            const text = (data.text ?? "").trim();
            if (!text) break;
            this.log.debug({ textLen: text.length }, "STT partial transcript");
            this.emit("transcript", {
              text,
              isFinal: false,
              confidence: 1,
            } satisfies TranscriptEvent);
            break;
          }

          case "committed_transcript":
          case "committed_transcript_with_timestamps": {
            const text = (data.text ?? "").trim();
            if (!text) break;
            this.log.info({ textLen: text.length, text: text.slice(0, 100) }, "STT committed transcript");
            this.emit("transcript", {
              text,
              isFinal: true,
              confidence: 1,
            } satisfies TranscriptEvent);
            // A committed transcript in VAD mode signals that the speaker
            // finished an utterance (silence detected).
            this.emit("utterance-end");
            break;
          }

          default:
            if (data.error) {
              this.log.error(
                { type: data.message_type, error: data.error },
                "ElevenLabs STT error message",
              );
              this.emit("error", new Error(data.error));
            }
            break;
        }
      } catch (err) {
        this.log.error({ err }, "Failed to parse ElevenLabs STT message");
      }
    });

    ws.addEventListener("error", (event) => {
      this.log.error({ event }, "ElevenLabs STT stream error");
      this.emit("error", event);
    });

    ws.addEventListener("close", () => {
      this.log.info("ElevenLabs STT stream closed");
    });

    this.ws = ws;
  }

  /**
   * Re-open the STT WebSocket if it was closed by the server (e.g. inactivity
   * timeout). Safe to call when the stream is already open — it's a no-op.
   */
  async ensureStream(): Promise<void> {
    if (this.closed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.log.info("STT stream lost, reconnecting");
    // Clean up dead socket
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;

    await this.startStream();
  }

  private droppedAudioBytes = 0;
  private sentAudioBytes = 0;
  private lastAudioStatsMs = 0;

  sendAudio(pcm: Buffer): void {
    if (this.closed) {
      this.droppedAudioBytes += pcm.length;
      // Log periodically to avoid spam
      const now = Date.now();
      if (now - this.lastAudioStatsMs > 3000) {
        this.lastAudioStatsMs = now;
        this.log.warn(
          {
            droppedBytes: this.droppedAudioBytes,
            wsState: this.ws?.readyState ?? "null",
            closed: this.closed,
          },
          "STT audio dropped — WebSocket not ready",
        );
      }
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.preOpenBuffer.push(pcm);
      this.preOpenBufferBytes += pcm.length;
      while (
        this.preOpenBufferBytes > STTService.MAX_PREOPEN_BUFFER_BYTES &&
        this.preOpenBuffer.length > 0
      ) {
        const dropped = this.preOpenBuffer.shift();
        if (!dropped) break;
        this.preOpenBufferBytes -= dropped.length;
      }
      return;
    }

    this.audioBuffer.push(pcm);
    this.sentAudioBytes += pcm.length;

    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushAudio(), STTService.FLUSH_INTERVAL_MS);
    }
  }

  private flushAudio(): void {
    if (this.audioBuffer.length === 0) {
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }
      return;
    }

    const combined = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];

    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.droppedAudioBytes += combined.length;
      this.log.warn(
        { droppedBytes: combined.length, totalDropped: this.droppedAudioBytes },
        "STT flush dropped — WebSocket not ready",
      );
      return;
    }

    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: combined.toString("base64"),
        commit: false,
        sample_rate: 16000,
      }),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushAudio();
    this.audioBuffer = [];
    this.preOpenBuffer = [];
    this.preOpenBufferBytes = 0;
    try {
      this.ws?.close();
    } catch {
      // ignore close errors
    }
    this.ws = null;
    this.removeAllListeners();
  }

  private flushPreOpenAudio(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.preOpenBuffer.length === 0) return;

    this.log.info(
      { chunks: this.preOpenBuffer.length, bytes: this.preOpenBufferBytes },
      "Flushing buffered pre-open STT audio",
    );
    this.audioBuffer.push(...this.preOpenBuffer);
    this.sentAudioBytes += this.preOpenBufferBytes;
    this.preOpenBuffer = [];
    this.preOpenBufferBytes = 0;
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushAudio(), STTService.FLUSH_INTERVAL_MS);
    }
  }
}
