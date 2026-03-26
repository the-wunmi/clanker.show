import type { FastifyInstance } from "fastify";
import { Station, StationHost, StationSource, type StationWithRelations } from "../../db/index";
import type { StationManager } from "../../engine/StationManager";
import { ElevenLabsAgentService } from "../../services/ElevenLabsAgentService";
import { toStationResponse } from "../dto/station";
import { createStationSchema } from "../validation/schemas";

export async function registerStationRoutes(
  app: FastifyInstance,
  stationManager: StationManager,
): Promise<void> {
  app.post("/api/stations", async (request, reply) => {
    const parsed = createStationSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Validation failed", issues: parsed.error.issues };
    }

    const { name, slug, description, template, hosts, sources, idleBehavior } = parsed.data;

    const row = await Station.create({
      name,
      slug,
      description: description || null,
      template: template || "custom",
      idleBehavior,
    });

    const [hostRows] = await Promise.all([
      hosts.length ? StationHost.bulkCreate(row.id, hosts) : Promise.resolve([]),
      sources.length ? StationSource.bulkCreate(row.id, sources) : Promise.resolve(),
    ]);

    // Ensure ElevenLabs agents exist (idempotent on retry via host-id tags)
    if (hostRows.length > 0) {
      const agentIds = await ElevenLabsAgentService.ensureAgents(
        hostRows.map((hr, i) => ({
          id: hr.id,
          name: hosts[i].name,
          personality: hosts[i].personality,
          voiceId: hosts[i].voiceId,
        })),
        description,
        undefined,
      );

      await Promise.all(
        hostRows.map((hr) => {
          const agentId = agentIds.get(hr.id);
          if (agentId) return StationHost.update(hr.id, { agentId });
        }),
      );
    }

    reply.code(201);
    return { id: row.id, slug };
  });

  app.get("/api/stations", async () => {
    const rows = await Station.findMany({ include: { hosts: true, sources: true } });
    return rows.map((station) => toStationResponse(station as StationWithRelations));
  });

  app.get<{ Params: { slug: string } }>("/api/stations/:slug", async (request, reply) => {
    const station = await Station.findBySlug(request.params.slug, { hosts: true, sources: true });
    if (!station) {
      reply.code(404);
      return { error: "Station not found" };
    }

    return toStationResponse(station, stationManager.getStationState(station.id));
  });
}
