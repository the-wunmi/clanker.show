import { initDb } from "./db/index";
import { LiveSpaceRecovery } from "./runtime/LiveSpaceRecovery";
import { SpaceManager } from "./engine/SpaceManager";
import { buildServer } from "./server";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: { target: "pino-pretty" },
});

async function main() {
  logger.info("Starting clanker.show space server...");

  await initDb();
  logger.info("Database initialized");

  const spaceManager = new SpaceManager();
  const spaceRecovery = new LiveSpaceRecovery(spaceManager);
  logger.info("Space manager ready");

  const server = await buildServer(spaceManager);
  const port = parseInt(process.env.PORT || "3001", 10);

  await server.listen({ port, host: "0.0.0.0" });
  logger.info(`Space API listening on http://localhost:${port}`);
  await spaceRecovery.run();

  const shutdown = async () => {
    logger.info("Shutting down...");
    spaceManager.stopAll();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(err, "Failed to start server");
  process.exit(1);
});
