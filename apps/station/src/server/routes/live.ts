import type { FastifyInstance } from "fastify";
import { Station, Segment, TranscriptLine as TranscriptLineModel } from "../../db/index";
import type { StationManager } from "../../engine/StationManager";
import type { TranscriptLine as LiveTranscriptLine } from "../../engine/types";
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

  app.post<{ Params: { slug: string } }>("/api/stations/:slug/pause", async (request, reply) => {
    const station = await Station.findBySlug(request.params.slug);
    if (!station) {
      reply.code(404);
      return { error: "Station not found" };
    }

    if (station.status !== "live") {
      reply.code(409);
      return { error: "Station is not live" };
    }

    stationManager.pauseStation(station);
    await Station.update(station.id, { status: "paused" });
    return { ok: true, status: "paused" };
  });

  app.post<{ Params: { slug: string } }>("/api/stations/:slug/stop", async (request, reply) => {
    const station = await Station.findBySlug(request.params.slug);
    if (!station) {
      reply.code(404);
      return { error: "Station not found" };
    }

    stationManager.stopStation(station);
    await Station.update(station.id, { status: "idle", listenerCount: 0 });
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

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(`event: ready\ndata: {"ok":true}\n\n`);

      const latestSegment = (
        await Segment.findMany({
          where: { stationId: station.id },
          take: 1,
          orderBy: { createdAt: "desc" },
        })
      )[0];
      if (latestSegment) {
        const recentLines = await TranscriptLineModel.findMany({
          where: {
            segmentId: latestSegment.id,
            spokenAt: { not: null },
          },
          orderBy: { lineIndex: "asc" },
          take: 80,
        });
        for (const line of recentLines) {
          reply.raw.write(
            `data: ${JSON.stringify({
              host: line.host,
              text: line.text,
              emotion: line.emotion ?? "neutral",
              timestamp: line.spokenAt ? new Date(line.spokenAt).getTime() : Date.now(),
            })}\n\n`,
          );
        }
      }

      const handler = (line: LiveTranscriptLine) => {
        reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
      };

      stationManager.onTranscriptLine(station.id, handler);
      const heartbeat = setInterval(() => {
        reply.raw.write(`event: ping\ndata: {}\n\n`);
      }, 15_000);
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        stationManager.offTranscriptLine(station.id, handler);
      });
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/api/stations/:slug/transcript/recent",
    async (request, reply) => {
      const station = await Station.findBySlug(request.params.slug);
      if (!station) {
        reply.code(404);
        return { error: "Station not found" };
      }

      const latestSegment = (
        await Segment.findMany({
          where: { stationId: station.id },
          take: 1,
          orderBy: { createdAt: "desc" },
        })
      )[0];
      if (!latestSegment) return { lines: [] };

      const recentLines = await TranscriptLineModel.findMany({
        where: {
          segmentId: latestSegment.id,
          spokenAt: { not: null },
        },
        orderBy: { lineIndex: "asc" },
        take: 120,
      });

      return {
        lines: recentLines.map((line) => ({
          host: line.host,
          text: line.text,
          emotion: line.emotion ?? "neutral",
          timestamp: line.spokenAt ? new Date(line.spokenAt).getTime() : Date.now(),
        })),
      };
    },
  );
}
