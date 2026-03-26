"use client";

import { useState, useEffect } from "react";
import { useCallSession, type CallTranscriptLine } from "@/lib/useCallSession";

export function CallInButton({ slug, onMuteStream }: { slug: string; onMuteStream?: (mute: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const { state, muteStream, transcript, error, submitToQueue, endCall } =
    useCallSession(slug);

  // Notify parent to mute/unmute the live player
  useEffect(() => {
    onMuteStream?.(muteStream);
  }, [muteStream, onMuteStream]);

  const handleSubmit = () => {
    if (!name.trim()) return;
    submitToQueue(name.trim(), topic.trim());
  };

  // After call ends, allow reset
  if (state === "ended") {
    return (
      <div className="rounded-xl border border-zinc-700 bg-zinc-800/80 p-4">
        <p className="text-sm text-zinc-300">
          Call ended. Thanks for calling in!
        </p>
        {transcript.length > 0 && (
          <MiniTranscript lines={transcript} />
        )}
        <button
          onClick={() => {
            setOpen(false);
            setName("");
            setTopic("");
          }}
          className="mt-2 text-xs text-zinc-500 underline"
        >
          Close
        </button>
      </div>
    );
  }

  // On-air or listening state
  if (state === "on-air" || state === "listening" || state === "connecting") {
    return (
      <div className="rounded-xl border border-zinc-700 bg-zinc-800/80 p-4">
        {state === "connecting" && (
          <div className="flex items-center gap-2">
            <Spinner />
            <span className="text-sm text-zinc-400">Connected — waiting to go on air...</span>
          </div>
        )}
        {state === "on-air" && (
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
            <span className="text-sm font-semibold text-green-400">
              ON AIR — Speak!
            </span>
          </div>
        )}
        {state === "listening" && (
          <div className="flex items-center gap-2">
            <Spinner />
            <span className="text-sm text-zinc-400">AI is responding...</span>
          </div>
        )}
        {transcript.length > 0 && (
          <MiniTranscript lines={transcript} />
        )}
        <button
          onClick={endCall}
          className="mt-3 rounded-lg border border-red-700 bg-red-900/50 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-800/50"
        >
          End Call
        </button>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  // Queued / accepted state
  if (state === "queued" || state === "accepted") {
    return (
      <div className="rounded-xl border border-zinc-700 bg-zinc-800/80 p-4">
        <div className="flex items-center gap-2">
          <Spinner />
          <span className="text-sm text-zinc-400">
            {state === "queued"
              ? "In queue... waiting to be brought on air"
              : "Accepted! Connecting..."}
          </span>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  // Idle state — show button or form
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-700"
      >
        Call In
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-800/80 p-4">
      <h3 className="mb-3 text-sm font-semibold">Request to Call In</h3>
      <input
        type="text"
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mb-2 w-full rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-400 focus:outline-none"
      />
      <input
        type="text"
        placeholder="What do you want to talk about? (optional)"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        className="mb-3 w-full rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-400 focus:outline-none"
      />
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={!name.trim()}
          className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:opacity-50"
        >
          Join Queue
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-zinc-400"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function MiniTranscript({ lines }: { lines: CallTranscriptLine[] }) {
  const recent = lines.slice(-5);
  return (
    <div className="mt-3 max-h-32 overflow-y-auto rounded-lg bg-zinc-900/50 p-2">
      {recent.map((line, i) => (
        <p key={i} className="text-xs text-zinc-400">
          <span className="font-medium text-zinc-300">{line.speaker}:</span>{" "}
          {line.text}
        </p>
      ))}
    </div>
  );
}
