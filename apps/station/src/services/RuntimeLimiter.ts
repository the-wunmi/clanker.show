type Task<T> = () => Promise<T>;

class Semaphore {
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(task: Task<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.inFlight += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

const aiSemaphore = new Semaphore(
  Math.max(1, Number(process.env.AI_MAX_CONCURRENCY ?? "24")),
);
const ttsSemaphore = new Semaphore(
  Math.max(1, Number(process.env.TTS_MAX_CONCURRENCY ?? "16")),
);
const searchSemaphore = new Semaphore(
  Math.max(1, Number(process.env.SEARCH_MAX_CONCURRENCY ?? "8")),
);
const encodeSemaphore = new Semaphore(
  Math.max(1, Number(process.env.ENCODE_MAX_CONCURRENCY ?? "12")),
);

export function withAiLimit<T>(task: Task<T>): Promise<T> {
  return aiSemaphore.run(task);
}

export function withTtsLimit<T>(task: Task<T>): Promise<T> {
  return ttsSemaphore.run(task);
}

export function withSearchLimit<T>(task: Task<T>): Promise<T> {
  return searchSemaphore.run(task);
}

export function withEncodeLimit<T>(task: Task<T>): Promise<T> {
  return encodeSemaphore.run(task);
}
