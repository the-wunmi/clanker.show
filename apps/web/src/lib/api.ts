const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

export class ApiError extends Error {
  status: number;
  issues: Array<{ message: string; path: (string | number)[] }>;

  constructor(
    message: string,
    status: number,
    issues: Array<{ message: string; path: (string | number)[] }> = [],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
  }
}

async function throwIfError(res: Response, fallbackMessage: string): Promise<void> {
  if (res.ok) return;

  let message = fallbackMessage;
  let issues: Array<{ message: string; path: (string | number)[] }> = [];

  try {
    const body = await res.json();
    if (body.issues?.length) {
      issues = body.issues;
      message = issues.map((i) => i.message).join(". ");
    } else if (body.error) {
      message = body.error;
    }
  } catch {
    // response wasn't JSON, use fallback
  }

  throw new ApiError(message, res.status, issues);
}

export interface SpaceHost {
  name: string;
  personality: string;
  voiceId: string;
  style: number;
}

export interface SpaceSource {
  type: "firecrawl_search";
  query: string;
}

export interface Space {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  template: string | null;
  hosts: SpaceHost[];
  sources: SpaceSource[];
  status: "idle" | "live" | "paused";
  listenerCount: number;
  idleBehavior: string;
  category: string | null;
  maxSpeakers: number | null;
  durationMin: number | null;
  visibility: string | null;
  createdAt: number;
}

export interface SpaceState {
  status: "idle" | "live" | "paused";
  currentTopic: string | null;
  currentHost: string | null;
  listenerCount: number;
  uptime: number;
}

export interface TranscriptLine {
  host: string;
  text: string;
  emotion: string;
  timestamp: number;
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  description: string;
}

export interface NewSpaceDraft {
  name: string;
  slug: string;
  description: string;
  hosts: SpaceHost[];
  sources: SpaceSource[];
  category?: string;
  maxSpeakers?: number;
  durationMin?: number;
  visibility?: string;
}

export async function fetchVoices(): Promise<ElevenLabsVoice[]> {
  const res = await fetch(`${API_BASE}/api/voices`);
  await throwIfError(res, "Failed to fetch voices");
  return res.json();
}

export async function fetchSpaces(): Promise<Space[]> {
  const res = await fetch(`${API_BASE}/api/spaces`);
  await throwIfError(res, "Failed to fetch spaces");
  return res.json();
}

export async function fetchSpace(slug: string): Promise<Space & { state: SpaceState | null }> {
  const res = await fetch(`${API_BASE}/api/spaces/${slug}`);
  await throwIfError(res, "Failed to fetch space");
  return res.json();
}

export async function fetchStreamUrl(slug: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/spaces/${slug}/stream-url`);
  await throwIfError(res, "Failed to fetch stream URL");
  const data = await res.json();
  return data.url;
}

export async function createSpace(data: {
  name: string;
  slug: string;
  description?: string;
  hosts: SpaceHost[];
  sources: SpaceSource[];
  category?: string;
  maxSpeakers?: number;
  durationMin?: number;
  visibility?: string;
}): Promise<{ id: string; slug: string }> {
  const res = await fetch(`${API_BASE}/api/spaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  await throwIfError(res, "Failed to create space");
  return res.json();
}

export async function generateSpaceDraft(): Promise<NewSpaceDraft> {
  const res = await fetch(`${API_BASE}/api/spaces/new`);
  await throwIfError(res, "Failed to generate space draft");
  return res.json();
}

export async function startSpace(slug: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/spaces/${slug}/start`, {
    method: "POST",
  });
  await throwIfError(res, "Failed to start space");
}

export async function stopSpace(slug: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/spaces/${slug}/stop`, {
    method: "POST",
  });
  await throwIfError(res, "Failed to stop space");
}

export async function submitCallIn(
  slug: string,
  data: { name: string; topicHint?: string }
): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/api/spaces/${slug}/call-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  await throwIfError(res, "Failed to submit call-in");
  return res.json();
}

export async function submitComment(
  slug: string,
  data: { name?: string; topic: string; content: string }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/spaces/${slug}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  await throwIfError(res, "Failed to submit comment");
}

export async function fetchCallerStatus(
  slug: string,
  callerId: string,
): Promise<{ id: string; status: string }> {
  const res = await fetch(
    `${API_BASE}/api/spaces/${slug}/call-in/${callerId}/status`,
  );
  await throwIfError(res, "Failed to fetch caller status");
  return res.json();
}

export async function leaveCallQueue(
  slug: string,
  callerId: string,
): Promise<void> {
  await fetch(
    `${API_BASE}/api/spaces/${slug}/call-in/${callerId}`,
    { method: "DELETE" },
  ).catch(() => {});
}

export async function acceptCaller(
  slug: string,
  callerId: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/spaces/${slug}/call-in/${callerId}/accept`,
    { method: "POST" },
  );
  await throwIfError(res, "Failed to accept caller");
}

export function subscribeToTranscript(
  slug: string,
  onLine: (line: TranscriptLine) => void
): () => void {
  const eventSource = new EventSource(
    `${API_BASE}/api/spaces/${slug}/transcript`
  );

  eventSource.onmessage = (event) => {
    const line: TranscriptLine = JSON.parse(event.data);
    onLine(line);
  };

  eventSource.onerror = () => {
    // Let native EventSource retry automatically.
  };

  return () => eventSource.close();
}

export async function fetchRecentTranscript(
  slug: string,
): Promise<TranscriptLine[]> {
  const res = await fetch(`${API_BASE}/api/spaces/${slug}/transcript/recent`);
  await throwIfError(res, "Failed to fetch recent transcript");
  const data = await res.json() as { lines?: TranscriptLine[] };
  return data.lines ?? [];
}
