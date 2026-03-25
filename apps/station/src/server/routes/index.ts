import type { FastifyInstance } from "fastify";
import type { StationManager } from "../../engine/StationManager";
import { registerMetaRoutes } from "./meta";
import { registerStationRoutes } from "./stations";
import { registerLiveRoutes } from "./live";
import { registerCallInRoutes } from "./callIn";
import { registerTipRoutes } from "./tips";

export async function registerRoutes(
  app: FastifyInstance,
  stationManager: StationManager,
): Promise<void> {
  await registerMetaRoutes(app);
  await registerStationRoutes(app, stationManager);
  await registerLiveRoutes(app, stationManager);
  await registerCallInRoutes(app);
  await registerTipRoutes(app, stationManager);
}
