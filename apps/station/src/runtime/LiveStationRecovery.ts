import pino from "pino";
import { Station, type StationWithRelations } from "../db";
import { toStationConfig } from "../server/dto/station";
import type { StationManager } from "../engine/StationManager";

export class LiveStationRecovery {
  private readonly log = pino({ name: "LiveStationRecovery" });

  constructor(private readonly stationManager: StationManager) {}

  async run(): Promise<void> {
    const rows = await Station.findMany({
      where: { status: { in: ["live", "paused"] } },
      include: { hosts: true, sources: true },
      orderBy: { listenerCount: "desc" },
    });

    this.log.info({ count: rows.length }, "Recovering live stations after restart");

    for (const station of rows) {
      try {
        const stationRow = station as StationWithRelations;
        const config = toStationConfig(stationRow);

        if (config.hosts.length === 0) {
          this.log.warn(
            { stationId: stationRow.id, slug: stationRow.slug },
            "Skipping recovery: no hosts configured",
          );
          continue;
        }

        this.stationManager.startStation(stationRow, config);
      } catch (err) {
        this.log.error(
          { err, stationId: station.id, slug: station.slug },
          "Failed to recover station",
        );
      }
    }
  }
}
