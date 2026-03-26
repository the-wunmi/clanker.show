import pino from "pino";
import { Space, type SpaceWithRelations } from "../db";
import { toSpaceConfig } from "../server/dto/space";
import type { SpaceManager } from "../engine/SpaceManager";

export class LiveSpaceRecovery {
  private readonly log = pino({ name: "LiveSpaceRecovery" });

  constructor(private readonly spaceManager: SpaceManager) {}

  async run(): Promise<void> {
    const rows = await Space.findMany({
      where: { status: { in: ["live", "paused"] } },
      include: { hosts: true, sources: true },
      orderBy: { listenerCount: "desc" },
    });

    this.log.info({ count: rows.length }, "Recovering live spaces after restart");

    for (const row of rows) {
      try {
        const spaceRow = row as SpaceWithRelations;
        const config = toSpaceConfig(spaceRow);

        if (config.hosts.length === 0) {
          this.log.warn(
            { spaceId: spaceRow.id, slug: spaceRow.slug },
            "Skipping recovery: no hosts configured",
          );
          continue;
        }

        this.spaceManager.startSpace(spaceRow, config);
      } catch (err) {
        this.log.error(
          { err, spaceId: row.id, slug: row.slug },
          "Failed to recover space",
        );
      }
    }
  }
}
