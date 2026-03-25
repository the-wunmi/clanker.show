import net from "node:net";
import { once } from "node:events";
import pino from "pino";
import { AudioEncoder } from "./AudioEncoder";

const KEEPALIVE_INTERVAL_MS = Math.max(
  1_000,
  Number(process.env.ICECAST_KEEPALIVE_INTERVAL_MS ?? "1500"),
);

export interface IcecastPublisherConfig {
  host?: string;
  port?: number;
  sourcePassword?: string;
  encoderConfig?: ConstructorParameters<typeof AudioEncoder>[0];
}

export class IcecastPublisher {
  private readonly log: pino.Logger;
  private readonly host: string;
  private readonly port: number;
  private readonly sourcePassword: string;
  private readonly encoder: AudioEncoder;

  private socket: net.Socket | null = null;
  private _connected = false;
  private reconnecting = false;
  private currentMountPoint: string | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPushTime = 0;
  private silenceFrame: Buffer | null = null;
  private _broadcasting = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(config: IcecastPublisherConfig = {}) {
    this.log = pino({ name: "IcecastPublisher" });
    this.host = config.host ?? process.env.ICECAST_HOST ?? "localhost";
    this.port = config.port ?? Number(process.env.ICECAST_PORT ?? 8000);
    this.sourcePassword =
      config.sourcePassword ?? process.env.ICECAST_SOURCE_PASSWORD ?? "hackme";
    this.encoder = new AudioEncoder(config.encoderConfig);
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Suppress keepalive silence while actively broadcasting audio. */
  set broadcasting(value: boolean) {
    this._broadcasting = value;
  }

  async connect(mountPoint: string): Promise<void> {
    if (this._connected) {
      this.log.warn("Already connected — disconnect first");
      return;
    }

    this.currentMountPoint = mountPoint;
    const mount = mountPoint.startsWith("/") ? mountPoint : `/${mountPoint}`;
    const auth = Buffer.from(`source:${this.sourcePassword}`).toString(
      "base64",
    );

    this.log.info(
      { host: this.host, port: this.port, mount },
      "Connecting to Icecast",
    );

    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(
        { host: this.host, port: this.port },
        () => {
          socket.setNoDelay(true);
          socket.setKeepAlive(true, 5000);
          const headers = [
            `PUT ${mount} HTTP/1.0`,
            `Host: ${this.host}:${this.port}`,
            `Authorization: Basic ${auth}`,
            `Content-Type: audio/mpeg`,
            `Ice-Name: clanker.show`,
            `Ice-Public: 0`,
            ``,
            ``,
          ].join("\r\n");

          socket.write(headers);
        },
      );

      let responded = false;
      let responseBuf = "";

      socket.once("data", (chunk) => {
        if (responded) return;
        responded = true;

        responseBuf += chunk.toString();
        const statusMatch = responseBuf.match(/HTTP\/\d\.\d (\d{3})/);

        if (!statusMatch) {
          const err = new Error(
            `Unexpected Icecast response: ${responseBuf.slice(0, 200)}`,
          );
          this.log.error(err.message);
          socket.destroy();
          return reject(err);
        }

        const status = parseInt(statusMatch[1], 10);
        if (status >= 200 && status < 300) {
          this._connected = true;
          this.socket = socket;
          this.log.info({ statusCode: status }, "Connected to Icecast");
          this.startKeepalive();
          void this.pushInitialBurst();
          resolve();
        } else {
          const err = new Error(`Icecast responded with status ${status}`);
          this.log.error({ statusCode: status }, err.message);
          socket.destroy();
          reject(err);
        }
      });

      socket.on("error", (err) => {
        this._connected = false;
        this.log.error({ err }, "Icecast connection error");
        if (!responded) {
          responded = true;
          reject(err);
        }
        if (!this.reconnecting) this.scheduleReconnect();
      });

      socket.on("close", () => {
        this.stopKeepalive();
        if (this._connected) {
          this.log.warn("Icecast connection closed unexpectedly");
          this._connected = false;
          this.socket = null;
          if (!this.reconnecting) this.scheduleReconnect();
        }
      });
    });
  }

  async pushAudio(mp3Buffer: Buffer): Promise<void> {
    this.writeChain = this.writeChain
      .then(() => this.writeWithBackpressure(mp3Buffer))
      .catch((err) => {
        this.log.error({ err }, "Error writing audio to Icecast");
        this._connected = false;
      });
    return this.writeChain;
  }

  private async writeWithBackpressure(mp3Buffer: Buffer): Promise<void> {
    if (!this.socket || !this._connected) {
      this.log.warn("Cannot push audio — not connected");
      return;
    }

    const socket = this.socket;
    const flushed = socket.write(mp3Buffer);
    this.lastPushTime = Date.now();
    this.log.debug(
      { bytes: mp3Buffer.length, flushed, writable: socket.writable },
      "Socket write",
    );
    if (!flushed) {
      await Promise.race([
        once(socket, "drain"),
        once(socket, "close").then(() => {
          throw new Error("Socket closed before drain");
        }),
        once(socket, "error").then(([err]) => {
          throw err instanceof Error ? err : new Error(String(err));
        }),
      ]);
    }
  }

  async pushSilence(durationMs: number): Promise<void> {
    if (!this.socket || !this._connected) {
      this.log.warn("Cannot push silence — not connected");
      return;
    }

    try {
      const silentPcm = this.encoder.generateSilence(durationMs);
      const mp3 = await this.encoder.encode(silentPcm);
      await this.pushAudio(mp3);
    } catch (err) {
      this.log.error({ err }, "Error pushing silence");
    }
  }

  disconnect(): void {
    this.log.info("Disconnecting from Icecast");
    this._connected = false;
    this.reconnecting = false;
    this.currentMountPoint = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopKeepalive();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  // TODO play music or sumn here
  private async pushInitialBurst(): Promise<void> {
    const BURST_DURATION_MS = Math.max(
      0,
      Number(process.env.ICECAST_INITIAL_BURST_MS ?? "400"),
    );
    if (BURST_DURATION_MS === 0) return;
    try {
      const pcm = this.encoder.generateSilence(BURST_DURATION_MS);
      const mp3 = await this.encoder.encode(pcm);
      await this.pushAudio(mp3);
      this.log.info(
        { bytes: mp3.length, durationMs: BURST_DURATION_MS },
        "Pushed initial silence burst",
      );
    } catch (err) {
      this.log.error({ err }, "Failed to push initial burst");
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.lastPushTime = Date.now();

    this.keepaliveTimer = setInterval(async () => {
      if (!this._connected || this._broadcasting) return;

      const idle = Date.now() - this.lastPushTime;
      if (idle >= KEEPALIVE_INTERVAL_MS) {
        try {
          if (!this.silenceFrame) {
            const pcm = this.encoder.generateSilence(KEEPALIVE_INTERVAL_MS);
            this.silenceFrame = await this.encoder.encode(pcm);
          }
          await this.pushAudio(this.silenceFrame);
        } catch {
          // silence push failed — connection error handler will deal with it
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.currentMountPoint) return;
    if (this.reconnectTimer) return;

    this.reconnecting = true;
    const mount = this.currentMountPoint;
    const delay = 5000;

    this.log.info({ delay, mount }, "Scheduling Icecast reconnect");

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect(mount);
        this.reconnecting = false;
      } catch {
        this.reconnecting = false;
      }
    }, delay);
  }
}
