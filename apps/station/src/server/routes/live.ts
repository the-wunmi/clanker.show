import type { FastifyInstance } from "fastify";
import { Station } from "../../db/index";
import type { StationManager } from "../../engine/StationManager";
import type { TranscriptLine } from "../../engine/types";
import { toStationConfig } from "../dto/station";

export async function registerLiveRoutes(
  app: FastifyInstance,
  stationManager: StationManager,
): Promise<void> {
  app.post<{ Params: { slug: string } }>("/api/stations/:slug/start", async (request, reply) => {
    const station = await Station.findBySlug(request.params.slug, { hosts: true, sources: true });
    if (!station) {
      reply.code(404);
      return { error: "Station not found" };
    }

    stationManager.startStation(station, toStationConfig(station));
    await Station.update(station.id, { status: "live" });
    return { ok: true, status: "live" };
  });

  app.post<{ Params: { slug: string } }>("/api/stations/:slug/stop", async (request, reply) => {
    const station = await Station.findBySlug(request.params.slug);
    if (!station) {
      reply.code(404);
      return { error: "Station not found" };
    }

    stationManager.stopStation(station);
    await Station.update(station.id, { status: "idle" });
    return { ok: true, status: "idle" };
  });

  app.get<{ Params: { slug: string } }>("/api/stations/:slug/stream-url", async (request, reply) => {
    const station = await Station.findBySlug(request.params.slug);
    if (!station) {
      reply.code(404);
      return { error: "Station not found" };
    }

    const host = process.env.ICECAST_HOST || "localhost";
    const port = process.env.ICECAST_PORT || "8000";
    return { url: `http://${host}:${port}/station-${station.slug}` };
  });

  app.get<{ Params: { slug: string } }>(
    "/api/stations/:slug/transcript",
    async (request, reply) => {
      const station = await Station.findBySlug(request.params.slug);
      if (!station) {
        reply.code(404);
        return { error: "Station not found" };
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      const handler = (line: TranscriptLine) => {
        reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
      };

      stationManager.onTranscriptLine(station.id, handler);
      request.raw.on("close", () => {
        stationManager.offTranscriptLine(station.id, handler);
      });
    },
  );
}
