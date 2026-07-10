import { md5 } from 'js-md5';
import { isTauriAppPlatform } from '@/services/environment';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
  OpenAITTSAudioMemoryCache,
  type OpenAITTSCachedAudio,
} from '@/services/tts/openaiTTSAudioCache';

// Client for a self-hosted OpenAI-compatible TTS server (e.g. a patched
// macos-speech-server, openedai-speech, kokoro-fastapi). Wire contract:
//   GET  {base}/v1/models           -> OpenAI-style model list (health check)
//   GET  {base}/v1/audio/voices     -> { voices: ["<id>", ...] }
//   GET  {base}/v1/audio/voices/all -> { voices: [{ id, name, lang, quality }] }
//   POST {base}/v1/audio/speech     -> audio bytes (Opus/AAC requested)
// Synthesis is always requested at speed 1.0; the playback rate is applied
// client-side via WSOLA time-stretch (see OpenAITTSClient), which keeps the
// audio cache rate-independent.

const HEALTH_TIMEOUT_MS = 3000;
const VOICES_TIMEOUT_MS = 5000;
const SPEECH_TIMEOUT_MS = 30000;

export interface OpenAITTSPayload {
  model: string;
  text: string;
  voice: string;
  responseFormat: OpenAITTSResponseFormat;
  speed: number;
}

export const OPENAI_TTS_FORMAT_ORDER = ['opus', 'aac'] as const;
export type OpenAITTSResponseFormat = (typeof OPENAI_TTS_FORMAT_ORDER)[number];

export interface OpenAITTSAudioData {
  data: ArrayBuffer;
  contentType: string;
}

export interface OpenAITTSVoice {
  id: string;
  name: string;
  lang: string;
  quality?: string;
}

const FORMAT_ERROR_PATTERN =
  /(?:unsupported|invalid|unavailable|not (?:supported|available|implemented)).{0,80}(?:response[_ -]?format|audio format|codec|opus|aac|m4a)|(?:response[_ -]?format|audio format|codec|opus|aac|m4a).{0,80}(?:unsupported|invalid|unavailable|not (?:supported|available|implemented))/i;
const SENTENCE_ERROR_PATTERN = /\b(?:input|text|utterance|sentence|voice|language|character)\b/i;

// Structured HTTP failure from /v1/audio/speech. Callers use the status and
// server body to distinguish an explicitly unsupported codec from auth,
// throttling, invalid input, and transient server errors. Only the first case
// is allowed to advance the codec ladder.
export class OpenAITTSRequestError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  readonly responseFormat: OpenAITTSResponseFormat;

  constructor(options: {
    status: number;
    statusText: string;
    body: string;
    responseFormat: OpenAITTSResponseFormat;
  }) {
    const { status, statusText, body, responseFormat } = options;
    const message = `OpenAI TTS error: ${status} ${statusText} ${body}`.trim();
    super(message);
    this.name = 'OpenAITTSRequestError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.responseFormat = responseFormat;
  }

  get isUnsupportedFormat(): boolean {
    if (this.status === 406 || this.status === 415) return true;
    return (
      (this.status === 400 || this.status === 422 || this.status === 501) &&
      FORMAT_ERROR_PATTERN.test(this.body)
    );
  }

  get isRetryable(): boolean {
    return this.status === 408 || this.status === 425 || this.status === 429 || this.status >= 500;
  }

  get isSkippableInput(): boolean {
    return (
      (this.status === 400 || this.status === 422) &&
      !this.isUnsupportedFormat &&
      SENTENCE_ERROR_PATTERN.test(this.body)
    );
  }
}

// Kokoro-style voice ids ('af_heart') encode the language in the first letter.
const KOKORO_LANG_MAP: Record<string, string> = {
  a: 'en-US',
  b: 'en-GB',
  e: 'es-ES',
  f: 'fr-FR',
  h: 'hi-IN',
  i: 'it-IT',
  j: 'ja-JP',
  p: 'pt-BR',
  z: 'zh-CN',
};

// Infer name/lang/quality from a flat voice identifier when the server only
// exposes the plain /v1/audio/voices list.
export const inferVoiceFromId = (id: string): OpenAITTSVoice => {
  // Apple-style identifiers: com.apple.voice.<tier>.<lang>.<Name>
  const apple = id.match(/^com\.apple\.voice\.([\w-]+)\.([A-Za-z]{2,3}(?:-[\w]+)*)\.(\w+)$/);
  if (apple) {
    return { id, name: apple[3]!, lang: apple[2]!, quality: apple[1]! };
  }
  // Other Apple identifiers (eloquence, ttsbundle) carry an embedded locale.
  const appleLang = id.match(/^com\.apple\..*\.([a-z]{2,3}-[A-Za-z0-9]{2,4})\.(\w+)$/);
  if (appleLang) {
    return { id, name: appleLang[2]!, lang: appleLang[1]! };
  }
  // Kokoro-style ids: af_heart, bm_george, ...
  const kokoro = id.match(/^([a-z])[a-z]?_([a-z]+)$/i);
  if (kokoro) {
    const name = kokoro[2]!.charAt(0).toUpperCase() + kokoro[2]!.slice(1);
    return { id, name, lang: KOKORO_LANG_MAP[kokoro[1]!.toLowerCase()] || 'en-US' };
  }
  return { id, name: id, lang: 'en-US' };
};

// Accept endpoints with or without a trailing '/v1' (and trailing slashes):
// 'http://mac:8787', 'http://mac:8787/', 'http://mac:8787/v1/' all normalize
// to 'http://mac:8787'.
export const normalizeOpenAITTSEndpoint = (endpoint: string): string => {
  let base = endpoint.trim().replace(/\/+$/, '');
  if (base.toLowerCase().endsWith('/v1')) {
    base = base.slice(0, -3).replace(/\/+$/, '');
  }
  return base;
};

// Quality-tier ordering for voice lists: premium first, then enhanced, then
// everything else (default/compact/unknown share one tier so the comparator
// stays stable within it and secondary sorts apply).
const QUALITY_RANK: Record<string, number> = { premium: 0, enhanced: 1 };

export const compareVoiceQuality = (a: { quality?: string }, b: { quality?: string }): number =>
  (QUALITY_RANK[a.quality ?? ''] ?? 2) - (QUALITY_RANK[b.quality ?? ''] ?? 2);

// Parse a GET /v1/audio/voices/all response ({ voices: [{ id, name, lang,
// quality? }] }). Servers that wrap plain system voices (e.g. a macOS speech
// server) omit `quality` or send a blanket 'default' even though the tier is
// encoded in the Apple voice id — derive it there so the picker's badges and
// quality-first ordering work either way. Malformed entries are dropped; an
// empty result tells fetchVoices to fall back to the flat /v1/audio/voices
// list.
export const parseOpenAITTSVoicesAll = (data: unknown): OpenAITTSVoice[] => {
  const list = (data as { voices?: unknown } | null)?.voices;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (v): v is OpenAITTSVoice =>
        !!v &&
        typeof (v as OpenAITTSVoice).id === 'string' &&
        typeof (v as OpenAITTSVoice).name === 'string' &&
        typeof (v as OpenAITTSVoice).lang === 'string',
    )
    .map((v) => {
      if (v.quality && v.quality !== 'default') return v;
      const derived = inferVoiceFromId(v.id).quality;
      return derived ? { ...v, quality: derived } : v;
    });
};

// Extract model ids from an OpenAI-style GET /v1/models response
// ({ object: 'list', data: [{ id, ... }, ...] }).
export const parseOpenAITTSModelIds = (data: unknown): string[] => {
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) =>
      entry && typeof (entry as { id?: unknown }).id === 'string'
        ? (entry as { id: string }).id
        : null,
    )
    .filter((id): id is string => !!id);
};

// The static cache is shared by client instances, so the endpoint and auth
// identity are part of the key. Only a one-way fingerprint of the API key is
// included; neither the key nor the request text ever appears in cache keys.
export const getOpenAITTSCacheKey = (
  endpoint: string,
  apiKey: string,
  payload: OpenAITTSPayload,
): string =>
  md5(
    JSON.stringify({
      endpoint: normalizeOpenAITTSEndpoint(endpoint),
      auth: apiKey.trim() ? md5(apiKey.trim()) : 'anonymous',
      payload,
    }),
  );

interface InflightSpeechRequest {
  promise: Promise<OpenAITTSCachedAudio>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

const abortError = (signal?: AbortSignal): Error => {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('Aborted', 'AbortError');
};

export class OpenAISpeechTTS {
  // Bounded cache keyed by endpoint + auth fingerprint + the full payload
  // (including response_format), shared across instances like EdgeSpeechTTS.
  private static audioCache = new OpenAITTSAudioMemoryCache();
  // A caller owns one subscription, not the underlying shared fetch. Aborting
  // preload therefore cannot poison playback (or vice versa); the HTTP request
  // is aborted only after its final consumer leaves.
  private static inflight = new Map<string, InflightSpeechRequest>();

  #baseUrl: string;
  #apiKey: string;

  constructor(endpoint: string, apiKey = '') {
    this.#baseUrl = normalizeOpenAITTSEndpoint(endpoint);
    this.#apiKey = apiKey.trim();
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  getCacheKey(payload: OpenAITTSPayload): string {
    return getOpenAITTSCacheKey(this.#baseUrl, this.#apiKey, payload);
  }

  #headers(json = true): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers['Accept'] = 'application/json';
    if (this.#apiKey) headers['Authorization'] = `Bearer ${this.#apiKey}`;
    return headers;
  }

  // Tauri's plugin-http fetch bypasses webview CORS for the LAN endpoint;
  // the web build falls back to window.fetch (server must allow CORS there).
  #fetch(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl = isTauriAppPlatform() ? tauriFetch : window.fetch.bind(window);
    return fetchImpl(url, init);
  }

  // Timeout + caller-abort combined into one signal; the timer and listener
  // are cleaned up when the request settles.
  async #fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
      timeoutMs,
    );
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // Health check: the endpoint is considered available when /v1/models
  // answers OK within a short timeout.
  async checkAvailability(): Promise<boolean> {
    if (!this.#baseUrl) return false;
    try {
      const response = await this.#fetchWithTimeout(
        `${this.#baseUrl}/v1/models`,
        { method: 'GET', headers: this.#headers() },
        HEALTH_TIMEOUT_MS,
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  // Model ids from GET /v1/models; empty on any failure (callers fall back
  // to the standard OpenAI TTS model names).
  async fetchModels(): Promise<string[]> {
    try {
      const response = await this.#fetchWithTimeout(
        `${this.#baseUrl}/v1/models`,
        { method: 'GET', headers: this.#headers() },
        VOICES_TIMEOUT_MS,
      );
      if (!response.ok) return [];
      return parseOpenAITTSModelIds(await response.json());
    } catch (err) {
      console.warn('OpenAI TTS: failed to fetch models', err);
      return [];
    }
  }

  // Voice catalog: prefer /v1/audio/voices/all (rich entries with name, lang
  // and quality tier); fall back to the flat /v1/audio/voices identifier list.
  async fetchVoices(): Promise<OpenAITTSVoice[]> {
    try {
      const response = await this.#fetchWithTimeout(
        `${this.#baseUrl}/v1/audio/voices/all`,
        { method: 'GET', headers: this.#headers() },
        VOICES_TIMEOUT_MS,
      );
      if (response.ok) {
        const voices = parseOpenAITTSVoicesAll(await response.json());
        if (voices.length > 0) return voices;
      }
    } catch (err) {
      console.warn('OpenAI TTS: /v1/audio/voices/all failed, trying flat list', err);
    }
    try {
      const response = await this.#fetchWithTimeout(
        `${this.#baseUrl}/v1/audio/voices`,
        { method: 'GET', headers: this.#headers() },
        VOICES_TIMEOUT_MS,
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch voices: ${response.status} ${response.statusText}`);
      }
      const data = (await response.json()) as { voices?: unknown[] };
      return (data.voices ?? [])
        .filter((v): v is string => typeof v === 'string')
        .map(inferVoiceFromId);
    } catch (err) {
      console.warn('OpenAI TTS: failed to fetch voices', err);
      return [];
    }
  }

  async #fetchSpeech(
    payload: OpenAITTSPayload,
    signal?: AbortSignal,
  ): Promise<OpenAITTSCachedAudio> {
    const response = await this.#fetchWithTimeout(
      `${this.#baseUrl}/v1/audio/speech`,
      {
        method: 'POST',
        cache: 'no-store',
        headers: {
          ...this.#headers(false),
          'Content-Type': 'application/json',
          Accept: 'audio/*',
        },
        body: JSON.stringify({
          model: payload.model,
          input: payload.text,
          voice: payload.voice,
          response_format: payload.responseFormat,
          speed: payload.speed,
        }),
      },
      SPEECH_TIMEOUT_MS,
      signal,
    );
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new OpenAITTSRequestError({
        status: response.status,
        statusText: response.statusText,
        body: errorText,
        responseFormat: payload.responseFormat,
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Keep the server's actual media type. In particular, AAC-LC is carried
    // in M4A and should remain audio/mp4 rather than the fabricated audio/aac.
    const contentType = response.headers.get('content-type')?.trim() || 'application/octet-stream';
    return { bytes, contentType };
  }

  #newInflight(payload: OpenAITTSPayload, cacheKey: string): InflightSpeechRequest {
    const controller = new AbortController();
    const entry: InflightSpeechRequest = {
      promise: Promise.resolve({ bytes: new Uint8Array(), contentType: '' }),
      controller,
      consumers: 0,
      settled: false,
    };
    entry.promise = this.#fetchSpeech(payload, controller.signal)
      .then((audio) => {
        if (!controller.signal.aborted) OpenAISpeechTTS.audioCache.set(cacheKey, audio);
        return audio;
      })
      .finally(() => {
        entry.settled = true;
        if (OpenAISpeechTTS.inflight.get(cacheKey) === entry) {
          OpenAISpeechTTS.inflight.delete(cacheKey);
        }
      });
    // The shared promise can outlive an aborted final subscriber briefly.
    // Attach a rejection observer so that case never becomes unhandled.
    entry.promise.catch(() => {});
    OpenAISpeechTTS.inflight.set(cacheKey, entry);
    return entry;
  }

  async #consumeInflight(
    cacheKey: string,
    entry: InflightSpeechRequest,
    signal?: AbortSignal,
  ): Promise<OpenAITTSCachedAudio> {
    entry.consumers++;
    let onAbort: (() => void) | undefined;
    try {
      if (!signal) return await entry.promise;
      if (signal.aborted) throw abortError(signal);
      return await new Promise<OpenAITTSCachedAudio>((resolve, reject) => {
        let done = false;
        const finish = (callback: () => void) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort!);
          callback();
        };
        onAbort = () => finish(() => reject(abortError(signal)));
        signal.addEventListener('abort', onAbort, { once: true });
        entry.promise.then(
          (audio) => finish(() => resolve(audio)),
          (error) => finish(() => reject(error)),
        );
      });
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      entry.consumers--;
      if (!entry.settled && entry.consumers === 0) {
        if (OpenAISpeechTTS.inflight.get(cacheKey) === entry) {
          OpenAISpeechTTS.inflight.delete(cacheKey);
        }
        entry.controller.abort(new DOMException('No request consumers remain', 'AbortError'));
      }
    }
  }

  async #fetchAndCache(
    payload: OpenAITTSPayload,
    signal?: AbortSignal,
  ): Promise<OpenAITTSCachedAudio> {
    if (signal?.aborted) throw abortError(signal);
    const cacheKey = this.getCacheKey(payload);
    const cached = OpenAISpeechTTS.audioCache.get(cacheKey);
    if (cached) return cached;
    const pending = OpenAISpeechTTS.inflight.get(cacheKey) ?? this.#newInflight(payload, cacheKey);
    return this.#consumeInflight(cacheKey, pending, signal);
  }

  evictAudio(payload: OpenAITTSPayload): boolean {
    return OpenAISpeechTTS.audioCache.delete(this.getCacheKey(payload));
  }

  async preloadAudio(payload: OpenAITTSPayload, signal?: AbortSignal): Promise<void> {
    await this.#fetchAndCache(payload, signal);
  }

  // Audio bytes plus the real server media type. Mint a fresh ArrayBuffer copy
  // per call — WebKit's decodeAudioData detaches its input, so handing out a
  // shared buffer would break replay from cache.
  async createAudioData(
    payload: OpenAITTSPayload,
    signal?: AbortSignal,
  ): Promise<OpenAITTSAudioData> {
    const audio = await this.#fetchAndCache(payload, signal);
    const data = audio.bytes.slice().buffer;
    if (signal?.aborted) throw abortError(signal);
    return { data, contentType: audio.contentType };
  }

  // A settings-screen connection check is only successful after the endpoint
  // has synthesized real audio and this runtime has decoded it. Try the same
  // compatibility ladder as playback, but never disguise auth/network/server
  // errors as codec incompatibility.
  async verifySynthesis(
    model: string,
    voice: string,
    decode: (data: ArrayBuffer) => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<OpenAITTSResponseFormat> {
    for (const responseFormat of OPENAI_TTS_FORMAT_ORDER) {
      const payload: OpenAITTSPayload = {
        model,
        voice,
        responseFormat,
        speed: 1,
        text: 'Readest Siri voice connection test.',
      };
      let audio: OpenAITTSAudioData;
      try {
        audio = await this.createAudioData(payload, signal);
      } catch (error) {
        if (error instanceof OpenAITTSRequestError && error.isUnsupportedFormat) continue;
        throw error;
      }
      try {
        await decode(audio.data.slice(0));
        return responseFormat;
      } catch (error) {
        this.evictAudio(payload);
        if (signal?.aborted) throw abortError(signal);
        if (responseFormat === OPENAI_TTS_FORMAT_ORDER.at(-1)) throw error;
      }
    }
    throw new Error('No supported OpenAI TTS audio format was available.');
  }
}
