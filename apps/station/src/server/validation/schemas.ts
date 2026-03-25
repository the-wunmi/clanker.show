import { z } from "zod";

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const hostSchema = z.object({
  name: z.string().trim().min(1, "Host name is required"),
  personality: z.string().default(""),
  voiceId: z.string().trim().min(1, "Voice selection is required"),
  style: z.number().min(0).max(1).default(0.5),
});

export const sourceSchema = z.object({
  type: z.string().optional(),
  query: z.string().trim().min(1, "Source query is required"),
});

export const createStationSchema = z.object({
  name: z.string().trim().min(1, "Station name is required"),
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
});

export const callInSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  topicHint: z.string().trim().optional(),
  sessionToken: z.string().trim().optional(),
});

export const reconnectSchema = z.object({
  sessionToken: z.string().min(1, "Session token is required"),
});

export const tipSchema = z.object({
  name: z.string().trim().optional(),
  topic: z.string().trim().min(1, "Topic is required"),
  content: z.string().trim().min(1, "Content is required"),
});
