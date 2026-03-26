"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import {
  useSpace,
  useStreamUrl,
  useStartSpace,
  useStopSpace,
  useSubmitComment,
} from "@/lib/hooks";
import { Player } from "@/components/Player";
import { Transcript } from "@/components/Transcript";
import { CallInButton } from "@/components/CallInButton";
import Link from "next/link";

export default function SpacePage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const { data: space, isLoading } = useSpace(slug);
  const { data: streamUrl } = useStreamUrl(slug);
  const startSpace = useStartSpace();
  const stopSpace = useStopSpace();
  const submitComment = useSubmitComment(slug);

  const [commentOpen, setCommentOpen] = useState(false);
  const [commentTopic, setCommentTopic] = useState("");
  const [commentContent, setCommentContent] = useState("");
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [streamMuted, setStreamMuted] = useState(false);

  const handleStart = () => startSpace.mutate(slug);
  const handleStop = () => stopSpace.mutate(slug);

  const handleComment = () => {
    if (!commentTopic.trim()) return;
    submitComment.mutate(
      { topic: commentTopic, content: commentContent },
      {
        onSuccess: () => {
          setCommentOpen(false);
          setCommentTopic("");
          setCommentContent("");
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

  if (!space) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="mb-2 text-xl font-semibold">Space not found</h1>
          <Link href="/" className="text-sm text-zinc-400 underline">
            Back to directory
          </Link>
        </div>
      </div>
    );
  }

  const runtimeStatus = space.state?.status ?? space.status;
  const isLive = runtimeStatus === "live" || runtimeStatus === "paused";
  const hostNames = space.hosts.map((h) => h.name);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link
        href="/"
        className="mb-6 inline-block text-sm text-zinc-500 hover:text-zinc-300"
      >
        &larr; All spaces
      </Link>

      <div className="mb-6">
        <div className="mb-2 flex items-center gap-3">
          <h1 className="text-2xl font-bold">{space.name}</h1>
          {isLive && (
            <span className="flex items-center gap-1 rounded-full bg-red-500/20 px-2.5 py-0.5 text-xs font-medium text-red-400">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
              LIVE
            </span>
          )}
        </div>
        {space.description && (
          <p className="mb-2 text-zinc-400">{space.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-500">
          {space.category && (
            <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-300 capitalize">
              {space.category}
            </span>
          )}
          <span>Hosts: {hostNames.join(", ")}</span>
          {space.maxSpeakers != null && (
            <span>Max speakers: {space.maxSpeakers}</span>
          )}
          {space.durationMin != null && (
            <span>{space.durationMin} min</span>
          )}
          <span>
            {space.state?.listenerCount ?? space.listenerCount} listener
            {(space.state?.listenerCount ?? space.listenerCount) !== 1
              ? "s"
              : ""}
          </span>
        </div>
      </div>

      {streamUrl && (
        <div className="mb-6">
          <Player
            streamUrl={streamUrl}
            spaceName={space.name}
            isLive={isLive}
            onPlaybackStateChange={setIsAudioPlaying}
            muted={streamMuted}
          />
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-3">
        {isLive ? (
          <button
            onClick={handleStop}
            className="rounded-lg border border-red-800 bg-red-900/30 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/50"
          >
            End Session
          </button>
        ) : (
          <button
            onClick={handleStart}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500"
          >
            Go Live
          </button>
        )}
        <CallInButton slug={slug} onMuteStream={setStreamMuted} />
        <button
          onClick={() => setCommentOpen(!commentOpen)}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-500"
        >
          Comment
        </button>
      </div>

      {commentOpen && (
        <div className="mb-6 rounded-xl border border-zinc-700 bg-zinc-800/80 p-4">
          <h3 className="mb-3 text-sm font-semibold">Suggest a Topic</h3>
          <input
            type="text"
            placeholder="Topic"
            value={commentTopic}
            onChange={(e) => setCommentTopic(e.target.value)}
            className="mb-2 w-full rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-400 focus:outline-none"
          />
          <textarea
            placeholder="Additional context"
            value={commentContent}
            onChange={(e) => setCommentContent(e.target.value)}
            rows={3}
            className="mb-3 w-full rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-400 focus:outline-none"
          />
          <button
            onClick={handleComment}
            disabled={!commentTopic.trim() || !commentContent.trim()}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-200 disabled:opacity-50"
          >
            Submit
          </button>
        </div>
      )}

      {space.state?.currentTopic && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
            Now discussing
          </div>
          <p className="text-sm text-zinc-200">{space.state.currentTopic}</p>
        </div>
      )}

      <div className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-zinc-400">
          Live Transcript
        </h2>
        <Transcript slug={slug} isLive={isLive} pollEnabled={isAudioPlaying} />
      </div>
    </main>
  );
}
