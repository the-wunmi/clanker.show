"use client";

import { useEffect, useRef, useState } from "react";
import {
  subscribeToTranscript,
  fetchRecentTranscript,
  type TranscriptLine,
} from "@/lib/api";

interface TranscriptProps {
  slug: string;
  isLive: boolean;
  pollEnabled?: boolean;
}

const emotionColors: Record<string, string> = {
  neutral: "text-zinc-300",
  excited: "text-amber-300",
  skeptical: "text-blue-300",
  amused: "text-green-300",
  serious: "text-rose-300",
};

export function Transcript({ slug, isLive, pollEnabled = false }: TranscriptProps) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const mergeLines = (incoming: TranscriptLine[]) => {
    setLines((prev) => {
      const combined = [...prev, ...incoming];
      const seen = new Set<string>();
      const deduped: TranscriptLine[] = [];
      for (const line of combined) {
        const key = `${line.host}|${line.text}|${line.timestamp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(line);
      }
      return deduped.slice(-150);
    });
  };

  useEffect(() => {
    let stopped = false;

    void fetchRecentTranscript(slug).then((recent) => {
      if (stopped) return;
      if (recent.length > 0) mergeLines(recent);
    }).catch(() => {
      // ignore initial load errors
    });

    const unsubscribe = subscribeToTranscript(slug, (line) => {
      mergeLines([line]);
    });

    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [slug]);

  useEffect(() => {
    if (!pollEnabled) return;

    const fetchIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      void fetchRecentTranscript(slug)
        .then((recent) => {
          if (recent.length > 0) mergeLines(recent);
        })
        .catch(() => {
          // ignore polling errors
        });
    };

    const timer = setInterval(fetchIfVisible, 3000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchIfVisible();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [slug, pollEnabled]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="h-96 space-y-3 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
    >
      {lines.length === 0 ? (
        <div className="flex h-full items-center justify-center text-zinc-500">
          {isLive
            ? "Waiting for transcript..."
            : "No transcript yet. It will appear here once available."}
        </div>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="animate-in fade-in slide-in-from-bottom-2">
            <div className="mb-0.5 flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-400">
                {line.host}
              </span>
              <span
                className={`text-[10px] uppercase tracking-wider ${
                  emotionColors[line.emotion] || "text-zinc-500"
                }`}
              >
                {line.emotion !== "neutral" ? line.emotion : ""}
              </span>
            </div>
            <p className="text-sm leading-relaxed text-zinc-200">{line.text}</p>
          </div>
        ))
      )}
    </div>
  );
}
