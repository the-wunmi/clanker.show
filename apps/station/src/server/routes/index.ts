import type { FastifyInstance } from "fastify";
import type { SpaceManager } from "../../engine/SpaceManager";
import { registerMetaRoutes } from "./meta";
import { registerSpaceRoutes } from "./spaces";
import { registerLiveRoutes } from "./live";
import { registerCallInRoutes } from "./callIn";
import { registerCallerWsRoutes } from "./callerWs";
import { registerStreamWsRoutes } from "./streamWs";
import { registerCommentRoutes } from "./comments";

export async function registerRoutes(
  app: FastifyInstance,
  spaceManager: SpaceManager,
): Promise<void> {
  await registerMetaRoutes(app);
  await registerSpaceRoutes(app, spaceManager);
  await registerLiveRoutes(app, spaceManager);
  await registerCallInRoutes(app, spaceManager);
  await registerCallerWsRoutes(app, spaceManager);
  await registerStreamWsRoutes(app, spaceManager);
  await registerCommentRoutes(app, spaceManager);
}
