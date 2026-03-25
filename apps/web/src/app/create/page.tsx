"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCreateStation, useGenerateStationDraft, useVoices } from "@/lib/hooks";

interface HostForm {
  name: string;
  personality: string;
  voiceId: string;
  style: number;
}

interface SourceForm {
  query: string;
}

export default function CreateStationPage() {
  const router = useRouter();
  const createStation = useCreateStation();
  const generateDraft = useGenerateStationDraft();
  const { data: voices, isLoading: voicesLoading } = useVoices();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [hosts, setHosts] = useState<HostForm[]>([
    {
      name: "Tobe",
      personality: "Energetic and curious. Loves breaking news and hot takes.",
      voiceId: "",
      style: 0.5,
    },
    {
      name: "Sam",
      personality: "Thoughtful and analytical. Plays devil's advocate.",
      voiceId: "",
      style: 0.5,
    },
  ]);
  const [sources, setSources] = useState<SourceForm[]>([
    { query: "latest technology news" },
  ]);

  const autoSlug = (value: string) => {
    setName(value);
    if (!slug || slug === slugify(name)) {
      setSlug(slugify(value));
    }
  };

  const slugify = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  const updateHost = (
    index: number,
    field: keyof HostForm,
    value: string | number
  ) => {
    setHosts((prev) =>
      prev.map((h, i) => (i === index ? { ...h, [field]: value } : h))
    );
  };

  const addHost = () => {
    if (hosts.length >= 4) return;
    setHosts([
      ...hosts,
      { name: "", personality: "", voiceId: "", style: 0.5 },
    ]);
  };

  const removeHost = (index: number) => {
    if (hosts.length <= 1) return;
    setHosts(hosts.filter((_, i) => i !== index));
  };

  const updateSource = (index: number, query: string) => {
    setSources((prev) =>
      prev.map((s, i) => (i === index ? { ...s, query } : s))
    );
  };

  const addSource = () => {
    setSources([...sources, { query: "" }]);
  };

  const removeSource = (index: number) => {
    if (sources.length <= 1) return;
    setSources(sources.filter((_, i) => i !== index));
  };

  const handleSubmit = () => {
    if (
      !name.trim() ||
      !slug.trim() ||
      hosts.some((h) => !h.name.trim() || !h.voiceId.trim())
    ) {
      return;
    }

    createStation.mutate(
      {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || undefined,
        hosts: hosts.map((h) => ({
          name: h.name,
          personality: h.personality,
          voiceId: h.voiceId,
          style: h.style,
        })),
        sources: sources
          .filter((s) => s.query.trim())
          .map((s) => ({
            type: "firecrawl_search" as const,
            query: s.query,
          })),
      },
      {
        onSuccess: (result) => router.push(`/station/${result.slug}`),
      }
    );
  };

  const handleGenerateWithAI = () => {
    generateDraft.mutate(undefined, {
      onSuccess: (draft) => {
        setName(draft.name);
        setSlug(slugify(draft.slug || draft.name));
        setDescription(draft.description || "");
        const voiceCount = voices?.length ?? 0;

        const nextHosts = draft.hosts.slice(0, 4).map((host, index) => ({
          name: host.name,
          personality: host.personality,
          voiceId:
            host.voiceId ||
            (voiceCount > 0 ? voices?.[index % voiceCount]?.voice_id : "") ||
            "",
          style:
            typeof host.style === "number"
              ? Math.max(0, Math.min(1, host.style))
              : 0.5,
        }));

        if (nextHosts.length > 0) {
          setHosts(nextHosts);
        }

        const nextSources = draft.sources
          .map((source) => ({ query: source.query }))
          .filter((source) => source.query.trim().length > 0);
        if (nextSources.length > 0) {
          setSources(nextSources);
        }
      },
    });
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="mb-8 text-2xl font-bold">Create a Station</h1>

      {createStation.error && (
        <div className="mb-6 rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-300">
          {createStation.error.message || "Failed to create station. Please try again."}
        </div>
      )}
      {generateDraft.error && (
        <div className="mb-6 rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-300">
          Failed to pregenerate a station. Please try again.
        </div>
      )}

      <section className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Basic Info
          </h2>
          <button
            type="button"
            onClick={handleGenerateWithAI}
            disabled={generateDraft.isPending || voicesLoading}
            title="Auto-fill all fields with AI"
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-zinc-200 transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-50"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
            >
              <path d="M10 2.5l1.7 3.7 3.8 1.2-3.8 1.2L10 12.3 8.3 8.6 4.5 7.4l3.8-1.2L10 2.5z" />
              <path d="M15.6 12.8l.9 2 2 .7-2 .6-.9 2-.9-2-2-.6 2-.7.9-2z" />
            </svg>
            <span>{generateDraft.isPending ? "Generating..." : "Auto-fill with AI"}</span>
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-zinc-400">
              Station Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => autoSlug(e.target.value)}
              placeholder="The AI Daily"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-zinc-400">
              URL Slug
            </label>
            <div className="flex items-center gap-1 text-sm text-zinc-500">
              <span>clanker.show/station/</span>
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(slugify(e.target.value))}
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 focus:border-zinc-400 focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm text-zinc-400">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this station about?"
              rows={2}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-400 focus:outline-none"
            />
          </div>
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Hosts ({hosts.length})
          </h2>
          <button
            onClick={addHost}
            disabled={hosts.length >= 4}
            className="text-sm text-zinc-400 hover:text-white disabled:opacity-30"
          >
            + Add Host
          </button>
        </div>
        <div className="space-y-4">
          {hosts.map((host, i) => (
            <div
              key={i}
              className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs text-zinc-500">Host {i + 1}</span>
                {hosts.length > 1 && (
                  <button
                    onClick={() => removeHost(i)}
                    className="text-xs text-zinc-500 hover:text-red-400"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  type="text"
                  placeholder="Name"
                  value={host.name}
                  onChange={(e) => updateHost(i, "name", e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-400 focus:outline-none"
                />
                <select
                  value={host.voiceId}
                  onChange={(e) => updateHost(i, "voiceId", e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-400 focus:outline-none"
                >
                  <option value="">
                    {voicesLoading ? "Loading voices..." : "Select a voice"}
                  </option>
                  {voices?.map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.name}{v.description ? ` -- ${v.description}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                placeholder="Personality (e.g., 'Energetic and curious. Loves breaking news.')"
                value={host.personality}
                onChange={(e) => updateHost(i, "personality", e.target.value)}
                rows={2}
                className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-400 focus:outline-none"
              />
            </div>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Content Sources
          </h2>
          <button
            onClick={addSource}
            className="text-sm text-zinc-400 hover:text-white"
          >
            + Add Source
          </button>
        </div>
        <div className="space-y-3">
          {sources.map((source, i) => (
            <div key={i} className="flex items-center gap-3">
              <input
                type="text"
                placeholder="Search query (e.g., 'latest AI news')"
                value={source.query}
                onChange={(e) => updateSource(i, e.target.value)}
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-400 focus:outline-none"
              />
              {sources.length > 1 && (
                <button
                  onClick={() => removeSource(i)}
                  className="text-zinc-500 hover:text-red-400"
                >
                  &times;
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <button
        onClick={handleSubmit}
        disabled={createStation.isPending}
        className="w-full rounded-lg bg-white py-3 text-sm font-semibold text-zinc-900 transition-colors hover:bg-zinc-200 disabled:opacity-50"
      >
        {createStation.isPending ? "Creating..." : "Create Station"}
      </button>
    </main>
  );
}
