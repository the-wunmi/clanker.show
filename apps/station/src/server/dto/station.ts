import type { StationWithRelations } from "../../db";
import type { StationConfig, StationState } from "../../engine/types";

export function toStationResponse(
  station: StationWithRelations,
  state?: StationState | null,
) {
  const payload = {
    id: station.id,
    name: station.name,
    slug: station.slug,
    description: station.description,
    template: station.template,
    hosts: station.hosts.map((host) => ({
      name: host.name,
      personality: host.personality,
      voiceId: host.voiceId,
      style: host.style,
    })),
    sources: station.sources.map((source) => ({
      type: source.type,
      query: source.query,
    })),
    status: station.status,
    listenerCount: station.listenerCount,
    idleBehavior: station.idleBehavior,
    createdAt: station.createdAt,
  };

  if (state === undefined) {
    return payload;
  }

  return { ...payload, state };
}

export function toStationConfig(station: StationWithRelations): StationConfig {
  return {
    hosts: station.hosts.map((host) => ({
      name: host.name,
      personality: host.personality,
      voiceId: host.voiceId,
      style: host.style ?? 0.5,
    })),
    sources: station.sources.map((source) => ({
      type: source.type as "firecrawl_search",
      query: source.query,
    })),
    description: station.description ?? undefined,
  };
}
