import pino from "pino";
import type { AudioEncoder, AudioStream } from "../services/AudioEncoder";

export interface CallAudioStreamerConfig {
  audioEncoder: AudioEncoder;
  onAgentMp3: (mp3: Buffer) => void;
  onCallerMp3: (mp3: Buffer) => void;
  flushIntervalMs?: number;
}

/**
 * Manages two persistent ffmpeg processes for the duration of a call:
 *   - Agent stream:  ElevenLabs PCM → ffmpeg → MP3 → broadcast + send to caller
 *   - Caller stream: browser mic PCM → ffmpeg → MP3 → broadcast only
 *
 * PCM is written directly to ffmpeg stdin as it arrives. ffmpeg outputs MP3
 * frames continuously. We collect output in time-based chunks and split at
 * MP3 frame boundaries before emitting.
 */
export class CallAudioStreamer {
  private readonly log = pino({ name: "CallAudioStreamer" });
  private readonly audioEncoder: AudioEncoder;
  private readonly onAgentMp3: (mp3: Buffer) => void;
  private readonly onCallerMp3: (mp3: Buffer) => void;
  private readonly flushIntervalMs: number;

  private agentStream: AudioStream | null = null;
  private callerStream: AudioStream | null = null;

  private agentBuf = Buffer.alloc(0);
  private callerBuf = Buffer.alloc(0);

  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: CallAudioStreamerConfig) {
    this.audioEncoder = config.audioEncoder;
    this.onAgentMp3 = config.onAgentMp3;
    this.onCallerMp3 = config.onCallerMp3;
    this.flushIntervalMs = config.flushIntervalMs ?? 200;
  }

  start(): void {
    this.agentStream = this.audioEncoder.createStream();
    this.callerStream = this.audioEncoder.createStream();

    this.agentStream.readable.on("data", (chunk: Buffer) => {
      this.agentBuf = Buffer.concat([this.agentBuf, chunk]);
    });

    this.callerStream.readable.on("data", (chunk: Buffer) => {
      this.callerBuf = Buffer.concat([this.callerBuf, chunk]);
    });

    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);

    this.log.info("CallAudioStreamer started");
  }

  pushAgentPcm(pcm: Buffer): void {
    this.agentStream?.write(pcm);
  }

  pushCallerPcm(pcm: Buffer): void {
    this.callerStream?.write(pcm);
  }

  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush — send everything including any partial trailing frame.
    // The browser silently drops undecodable tail bytes.
    this.flushFinal();

    this.agentStream?.close();
    this.callerStream?.close();
    this.agentStream = null;
    this.callerStream = null;

    this.log.info("CallAudioStreamer closed");
  }

  // ── MP3 frame-boundary-aware flushing ──────────────────────────────

  private flush(): void {
    this.flushSource("agent");
    this.flushSource("caller");
  }

  private flushFinal(): void {
    // Emit whatever is left, including partial frames
    if (this.agentBuf.length > 0) {
      this.onAgentMp3(this.agentBuf);
      this.agentBuf = Buffer.alloc(0);
    }
    if (this.callerBuf.length > 0) {
      this.onCallerMp3(this.callerBuf);
      this.callerBuf = Buffer.alloc(0);
    }
  }

  private flushSource(source: "agent" | "caller"): void {
    const buf = source === "agent" ? this.agentBuf : this.callerBuf;
    if (buf.length === 0) return;

    const completeBytes = findMp3FrameBoundary(buf);
    if (completeBytes <= 0) return; // no complete frame yet

    const chunk = buf.subarray(0, completeBytes);
    const remainder = buf.subarray(completeBytes);

    if (source === "agent") {
      this.agentBuf = remainder.length > 0 ? Buffer.from(remainder) : Buffer.alloc(0);
      this.onAgentMp3(Buffer.from(chunk));
    } else {
      this.callerBuf = remainder.length > 0 ? Buffer.from(remainder) : Buffer.alloc(0);
      this.onCallerMp3(Buffer.from(chunk));
    }
  }
}

// ── MP3 frame header parsing ──────────────────────────────────────────

/** MPEG1 Layer3 bitrate table (index → kbps). Index 0 and 15 are invalid. */
const MPEG1_L3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];

/** MPEG1 sample rate table (index → Hz). */
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000, 0];

/**
 * Walk the buffer parsing consecutive MPEG1 Layer3 frames.
 * Returns the byte offset up to which all frames are complete.
 * Any trailing bytes that don't form a complete frame are excluded.
 */
function findMp3FrameBoundary(buf: Buffer): number {
  let offset = 0;

  while (offset + 4 <= buf.length) {
    // Sync word: 0xFF followed by 0xFB (MPEG1, Layer3, no CRC)
    // or 0xFF 0xFA (MPEG1, Layer3, with CRC)
    if (buf[offset] !== 0xff) {
      // Try to resync — skip forward to find next 0xFF
      offset++;
      continue;
    }

    const b1 = buf[offset + 1];
    // Check for MPEG1 (bit 3 = 1), Layer3 (bits 2-1 = 01), any CRC
    // Valid second bytes: 0xFB (no CRC) or 0xFA (CRC)
    // More broadly: 11111 01 x  → top 5 bits = 11111, layer bits = 01
    if ((b1 & 0xfe) !== 0xfa) {
      offset++;
      continue;
    }

    const b2 = buf[offset + 2];
    const bitrateIdx = (b2 >> 4) & 0x0f;
    const sampleRateIdx = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;

    const bitrate = MPEG1_L3_BITRATES[bitrateIdx];
    const sampleRate = MPEG1_SAMPLE_RATES[sampleRateIdx];

    if (bitrate === 0 || sampleRate === 0) {
      // Invalid frame header — skip
      offset++;
      continue;
    }

    const frameSize = Math.floor((144 * bitrate * 1000) / sampleRate) + padding;

    if (offset + frameSize > buf.length) {
      // Incomplete frame — stop here
      break;
    }

    offset += frameSize;
  }

  return offset;
}
