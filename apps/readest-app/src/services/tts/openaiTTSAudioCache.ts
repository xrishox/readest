export const OPENAI_TTS_AUDIO_CACHE_MAX_ENTRIES = 64;
export const OPENAI_TTS_AUDIO_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const OPENAI_TTS_AUDIO_CACHE_TTL_MS = 10 * 60 * 1000;

export interface OpenAITTSCachedAudio {
  bytes: Uint8Array;
  contentType: string;
}

interface CacheEntry extends OpenAITTSCachedAudio {
  lastAccess: number;
}

interface AudioCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

// Volatile compressed-audio storage. This deliberately has no persistence
// adapter: entries live only in the Readest process and disappear on restart.
export class OpenAITTSAudioMemoryCache {
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();
  #byteSize = 0;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: AudioCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? OPENAI_TTS_AUDIO_CACHE_MAX_ENTRIES;
    this.#maxBytes = options.maxBytes ?? OPENAI_TTS_AUDIO_CACHE_MAX_BYTES;
    this.#ttlMs = options.ttlMs ?? OPENAI_TTS_AUDIO_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
    if (this.#maxEntries <= 0 || this.#maxBytes <= 0 || this.#ttlMs <= 0) {
      throw new Error('OpenAI TTS audio cache limits must be positive.');
    }
  }

  get byteSize(): number {
    return this.#byteSize;
  }

  get size(): number {
    this.pruneExpired();
    return this.#entries.size;
  }

  get(key: string): OpenAITTSCachedAudio | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    const now = this.#now();
    if (now - entry.lastAccess >= this.#ttlMs) {
      this.delete(key);
      return undefined;
    }
    entry.lastAccess = now;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#scheduleExpiry();
    return entry;
  }

  set(key: string, audio: OpenAITTSCachedAudio): void {
    this.delete(key);
    this.pruneExpired();
    if (audio.bytes.byteLength > this.#maxBytes) return;
    const entry: CacheEntry = { ...audio, lastAccess: this.#now() };
    this.#entries.set(key, entry);
    this.#byteSize += entry.bytes.byteLength;
    this.#enforceLimits();
    this.#scheduleExpiry();
  }

  delete(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#byteSize -= entry.bytes.byteLength;
    this.#scheduleExpiry();
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#byteSize = 0;
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }

  pruneExpired(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [key, entry] of this.#entries) {
      if (entry.lastAccess > cutoff) continue;
      this.#entries.delete(key);
      this.#byteSize -= entry.bytes.byteLength;
    }
    this.#scheduleExpiry();
  }

  #enforceLimits(): void {
    while (this.#entries.size > this.#maxEntries || this.#byteSize > this.#maxBytes) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.delete(oldestKey);
    }
  }

  #scheduleExpiry(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    const oldest = this.#entries.values().next().value as CacheEntry | undefined;
    if (!oldest) return;
    const delay = Math.max(0, oldest.lastAccess + this.#ttlMs - this.#now());
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = undefined;
      this.pruneExpired();
    }, delay);
  }
}
