import type { FastifyInstance } from "fastify";
import { CallQueue, Space, Session } from "../../db/index";
import type { SpaceManager } from "../../engine/SpaceManager";
import { callInSchema, reconnectSchema } from "../validation/schemas";

export async function registerCallInRoutes(
  app: FastifyInstance,
  spaceManager: SpaceManager,
): Promise<void> {
  app.post<{ Params: { slug: string } }>("/api/spaces/:slug/call-in", async (request, reply) => {
    const parsed = callInSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Validation failed", issues: parsed.error.issues };
    }

    const space = await Space.findBySlug(request.params.slug);
    if (!space) {
      reply.code(404);
      return { error: "Space not found" };
    }

    // Resolve or create session
    let session;
    if (parsed.data.sessionToken) {
      session = await Session.findByToken(parsed.data.sessionToken);
    }
    if (!session) {
      session = await Session.create({ name: parsed.data.name });
    }

    const currentProgramId = spaceManager.getCurrentProgramId(space.id);

    const row = await CallQueue.create({
      spaceId: space.id,
      topicHint: parsed.data.topicHint || null,
      programId: currentProgramId ?? null,
      sessionId: session.id,
    });

    reply.code(201);
    return { id: row.id, status: "waiting", sessionToken: session.sessionToken };
  });

  app.post<{ Params: { slug: string } }>(
    "/api/spaces/:slug/call-in/reconnect",
    async (request, reply) => {
      const parsed = reconnectSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "Invalid request", issues: parsed.error.issues };
      }

      const space = await Space.findBySlug(request.params.slug);
      if (!space) {
        reply.code(404);
        return { error: "Space not found" };
      }

      const session = await Session.findByToken(parsed.data.sessionToken);
      if (!session) {
        reply.code(404);
        return { error: "Session not found" };
      }

      const entries = await CallQueue.findMany({
        where: { sessionId: session.id, spaceId: space.id, status: { not: "ended" } },
        take: 1,
      });
      const entry = entries[0];
      if (!entry) {
        reply.code(404);
        return { error: "No active call found for this session" };
      }

      return {
        id: entry.id,
        status: entry.status,
        callerName: session.name,
        topicHint: entry.topicHint,
      };
    },
  );

  app.get<{ Params: { slug: string; callerId: string } }>(
    "/api/spaces/:slug/call-in/:callerId/status",
    async (request, reply) => {
      const { slug, callerId } = request.params;

      const space = await Space.findBySlug(slug);
      if (!space) {
        reply.code(404);
        return { error: "Space not found" };
      }

      const callers = await CallQueue.findMany({
        where: { id: callerId, spaceId: space.id },
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
    "/api/spaces/:slug/call-in/:callerId/accept",
    async (request, reply) => {
      const { slug, callerId } = request.params;

      const space = await Space.findBySlug(slug);
      if (!space) {
        reply.code(404);
        return { error: "Space not found" };
      }

      const callers = await CallQueue.findMany({
        where: { id: callerId, spaceId: space.id },
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

      spaceManager.acceptCaller(space.id, callerId);
      return { ok: true, status: "accepted" };
    },
  );
}
