"use client";

import { useRef, useState, useEffect } from "react";

interface PlayerProps {
  streamUrl: string;
  stationName: string;
  isLive: boolean;
  onPlaybackStateChange?: (playing: boolean) => void;
  autoPlayOnLoad?: boolean;
}

export function Player({
  streamUrl,
  stationName,
  isLive,
  onPlaybackStateChange,
  autoPlayOnLoad = true,
}: PlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const autoplayAttemptedRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlaying = () => {
      setErrored(false);
      setLoading(false);
      setPlaying(true);
      onPlaybackStateChange?.(true);
    };
    const onPause = () => {
      setLoading(false);
      setPlaying(false);
      onPlaybackStateChange?.(false);
    };
    const onLoadStart = () => {
      if (!playing) setLoading(true);
    };
    const onWaiting = () => {
      if (!playing) setLoading(true);
    };
    const onCanPlay = () => {
      if (!playing) setLoading(false);
    };
    const onError = () => {
      setPlaying(false);
      setLoading(false);
      setErrored(true);
      onPlaybackStateChange?.(false);
    };

    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("loadstart", onLoadStart);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("loadstart", onLoadStart);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("error", onError);
    };
  }, [onPlaybackStateChange]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!isLive) {
      audio.pause();
      audio.src = "";
      setPlaying(false);
      setLoading(false);
      setErrored(false);
      onPlaybackStateChange?.(false);
      return;
    }
    if (audio.src !== streamUrl) {
      audio.src = streamUrl;
      audio.load();
      setErrored(false);
    }
  }, [isLive, streamUrl, onPlaybackStateChange]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!autoPlayOnLoad) return;
    if (!isLive) return;
    if (autoplayAttemptedRef.current === streamUrl) return;

    autoplayAttemptedRef.current = streamUrl;

    if (audio.src !== streamUrl) {
      audio.src = streamUrl;
      audio.load();
    }

    setLoading(true);
    void audio.play().then(() => {
      setErrored(false);
    }).catch(() => {
      // Browser autoplay policies may block non-gesture playback.
      setLoading(false);
      setPlaying(false);
      setErrored(false);
    });
  }, [autoPlayOnLoad, isLive, streamUrl]);

  const togglePlay = async () => {
    if (!audioRef.current) return;
    const audio = audioRef.current;

    if (playing) {
      audio.pause();
      setPlaying(false);
      setLoading(false);
    } else {
      if (audio.src !== streamUrl) {
        audio.src = streamUrl;
        audio.load();
      }
      setPlaying(true);
      setLoading(true);
      try {
        await audio.play();
        setErrored(false);
      } catch {
        setPlaying(false);
        setErrored(true);
      }
    }
  };

  return (
    <div className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <audio ref={audioRef} preload="auto" playsInline />

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
        <p className="text-xs text-zinc-500">
          {errored
            ? "Unable to start stream"
            : loading
            ? "Connecting to live stream..."
            : playing
            ? "Listening now"
            : isLive
              ? "Tap to tune in"
              : "Station offline"}
        </p>
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
