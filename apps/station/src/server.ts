import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { StationManager } from "./engine/StationManager";
import { registerMetaRoutes } from "./server/metaRoutes";
import { registerStationRoutes } from "./server/stationRoutes";

export async function buildServer(stationManager: StationManager) {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(websocket);
  await registerMetaRoutes(app);
  await registerStationRoutes(app, stationManager);

  return app;
}
