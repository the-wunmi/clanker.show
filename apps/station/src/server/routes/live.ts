import type { FastifyInstance } from "fastify";
import { Space, Segment, TranscriptLine as TranscriptLineModel } from "../../db/index";
import type { SpaceManager } from "../../engine/SpaceManager";
import type { TranscriptLine as LiveTranscriptLine } from "../../engine/types";
import { toSpaceConfig } from "../dto/space";

export async function registerLiveRoutes(
  app: FastifyInstance,
  spaceManager: SpaceManager,
): Promise<void> {
  app.post<{ Params: { slug: string } }>("/api/spaces/:slug/start", async (request, reply) => {
    const space = await Space.findBySlug(request.params.slug, { hosts: true, sources: true });
    if (!space) {
      reply.code(404);
      return { error: "Space not found" };
    }

    spaceManager.startSpace(space, toSpaceConfig(space));
    await Space.update(space.id, { status: "live" });
    return { ok: true, status: "live" };
  });

  app.post<{ Params: { slug: string } }>("/api/spaces/:slug/pause", async (request, reply) => {
    const space = await Space.findBySlug(request.params.slug);
    if (!space) {
      reply.code(404);
      return { error: "Space not found" };
    }

    if (space.status !== "live") {
      reply.code(409);
      return { error: "Space is not live" };
    }

    spaceManager.pauseSpace(space);
    await Space.update(space.id, { status: "paused" });
    return { ok: true, status: "paused" };
  });

  app.post<{ Params: { slug: string } }>("/api/spaces/:slug/stop", async (request, reply) => {
    const space = await Space.findBySlug(request.params.slug);
    if (!space) {
      reply.code(404);
      return { error: "Space not found" };
    }

    spaceManager.stopSpace(space);
    await Space.update(space.id, { status: "idle", listenerCount: 0 });
    return { ok: true, status: "idle" };
  });

  app.get<{ Params: { slug: string } }>("/api/spaces/:slug/stream-url", async (request, reply) => {
    const space = await Space.findBySlug(request.params.slug);
    if (!space) {
      reply.code(404);
      return { error: "Space not found" };
    }


    const protocol = (request.headers['x-forwarded-proto'] ?? request.protocol) === "https" ? "wss" : "ws";
    const host = request.headers['x-forwarded-host'] ?? request.headers.host ?? "localhost:3001";
    return { url: `${protocol}://${host}/api/spaces/${space.slug}/stream-ws` };
  });

  app.get<{ Params: { slug: string } }>(
    "/api/spaces/:slug/transcript",
    async (request, reply) => {
      const space = await Space.findBySlug(request.params.slug);
      if (!space) {
        reply.code(404);
        return { error: "Space not found" };
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
          where: { spaceId: space.id },
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

      spaceManager.onTranscriptLine(space.id, handler);
      const heartbeat = setInterval(() => {
        reply.raw.write(`event: ping\ndata: {}\n\n`);
      }, 15_000);
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        spaceManager.offTranscriptLine(space.id, handler);
      });
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/api/spaces/:slug/transcript/recent",
    async (request, reply) => {
      const space = await Space.findBySlug(request.params.slug);
      if (!space) {
        reply.code(404);
        return { error: "Space not found" };
      }

      const latestSegment = (
        await Segment.findMany({
          where: { spaceId: space.id },
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
