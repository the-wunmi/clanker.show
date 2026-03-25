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
  private readonly log = pino({ name: "ElevenLabsSTT" });
  private ws: WebSocket | null = null;
  private closed = false;

  async startStream(): Promise<void> {
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

    ws.addEventListener("open", () => {
      this.log.info("ElevenLabs STT stream opened");
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

  sendAudio(pcm: Buffer): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN)
      return;

    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: pcm.toString("base64"),
        commit: false,
        sample_rate: 16000,
      }),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // ignore close errors
    }
    this.ws = null;
    this.removeAllListeners();
  }
}
