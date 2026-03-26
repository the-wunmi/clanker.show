import type { FastifyInstance } from "fastify";
import { Space } from "../../db/index";
import type { SpaceManager } from "../../engine/SpaceManager";
import { commentSchema } from "../validation/schemas";

export async function registerCommentRoutes(
  app: FastifyInstance,
  spaceManager: SpaceManager,
): Promise<void> {
  app.post<{ Params: { slug: string } }>("/api/spaces/:slug/comments", async (request, reply) => {
    const parsed = commentSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Validation failed", issues: parsed.error.issues };
    }

    const space = await Space.findBySlug(request.params.slug);
    if (!space) {
      reply.code(404);
      return { error: "Space not found" };
    }

    spaceManager.submitComment(space.id, {
      topic: parsed.data.topic,
      content: parsed.data.content,
      submitter: parsed.data.name || "anonymous",
    });

    return { ok: true };
  });
}
