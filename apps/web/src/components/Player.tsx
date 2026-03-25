"use client";

import { useRef, useState, useEffect } from "react";

interface PlayerProps {
  streamUrl: string;
  stationName: string;
  isLive: boolean;
}

export function Player({ streamUrl, stationName, isLive }: PlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  const togglePlay = () => {
    if (!audioRef.current) return;

    if (playing) {
      audioRef.current.pause();
      audioRef.current.src = "";
      setPlaying(false);
    } else {
      audioRef.current.src = streamUrl;
      audioRef.current.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  };

  return (
    <div className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <audio ref={audioRef} />

      <button
        onClick={togglePlay}
        disabled={!isLive}
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-zinc-900 transition-transform hover:scale-105 disabled:opacity-40"
      >
        {playing ? (
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
          {playing
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
