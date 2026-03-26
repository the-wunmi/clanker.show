import type { FastifyInstance } from "fastify";
import { Station } from "../../db/index";
import type { StationManager } from "../../engine/StationManager";
import { commentSchema } from "../validation/schemas";

export async function registerCommentRoutes(
  app: FastifyInstance,
  stationManager: StationManager,
): Promise<void> {
  app.post<{ Params: { slug: string } }>("/api/stations/:slug/comments", async (request, reply) => {
    const parsed = commentSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Validation failed", issues: parsed.error.issues };
    }

    const station = await Station.findBySlug(request.params.slug);
    if (!station) {
      reply.code(404);
      return { error: "Station not found" };
    }

    stationManager.submitComment(station.id, {
      topic: parsed.data.topic,
      content: parsed.data.content,
      submitter: parsed.data.name || "anonymous",
    });

    return { ok: true };
  });
}
