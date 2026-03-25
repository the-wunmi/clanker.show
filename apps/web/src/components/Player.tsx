"use client";

import { useRef, useState, useEffect, useCallback } from "react";

const MAX_BUFFER_AHEAD_SEC = 2.5;
const RESET_BEHIND_SEC = 0.15;

interface PlayerProps {
  streamUrl: string;
  stationName: string;
  isLive: boolean;
  onPlaybackStateChange?: (playing: boolean) => void;
  autoPlayOnLoad?: boolean;
  /** When true, mutes the audio (e.g. caller is on a call and gets audio via WebSocket) */
  muted?: boolean;
}

export function Player({
  streamUrl,
  stationName,
  isLive,
  onPlaybackStateChange,
  autoPlayOnLoad = true,
  muted = false,
}: PlayerProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const autoplayAttemptedRef = useRef<string | null>(null);
  const manualCloseRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [errored, setErrored] = useState(false);

  const stopPlayback = useCallback(() => {
    manualCloseRef.current = true;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    gainRef.current = null;
    nextPlayTimeRef.current = 0;
    setPlaying(false);
    setLoading(false);
    onPlaybackStateChange?.(false);
  }, [onPlaybackStateChange]);

  useEffect(() => {
    if (gainRef.current) {
      gainRef.current.gain.value = muted ? 0 : volume;
    }
  }, [muted, volume]);

  const scheduleChunkPlayback = useCallback((chunk: ArrayBuffer) => {
    const ctx = audioCtxRef.current;
    const gainNode = gainRef.current;
    if (!ctx || !gainNode) return;

    const copy = chunk.slice(0);
    void ctx.decodeAudioData(copy).then((audioBuffer) => {
      const now = ctx.currentTime;
      const bufferedAhead = Math.max(0, nextPlayTimeRef.current - now);

      // Prevent unbounded latency growth when chunks arrive too quickly.
      if (bufferedAhead > MAX_BUFFER_AHEAD_SEC) {
        return;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);

      // If playback clock fell behind, snap to realtime to reduce stutter.
      if (nextPlayTimeRef.current < now - RESET_BEHIND_SEC) {
        nextPlayTimeRef.current = now;
      }
      source.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += audioBuffer.duration;
    }).catch(() => {
      // Ignore malformed chunks; next chunk will continue.
    });
  }, []);

  const startPlayback = useCallback(async () => {
    if (!isLive) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      setLoading(true);
      setErrored(false);
      manualCloseRef.current = false;

      const ctx = new AudioContext();
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      const gainNode = ctx.createGain();
      gainNode.gain.value = muted ? 0 : volume;
      gainNode.connect(ctx.destination);
      audioCtxRef.current = ctx;
      gainRef.current = gainNode;
      nextPlayTimeRef.current = 0;

      const ws = new WebSocket(streamUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setPlaying(true);
        setLoading(false);
        setErrored(false);
        onPlaybackStateChange?.(true);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          scheduleChunkPlayback(event.data);
        }
      };

      ws.onerror = () => {
        setErrored(true);
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!manualCloseRef.current) {
          setErrored(true);
        }
        setPlaying(false);
        setLoading(false);
        onPlaybackStateChange?.(false);
      };
    } catch {
      setLoading(false);
      setPlaying(false);
      setErrored(true);
      onPlaybackStateChange?.(false);
    }
  }, [
    isLive,
    muted,
    onPlaybackStateChange,
    scheduleChunkPlayback,
    streamUrl,
    volume,
  ]);

  useEffect(() => {
    if (!isLive) {
      stopPlayback();
      setErrored(false);
      return;
    }
  }, [isLive, stopPlayback]);

  useEffect(() => {
    if (!autoPlayOnLoad || !isLive) return;
    if (autoplayAttemptedRef.current === streamUrl) return;
    autoplayAttemptedRef.current = streamUrl;
    void startPlayback().catch(() => {
      setErrored(false);
      setLoading(false);
    });
  }, [autoPlayOnLoad, isLive, startPlayback, streamUrl]);

  useEffect(() => {
    return () => {
      stopPlayback();
    };
  }, [stopPlayback]);

  const togglePlay = async () => {
    if (playing || loading) {
      stopPlayback();
      return;
    }
    await startPlayback();
  };

  const statusText = () => {
    if (errored) return "Unable to start stream";
    if (loading) return "Connecting to live stream...";
    if (playing) return "Listening now";
    if (isLive) return "Tap to tune in";
    return "Station offline";
  };

  return (
    <div className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <button
        onClick={togglePlay}
        disabled={!isLive}
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-zinc-900 transition-transform hover:scale-105 disabled:opacity-40"
      >
        {loading ? (
          <svg
            className="h-5 w-5 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="9" className="opacity-25" />
            <path d="M21 12a9 9 0 0 0-9-9" className="opacity-90" />
          </svg>
        ) : playing ? (
          <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="4" width="4" height="16" />
            <rect x="14" y="4" width="4" height="16" />
          </svg>
        ) : (
          <svg
            className="ml-0.5 h-5 w-5"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <polygon points="5,3 19,12 5,21" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{stationName}</h2>
          {isLive && (
            <span className="flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
              LIVE
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-500">{statusText()}</p>
      </div>

      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={volume}
        onChange={(e) => setVolume(parseFloat(e.target.value))}
        className="hidden w-24 accent-white sm:block"
      />
    </div>
  );
}
