import type { FastifyInstance } from "fastify";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createAIClient, FAST_MODEL } from "../../services/ai";
import { extractJsonObject, firstTextBlock } from "../../services/aiResponse";
import { normaliseDraft } from "../dto/drafting";

export async function registerMetaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/voices", async (_request, reply) => {
    try {
      const response = await new ElevenLabsClient({
        apiKey: process.env.ELEVENLABS_API_KEY,
      }).voices.getAll();

      return response.voices.map((voice) => {
        const labels = voice.labels
          ? Object.values(voice.labels).filter(Boolean).join(", ")
          : "";

        return {
          voice_id: voice.voiceId,
          name: voice.name ?? "Unnamed",
          description: labels || voice.description || "",
        };
      });
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
        temperature: 0.8,
        system: [
          "You generate space setup presets for a live audio app.",
          "Return JSON only.",
          "Create a punchy, realistic live audio space concept that feels current.",
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
            content:
              "Generate one space preset now. Focus on technology, internet culture, and business trends.",
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
