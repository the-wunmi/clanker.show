export interface NewSpaceDraft {
  name: string;
  slug: string;
  description: string;
  hosts: Array<{ name: string; personality: string; voiceId: string; style: number }>;
  sources: Array<{ type: "firecrawl_search"; query: string }>;
  category?: string;
  maxSpeakers?: number;
  durationMin?: number;
  visibility?: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export function normaliseDraft(input: unknown, voiceIds: string[]): NewSpaceDraft {
  const fallbackName = "AI Space";
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;

  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fallbackName;
  const slug = slugify(typeof raw.slug === "string" ? raw.slug : name) || "ai-space";
  const description = typeof raw.description === "string"
    ? raw.description.trim()
    : "Fast-paced live audio space with opinionated hosts and fresh daily topics.";

  const rawHosts = Array.isArray(raw.hosts) ? raw.hosts : [];
  const hosts = rawHosts
    .map((host, idx) => {
      const row = (typeof host === "object" && host !== null ? host : {}) as Record<string, unknown>;
      const styleValue = typeof row.style === "number" ? row.style : 0.5;
      const style = Math.max(0, Math.min(1, styleValue));
      const hostName = typeof row.name === "string" && row.name.trim()
        ? row.name.trim()
        : idx === 0
          ? "Host One"
          : `Host ${idx + 1}`;
      const personality = typeof row.personality === "string" && row.personality.trim()
        ? row.personality.trim()
        : "Sharp, conversational, and curious.";
      const requestedVoiceId = typeof row.voiceId === "string" ? row.voiceId.trim() : "";
      const voiceId = voiceIds.includes(requestedVoiceId)
        ? requestedVoiceId
        : voiceIds[idx % voiceIds.length] || "";
      return { name: hostName, personality, voiceId, style };
    })
    .filter((host) => host.name.length > 0)
    .slice(0, 4);

  if (hosts.length === 0) {
    hosts.push(
      {
        name: "Maya",
        personality: "Energetic and curious. Loves spotting trends early.",
        voiceId: voiceIds[0] || "",
        style: 0.55,
      },
      {
        name: "Noah",
        personality: "Calm and analytical. Adds context and pushback.",
        voiceId: voiceIds[1] || voiceIds[0] || "",
        style: 0.45,
      },
    );
  }

  const rawSources = Array.isArray(raw.sources) ? raw.sources : [];
  const sources = rawSources
    .map((source) => {
      const row = (typeof source === "object" && source !== null ? source : {}) as Record<string, unknown>;
      const query = typeof row.query === "string" ? row.query.trim() : "";
      return { type: "firecrawl_search" as const, query };
    })
    .filter((source) => source.query.length > 0)
    .slice(0, 6);

  if (sources.length === 0) {
    sources.push(
      { type: "firecrawl_search", query: "latest AI product launches and research" },
      { type: "firecrawl_search", query: "startup funding and market moves this week" },
      { type: "firecrawl_search", query: "consumer internet trends and social platforms" },
    );
  }

  const category = typeof raw.category === "string" ? raw.category.trim() : undefined;
  const maxSpeakers = typeof raw.maxSpeakers === "number" ? raw.maxSpeakers : undefined;
  const durationMin = typeof raw.durationMin === "number" ? raw.durationMin : undefined;
  const visibility = typeof raw.visibility === "string" ? raw.visibility.trim() : undefined;

  return { name, slug, description, hosts, sources, category, maxSpeakers, durationMin, visibility };
}
