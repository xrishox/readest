export const OPENAI_TTS_MAX_FETCHES = 10;

export type OpenAITTSFetchPriority = 'playback' | 'preload';

const abortError = (signal?: AbortSignal): Error => {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('Aborted', 'AbortError');
};

// A client-wide priority limiter keeps current playback plus all speculative
// preloads at ten active jobs. The audible paragraph uses playback priority;
// the rolling resilience buffer can only fill capacity left over.
export class OpenAITTSTaskPool {
  readonly #limit: number;
  readonly #playbackQueue: Array<() => void> = [];
  readonly #preloadQueue: Array<() => void> = [];
  #active = 0;

  constructor(limit = OPENAI_TTS_MAX_FETCHES) {
    if (!Number.isInteger(limit) || limit <= 0)
      throw new Error('Task pool limit must be positive.');
    this.#limit = limit;
  }

  get activeCount(): number {
    return this.#active;
  }

  run<T>(
    task: () => Promise<T>,
    signal: AbortSignal,
    priority: OpenAITTSFetchPriority,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise<T>((resolve, reject) => {
      let started = false;
      let settled = false;
      const onAbort = () => {
        if (started || settled) return;
        settled = true;
        reject(abortError(signal));
      };
      const start = () => {
        if (settled || signal.aborted) {
          if (!settled) {
            settled = true;
            reject(abortError(signal));
          }
          signal.removeEventListener('abort', onAbort);
          return;
        }
        started = true;
        signal.removeEventListener('abort', onAbort);
        this.#active++;
        Promise.resolve()
          .then(task)
          .then(
            (value) => {
              if (!settled) {
                settled = true;
                resolve(value);
              }
            },
            (error) => {
              if (!settled) {
                settled = true;
                reject(error);
              }
            },
          )
          .finally(() => {
            this.#active--;
            this.#drain();
          });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      (priority === 'playback' ? this.#playbackQueue : this.#preloadQueue).push(start);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#limit) {
      const start = this.#playbackQueue.shift() ?? this.#preloadQueue.shift();
      if (!start) return;
      start();
    }
  }
}

type WindowResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

// Starts at most `maxAhead` loaders, retains their results by source index,
// and exposes them strictly in order. Calling next() consumes one slot and
// immediately admits one more speculative fetch, maintaining current + nine.
export class OpenAITTSOrderedWindow<TInput, TOutput> {
  readonly #items: readonly TInput[];
  readonly #load: (item: TInput, index: number) => Promise<TOutput>;
  readonly #maxAhead: number;
  readonly #signal: AbortSignal;
  readonly #jobs = new Map<number, Promise<WindowResult<TOutput>>>();
  #nextStart = 0;
  #nextConsume = 0;

  constructor(options: {
    items: readonly TInput[];
    load: (item: TInput, index: number) => Promise<TOutput>;
    signal: AbortSignal;
    maxAhead?: number;
  }) {
    this.#items = options.items;
    this.#load = options.load;
    this.#signal = options.signal;
    this.#maxAhead = options.maxAhead ?? OPENAI_TTS_MAX_FETCHES;
    if (!Number.isInteger(this.#maxAhead) || this.#maxAhead <= 0) {
      throw new Error('Ordered window size must be positive.');
    }
    this.#fill();
  }

  get outstandingCount(): number {
    return this.#jobs.size;
  }

  async next(): Promise<{ index: number; item: TInput; value: TOutput } | null> {
    if (this.#nextConsume >= this.#items.length) return null;
    const index = this.#nextConsume;
    const job = this.#jobs.get(index);
    if (!job) throw abortError(this.#signal);
    const result = await job;
    this.#jobs.delete(index);
    this.#nextConsume++;
    this.#fill();
    if (!result.ok) throw result.error;
    return { index, item: this.#items[index]!, value: result.value };
  }

  #fill(): void {
    while (
      !this.#signal.aborted &&
      this.#nextStart < this.#items.length &&
      this.#jobs.size < this.#maxAhead
    ) {
      const index = this.#nextStart++;
      const item = this.#items[index]!;
      const job: Promise<WindowResult<TOutput>> = Promise.resolve()
        .then(() => this.#load(item, index))
        .then(
          (value): WindowResult<TOutput> => ({ ok: true, value }),
          (error): WindowResult<TOutput> => ({ ok: false, error }),
        );
      this.#jobs.set(index, job);
    }
  }
}
