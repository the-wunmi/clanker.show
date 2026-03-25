import pino from "pino";
import { Station } from "../db";
import type { StationManager } from "../engine/StationManager";

type IcecastSource = {
  listeners?: number | string;
  listenurl?: string;
  mount?: string;
  server_name?: string;
};

type IcecastStatsResponse = {
  icestats?: {
    source?: IcecastSource | IcecastSource[];
  };
};

export class IcecastListenerPoller {
  private readonly log = pino({ name: "IcecastListenerPoller" });
  private readonly host = process.env.ICECAST_HOST ?? "localhost";
  private readonly port = Number(process.env.ICECAST_PORT ?? "8000");
  private readonly protocol = process.env.ICECAST_PROTOCOL ?? "http";
  private readonly adminUser = process.env.ICECAST_ADMIN_USER ?? "admin";
  private readonly adminPassword = process.env.ICECAST_ADMIN_PASSWORD ?? "hackme";
  private readonly pollIntervalMs = Math.max(
    1000,
    Number(process.env.ICECAST_LISTENER_POLL_MS ?? "5000"),
  );
  private readonly countsByStationId = new Map<string, number>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly stationManager: StationManager) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextPoll(0);
    this.log.info(
      { host: this.host, port: this.port, pollIntervalMs: this.pollIntervalMs },
      "Listener poller started",
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log.info("Listener poller stopped");
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.runPollCycle();
    }, delayMs);
  }

  private async runPollCycle(): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.pollOnce();
    } finally {
      if (!this.running) return;
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > this.pollIntervalMs) {
        this.log.warn(
          { elapsedMs, pollIntervalMs: this.pollIntervalMs },
          "Listener poll cycle exceeded interval",
        );
      }
      this.scheduleNextPoll(Math.max(0, this.pollIntervalMs - elapsedMs));
    }
  }

  private async pollOnce(): Promise<void> {
    try {
      if (!this.running) return;
      const activeStations = await Station.findMany({
        where: { status: { in: ["live", "paused"] } },
      });
      if (activeStations.length === 0) {
        this.countsByStationId.clear();
        return;
      }

      const listenersBySlug = await this.fetchListenerCounts();
      const activeIds = new Set<string>();
      const changedStations: Array<{ stationId: string; slug: string; count: number }> = [];

      for (const station of activeStations) {
        activeIds.add(station.id);
        if (!this.stationManager.getStationState(station.id)) continue;

        const count = listenersBySlug.get(station.slug) ?? 0;
        const previousCount = this.countsByStationId.get(station.id);
        if (previousCount === count) continue;

        this.stationManager.onListenerChange(station, count);
        this.countsByStationId.set(station.id, count);
        changedStations.push({
          stationId: station.id,
          slug: station.slug,
          count,
        });
      }

      if (changedStations.length > 0) {
        const updates = await Promise.allSettled(
          changedStations.map(({ stationId, count }) =>
            Station.update(stationId, { listenerCount: count }),
          ),
        );

        for (let i = 0; i < updates.length; i++) {
          const result = updates[i];
          if (result.status === "fulfilled") continue;
          const failed = changedStations[i];
          this.log.warn(
            {
              stationId: failed.stationId,
              slug: failed.slug,
              listenerCount: failed.count,
              err:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            },
            "Failed to persist listener count",
          );
        }
      }

      for (const stationId of this.countsByStationId.keys()) {
        if (!activeIds.has(stationId)) {
          this.countsByStationId.delete(stationId);
        }
      }
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Listener poll failed",
      );
    }
  }

  private async fetchListenerCounts(): Promise<Map<string, number>> {
    const url = `${this.protocol}://${this.host}:${this.port}/status-json.xsl`;
    const headers = {
      Authorization: `Basic ${Buffer.from(`${this.adminUser}:${this.adminPassword}`).toString("base64")}`,
    };

    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Icecast stats request failed with status ${res.status}`);
    }

    const payload = (await res.json()) as IcecastStatsResponse;
    const sourceNode = payload.icestats?.source;
    const sources = Array.isArray(sourceNode)
      ? sourceNode
      : sourceNode
        ? [sourceNode]
        : [];

    const counts = new Map<string, number>();
    for (const source of sources) {
      const mount = this.resolveMountPath(source);
      if (!mount?.startsWith("/station-")) continue;

      const slug = mount.slice("/station-".length);
      if (!slug) continue;

      const parsed = Number(source.listeners);
      const listeners = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
      const current = counts.get(slug) ?? 0;
      if (listeners > current) counts.set(slug, listeners);
    }

    return counts;
  }

  private resolveMountPath(source: IcecastSource): string | null {
    if (typeof source.mount === "string" && source.mount.startsWith("/")) {
      return source.mount;
    }

    if (typeof source.listenurl === "string") {
      try {
        return new URL(source.listenurl).pathname;
      } catch {
        return null;
      }
    }

    if (typeof source.server_name === "string" && source.server_name.startsWith("/")) {
      return source.server_name;
    }

    return null;
  }
}
