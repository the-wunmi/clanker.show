import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { StationManager } from "./engine/StationManager";
import { registerRoutes } from "./server/routes";

export async function buildServer(stationManager: StationManager) {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(websocket);
  await registerRoutes(app, stationManager);

  return app;
}
