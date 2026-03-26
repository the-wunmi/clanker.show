import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

export interface VoiceSummary {
  voice_id: string;
  name: string;
  description: string;
}

let cached: VoiceSummary[] | null = null;

async function fetchVoices(): Promise<VoiceSummary[]> {
  if (cached) return cached;

  try {
    const client = new ElevenLabsClient({
      apiKey: process.env.ELEVENLABS_API_KEY,
    });
    const response = await client.voices.getAll();

    cached = response.voices
      .filter((v) => v.voiceId)
      .map((voice) => {
        const labels = voice.labels
          ? Object.values(voice.labels).filter(Boolean).join(", ")
          : "";
        return {
          voice_id: voice.voiceId!,
          name: voice.name ?? "Unnamed",
          description: labels || voice.description || "",
        };
      });
  } catch {
    cached = [];
  }

  return cached;
}

/** Full voice list (id, name, description). */
export async function getVoiceProfiles(): Promise<VoiceSummary[]> {
  return fetchVoices();
}

/** Map of voiceId → description, for prompt building. */
export async function getVoiceProfileMap(): Promise<Map<string, string>> {
  const voices = await fetchVoices();
  return new Map(voices.map((v) => [v.voice_id, v.description]));
}
