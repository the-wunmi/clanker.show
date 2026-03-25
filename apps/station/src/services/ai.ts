import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";

export type AIClient = Anthropic;

const isBedrock = !!(process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_BEDROCK === "true");

export const DEFAULT_MODEL =
  process.env.AI_MODEL ??
  (isBedrock
    ? "us.anthropic.claude-sonnet-4-20250514-v1:0"
    : "claude-sonnet-4-20250514");

export const FAST_MODEL =
  process.env.AI_FAST_MODEL ??
  (isBedrock
    ? "us.anthropic.claude-3-5-haiku-20241022-v1:0"
    : "claude-3-5-haiku-20241022");

export function createAIClient(): AIClient {
  const bedrockToken = process.env.AWS_BEARER_TOKEN_BEDROCK;

  if (bedrockToken) {
    return new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION ?? "us-east-1",
      skipAuth: true,
      defaultHeaders: {
        Authorization: `Bearer ${bedrockToken}`,
      },
    }) as unknown as AIClient;
  }

  if (process.env.AWS_BEDROCK === "true") {
    return new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION ?? "us-east-1",
    }) as unknown as AIClient;
  }

  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
}
