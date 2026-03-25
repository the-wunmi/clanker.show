import type { FastifyInstance } from "fastify";
import { Station, CallQueue, type CallQueueWithSession } from "../../db/index";
import type { StationManager } from "../../engine/StationManager";
import type { CallerStatus } from "../../engine/types";

export async function registerCallerWsRoutes(
  app: FastifyInstance,
  stationManager: StationManager,
): Promise<void> {
  app.get<{ Params: { slug: string; callerId: string } }>(
    "/api/stations/:slug/call-ws/:callerId",
    { websocket: true },
    async (socket, request) => {
      const { slug, callerId } = request.params;

      const station = await Station.findBySlug(slug);
      if (!station) {
        socket.send(JSON.stringify({ type: "error", message: "Station not found" }));
        socket.close();
        return;
      }

      const callers = await CallQueue.findMany({
        where: { id: callerId, stationId: station.id },
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

      // Notify the station worker
      stationManager.notifyCallerConnected(station.id, callerId, {
        callerName: caller.session?.name ?? "Anonymous",
        topicHint: caller.topicHint ?? "",
      });

      // Listen for caller-status events from worker and forward to WebSocket
      const statusHandler = (evtCallerId: string, status: CallerStatus) => {
        if (evtCallerId !== callerId) return;
        socket.send(JSON.stringify({ type: "caller-status", status }));
      };
      stationManager.onCallerStatus(station.id, statusHandler);

      // Listen for host audio and forward to caller as binary frames
      const audioHandler = (evtCallerId: string, mp3: Buffer) => {
        if (evtCallerId !== callerId) return;
        socket.send(mp3);
      };
      stationManager.onCallerAudio(station.id, audioHandler);

      // Handle incoming messages
      socket.on("message", (data: Buffer | string, isBinary: boolean) => {
        if (isBinary || data instanceof Buffer) {
          // Binary frame = raw PCM audio
          const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data);
          stationManager.forwardCallerAudio(station.id, callerId, pcm);
        } else {
          // Text frame = JSON control message
          try {
            const msg = JSON.parse(typeof data === "string" ? data : data.toString());
            if (msg.type === "end-call") {
              stationManager.notifyCallerDisconnected(station.id, callerId);
              socket.close();
            }
          } catch {
            // Ignore malformed JSON
          }
        }
      });

      // Handle WebSocket close
      socket.on("close", () => {
        stationManager.offCallerStatus(station.id, statusHandler);
        stationManager.offCallerAudio(station.id, audioHandler);
        stationManager.notifyCallerDisconnected(station.id, callerId);
      });
    },
  );
}
