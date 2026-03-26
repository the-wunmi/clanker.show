import type { FastifyInstance } from "fastify";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createAIClient, FAST_MODEL } from "../../services/ai";
import { extractJsonObject, firstTextBlock } from "../../services/aiResponse";
import { normaliseDraft } from "../dto/drafting";
import { getVoiceProfiles } from "../../services/voiceProfiles";

export async function registerMetaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/voices", async (_request, reply) => {
    try {
      return await getVoiceProfiles();
    } catch {
      reply.code(500);
      return { error: "Failed to fetch voices from ElevenLabs" };
    }
  });

  app.get("/api/spaces/new", async (_request, reply) => {
    try {
      const voiceResponse = await new ElevenLabsClient({
        apiKey: process.env.ELEVENLABS_API_KEY,
      }).voices.getAll();

      const voiceIds = (voiceResponse.voices ?? [])
        .map((voice) => voice.voiceId)
        .filter((id): id is string => Boolean(id));

      if (voiceIds.length === 0) {
        reply.code(503);
        return { error: "No voices available for space draft generation" };
      }

      const ai = createAIClient();
      const response = await ai.messages.create({
        model: FAST_MODEL,
        max_tokens: 1200,
        temperature: 1.0,
        system: [
          "You generate space setup presets for a live audio app.",
          "Return JSON only.",
          "Create a punchy, realistic live audio space concept that feels current and surprising.",
          "Pick any topic or niche — variety is key. Never repeat the same concept twice.",
          "Output shape:",
          "{",
          '  "name": string,',
          '  "slug": string,',
          '  "description": string,',
          '  "hosts": [{ "name": string, "personality": string, "voiceId": string, "style": number }],',
          '  "sources": [{ "query": string }]',
          "}",
          "Rules:",
          "- hosts: 2 or 3 entries",
          "- sources: 3 to 5 entries",
          "- style values between 0 and 1",
          "- source queries must be broad enough to fetch recurring updates",
          "- no markdown, no prose outside JSON",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: `Generate one space preset now. Surprise me with the topic — be creative and unique. Seed: ${Math.random().toString(36).slice(2, 8)}`,
          },
        ],
      });

      const text = firstTextBlock(response.content);
      const parsed = JSON.parse(extractJsonObject(text)) as unknown;
      return normaliseDraft(parsed, voiceIds);
    } catch (err) {
      app.log.error({ err }, "Failed to generate space preset");
      reply.code(500);
      return { error: "Failed to generate space draft" };
    }
  });
}
