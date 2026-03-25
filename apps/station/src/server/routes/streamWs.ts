import type { FastifyInstance } from "fastify";
import { Station } from "../../db/index";
import type { StationManager } from "../../engine/StationManager";

export async function registerStreamWsRoutes(
  app: FastifyInstance,
  stationManager: StationManager,
): Promise<void> {
  app.get<{ Params: { slug: string } }>(
    "/api/stations/:slug/stream-ws",
    { websocket: true },
    async (socket, request) => {
      const station = await Station.findBySlug(request.params.slug);
      if (!station) {
        socket.close();
        return;
      }

      const listener = stationManager.addStreamListener(station.id);
      if (!listener) {
        socket.close();
        return;
      }

      stationManager.onListenerChange(station, listener.count);
      await Station.update(station.id, { listenerCount: listener.count }).catch(() => {
        // Listener count persistence should not break the stream.
      });

      const audioHandler = (mp3: Buffer) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(mp3, { binary: true });
        }
      };
      stationManager.onStreamAudio(station.id, audioHandler);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        stationManager.offStreamAudio(station.id, audioHandler);
        const count = stationManager.removeStreamListener(station.id, listener.listenerId);
        if (count !== null) {
          stationManager.onListenerChange(station, count);
          void Station.update(station.id, { listenerCount: count }).catch(() => {
            // Listener count persistence should not break the stream.
          });
        }
      };

      socket.on("close", cleanup);
      socket.on("error", cleanup);
    },
  );
}
