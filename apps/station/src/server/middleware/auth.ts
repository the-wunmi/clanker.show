import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ApiKey, type ApiKeyRow } from "../../db";

declare module "fastify" {
  interface FastifyRequest {
    apiKey: ApiKeyRow | null;
  }
}

export function registerAuthHook(app: FastifyInstance): void {
  app.decorateRequest("apiKey", null);

  app.addHook("onRequest", async (request) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return;

    const rawKey = auth.slice(7);
    if (!rawKey) return;

    request.apiKey = await ApiKey.findByRawKey(rawKey);
  });
}

export function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.apiKey) return true;
  reply.code(401).send({ error: "Valid API key required" });
  return false;
}
