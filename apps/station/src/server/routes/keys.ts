import type { FastifyInstance } from "fastify";
import { ApiKey } from "../../db";
import { requireAuth } from "../middleware/auth";
import { createApiKeySchema } from "../validation/schemas";

export async function registerKeyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/keys", async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const parsed = createApiKeySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Validation failed", issues: parsed.error.issues };
    }

    const { row, rawKey } = await ApiKey.create(parsed.data.name);

    reply.code(201);
    return {
      id: row.id,
      key: rawKey,
      keyPrefix: row.keyPrefix,
      name: row.name,
      createdAt: row.createdAt,
    };
  });

  app.get("/api/keys", async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const rows = await ApiKey.findMany();
    return rows.map((row) => ({
      id: row.id,
      keyPrefix: row.keyPrefix,
      name: row.name,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    }));
  });

  app.delete<{ Params: { id: string } }>("/api/keys/:id", async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const existing = await ApiKey.findById(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "API key not found" };
    }

    await ApiKey.delete(request.params.id);
    return { ok: true };
  });
}
