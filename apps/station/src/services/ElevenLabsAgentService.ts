import { EventEmitter } from "events";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import pino from "pino";

const HOST_TAG_PREFIX = "host:";

export interface HostSpec {
  id: string;
  name: string;
  personality: string;
  voiceId: string;
}

export interface AgentSessionConfig {
  agentId: string;
  dynamicVariables: Record<string, string>;
  overrides?: {
    agent?: { firstMessage?: string; language?: string };
    tts?: { voiceId?: string };
  };
}

export class ElevenLabsAgentService extends EventEmitter {
  private static readonly FLUSH_INTERVAL_MS = 100;
  private static readonly MAX_PREOPEN_BUFFER_BYTES = 320_000; // ~10s at 16kHz PCM16 mono
  private static readonly sharedClient = new ElevenLabsClient();

  private readonly log = pino({ name: "ElevenLabsAgent" });
  private readonly client: ElevenLabsClient;
  private ws: WebSocket | null = null;
  private closed = false;
  private audioBuffer: Buffer[] = [];
  private preOpenBuffer: Buffer[] = [];
  private preOpenBufferBytes = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private _conversationId: string | null = null;

  private static readonly mgrLog = pino({ name: "ElevenLabsAgent" });

  /**
   * Ensures one ElevenLabs agent exists per host. Returns a Map of hostId → agentId.
   * On retries, existing agents are found by their `host:<id>` tag and reused.
   */
  static async ensureAgents(
    hosts: HostSpec[],
    spaceDescription?: string,
    language?: string,
  ): Promise<Map<string, string>> {
    const client = ElevenLabsAgentService.sharedClient;
    const log = ElevenLabsAgentService.mgrLog;
    const existing = await ElevenLabsAgentService.findExistingAgents(hosts.map((h) => h.id));
    const result = new Map<string, string>();

    for (const host of hosts) {
      const existingAgentId = existing.get(host.id);
      if (existingAgentId) {
        log.info({ hostId: host.id, agentId: existingAgentId }, "Reusing existing agent");
        result.set(host.id, existingAgentId);
        continue;
      }

      const response = await client.conversationalAi.agents.create({
        name: `${spaceDescription ?? "Space"} - ${host.name}`,
        tags: [`${HOST_TAG_PREFIX}${host.id}`],
        conversationConfig: {
          agent: {
            prompt: {
              prompt: ElevenLabsAgentService.buildSystemPrompt(host),
              tools: [
                {
                  type: "client",
                  name: "end_call",
                  description:
                    "End the current call. Use when the conversation has naturally concluded or the caller says goodbye.",
                },
              ],
            },
            firstMessage: `Welcome to the show, {{caller_name}}! You're live on {{station_name}}. You wanted to talk about {{caller_topic}} — let's hear it!`,
            language: language ?? "en",
          },
          asr: { quality: "high" },
          tts: {
            voiceId: host.voiceId,
            modelId: "eleven_flash_v2",
            agentOutputAudioFormat: "pcm_16000",
          },
          conversation: { maxDurationSeconds: 360 },
        },
        platformSettings: {
          auth: { enableAuth: true },
        },
      });

      const agentId = response.agentId;
      result.set(host.id, agentId);
      log.info({ hostId: host.id, hostName: host.name, agentId }, "Created agent");
    }

    return result;
  }

  private static async findExistingAgents(hostIds: string[]): Promise<Map<string, string>> {
    const client = ElevenLabsAgentService.sharedClient;
    const tagSet = new Set(hostIds.map((id) => `${HOST_TAG_PREFIX}${id}`));
    const found = new Map<string, string>();

    let cursor: string | undefined;
    do {
      const page = await client.conversationalAi.agents.list({
        pageSize: 100,
        ...(cursor ? { cursor } : {}),
      });

      for (const agent of page.agents) {
        for (const tag of agent.tags) {
          if (tagSet.has(tag)) {
            const hostId = tag.slice(HOST_TAG_PREFIX.length);
            found.set(hostId, agent.agentId);
            tagSet.delete(tag);
          }
        }
      }

      if (tagSet.size === 0) break;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    return found;
  }

  private static buildSystemPrompt(host: { name: string; personality: string }): string {
    return `You are ${host.name}, a host on "{{station_name}}".
${host.personality}

You are live on air talking with {{caller_name}} who called about: "{{caller_topic}}"

Show context: {{show_context}}

RULES:
- You are LIVE on air. Everything is broadcast.
- Keep responses SHORT (1-3 sentences). React to what the caller says.
- Ask follow-ups to keep conversation flowing.
- When you get a contextual update about wrapping up, thank the caller and say goodbye.
- Do NOT break character or mention being an AI.

# Guardrails
- Stay on topic with the caller's discussion.
- Do not make promises or commitments on behalf of the space.
- Keep content appropriate for a general audience.`;
  }

  constructor() {
    super();
    this.client = new ElevenLabsClient();
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get conversationId(): string | null {
    return this._conversationId;
  }

  async startSession(config: AgentSessionConfig): Promise<string> {
    this.log.info({ agentId: config.agentId }, "Starting agent session — fetching signed URL");

    const response = await this.client.conversationalAi.conversations.getSignedUrl({
      agentId: config.agentId,
    });
    const signed_url = response.signedUrl;
    this.log.info("Signed URL acquired, opening WebSocket");

    const ws = new WebSocket(signed_url);

    // Wait for open
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Agent WebSocket open timed out after 10s"));
      }, 10_000);

      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        this.log.info("Agent WebSocket opened, sending initiation data");

        // Send conversation initiation data — only include overrides that
        // are actually set, so we don't accidentally nullify the agent's
        // configured first_message, voice, etc.
        const initData: Record<string, unknown> = {
          type: "conversation_initiation_client_data",
          dynamic_variables: config.dynamicVariables,
        };

        if (config.overrides) {
          const configOverride: Record<string, unknown> = {};
          if (config.overrides.agent) {
            const agentOverride: Record<string, unknown> = {};
            if (config.overrides.agent.firstMessage) agentOverride.first_message = config.overrides.agent.firstMessage;
            if (config.overrides.agent.language) agentOverride.language = config.overrides.agent.language;
            if (Object.keys(agentOverride).length > 0) configOverride.agent = agentOverride;
          }
          if (config.overrides.tts?.voiceId) {
            configOverride.tts = { voice_id: config.overrides.tts.voiceId };
          }
          if (Object.keys(configOverride).length > 0) {
            initData.conversation_config_override = configOverride;
          }
        }

        ws.send(JSON.stringify(initData));

        this.flushPreOpenAudio();
        resolve();
      }, { once: true });

      ws.addEventListener("error", (event) => {
        clearTimeout(timeout);
        reject(new Error(`Agent WebSocket failed to open: ${String(event)}`));
      }, { once: true });
    });

    // Wire message handler
    ws.addEventListener("message", (event) => {
      try {
        const data =
          typeof event.data === "string"
            ? JSON.parse(event.data)
            : JSON.parse(event.data.toString());

        this.handleMessage(data);
      } catch (err) {
        this.log.error({ err }, "Failed to parse agent message");
      }
    });

    ws.addEventListener("error", (event) => {
      this.log.error({ event }, "Agent WebSocket error");
      this.emit("error", new Error("Agent WebSocket error"));
    });

    ws.addEventListener("close", (event) => {
      this.log.info({ code: event.code, reason: event.reason }, "Agent WebSocket closed");
      if (!this.closed) {
        this.emit("session-ended", event.reason || "ws_closed");
      }
    });

    this.ws = ws;

    // Wait for conversation_initiation_metadata to get the conversation ID
    const conversationId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for conversation initiation metadata"));
      }, 15_000);

      const handler = (id: string) => {
        clearTimeout(timeout);
        resolve(id);
      };
      this.once("_conversation_id", handler);
    });

    this._conversationId = conversationId;
    this.log.info({ conversationId }, "Agent session started");
    return conversationId;
  }

  sendAudio(pcm: Buffer): void {
    if (this.closed) return;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.preOpenBuffer.push(pcm);
      this.preOpenBufferBytes += pcm.length;
      while (
        this.preOpenBufferBytes > ElevenLabsAgentService.MAX_PREOPEN_BUFFER_BYTES &&
        this.preOpenBuffer.length > 0
      ) {
        const dropped = this.preOpenBuffer.shift();
        if (!dropped) break;
        this.preOpenBufferBytes -= dropped.length;
      }
      return;
    }

    this.audioBuffer.push(pcm);

    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushAudio(), ElevenLabsAgentService.FLUSH_INTERVAL_MS);
    }
  }

  sendContextualUpdate(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: "contextual_update",
      text,
    }));
    this.log.info({ textLen: text.length }, "Sent contextual update to agent");
  }

  sendUserActivity(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "user_activity" }));
  }

  endSession(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.audioBuffer = [];
    this.preOpenBuffer = [];
    this.preOpenBufferBytes = 0;
    try {
      this.ws?.close();
    } catch {
      // ignore close errors
    }
    this.ws = null;
    this.removeAllListeners();
  }

  
  private handleMessage(data: Record<string, unknown>): void {
    const type = data.type as string;

    switch (type) {
      case "conversation_initiation_metadata": {
        const conversationId =
          (data.conversation_id as string) ??
          ((data.conversation_initiation_metadata_event as Record<string, unknown>)?.conversation_id as string);
        if (conversationId) {
          this.emit("_conversation_id", conversationId);
        }
        break;
      }

      case "audio": {
        const audioEvent = data.audio_event as Record<string, unknown> | undefined;
        const base64Audio = (audioEvent?.audio_base_64 ?? data.audio_base_64) as string | undefined;
        if (base64Audio) {
          const pcm = Buffer.from(base64Audio, "base64");
          this.emit("agent-audio", pcm);
        }
        break;
      }

      case "agent_response": {
        const text =
          (data.agent_response_event as Record<string, unknown>)?.agent_response as string ??
          data.agent_response as string;
        if (text) {
          this.emit("agent-response", text);
        }
        break;
      }

      case "user_transcript": {
        const text =
          (data.user_transcription_event as Record<string, unknown>)?.user_transcript as string ??
          data.user_transcript as string;
        if (text) {
          this.emit("user-transcript", text);
        }
        break;
      }

      case "interruption":
        this.log.debug("Agent detected interruption");
        break;

      case "ping": {
        const pingEvent = data.ping_event as Record<string, unknown> | undefined;
        const pingMs = (pingEvent?.ping_ms ?? data.ping_ms ?? 0) as number;
        const eventId = (pingEvent?.event_id ?? data.event_id) as number | undefined;
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: "pong",
              event_id: eventId,
            }));
          }
        }, pingMs);
        break;
      }

      case "client_tool_call": {
        const toolName =
          (data.client_tool_call as Record<string, unknown>)?.tool_name as string ??
          data.tool_name as string;
        const toolCallId =
          (data.client_tool_call as Record<string, unknown>)?.tool_call_id as string ??
          data.tool_call_id as string;

        if (toolName === "end_call") {
          this.log.info("Agent invoked end_call tool");
          // Respond to acknowledge the tool call
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: "client_tool_result",
              tool_call_id: toolCallId,
              result: "Call ended successfully.",
              is_error: false,
            }));
          }
          this.emit("session-ended", "agent_end_call");
        }
        break;
      }

      case "session_ended":
        this.emit("session-ended", "server_ended");
        break;

      default:
        if (data.error) {
          this.log.error({ type, error: data.error }, "Agent error message");
          this.emit("error", new Error(String(data.error)));
        }
        break;
    }
  }

  private flushAudio(): void {
    if (this.audioBuffer.length === 0) {
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }
      return;
    }

    const combined = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];

    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({
      type: "user_audio_chunk",
      user_audio_chunk: combined.toString("base64"),
    }));
  }

  private flushPreOpenAudio(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.preOpenBuffer.length === 0) return;

    this.log.info(
      { chunks: this.preOpenBuffer.length, bytes: this.preOpenBufferBytes },
      "Flushing buffered pre-open agent audio",
    );
    this.audioBuffer.push(...this.preOpenBuffer);
    this.preOpenBuffer = [];
    this.preOpenBufferBytes = 0;
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushAudio(), ElevenLabsAgentService.FLUSH_INTERVAL_MS);
    }
  }
}
