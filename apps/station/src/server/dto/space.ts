import type { SpaceWithRelations } from "../../db";
import type { SpaceConfig, SpaceState } from "../../engine/types";

export function toSpaceResponse(
  space: SpaceWithRelations,
  state?: SpaceState | null,
) {
  const payload = {
    id: space.id,
    name: space.name,
    slug: space.slug,
    description: space.description,
    template: space.template,
    hosts: space.hosts.map((host) => ({
      name: host.name,
      personality: host.personality,
      voiceId: host.voiceId,
      externalAgent: host.externalAgent ?? true,
      style: host.style,
    })),
    sources: space.sources.map((source) => ({
      type: source.type,
      query: source.query,
    })),
    status: space.status,
    listenerCount: space.listenerCount,
    idleBehavior: space.idleBehavior,
    category: space.category,
    maxSpeakers: space.maxSpeakers,
    durationMin: space.durationMin,
    visibility: space.visibility,
    createdAt: space.createdAt,
  };

  if (state === undefined) {
    return payload;
  }

  return { ...payload, state };
}

export function toSpaceConfig(space: SpaceWithRelations): SpaceConfig {
  return {
    hosts: space.hosts.map((host) => ({
      name: host.name,
      personality: host.personality,
      voiceId: host.voiceId,
      style: host.style ?? 0.5,
    })),
    sources: space.sources.map((source) => ({
      type: source.type as "firecrawl_search",
      query: source.query,
    })),
    description: space.description ?? undefined,
    category: space.category ?? undefined,
    maxSpeakers: space.maxSpeakers ?? undefined,
    durationMin: space.durationMin ?? undefined,
    idleBehavior: (space.idleBehavior as "always_on" | "pause") ?? undefined,
  };
}
