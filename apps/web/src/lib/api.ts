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

export interface StationHost {
  name: string;
  personality: string;
  voiceId: string;
  style: number;
}

export interface StationSource {
  type: "firecrawl_search";
  query: string;
}

export interface Station {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  template: string | null;
  hosts: StationHost[];
  sources: StationSource[];
  status: "idle" | "live" | "paused";
  listenerCount: number;
  idleBehavior: string;
  createdAt: number;
}

export interface StationState {
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

export interface NewStationDraft {
  name: string;
  slug: string;
  description: string;
  hosts: StationHost[];
  sources: StationSource[];
}

export async function fetchVoices(): Promise<ElevenLabsVoice[]> {
  const res = await fetch(`${API_BASE}/api/voices`);
  await throwIfError(res, "Failed to fetch voices");
  return res.json();
}

export async function fetchStations(): Promise<Station[]> {
  const res = await fetch(`${API_BASE}/api/stations`);
  await throwIfError(res, "Failed to fetch stations");
  return res.json();
}

export async function fetchStation(slug: string): Promise<Station & { state: StationState | null }> {
  const res = await fetch(`${API_BASE}/api/stations/${slug}`);
  await throwIfError(res, "Failed to fetch station");
  return res.json();
}

export async function fetchStreamUrl(slug: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/stations/${slug}/stream-url`);
  await throwIfError(res, "Failed to fetch stream URL");
  const data = await res.json();
  return data.url;
}

export async function createStation(data: {
  name: string;
  slug: string;
  description?: string;
  hosts: StationHost[];
  sources: StationSource[];
}): Promise<{ id: string; slug: string }> {
  const res = await fetch(`${API_BASE}/api/stations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  await throwIfError(res, "Failed to create station");
  return res.json();
}

export async function generateStationDraft(): Promise<NewStationDraft> {
  const res = await fetch(`${API_BASE}/api/stations/new`);
  await throwIfError(res, "Failed to generate station draft");
  return res.json();
}

export async function startStation(slug: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/stations/${slug}/start`, {
    method: "POST",
  });
  await throwIfError(res, "Failed to start station");
}

export async function stopStation(slug: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/stations/${slug}/stop`, {
    method: "POST",
  });
  await throwIfError(res, "Failed to stop station");
}

export async function submitCallIn(
  slug: string,
  data: { name: string; topicHint?: string }
): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/api/stations/${slug}/call-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  await throwIfError(res, "Failed to submit call-in");
  return res.json();
}

export async function submitTip(
  slug: string,
  data: { name?: string; topic: string; content: string }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/stations/${slug}/tips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  await throwIfError(res, "Failed to submit tip");
}

export function subscribeToTranscript(
  slug: string,
  onLine: (line: TranscriptLine) => void
): () => void {
  const eventSource = new EventSource(
    `${API_BASE}/api/stations/${slug}/transcript`
  );

  eventSource.onmessage = (event) => {
    const line: TranscriptLine = JSON.parse(event.data);
    onLine(line);
  };

  return () => eventSource.close();
}
