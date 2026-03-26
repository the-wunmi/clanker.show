import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { SpaceManager } from "./engine/SpaceManager";
import { registerRoutes } from "./server/routes";

export async function buildServer(spaceManager: SpaceManager) {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(websocket);
  await registerRoutes(app, spaceManager);

  return app;
}
