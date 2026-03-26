import { z } from "zod";

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SPACE_CATEGORIES = ["podcast", "meeting", "radio", "townhall", "space"] as const;

export const hostSchema = z.object({
  name: z.string().trim().min(1, "Host name is required"),
  personality: z.string().default(""),
  voiceId: z.string().trim().min(1, "Voice selection is required"),
  agentId: z.string().trim().optional(),
  style: z.number().min(0).max(1).default(0.5),
});

export const sourceSchema = z.object({
  type: z.string().optional(),
  query: z.string().trim().min(1, "Source query is required"),
});

export const createSpaceSchema = z.object({
  name: z.string().trim().min(1, "Space name is required"),
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .regex(slugPattern, "Slug must be lowercase alphanumeric with hyphens only"),
  description: z.string().trim().optional(),
  template: z.string().optional(),
  hosts: z.array(hostSchema).min(1, "At least one host is required").max(4, "Maximum 4 hosts allowed"),
  sources: z.array(sourceSchema).default([]),
  idleBehavior: z.enum(["always_on", "pause"]).default("pause"),
  category: z.enum(SPACE_CATEGORIES).default("space"),
  maxSpeakers: z.number().int().min(1).max(10).default(1),
  durationMin: z.number().int().min(5).max(1440).default(60),
  visibility: z.enum(["public", "private"]).default("public"),
});

export const callInSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  topicHint: z.string().trim().optional(),
  sessionToken: z.string().trim().optional(),
});

export const reconnectSchema = z.object({
  sessionToken: z.string().min(1, "Session token is required"),
});

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, "Key name is required").max(100),
});

export const commentSchema = z.object({
  name: z.string().trim().optional(),
  topic: z.string().trim().min(1, "Topic is required"),
  content: z.string().trim().min(1, "Content is required"),
});
