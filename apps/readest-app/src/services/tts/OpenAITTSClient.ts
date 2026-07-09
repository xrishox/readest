import { getUserLocale } from '@/utils/misc';
import { isSameLang } from '@/utils/lang';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import {
  OpenAISpeechTTS,
  OpenAITTSPayload,
  OpenAITTSRequestError,
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

// OpenAI-compatible TTS client for a self-hosted server (endpoint + optional
// API key configured in Settings -> TTS). Mirrors EdgeTTSClient's playback
// pipeline: fetch WAV (cached at speed 1.0) -> decode -> trim silence ->
// WSOLA time-stretch to the playback rate -> schedule gaplessly on the shared
// AudioContext. Marks are dispatched when a chunk becomes AUDIBLE, not when
// it is fetched. The server reports no word boundaries, so granularity and
// highlighting stay sentence-level.

const INTER_SENTENCE_GAP_SEC = 0.15;
const RESPONSE_FORMAT = 'wav';
const DEFAULT_MODEL = 'tts-1';

interface ChunkMeta {
  mark: TTSMark;
  trimStartSec: number;
  trimmedDurationSec: number;
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

// Voice label shown in the picker: include the quality tier when the server
// reports a non-default one, plus the locale so region variants of the same
// primary language stay distinguishable (the list is filtered by primary
// language only), e.g. 'Zoe (premium) — en-US'.
const formatVoiceName = (voice: OpenAITTSVoice): string => {
  const quality = voice.quality && voice.quality !== 'default' ? ` (${voice.quality})` : '';
  return `${voice.name}${quality} — ${voice.lang}`;
};

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
  #player = new WebAudioPlayer();
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
    if (await this.#openaiTTS.checkAvailability()) {
      const voices = await this.#openaiTTS.fetchVoices();
      this.#voices = voices.map((voice) => ({
        id: voice.id,
        name: formatVoiceName(voice),
        lang: voice.lang,
      }));
      this.initialized = this.#voices.length > 0;
    } else {
      console.warn('OpenAI TTS endpoint not reachable:', endpoint);
      this.initialized = false;
    }
    return this.initialized;
  }

  getPayload = (text: string, voiceId: string): OpenAITTSPayload => {
    // Speed stays 1.0 so the audio cache is rate-independent; the playback
    // rate is applied client-side via time-stretch.
    return {
      model: DEFAULT_MODEL,
      text,
      voice: voiceId,
      responseFormat: RESPONSE_FORMAT,
      speed: 1.0,
    };
  };

  // Transient failures (network hiccup, 5xx) retry a few times before giving
  // up. 4xx responses are permanent for a given sentence/voice
  // (OpenAITTSRequestError), so they rethrow immediately for the caller's
  // skip path.
  #createAudioDataWithRetry = async (
    payload: OpenAITTSPayload,
    signal: AbortSignal,
    maxAttempts = 3,
  ): Promise<ArrayBuffer | undefined> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) return undefined;
      try {
        return await this.#openaiTTS?.createAudioData(payload, signal);
      } catch (err) {
        if (err instanceof OpenAITTSRequestError) throw err;
        lastError = err;
        console.warn(`OpenAI TTS fetch attempt ${attempt}/${maxAttempts} failed`, err);
        if (attempt < maxAttempts && !signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
      }
    }
    throw lastError;
  };

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

    this.#runScheduler(marks, signal, generation, queue, chunkMeta);

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
          yield { code: 'error', message: event.message } as TTSMessageEvent;
          return;
        }
      }
    } finally {
      // The controller aborts the signal after every successful paragraph; a
      // lingering listener would push a stale 'Aborted' into a dead queue.
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
      this.#isPlaying = false;
      if (this.#activeGeneration === generation) {
        this.#activeGeneration = null;
        this.#activeQueue = null;
        this.#player.abortSession();
      }
    }
  }

  async *#preload(marks: TTSMark[], signal: AbortSignal) {
    // Fetch the first couple of marks immediately and the rest in the
    // background; the in-flight dedup in OpenAISpeechTTS keeps this from
    // racing duplicate requests against the playback scheduler.
    const maxImmediate = 2;
    for (let i = 0; i < Math.min(maxImmediate, marks.length); i++) {
      if (signal.aborted) break;
      const mark = marks[i]!;
      const voiceId = await this.getVoiceIdFromLang(mark.language);
      this.#currentVoiceId = voiceId;
      try {
        await this.#createAudioDataWithRetry(this.getPayload(mark.text, voiceId), signal);
      } catch (err) {
        console.warn('Error preloading mark', i, err);
      }
    }
    if (marks.length > maxImmediate) {
      (async () => {
        for (let i = maxImmediate; i < marks.length; i++) {
          const mark = marks[i]!;
          try {
            if (signal.aborted) break;
            const voiceId = await this.getVoiceIdFromLang(mark.language);
            await this.#createAudioDataWithRetry(this.getPayload(mark.text, voiceId), signal);
          } catch (err) {
            console.warn('Error preloading mark (bg)', i, err);
          }
        }
      })();
    }

    yield {
      code: 'end',
      message: 'Preload finished',
    } as TTSMessageEvent;
  }

  // Detached scheduler: fetches, prepares, and schedules chunks ahead of the
  // playhead under the player's backpressure. Never throws; failures surface
  // through the event queue.
  async #runScheduler(
    marks: TTSMark[],
    signal: AbortSignal,
    generation: number,
    queue: AsyncQueue<SpeakQueueEvent>,
    chunkMeta: ChunkMeta[],
  ): Promise<void> {
    const rate = this.#rate;
    try {
      for (const mark of marks) {
        if (signal.aborted || this.#activeGeneration !== generation) return;
        // Voices resolve per mark: mixed-language sections speak (and record
        // durations under) the voice actually used for each sentence.
        const voiceId = await this.getVoiceIdFromLang(mark.language);
        this.#speakingLang = mark.language;
        this.#currentVoiceId = voiceId;
        const payload = this.getPayload(mark.text, voiceId);

        let audio: ArrayBuffer | undefined;
        try {
          audio = await this.#createAudioDataWithRetry(payload, signal);
        } catch (error) {
          if (error instanceof OpenAITTSRequestError) {
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
        if (!audio || signal.aborted || this.#activeGeneration !== generation) return;

        let prepared: {
          buffer: TTSAudioBuffer;
          trimStartSec: number;
          trimmedDurationSec: number;
        };
        try {
          prepared = await this.#prepareChunkBuffer(audio, rate);
        } catch (error) {
          // Malformed audio must not dead-end the session: same UX as no-audio.
          console.warn('Failed to decode TTS audio for:', mark.text, error);
          queue.push({ kind: 'chunk-skip', markName: mark.name });
          continue;
        }
        // Canonical decode-time trimmed duration; feeds the per-voice
        // speaking-rate calibration used by timeline estimates.
        recordMeasuredDuration(voiceId, mark.text, prepared.trimmedDurationSec);
        calibrateVoiceRate(voiceId, mark.text, prepared.trimmedDurationSec);

        const ready = await this.#player.waitUntilReady(generation);
        if (!ready || signal.aborted) return;
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
    data: ArrayBuffer,
    rate: number,
  ): Promise<{ buffer: TTSAudioBuffer; trimStartSec: number; trimmedDurationSec: number }> {
    // decodeAudioData resamples to the context rate (44.1/48kHz on real
    // devices, not the stream's 22.05kHz) — all math below must use the
    // decoded buffer's sampleRate.
    const decoded = await this.#player.decode(data);
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
      voices: filteredVoices.sort(TTSUtils.sortVoicesPreferLocaleFunc(locale)),
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
