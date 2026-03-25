import type { FastifyInstance } from "fastify";
import { CallQueue, Station } from "../../db/index";
import type { StationManager } from "../../engine/StationManager";
import { callInSchema } from "../validation/schemas";

export async function registerCallInRoutes(
  app: FastifyInstance,
  stationManager: StationManager,
): Promise<void> {
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

  app.get<{ Params: { slug: string; callerId: string } }>(
    "/api/stations/:slug/call-in/:callerId/status",
    async (request, reply) => {
      const { slug, callerId } = request.params;

      const station = await Station.findBySlug(slug);
      if (!station) {
        reply.code(404);
        return { error: "Station not found" };
      }

      const callers = await CallQueue.findMany({
        where: { id: callerId, stationId: station.id },
        take: 1,
      });
      const caller = callers[0];
      if (!caller) {
        reply.code(404);
        return { error: "Call not found" };
      }

      return { id: caller.id, status: caller.status };
    },
  );

  app.post<{ Params: { slug: string; callerId: string } }>(
    "/api/stations/:slug/call-in/:callerId/accept",
    async (request, reply) => {
      const { slug, callerId } = request.params;

      const station = await Station.findBySlug(slug);
      if (!station) {
        reply.code(404);
        return { error: "Station not found" };
      }

      const callers = await CallQueue.findMany({
        where: { id: callerId, stationId: station.id },
        take: 1,
      });
      const caller = callers[0];
      if (!caller) {
        reply.code(404);
        return { error: "Call not found" };
      }

      if (caller.status !== "waiting") {
        reply.code(409);
        return { error: `Caller status is already "${caller.status}"` };
      }

      stationManager.acceptCaller(station.id, callerId);
      return { ok: true, status: "accepted" };
    },
  );
}
