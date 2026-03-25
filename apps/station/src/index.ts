import { initDb } from "./db/index";
import { LiveStationRecovery } from "./runtime/LiveStationRecovery";
import { StationManager } from "./engine/StationManager";
import { buildServer } from "./server";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: { target: "pino-pretty" },
});

async function main() {
  logger.info("Starting clanker.show station server...");

  await initDb();
  logger.info("Database initialized");

  const stationManager = new StationManager();
  const stationRecovery = new LiveStationRecovery(stationManager);
  logger.info("Station manager ready");

  const server = await buildServer(stationManager);
  const port = parseInt(process.env.PORT || "3001", 10);

  await server.listen({ port, host: "0.0.0.0" });
  logger.info(`Station API listening on http://localhost:${port}`);
  await stationRecovery.run();

  const shutdown = async () => {
    logger.info("Shutting down...");
    stationManager.stopAll();
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
