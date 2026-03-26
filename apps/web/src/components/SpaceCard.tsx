"use client";

import Link from "next/link";
import type { Space } from "@/lib/api";

export function SpaceCard({ space }: { space: Space }) {
  const isLive = space.status === "live";
  const hostNames = space.hosts.map((h) => h.name).join(" & ");

  return (
    <Link href={`/space/${space.slug}`}>
      <div className="group relative rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 transition-all hover:border-zinc-600 hover:bg-zinc-900">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isLive && (
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
              </span>
            )}
            <span
              className={`text-xs font-medium uppercase tracking-wider ${
                isLive ? "text-red-400" : "text-zinc-500"
              }`}
            >
              {isLive ? "Live" : space.status}
            </span>
          </div>
          <span className="text-xs text-zinc-500">
            {space.listenerCount} listener
            {space.listenerCount !== 1 ? "s" : ""}
          </span>
        </div>

        <h3 className="mb-1 text-lg font-semibold text-zinc-100 group-hover:text-white">
          {space.name}
        </h3>
        {space.category && (
          <span className="mb-2 inline-block rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-400 capitalize">
            {space.category}
          </span>
        )}
        {space.description && (
          <p className="mb-3 line-clamp-2 text-sm text-zinc-400">
            {space.description}
          </p>
        )}

        <div className="flex items-center gap-2">
          <div className="flex -space-x-2">
            {space.hosts.map((host) => (
              <div
                key={host.name}
                className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-zinc-900 bg-zinc-700 text-xs font-medium text-zinc-300"
              >
                {host.name[0]}
              </div>
            ))}
          </div>
          <span className="text-xs text-zinc-500">{hostNames}</span>
        </div>
      </div>
    </Link>
  );
}
