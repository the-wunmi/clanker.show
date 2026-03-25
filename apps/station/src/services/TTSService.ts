import { ElevenLabsClient } from "elevenlabs";
import pino from "pino";
import type { Emotion } from "./ScriptGenerator";

interface EmotionParams {
  stability: number;
  style: number;
}

export interface TTSServiceConfig {
  apiKey?: string;
  model?: string;
}

const EMOTION_MAP: Record<Emotion, EmotionParams> = {
  neutral: { stability: 0.5, style: 0.3 },
  excited: { stability: 0.3, style: 0.8 },
  skeptical: { stability: 0.7, style: 0.5 },
  amused: { stability: 0.4, style: 0.7 },
  serious: { stability: 0.8, style: 0.2 },
};

export class TTSService {
  private readonly log: pino.Logger;
  private readonly client: ElevenLabsClient;
  private readonly model: string;

  constructor(config: TTSServiceConfig = {}) {
    this.log = pino({ name: "TTSService" });
    this.client = new ElevenLabsClient({
      apiKey: config.apiKey ?? process.env.ELEVENLABS_API_KEY,
    });
    this.model = config.model ?? "eleven_flash_v2_5";
  }

  async synthesize(
    text: string,
    voiceId: string,
    emotion: string,
  ): Promise<Buffer> {
    const params = EMOTION_MAP[emotion as Emotion] ?? EMOTION_MAP.neutral;
    const startMs = Date.now();

    this.log.info(
      { voiceId, emotion, textLength: text.length },
      "ElevenLabs TTS request starting",
    );

    const audioStream = await this.client.textToSpeech.convert(voiceId, {
      text,
      model_id: this.model,
      output_format: "pcm_16000",
      voice_settings: {
        stability: params.stability,
        style: params.style,
        similarity_boost: 0.75,
      },
    });

    const apiElapsedMs = Date.now() - startMs;
    this.log.info({ voiceId, apiElapsedMs }, "ElevenLabs API responded, streaming chunks");

    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.from(chunk));
    }

    const pcm = Buffer.concat(chunks);
    const totalElapsedMs = Date.now() - startMs;
    const audioDurationMs = (pcm.length / 2 / 16000) * 1000;
    this.log.info(
      { voiceId, pcmBytes: pcm.length, audioDurationMs: Math.round(audioDurationMs), totalElapsedMs },
      "ElevenLabs TTS complete",
    );
    return pcm;
  }
}
