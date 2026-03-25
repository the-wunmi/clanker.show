"use client";

import { useState } from "react";
import { useSubmitCallIn } from "@/lib/hooks";

export function CallInButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const callIn = useSubmitCallIn(slug);

  const handleSubmit = () => {
    if (!name.trim()) return;
    callIn.mutate(
      { name: name.trim(), topicHint: topic.trim() || undefined },
      { onSuccess: () => setSubmitted(true) }
    );
  };

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

  if (submitted) {
    return (
      <div className="rounded-xl border border-zinc-700 bg-zinc-800/80 p-4">
        <p className="text-sm text-green-400">
          You're in the queue! The hosts will bring you on when they're ready.
        </p>
        <button
          onClick={() => {
            setOpen(false);
            setSubmitted(false);
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
          disabled={callIn.isPending || !name.trim()}
          className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:opacity-50"
        >
          {callIn.isPending ? "Submitting..." : "Join Queue"}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
