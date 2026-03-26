import { EventEmitter } from "node:events";
import pino from "pino";

export interface GuestSession {
  id: string;
  type: "ai" | "human";
  on(event: "audio", handler: (pcm: Buffer) => void): void;
  sendAudio(pcm: Buffer): void;
  end(): void;
}

export interface GuestGatewayConfig {
  elevenLabsConversationalUrl?: string;
  webrtcSignallingUrl?: string;
}

export class GuestGateway {
  private readonly log: pino.Logger;
  private readonly config: GuestGatewayConfig;
  private readonly sessions: Map<string, GuestSession> = new Map();
  private readonly spaceSessions: Map<string, string> = new Map();

  constructor(config: GuestGatewayConfig = {}) {
    this.log = pino({ name: "GuestGateway" });
    this.config = config;
  }

  async connectAIGuest(agentId: string, topic: string): Promise<GuestSession> {
    this.log.info({ agentId, topic }, "connectAIGuest called");
    throw new Error(
      `Not implemented yet: connectAIGuest(agentId=${agentId}, topic=${topic}).`,
    );
  }

  async acceptCaller(callerId: string): Promise<GuestSession> {
    this.log.info({ callerId }, "acceptCaller called");
    throw new Error(
      `Not implemented yet: acceptCaller(callerId=${callerId}).`,
    );
  }

  getActiveSession(spaceId: string): GuestSession | null {
    const sessionId = this.spaceSessions.get(spaceId);
    if (!sessionId) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.log.warn({ sessionId }, "No active session found to end");
      return;
    }

    this.log.info({ sessionId, type: session.type }, "Ending guest session");
    session.end();
    this.sessions.delete(sessionId);

    for (const [spaceId, sid] of this.spaceSessions) {
      if (sid === sessionId) {
        this.spaceSessions.delete(spaceId);
        break;
      }
    }
  }
}
