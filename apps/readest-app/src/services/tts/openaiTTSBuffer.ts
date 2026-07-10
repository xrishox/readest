export const OPENAI_TTS_BUFFER_TARGET_SECONDS = 120;
export const OPENAI_TTS_BUFFER_MAX_SENTENCES = 50;
export const OPENAI_TTS_BUFFER_MAX_BACKGROUND = 9;
export const OPENAI_TTS_REPLAY_SENTENCES = 10;

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export interface OpenAITTSBufferCandidate<T> {
  key: string;
  value: T;
  playbackSeconds: number;
}

interface ResilienceBufferOptions<T> {
  load: (item: OpenAITTSBufferCandidate<T>, signal: AbortSignal) => Promise<void>;
  evict: (item: OpenAITTSBufferCandidate<T>) => void;
  maxConcurrent?: number;
}

export const selectOpenAITTSBufferCandidates = <T>(
  candidates: readonly OpenAITTSBufferCandidate<T>[],
): OpenAITTSBufferCandidate<T>[] => {
  const selected: OpenAITTSBufferCandidate<T>[] = [];
  let seconds = 0;
  for (const candidate of candidates) {
    if (selected.length >= OPENAI_TTS_BUFFER_MAX_SENTENCES) break;
    selected.push(candidate);
    seconds += Math.max(0, candidate.playbackSeconds);
    if (seconds >= OPENAI_TTS_BUFFER_TARGET_SECONDS) break;
  }
  return selected;
};

// Owns only speculative subscriptions. The transport owns compressed bytes
// and shared HTTP requests, so cancelling stale lookahead never poisons a
// foreground consumer of the same sentence.
export class OpenAITTSResilienceBuffer<T> {
  readonly #load: ResilienceBufferOptions<T>['load'];
  readonly #evict: ResilienceBufferOptions<T>['evict'];
  readonly #maxConcurrent: number;
  #ordered: OpenAITTSBufferCandidate<T>[] = [];
  #known = new Map<string, OpenAITTSBufferCandidate<T>>();
  #needed = new Set<string>();
  #completed = new Set<string>();
  #pending = new Map<string, AbortController>();
  #retryAttempts = new Map<string, number>();
  #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #tail: string[] = [];

  constructor(options: ResilienceBufferOptions<T>) {
    this.#load = options.load;
    this.#evict = options.evict;
    this.#maxConcurrent = options.maxConcurrent ?? OPENAI_TTS_BUFFER_MAX_BACKGROUND;
    if (!Number.isInteger(this.#maxConcurrent) || this.#maxConcurrent <= 0) {
      throw new Error('OpenAI TTS background concurrency must be positive.');
    }
  }

  get replayTail(): readonly string[] {
    return [...this.#tail];
  }

  reconcile(candidates: readonly OpenAITTSBufferCandidate<T>[]): void {
    const selected = selectOpenAITTSBufferCandidates(candidates);
    const unique: OpenAITTSBufferCandidate<T>[] = [];
    const nextKeys = new Set<string>();
    for (const item of selected) {
      if (nextKeys.has(item.key)) continue;
      nextKeys.add(item.key);
      unique.push(item);
    }

    for (const [key, controller] of this.#pending) {
      if (!nextKeys.has(key))
        controller.abort(new DOMException('Stale TTS buffer item', 'AbortError'));
    }
    for (const [key, timer] of this.#retryTimers) {
      if (nextKeys.has(key)) continue;
      clearTimeout(timer);
      this.#retryTimers.delete(key);
      this.#retryAttempts.delete(key);
    }
    for (const key of this.#completed) {
      if (nextKeys.has(key) || this.#tail.includes(key)) continue;
      const old = this.#known.get(key);
      if (old) this.#evict(old);
      this.#completed.delete(key);
    }

    const tailItems = new Map<string, OpenAITTSBufferCandidate<T>>();
    for (const key of this.#tail) {
      const item = this.#known.get(key);
      if (item) tailItems.set(key, item);
    }
    this.#known = tailItems;
    for (const item of unique) this.#known.set(item.key, item);
    this.#ordered = unique;
    this.#needed = nextKeys;
    this.#pump();
  }

  consume(key: string): void {
    const item = this.#known.get(key);
    if (!item) return;
    this.#needed.delete(key);
    this.#ordered = this.#ordered.filter((candidate) => candidate.key !== key);
    this.#pending
      .get(key)
      ?.abort(new DOMException('TTS buffer item reached playback', 'AbortError'));
    const retryTimer = this.#retryTimers.get(key);
    if (retryTimer) clearTimeout(retryTimer);
    this.#retryTimers.delete(key);
    this.#retryAttempts.delete(key);
    this.#tail = this.#tail.filter((tailKey) => tailKey !== key);
    this.#tail.push(key);

    while (this.#tail.length > OPENAI_TTS_REPLAY_SENTENCES) {
      const evictedKey = this.#tail.shift()!;
      if (this.#needed.has(evictedKey)) continue;
      const evicted = this.#known.get(evictedKey);
      if (evicted) this.#evict(evicted);
      this.#completed.delete(evictedKey);
      this.#known.delete(evictedKey);
    }
    this.#pump();
  }

  stop(): void {
    for (const controller of this.#pending.values()) {
      controller.abort(new DOMException('TTS buffer stopped', 'AbortError'));
    }
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#pending.clear();
    this.#retryTimers.clear();
    this.#retryAttempts.clear();
    this.#ordered = [];
    this.#needed.clear();
  }

  shutdown(): void {
    this.stop();
    for (const item of this.#known.values()) this.#evict(item);
    this.#known.clear();
    this.#completed.clear();
    this.#tail = [];
  }

  #pump(): void {
    for (const item of this.#ordered) {
      if (this.#pending.size >= this.#maxConcurrent) return;
      if (
        !this.#needed.has(item.key) ||
        this.#completed.has(item.key) ||
        this.#pending.has(item.key) ||
        this.#retryTimers.has(item.key)
      ) {
        continue;
      }
      this.#start(item);
    }
  }

  #start(item: OpenAITTSBufferCandidate<T>): void {
    const controller = new AbortController();
    this.#pending.set(item.key, controller);
    void this.#load(item, controller.signal)
      .then(() => {
        if (this.#needed.has(item.key) && !controller.signal.aborted) {
          this.#completed.add(item.key);
          this.#retryAttempts.delete(item.key);
        }
      })
      .catch(() => {
        if (!this.#needed.has(item.key) || controller.signal.aborted) return;
        const attempt = this.#retryAttempts.get(item.key) ?? 0;
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
        this.#retryAttempts.set(item.key, attempt + 1);
        const timer = setTimeout(() => {
          this.#retryTimers.delete(item.key);
          this.#pump();
        }, delay);
        this.#retryTimers.set(item.key, timer);
      })
      .finally(() => {
        if (this.#pending.get(item.key) === controller) this.#pending.delete(item.key);
        this.#pump();
      });
  }
}
