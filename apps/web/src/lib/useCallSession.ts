"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { submitCallIn, fetchCallerStatus } from "./api";

export type CallState =
  | "idle"
  | "queued"
  | "accepted"
  | "connecting"
  | "on-air"
  | "listening"
  | "ended";

export interface CallTranscriptLine {
  speaker: string;
  text: string;
  timestamp: number;
}

export interface UseCallSessionReturn {
  state: CallState;
  transcript: CallTranscriptLine[];
  error: string | null;
  submitToQueue: (name: string, topicHint: string) => Promise<void>;
  endCall: () => void;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

export function useCallSession(slug: string): UseCallSessionReturn {
  const [state, setState] = useState<CallState>("idle");
  const [transcript, setTranscript] = useState<CallTranscriptLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const callerIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const cleanup = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  const connectAudio = useCallback(
    async (callerId: string) => {
      setState("connecting");

      try {
        // Request microphone
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: 16000,
          },
        });
        streamRef.current = stream;

        // Create AudioContext
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = audioCtx;

        // Load worklet
        await audioCtx.audioWorklet.addModule("/audio-worklet-processor.js");

        const source = audioCtx.createMediaStreamSource(stream);
        const workletNode = new AudioWorkletNode(audioCtx, "pcm-capture-processor");
        source.connect(workletNode);
        workletNode.connect(audioCtx.destination);

        // Open WebSocket
        const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsBase = API_BASE
          ? API_BASE.replace(/^http/, "ws")
          : `${wsProtocol}//${window.location.host}`;
        const ws = new WebSocket(
          `${wsBase}/api/stations/${slug}/call-ws/${callerId}`,
        );
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          setState("on-air");
        };

        // Forward PCM from worklet to WebSocket
        workletNode.port.onmessage = (event: MessageEvent) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(event.data);
          }
        };

        ws.onmessage = (event: MessageEvent) => {
          if (typeof event.data === "string") {
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === "caller-status") {
                const status = msg.status as string;
                if (status === "speak") setState("on-air");
                else if (status === "listening") setState("listening");
                else if (status === "ended") {
                  setState("ended");
                  cleanup();
                }
              }
              if (msg.type === "transcript") {
                setTranscript((prev) => [
                  ...prev,
                  {
                    speaker: msg.speaker,
                    text: msg.text,
                    timestamp: Date.now(),
                  },
                ]);
              }
            } catch {
              // ignore
            }
          }
        };

        ws.onclose = () => {
          if (state !== "ended") {
            setState("ended");
          }
          cleanup();
        };

        ws.onerror = () => {
          setError("WebSocket connection failed");
          setState("ended");
          cleanup();
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to connect audio";
        setError(message);
        setState("ended");
        cleanup();
      }
    },
    [slug, cleanup, state],
  );

  const startPolling = useCallback(
    (callerId: string) => {
      pollTimerRef.current = setInterval(async () => {
        try {
          const result = await fetchCallerStatus(slug, callerId);
          if (result.status === "accepted" || result.status === "connected") {
            if (pollTimerRef.current) {
              clearInterval(pollTimerRef.current);
              pollTimerRef.current = null;
            }
            setState("accepted");
            await connectAudio(callerId);
          }
        } catch {
          // keep polling
        }
      }, 2000);
    },
    [slug, connectAudio],
  );

  const submitToQueue = useCallback(
    async (name: string, topicHint: string) => {
      setError(null);
      setTranscript([]);

      try {
        const result = await submitCallIn(slug, {
          name,
          topicHint: topicHint || undefined,
        });
        callerIdRef.current = result.id;
        setState("queued");
        startPolling(result.id);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to join queue";
        setError(message);
      }
    },
    [slug, startPolling],
  );

  const endCall = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "end-call" }));
    }
    setState("ended");
    cleanup();
  }, [cleanup]);

  return { state, transcript, error, submitToQueue, endCall };
}
