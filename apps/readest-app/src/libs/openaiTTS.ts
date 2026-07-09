import { md5 } from 'js-md5';
import { LRUCache } from '@/utils/lru';
import { isTauriAppPlatform } from '@/services/environment';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

// Client for a self-hosted OpenAI-compatible TTS server (e.g. a patched
// macos-speech-server, openedai-speech, kokoro-fastapi). Wire contract:
//   GET  {base}/v1/models           -> OpenAI-style model list (health check)
//   GET  {base}/v1/audio/voices     -> { voices: ["<id>", ...] }
//   GET  {base}/v1/audio/voices/all -> { voices: [{ id, name, lang, quality }] }
//   POST {base}/v1/audio/speech     -> audio bytes (WAV requested)
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
  responseFormat: string;
  speed: number;
}

export interface OpenAITTSVoice {
  id: string;
  name: string;
  lang: string;
  quality?: string;
}

// Thrown for HTTP 4xx responses from /v1/audio/speech: the request itself is
// invalid for this sentence/voice (e.g. voice not installed), so retrying is
// futile — callers skip the chunk instead of failing the session.
export class OpenAITTSRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAITTSRequestError';
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

const hashPayload = (payload: OpenAITTSPayload): string => md5(JSON.stringify(payload));

export class OpenAISpeechTTS {
  // Cache keyed by the full payload hash (model + text + voice +
  // response_format + speed), shared across instances like EdgeSpeechTTS.
  private static audioCache = new LRUCache<string, Blob>(200);
  // In-flight fetches keyed by payload hash: the playback scheduler and the
  // preload paths race for the same sentences at every paragraph start.
  private static inflight = new Map<string, Promise<Blob>>();

  #baseUrl: string;
  #apiKey: string;

  constructor(endpoint: string, apiKey = '') {
    this.#baseUrl = normalizeOpenAITTSEndpoint(endpoint);
    this.#apiKey = apiKey.trim();
  }

  get baseUrl(): string {
    return this.#baseUrl;
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
        const data = (await response.json()) as { voices?: unknown[] };
        const voices = (data.voices ?? []).filter(
          (v): v is OpenAITTSVoice =>
            !!v &&
            typeof (v as OpenAITTSVoice).id === 'string' &&
            typeof (v as OpenAITTSVoice).name === 'string' &&
            typeof (v as OpenAITTSVoice).lang === 'string',
        );
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

  async #fetchSpeech(payload: OpenAITTSPayload, signal?: AbortSignal): Promise<Blob> {
    const response = await this.#fetchWithTimeout(
      `${this.#baseUrl}/v1/audio/speech`,
      {
        method: 'POST',
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
      const message =
        `OpenAI TTS error: ${response.status} ${response.statusText} ${errorText}`.trim();
      if (response.status >= 400 && response.status < 500) {
        throw new OpenAITTSRequestError(message);
      }
      throw new Error(message);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      throw new OpenAITTSRequestError('No audio data received.');
    }
    return new Blob([arrayBuffer], { type: `audio/${payload.responseFormat}` });
  }

  async #fetchAndCache(payload: OpenAITTSPayload, signal?: AbortSignal): Promise<Blob> {
    const cacheKey = hashPayload(payload);
    const cached = OpenAISpeechTTS.audioCache.get(cacheKey);
    if (cached) return cached;
    const pending = OpenAISpeechTTS.inflight.get(cacheKey);
    if (pending) return pending;
    const promise = (async () => {
      const blob = await this.#fetchSpeech(payload, signal);
      OpenAISpeechTTS.audioCache.set(cacheKey, blob);
      return blob;
    })();
    OpenAISpeechTTS.inflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      OpenAISpeechTTS.inflight.delete(cacheKey);
    }
  }

  // Audio bytes for Web Audio decoding. Mint a fresh ArrayBuffer copy per
  // call — WebKit's decodeAudioData detaches its input, so handing out a
  // shared buffer would break replay from cache.
  async createAudioData(payload: OpenAITTSPayload, signal?: AbortSignal): Promise<ArrayBuffer> {
    const blob = await this.#fetchAndCache(payload, signal);
    return blob.arrayBuffer();
  }
}
