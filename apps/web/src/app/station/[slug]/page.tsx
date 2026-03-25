"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import {
  useStation,
  useStreamUrl,
  useStartStation,
  useStopStation,
  useSubmitTip,
} from "@/lib/hooks";
import { Player } from "@/components/Player";
import { Transcript } from "@/components/Transcript";
import { CallInButton } from "@/components/CallInButton";
import Link from "next/link";

export default function StationPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const { data: station, isLoading } = useStation(slug);
  const { data: streamUrl } = useStreamUrl(slug);
  const startStation = useStartStation();
  const stopStation = useStopStation();
  const submitTip = useSubmitTip(slug);

  const [tipOpen, setTipOpen] = useState(false);
  const [tipTopic, setTipTopic] = useState("");
  const [tipContent, setTipContent] = useState("");

  const handleStart = () => startStation.mutate(slug);
  const handleStop = () => stopStation.mutate(slug);

  const handleTip = () => {
    if (!tipTopic.trim()) return;
    submitTip.mutate(
      { topic: tipTopic, content: tipContent },
      {
        onSuccess: () => {
          setTipOpen(false);
          setTipTopic("");
          setTipContent("");
        },
      }
    );
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-white" />
      </div>
    );
  }

  if (!station) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="mb-2 text-xl font-semibold">Station not found</h1>
          <Link href="/" className="text-sm text-zinc-400 underline">
            Back to directory
          </Link>
        </div>
      </div>
    );
  }

  const isLive = station.status === "live";
  const hostNames = station.hosts.map((h) => h.name);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link
        href="/"
        className="mb-6 inline-block text-sm text-zinc-500 hover:text-zinc-300"
      >
        &larr; All stations
      </Link>

      <div className="mb-6">
        <div className="mb-2 flex items-center gap-3">
          <h1 className="text-2xl font-bold">{station.name}</h1>
          {isLive && (
            <span className="flex items-center gap-1 rounded-full bg-red-500/20 px-2.5 py-0.5 text-xs font-medium text-red-400">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
              LIVE
            </span>
          )}
        </div>
        {station.description && (
          <p className="mb-2 text-zinc-400">{station.description}</p>
        )}
        <div className="flex items-center gap-4 text-sm text-zinc-500">
          <span>Hosts: {hostNames.join(", ")}</span>
          <span>
            {station.state?.listenerCount ?? station.listenerCount} listener
            {(station.state?.listenerCount ?? station.listenerCount) !== 1
              ? "s"
              : ""}
          </span>
        </div>
      </div>

      {streamUrl && (
        <div className="mb-6">
          <Player
            streamUrl={streamUrl}
            stationName={station.name}
            isLive={isLive}
          />
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-3">
        {isLive ? (
          <button
            onClick={handleStop}
            className="rounded-lg border border-red-800 bg-red-900/30 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/50"
          >
            Stop Broadcasting
          </button>
        ) : (
          <button
            onClick={handleStart}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500"
          >
            Start Broadcasting
          </button>
        )}
        <CallInButton slug={slug} />
        <button
          onClick={() => setTipOpen(!tipOpen)}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-500"
        >
          Submit Tip
        </button>
      </div>

      {tipOpen && (
        <div className="mb-6 rounded-xl border border-zinc-700 bg-zinc-800/80 p-4">
          <h3 className="mb-3 text-sm font-semibold">Suggest a Topic</h3>
          <input
            type="text"
            placeholder="Topic"
            value={tipTopic}
            onChange={(e) => setTipTopic(e.target.value)}
            className="mb-2 w-full rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-400 focus:outline-none"
          />
          <textarea
            placeholder="Additional context (optional)"
            value={tipContent}
            onChange={(e) => setTipContent(e.target.value)}
            rows={3}
            className="mb-3 w-full rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-400 focus:outline-none"
          />
          <button
            onClick={handleTip}
            disabled={!tipTopic.trim()}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-200 disabled:opacity-50"
          >
            Submit
          </button>
        </div>
      )}

      {station.state?.currentTopic && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
            Now discussing
          </div>
          <p className="text-sm text-zinc-200">{station.state.currentTopic}</p>
        </div>
      )}

      <div className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-zinc-400">
          Live Transcript
        </h2>
        <Transcript slug={slug} isLive={isLive} />
      </div>
    </main>
  );
}
