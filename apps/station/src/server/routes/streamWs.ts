import type { FastifyInstance } from "fastify";
import { Space } from "../../db/index";
import type { SpaceManager } from "../../engine/SpaceManager";

export async function registerStreamWsRoutes(
  app: FastifyInstance,
  spaceManager: SpaceManager,
): Promise<void> {
  app.get<{ Params: { slug: string } }>(
    "/api/spaces/:slug/stream-ws",
    { websocket: true },
    async (socket, request) => {
      const space = await Space.findBySlug(request.params.slug);
      if (!space) {
        socket.close();
        return;
      }

      const listener = spaceManager.addStreamListener(space.id);
      if (!listener) {
        socket.close();
        return;
      }

      spaceManager.onListenerChange(space, listener.count);
      await Space.update(space.id, { listenerCount: listener.count }).catch(() => {
        // Listener count persistence should not break the stream.
      });

      const audioHandler = (mp3: Buffer) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(mp3, { binary: true });
        }
      };
      spaceManager.onStreamAudio(space.id, audioHandler);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        spaceManager.offStreamAudio(space.id, audioHandler);
        const count = spaceManager.removeStreamListener(space.id, listener.listenerId);
        if (count !== null) {
          spaceManager.onListenerChange(space, count);
          void Space.update(space.id, { listenerCount: count }).catch(() => {
            // Listener count persistence should not break the stream.
          });
        }
      };

      socket.on("close", cleanup);
      socket.on("error", cleanup);
    },
  );
}
