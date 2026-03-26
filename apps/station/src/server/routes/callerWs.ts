import type { FastifyInstance } from "fastify";
import { Space, CallQueue, type CallQueueWithSession } from "../../db/index";
import type { SpaceManager } from "../../engine/SpaceManager";
import type { CallerStatus } from "../../engine/types";

export async function registerCallerWsRoutes(
  app: FastifyInstance,
  spaceManager: SpaceManager,
): Promise<void> {
  app.get<{ Params: { slug: string; callerId: string } }>(
    "/api/spaces/:slug/call-ws/:callerId",
    { websocket: true },
    async (socket, request) => {
      const { slug, callerId } = request.params;

      const space = await Space.findBySlug(slug);
      if (!space) {
        socket.send(JSON.stringify({ type: "error", message: "Space not found" }));
        socket.close();
        return;
      }

      const callers = await CallQueue.findMany({
        where: { id: callerId, spaceId: space.id },
        include: { session: true },
        take: 1,
      });
      const caller = callers[0] as CallQueueWithSession | undefined;
      if (!caller || caller.status !== "accepted") {
        socket.send(JSON.stringify({ type: "error", message: "Caller not accepted" }));
        socket.close();
        return;
      }

      // Update status to connected
      await CallQueue.update(callerId, { status: "connected" });

      // Notify the space worker
      spaceManager.notifyCallerConnected(space.id, callerId, {
        callerName: caller.session?.name ?? "Anonymous",
        topicHint: caller.topicHint ?? "",
      });

      // Listen for caller-status events from worker and forward to WebSocket
      const statusHandler = (evtCallerId: string, status: CallerStatus) => {
        if (evtCallerId !== callerId) return;
        socket.send(JSON.stringify({ type: "caller-status", status }));
      };
      spaceManager.onCallerStatus(space.id, statusHandler);

      // Listen for host audio and forward to caller as binary frames
      const audioHandler = (evtCallerId: string, mp3: Buffer) => {
        if (evtCallerId !== callerId) return;
        socket.send(mp3);
      };
      spaceManager.onCallerAudio(space.id, audioHandler);

      // Handle incoming messages
      socket.on("message", (data: Buffer | string, isBinary: boolean) => {
        if (isBinary || data instanceof Buffer) {
          // Binary frame = raw PCM audio
          const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data);
          spaceManager.forwardCallerAudio(space.id, callerId, pcm);
        } else {
          // Text frame = JSON control message
          try {
            const msg = JSON.parse(typeof data === "string" ? data : data.toString());
            if (msg.type === "end-call") {
              spaceManager.notifyCallerDisconnected(space.id, callerId);
              socket.close();
            }
          } catch {
            // Ignore malformed JSON
          }
        }
      });

      // Handle WebSocket close
      socket.on("close", () => {
        spaceManager.offCallerStatus(space.id, statusHandler);
        spaceManager.offCallerAudio(space.id, audioHandler);
        spaceManager.notifyCallerDisconnected(space.id, callerId);
      });
    },
  );
}
