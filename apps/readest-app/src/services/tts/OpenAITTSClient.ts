import { getUserLocale } from '@/utils/misc';
import { isSameLang } from '@/utils/lang';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import {
  compareVoiceQuality,
  OpenAITTSAudioData,
  OpenAISpeechTTS,
  OpenAITTSPayload,
  OpenAITTSRequestError,
  OpenAITTSResponseFormat,
  OpenAITTSVoice,
} from '@/libs/openaiTTS';
import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { AppService } from '@/types/system';
import { parseSSMLMarks } from '@/utils/ssml';
import { useSettingsStore } from '@/store/settingsStore';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { applyEdgeFade, findSpeechBounds } from './pcm';
import { timeStretch } from './timeStretch';
import { calibrateVoiceRate, recordMeasuredDuration } from './ttsDuration';
import { TTSAudioBuffer, WebAudioPlayer, WebAudioPlayerEvent } from './WebAudioPlayer';
import {
  decodeOpenAITTSAudioWithFallback,
  OpenAITTSCodecNegotiator,
  OpenAITTSFetchedAudio,
} from './openaiTTSCodec';
import {
  OpenAITTSFetchPriority,
  OpenAITTSOrderedWindow,
  OpenAITTSTaskPool,
} from './openaiTTSWindow';

// OpenAI-compatible TTS client for a self-hosted server (endpoint + optional
// API key configured in Settings -> TTS). Mirrors EdgeTTSClient's playback
// pipeline: probe + fetch Ogg Opus/AAC-LC/WAV (cached at speed 1.0) -> decode
// -> trim silence -> WSOLA time-stretch to the playback rate -> schedule
// gaplessly on the shared AudioContext. Fetching runs in an ordered current +
// nine window; decoding stays behind player backpressure. Marks are dispatched
// when a chunk becomes AUDIBLE, not when it is fetched. The server reports no
// word boundaries, so granularity and highlighting stay sentence-level.

const INTER_SENTENCE_GAP_SEC = 0.15;
const DEFAULT_MODEL = 'tts-1';

interface ChunkMeta {
  mark: TTSMark;
  trimStartSec: number;
  trimmedDurationSec: number;
}

interface FetchedMarkAudio extends OpenAITTSFetchedAudio {
  mark: TTSMark;
  voiceId: string;
}

type SpeakQueueEvent =
  | { kind: 'chunk-start'; index: number }
  | { kind: 'chunk-skip'; markName: string }
  | { kind: 'session-end' }
  | { kind: 'error'; message: string };

class AsyncQueue<T> {
  #items: T[] = [];
  #resolvers: Array<(item: T) => void> = [];

  push(item: T): void {
    const resolve = this.#resolvers.shift();
    if (resolve) resolve(item);
    else this.#items.push(item);
  }

  next(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.#resolvers.push(resolve));
  }
}

// Voice label shown in the picker: name plus locale so region variants of the
// same primary language stay distinguishable (the list is filtered by primary
// language only), e.g. 'Zoe — en-US'. The quality tier renders as a separate
// badge (TTSVoice.quality), not as part of the name — Apple display names
// already embed '(Premium)'/'(Enhanced)', which would duplicate the badge.
const formatVoiceName = (voice: OpenAITTSVoice): string => {
  const name = voice.name.replace(/\s*\((?:premium|enhanced)\)\s*$/i, '');
  return `${name} — ${voice.lang}`;
};

const voiceQualityTier = (quality?: string): TTSVoice['quality'] =>
  quality === 'premium' || quality === 'enhanced' ? quality : undefined;

const abortError = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('Aborted', 'AbortError');
};

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

export class OpenAITTSClient implements TTSClient {
  name = 'openai-tts';
  initialized = false;
  controller?: TTSController;
  appService?: AppService | null;

  #voices: TTSVoice[] = [];
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = '';
  #rate = 1.0;

  #openaiTTS: OpenAISpeechTTS | null = null;
  #codec: OpenAITTSCodecNegotiator | null = null;
  #model = DEFAULT_MODEL;
  #player = new WebAudioPlayer();
  #fetchPool = new OpenAITTSTaskPool();
  #activeFetchController: AbortController | null = null;
  #preloadControllers = new Set<AbortController>();
  #activeGeneration: number | null = null;
  #activeQueue: AsyncQueue<SpeakQueueEvent> | null = null;
  #chunkMeta: ChunkMeta[] = [];
  #isPlaying = false;

  constructor(controller?: TTSController, appService?: AppService | null) {
    this.controller = controller;
    this.appService = appService;
  }

  async init() {
    // Never break the other clients when no endpoint is configured: init
    // silently reports unavailability.
    const readSettings = useSettingsStore.getState().settings?.globalReadSettings;
    const endpoint = readSettings?.openaiTtsEndpoint?.trim() || '';
    if (!endpoint) {
      this.initialized = false;
      return false;
    }
    this.#openaiTTS = new OpenAISpeechTTS(endpoint, readSettings?.openaiTtsApiKey || '');
    this.#codec = new OpenAITTSCodecNegotiator((data) => this.#player.decode(data));
    this.#model = readSettings?.openaiTtsModel?.trim() || DEFAULT_MODEL;
    if (await this.#openaiTTS.checkAvailability()) {
      const voices = await this.#openaiTTS.fetchVoices();
      this.#voices = voices.map((voice) => ({
        id: voice.id,
        name: formatVoiceName(voice),
        lang: voice.lang,
        quality: voiceQualityTier(voice.quality),
      }));
      this.initialized = this.#voices.length > 0;
    } else {
      console.warn('OpenAI TTS endpoint not reachable:', endpoint);
      this.initialized = false;
    }
    return this.initialized;
  }

  getPayload = (
    text: string,
    voiceId: string,
    responseFormat: OpenAITTSResponseFormat = 'opus',
  ): OpenAITTSPayload => {
    // Speed stays 1.0 so the audio cache is rate-independent; the playback
    // rate is applied client-side via time-stretch.
    return {
      model: this.#model,
      text,
      voice: voiceId,
      responseFormat,
      speed: 1.0,
    };
  };

  // Transient failures (network hiccup, 429, 5xx) retry a few times before
  // giving up. Other HTTP failures rethrow immediately; the scheduler alone
  // decides whether a 400/422 is safe to skip or must stop the session.
  #createAudioDataWithRetry = async (
    payload: OpenAITTSPayload,
    signal: AbortSignal,
    maxAttempts = 3,
  ): Promise<OpenAITTSAudioData> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) throw abortError(signal);
      try {
        if (!this.#openaiTTS) throw new Error('OpenAI TTS client is not initialized.');
        return await this.#openaiTTS.createAudioData(payload, signal);
      } catch (err) {
        if (err instanceof OpenAITTSRequestError && (err.isUnsupportedFormat || !err.isRetryable)) {
          throw err;
        }
        lastError = err;
        console.warn(`OpenAI TTS fetch attempt ${attempt}/${maxAttempts} failed`, err);
        if (attempt < maxAttempts && !signal.aborted) {
          await waitForRetry(200 * attempt, signal);
        }
      }
    }
    throw lastError;
  };

  #fetchMark = (
    mark: TTSMark,
    signal: AbortSignal,
    priority: OpenAITTSFetchPriority,
  ): Promise<FetchedMarkAudio> =>
    this.#fetchPool.run(
      async () => {
        const codec = this.#codec;
        if (!codec) throw new Error('OpenAI TTS codec negotiation is not initialized.');
        const voiceId = await this.getVoiceIdFromLang(mark.language);
        for (;;) {
          if (signal.aborted) throw abortError(signal);
          const format = await codec.nextFormat();
          const payload = this.getPayload(mark.text, voiceId, format);
          try {
            const audio = await this.#createAudioDataWithRetry(payload, signal);
            return { mark, voiceId, format, payload, audio };
          } catch (error) {
            if (error instanceof OpenAITTSRequestError && error.isUnsupportedFormat) {
              codec.reject(format);
              continue;
            }
            // Another concurrent job may have explicitly rejected this codec
            // while this request was retrying. Follow that established result;
            // this error itself still does not cause a downgrade.
            if (!codec.accepts(format)) continue;
            throw error;
          }
        }
      },
      signal,
      priority,
    );

  getVoiceIdFromLang = async (lang: string) => {
    const preferredVoiceId = TTSUtils.getPreferredVoice(this.name, lang);
    const preferredVoice = this.#voices.find((v) => v.id === preferredVoiceId);
    if (preferredVoice) return preferredVoice.id;

    const availableVoices = (await this.getVoices(lang))[0]?.voices || [];
    const defaultVoice: TTSVoice | null = availableVoices[0] || null;
    return defaultVoice?.id || this.#currentVoiceId || this.#voices[0]?.id || '';
  };

  async *speak(ssml: string, signal: AbortSignal, preload = false) {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);

    if (preload) {
      yield* this.#preload(marks, signal);
      return;
    }

    await this.stopInternal();

    const queue = new AsyncQueue<SpeakQueueEvent>();
    const chunkMeta: ChunkMeta[] = [];
    this.#activeQueue = queue;
    this.#chunkMeta = chunkMeta;

    // startSession before ensureContext: starting a session declares playback
    // intent, clearing any lingering user-pause so the context may resume.
    const generation = this.#player.startSession((event: WebAudioPlayerEvent) => {
      if (event.type === 'chunk-start') {
        queue.push({ kind: 'chunk-start', index: event.chunkIndex });
      } else if (event.type === 'session-end') {
        queue.push({ kind: 'session-end' });
      } else {
        queue.push({ kind: 'error', message: event.message });
      }
    });
    this.#activeGeneration = generation;
    await this.#player.ensureContext();
    this.#isPlaying = true;

    const fetchController = new AbortController();
    const abortFetches = () => fetchController.abort(signal.reason);
    if (signal.aborted) abortFetches();
    else signal.addEventListener('abort', abortFetches, { once: true });
    this.#activeFetchController = fetchController;

    this.#runScheduler(marks, fetchController.signal, generation, queue, chunkMeta);

    let abortHandler: (() => void) | null = null;
    try {
      if (signal.aborted) {
        yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
        return;
      }
      abortHandler = () => queue.push({ kind: 'error', message: 'Aborted' });
      signal.addEventListener('abort', abortHandler);

      for (;;) {
        const event = await queue.next();
        if (event.kind === 'chunk-start') {
          const meta = chunkMeta[event.index];
          if (!meta) continue;
          this.controller?.dispatchSpeakMark(meta.mark);
          yield {
            code: 'boundary',
            message: `Start chunk: ${meta.mark.name}`,
            mark: meta.mark.name,
          } as TTSMessageEvent;
        } else if (event.kind === 'chunk-skip') {
          yield {
            code: 'end',
            message: `Chunk skipped: ${event.markName}`,
          } as TTSMessageEvent;
        } else if (event.kind === 'session-end') {
          yield { code: 'end', message: 'Speak finished' } as TTSMessageEvent;
          return;
        } else {
          // Unlike the native client, transport/config failures are not
          // skippable engine events. Throw so TTSController.error() stops the
          // session visibly instead of leaving controls in a playing state.
          throw new Error(event.message);
        }
      }
    } finally {
      // The controller aborts the signal after every successful paragraph; a
      // lingering listener would push a stale 'Aborted' into a dead queue.
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
      signal.removeEventListener('abort', abortFetches);
      fetchController.abort(new DOMException('Speech session ended', 'AbortError'));
      if (this.#activeFetchController === fetchController) {
        this.#activeFetchController = null;
      }
      this.#isPlaying = false;
      if (this.#activeGeneration === generation) {
        this.#activeGeneration = null;
        this.#activeQueue = null;
        this.#player.abortSession();
      }
    }
  }

  async *#preload(marks: TTSMark[], signal: AbortSignal) {
    // Do not create/resume an AudioContext merely for speculative preload: on
    // Apple platforms the initial codec probe must run in the playback context
    // warmed by the user gesture. Once playback has pinned a codec, warm only
    // the nearest mark and await it—never launch detached, uncancellable work.
    const mark = marks[0];
    if (mark && this.#codec?.pinnedFormat && !signal.aborted) {
      const controller = new AbortController();
      const relayAbort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', relayAbort, { once: true });
      this.#preloadControllers.add(controller);
      try {
        await this.#fetchMark(mark, controller.signal, 'preload');
      } catch (err) {
        if (!controller.signal.aborted) console.warn('Error preloading nearest mark', err);
      } finally {
        signal.removeEventListener('abort', relayAbort);
        this.#preloadControllers.delete(controller);
      }
    }

    yield {
      code: 'end',
      message: 'Preload finished',
    } as TTSMessageEvent;
  }

  // Detached from the event generator, but fully owned by its generation and
  // abort controller. Fetches stay ten-wide and ordered; decoding waits for
  // player capacity so speculative work retains compressed bytes, not PCM.
  async #runScheduler(
    marks: TTSMark[],
    signal: AbortSignal,
    generation: number,
    queue: AsyncQueue<SpeakQueueEvent>,
    chunkMeta: ChunkMeta[],
  ): Promise<void> {
    const rate = this.#rate;
    const window = new OpenAITTSOrderedWindow<TTSMark, FetchedMarkAudio>({
      items: marks,
      signal,
      load: (mark) => this.#fetchMark(mark, signal, 'playback'),
    });
    let markIndex = 0;
    try {
      while (markIndex < marks.length) {
        const mark = marks[markIndex++]!;
        if (signal.aborted || this.#activeGeneration !== generation) return;
        let fetched: FetchedMarkAudio;
        try {
          const next = await window.next();
          if (!next) break;
          fetched = next.value;
        } catch (error) {
          if (error instanceof OpenAITTSRequestError && error.isSkippableInput) {
            // Permanent for this sentence (bad voice, unsynthesizable text):
            // skip it instead of dead-ending the session.
            console.warn('OpenAI TTS rejected mark:', mark.text, error.message);
            queue.push({ kind: 'chunk-skip', markName: mark.name });
            continue;
          }
          if (signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          console.warn('TTS error for mark:', mark.text, message);
          queue.push({ kind: 'error', message });
          return;
        }
        if (signal.aborted || this.#activeGeneration !== generation) return;

        // Wait before decoding so at most the player's near-playback budget is
        // expanded to PCM. The window has already admitted the next compressed
        // fetch, preserving network lookahead while this chunk waits.
        const ready = await this.#player.waitUntilReady(generation);
        if (!ready || signal.aborted) return;

        let decoded: { fetched: FetchedMarkAudio; decoded: TTSAudioBuffer };
        try {
          decoded = await decodeOpenAITTSAudioWithFallback(fetched, {
            negotiator: this.#codec!,
            decode: (data) => this.#player.decode(data),
            refetch: () => this.#fetchMark(mark, signal, 'playback'),
            evict: (payload) => this.#openaiTTS?.evictAudio(payload),
          });
        } catch (error) {
          if (signal.aborted || this.#activeGeneration !== generation) return;
          if (error instanceof OpenAITTSRequestError && error.isSkippableInput) {
            console.warn(
              'OpenAI TTS rejected mark during codec fallback:',
              mark.text,
              error.message,
            );
            queue.push({ kind: 'chunk-skip', markName: mark.name });
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          console.warn('Failed to obtain decodable TTS audio for:', mark.text, message);
          queue.push({ kind: 'error', message });
          return;
        }

        const { voiceId } = decoded.fetched;
        this.#speakingLang = mark.language;
        this.#currentVoiceId = voiceId;

        let prepared: {
          buffer: TTSAudioBuffer;
          trimStartSec: number;
          trimmedDurationSec: number;
        };
        try {
          prepared = await this.#prepareChunkBuffer(decoded.decoded, rate);
        } catch (error) {
          // The codec has already decoded successfully. A later PCM/WSOLA
          // failure is not evidence that the container is unsupported.
          console.warn('Failed to prepare TTS audio for:', mark.text, error);
          queue.push({ kind: 'chunk-skip', markName: mark.name });
          continue;
        }
        // Canonical decode-time trimmed duration; feeds the per-voice
        // speaking-rate calibration used by timeline estimates.
        recordMeasuredDuration(voiceId, mark.text, prepared.trimmedDurationSec);
        calibrateVoiceRate(voiceId, mark.text, prepared.trimmedDurationSec);

        chunkMeta.push({
          mark,
          trimStartSec: prepared.trimStartSec,
          trimmedDurationSec: prepared.trimmedDurationSec,
        });
        this.#player.scheduleChunk(generation, prepared.buffer, {
          trimStartSec: prepared.trimStartSec,
          mediaScale: prepared.trimmedDurationSec / prepared.buffer.duration,
          gapSec: INTER_SENTENCE_GAP_SEC / rate,
        });
      }
      if (!signal.aborted && this.#activeGeneration === generation) {
        // Fires session-end synchronously when every mark was skipped or the
        // last chunk already ended, so the session always terminates.
        this.#player.endSession(generation);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queue.push({ kind: 'error', message });
    }
  }

  async #prepareChunkBuffer(
    decoded: TTSAudioBuffer,
    rate: number,
  ): Promise<{ buffer: TTSAudioBuffer; trimStartSec: number; trimmedDurationSec: number }> {
    // decodeAudioData resamples to the context rate (44.1/48kHz on real
    // devices, not the stream's 22.05kHz) — all math below must use the
    // decoded buffer's sampleRate.
    const sampleRate = decoded.sampleRate;
    const channel = decoded.getChannelData(0);
    const bounds = findSpeechBounds(channel, sampleRate);
    const startSample = Math.floor(bounds.startSec * sampleRate);
    const endSample = Math.min(channel.length, Math.ceil(bounds.endSec * sampleRate));
    // A subarray is a view; timeStretch never writes its input and
    // createMonoBuffer copies, so no mutation can reach the decoded buffer.
    const trimmed = channel.subarray(startSample, endSample);
    const trimmedDurationSec = trimmed.length / sampleRate;
    const samples = rate !== 1 ? timeStretch(trimmed, sampleRate, rate) : trimmed;
    const buffer = await this.#player.createMonoBuffer(samples, sampleRate);
    // Silence-trimmed edges sit on non-zero samples; fade the buffer's own copy
    // so chunk starts/ends don't click against the inter-sentence gap.
    applyEdgeFade(buffer.getChannelData(0), sampleRate);
    return { buffer, trimStartSec: startSample / sampleRate, trimmedDurationSec };
  }

  async pause() {
    if (!this.#isPlaying) return true;
    await this.#player.pauseContext();
    return true;
  }

  async resume() {
    // Throws when the context refuses to run again (iOS post-interruption);
    // the controller's catch stops playback visibly instead of showing
    // "playing" over silence.
    await this.#player.resumeContext();
    return true;
  }

  async stop() {
    await this.stopInternal();
  }

  private async stopInternal() {
    this.#isPlaying = false;
    this.#activeFetchController?.abort(new DOMException('Speech session stopped', 'AbortError'));
    this.#activeFetchController = null;
    for (const controller of this.#preloadControllers) {
      controller.abort(new DOMException('Preload generation stopped', 'AbortError'));
    }
    this.#preloadControllers.clear();
    if (this.#activeGeneration !== null) {
      this.#activeGeneration = null;
      // Unblock a generator awaiting the queue; without this a stop() outside
      // the abort path would leave the consumer parked forever.
      this.#activeQueue?.push({ kind: 'error', message: 'Aborted' });
      this.#activeQueue = null;
      this.#player.abortSession();
    }
  }

  getChunkPosition(): number | null {
    const generation = this.#activeGeneration;
    if (generation === null) return null;
    const pos = this.#player.getPlaybackPosition(generation);
    if (!pos) return null;
    const meta = this.#chunkMeta[pos.chunkIndex];
    if (!meta) return null;
    // Trim-relative and clamped: the section timeline sums TRIMMED durations,
    // while the player reports untrimmed media time.
    return Math.min(Math.max(pos.mediaTimeSec - meta.trimStartSec, 0), meta.trimmedDurationSec);
  }

  async setRate(rate: number) {
    // Applied client-side via WSOLA time-stretch at schedule time; takes
    // effect on the next speak() session (the controller restarts playback on
    // rate changes). Synthesis always requests speed 1.0.
    this.#rate = rate;
  }

  async setPitch(_pitch: number) {
    // The OpenAI speech API has no pitch control.
  }

  async setVoice(voice: string) {
    const selectedVoice = this.#voices.find((v) => v.id === voice);
    if (selectedVoice) {
      this.#currentVoiceId = selectedVoice.id;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    this.#voices.forEach((voice) => {
      voice.disabled = !this.initialized;
    });
    return this.#voices;
  }

  async getVoices(lang: string) {
    const locale = lang === 'en' ? getUserLocale(lang) || lang : lang;
    const voices = await this.getAllVoices();
    // Match by primary language so the voice set stays the same across a book
    // whose sections mix region variants; the requested locale's voices sort
    // first.
    const filteredVoices = voices.filter((v) => isSameLang(v.lang, lang));

    const voicesGroup: TTSVoicesGroup = {
      id: 'openai-tts',
      name: 'OpenAI-Compatible TTS',
      // Premium first, then enhanced, then the rest; locale preference breaks
      // ties within each tier.
      voices: filteredVoices.sort(
        (a, b) => compareVoiceQuality(a, b) || TTSUtils.sortVoicesPreferLocaleFunc(locale)(a, b),
      ),
      disabled: !this.initialized || filteredVoices.length === 0,
    };

    return [voicesGroup];
  }

  setPrimaryLang(lang: string) {
    this.#primaryLang = lang;
  }

  supportsWordBoundaries(): boolean {
    return false;
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId(): string {
    return this.#currentVoiceId;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }

  async shutdown(): Promise<void> {
    await this.stopInternal();
    await this.#player.shutdown();
    this.initialized = false;
    this.#voices = [];
  }
}
