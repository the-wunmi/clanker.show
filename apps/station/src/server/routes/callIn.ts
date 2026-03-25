import type { FastifyInstance } from "fastify";
import { CallQueue, Station } from "../../db/index";
import { callInSchema } from "../validation/schemas";

export async function registerCallInRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { slug: string } }>("/api/stations/:slug/call-in", async (request, reply) => {
    const parsed = callInSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Validation failed", issues: parsed.error.issues };
    }

    const station = await Station.findBySlug(request.params.slug);
    if (!station) {
      reply.code(404);
      return { error: "Station not found" };
    }

    const row = await CallQueue.create({
      stationId: station.id,
      callerName: parsed.data.name,
      topicHint: parsed.data.topicHint || null,
    });

    reply.code(201);
    return { id: row.id, status: "waiting" };
  });
}
