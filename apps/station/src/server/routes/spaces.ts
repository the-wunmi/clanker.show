import type { FastifyInstance } from "fastify";
import { Space, SpaceHost, SpaceSource, type SpaceWithRelations } from "../../db/index";
import type { SpaceManager } from "../../engine/SpaceManager";
import { ElevenLabsAgentService } from "../../services/ElevenLabsAgentService";
import { toSpaceResponse } from "../dto/space";
import { createSpaceSchema } from "../validation/schemas";

export async function registerSpaceRoutes(
  app: FastifyInstance,
  spaceManager: SpaceManager,
): Promise<void> {
  app.post("/api/spaces", async (request, reply) => {
    const parsed = createSpaceSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Validation failed", issues: parsed.error.issues };
    }

    const { name, slug, description, template, hosts, sources, idleBehavior, category, maxSpeakers, durationMin, visibility } = parsed.data;

    const row = await Space.create({
      name,
      slug,
      description: description || null,
      template: template || "custom",
      idleBehavior,
      category,
      maxSpeakers,
      durationMin,
      visibility,
    });

    const [hostRows] = await Promise.all([
      hosts.length ? SpaceHost.bulkCreate(row.id, hosts) : Promise.resolve([]),
      sources.length ? SpaceSource.bulkCreate(row.id, sources) : Promise.resolve(),
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
          if (agentId) return SpaceHost.update(hr.id, { agentId });
        }),
      );
    }

    reply.code(201);
    return { id: row.id, slug };
  });

  app.get("/api/spaces", async () => {
    const rows = await Space.findMany({ include: { hosts: true, sources: true } });
    return rows.map((space) => toSpaceResponse(space as SpaceWithRelations));
  });

  app.get<{ Params: { slug: string } }>("/api/spaces/:slug", async (request, reply) => {
    const space = await Space.findBySlug(request.params.slug, { hosts: true, sources: true });
    if (!space) {
      reply.code(404);
      return { error: "Space not found" };
    }

    return toSpaceResponse(space, spaceManager.getSpaceState(space.id));
  });
}
