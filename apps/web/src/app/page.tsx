"use client";

import Link from "next/link";
import { useStations } from "@/lib/hooks";
import { StationCard } from "@/components/StationCard";

export default function Home() {
  const { data: stations = [], isLoading } = useStations();

  return (
    <main className="mx-auto max-w-6xl px-4 py-12">
      <div className="mb-12 text-center">
        <h1 className="mb-2 text-4xl font-bold tracking-tight">
          clanker<span className="text-zinc-500">.show</span>
        </h1>
        <p className="mx-auto max-w-lg text-zinc-400">
          AI-powered live radio. Stations broadcast 24/7 discussions about
          current events, powered by AI hosts with distinct personalities.
        </p>
      </div>

      <div className="mb-8 flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Live Stations
          {stations.filter((s) => s.status === "live").length > 0 && (
            <span className="ml-2 text-sm text-zinc-500">
              {stations.filter((s) => s.status === "live").length} on air
            </span>
          )}
        </h2>
        <Link
          href="/create"
          className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200"
        >
          Create Station
        </Link>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/50"
            />
          ))}
        </div>
      ) : stations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center">
          <p className="mb-2 text-zinc-400">No stations yet.</p>
          <Link href="/create" className="text-sm text-white underline">
            Create the first one
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {stations.map((station) => (
            <StationCard key={station.id} station={station} />
          ))}
        </div>
      )}
    </main>
  );
}
