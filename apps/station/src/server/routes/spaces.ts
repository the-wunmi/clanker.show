import type { FastifyInstance } from "fastify";
import pino from "pino";
import { Space, SpaceHost, SpaceSource, type SpaceWithRelations } from "../../db/index";
import type { SpaceManager } from "../../engine/SpaceManager";
import { ElevenLabsAgentService } from "../../services/ElevenLabsAgentService";
import { toSpaceResponse } from "../dto/space";
import { createSpaceSchema } from "../validation/schemas";

const log = pino({ name: "spaces-route" });

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

    const existing = await Space.findBySlug(slug);
    if (existing) {
      reply.code(409);
      return { error: "A space with this slug already exists" };
    }

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
      createdBy: request.apiKey?.id ?? null,
    });

    const [createdHosts] = await Promise.all([
      hosts.length ? SpaceHost.bulkCreate(row.id, hosts) : Promise.resolve([]),
      sources.length ? SpaceSource.bulkCreate(row.id, sources) : Promise.resolve(),
    ]);

    const hostsNeedingAgents = (createdHosts ?? []).filter((h) => !h.agentId);
    if (hostsNeedingAgents.length > 0) {
      try {
        const hostSpecs = hostsNeedingAgents.map((h) => ({
          id: h.id,
          name: h.name,
          personality: h.personality,
          voiceId: h.voiceId,
        }));
        const agentMap = await ElevenLabsAgentService.ensureAgents(hostSpecs, description);
        await Promise.all(
          [...agentMap.entries()].map(([hostId, agentId]) =>
            SpaceHost.update(hostId, { agentId }),
          ),
        );
        log.info({ count: agentMap.size, spaceSlug: slug }, "Created ElevenLabs agents for hosts");
      } catch (err) {
        log.error({ err, spaceSlug: slug }, "Failed to create ElevenLabs agents (space created without them)");
      }
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
