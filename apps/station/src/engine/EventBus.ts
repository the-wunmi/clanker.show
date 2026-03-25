import { EventEmitter } from "node:events";

import type { CallerStatus, StationConfig } from "./types";
import type { PulseEvent } from "../services/ContentPipeline";
import type { ScriptLine } from "../services/ScriptGenerator";

export interface StationEvents {
  // External commands (from parentPort messages)
  "cmd:start": (config: StationConfig, stationId: string) => void;
  "cmd:stop": () => void;
  "cmd:pause": () => void;
  "cmd:resume": () => void;
  "cmd:listener-count": (count: number) => void;
  "cmd:submit-tip": (tip: { topic: string; content: string; submitter: string }) => void;
  "cmd:accept-caller": (callerId: string) => void;
  "cmd:caller-connected": (callerId: string, callerName: string, topicHint: string) => void;
  "cmd:caller-audio": (callerId: string, pcm: Buffer) => void;
  "cmd:caller-disconnected": (callerId: string) => void;

  // Internal lifecycle events
  "content:pulse": (pulse: PulseEvent) => void;
  "audio:chunk-pushed": (chunk: Buffer) => void;
  "segment:progress": (segmentProgress: number, programProgress: number) => void;
  "segment:line-spoken": (lineIndex: number, line: ScriptLine) => void;
  "caller:status": (callerId: string, status: CallerStatus) => void;
  "transcript:line": (line: ScriptLine) => void;
}

type EventKey = keyof StationEvents;

export class EventBus extends EventEmitter {
  emit<K extends EventKey>(event: K, ...args: Parameters<StationEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  on<K extends EventKey>(event: K, listener: StationEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  once<K extends EventKey>(event: K, listener: StationEvents[K]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  off<K extends EventKey>(event: K, listener: StationEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}
