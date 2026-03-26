import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

let cachedProfiles: Map<string, string> | null = null;

export async function getVoiceProfiles(): Promise<Map<string, string>> {
  if (cachedProfiles) return cachedProfiles;

  const profiles = new Map<string, string>();
  try {
    const client = new ElevenLabsClient({
      apiKey: process.env.ELEVENLABS_API_KEY,
    });
    const response = await client.voices.getAll();

    for (const voice of response.voices) {
      if (!voice.voiceId) continue;
      const description = voice.labels
        ? Object.values(voice.labels).filter(Boolean).join(", ")
        : "";
      profiles.set(voice.voiceId, description || voice.description || "");
    }
  } catch {
    // Non-critical — return empty map
  }

  cachedProfiles = profiles;
  return profiles;
}
