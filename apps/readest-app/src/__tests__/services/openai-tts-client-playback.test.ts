import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TTSMessageEvent } from '@/services/tts/TTSClient';
import type { TTSController } from '@/services/tts/TTSController';
import type { OpenAITTSLookaheadCandidate } from '@/services/tts/openaiTTSLookahead';
import { FakeAudioBuffer, FakeAudioContext, makeBuffer } from './tts-fake-audio';

let parsedMarks: Array<{ name: string; text: string; language: string }> = [];

vi.mock('@/utils/ssml', () => ({
  parseSSMLMarks: vi.fn(() => ({ marks: parsedMarks })),
}));

vi.mock('@/utils/misc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/misc')>()),
  getUserLocale: vi.fn(() => 'en-US'),
}));

vi.mock('@/services/tts/TTSUtils', () => ({
  TTSUtils: {
    getPreferredVoice: vi.fn(() => null),
    sortVoicesPreferLocaleFunc: () => () => 0,
  },
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      settings: {
        globalReadSettings: {
          openaiTtsEndpoint: 'https://client-playback.example',
          openaiTtsApiKey: 'key',
          openaiTtsModel: 'tts-1',
        },
      },
    }),
  },
}));

const identifyProbe = (data: ArrayBuffer): 'opus' | 'aac' | null => {
  const bytes = new Uint8Array(data);
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (ascii(0, 4) === 'OggS') return 'opus';
  if (ascii(4, 4) === 'ftyp') return 'aac';
  return null;
};

class CodecAwareAudioContext extends FakeAudioContext {
  constructor() {
    super(24000);
    this.decodeImpl = async (data) => {
      if (identifyProbe(data)) return makeBuffer(0.02);
      const marker = new Uint8Array(data)[0];
      if (marker === 0xee) throw new DOMException('Invalid real Opus stream', 'EncodingError');
      return new FakeAudioBuffer(new Float32Array(1200), 24000);
    };
  }
}

type OpenAIClientClass = typeof import('@/services/tts/OpenAITTSClient').OpenAITTSClient;

describe('OpenAITTSClient codec playback integration', () => {
  let OpenAITTSClient: OpenAIClientClass;
  let speechFormats: string[];
  let speechInputs: string[];
  let speechResponse: (format: string) => Response;

  beforeEach(async () => {
    vi.resetModules();
    FakeAudioContext.instances = [];
    parsedMarks = [{ name: '0', text: 'One sentence.', language: 'en' }];
    speechFormats = [];
    speechInputs = [];
    speechResponse = (format) =>
      format === 'opus'
        ? new Response(new Uint8Array([0xee]), {
            status: 200,
            headers: { 'Content-Type': 'audio/ogg; codecs=opus' },
          })
        : new Response(new Uint8Array([0xaa]), {
            status: 200,
            headers: { 'Content-Type': 'audio/mp4; codecs=mp4a.40.2' },
          });
    vi.stubGlobal('AudioContext', CodecAwareAudioContext);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/models')) {
          return Response.json({ object: 'list', data: [{ id: 'tts-1' }] });
        }
        if (url.endsWith('/v1/audio/voices/all')) {
          return Response.json({
            voices: [{ id: 'voice-1', name: 'Voice', lang: 'en-US' }],
          });
        }
        if (url.endsWith('/v1/audio/speech')) {
          const body = JSON.parse(String(init?.body)) as { response_format: string };
          speechFormats.push(body.response_format);
          speechInputs.push((JSON.parse(String(init?.body)) as { input: string }).input);
          return speechResponse(body.response_format);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    ({ OpenAITTSClient } = await import('@/services/tts/OpenAITTSClient'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const startClient = async (lookahead: OpenAITTSLookaheadCandidate[] = []) => {
    const controller = {
      dispatchSpeakMark: vi.fn(),
      getOpenAITTSLookahead: vi.fn(async () => lookahead),
    };
    const client = new OpenAITTSClient(controller as unknown as TTSController);
    await expect(client.init()).resolves.toBe(true);
    return { client, controller };
  };

  const collect = (client: InstanceType<OpenAIClientClass>) => {
    const events: TTSMessageEvent[] = [];
    const done = (async () => {
      for await (const event of client.speak('<ssml/>', new AbortController().signal)) {
        events.push(event);
      }
    })();
    return { events, done };
  };

  it('evicts undecodable real Opus, retries the sentence as AAC, then pins AAC', async () => {
    const { client } = await startClient();
    const first = collect(client);
    await vi.waitFor(() => expect(FakeAudioContext.instances[0]?.sources).toHaveLength(1));
    expect(speechFormats).toEqual(['opus', 'aac']);
    await FakeAudioContext.instances[0]!.advanceTo(1);
    await expect(first.done).resolves.toBeUndefined();
    expect(first.events.map((event) => event.code)).toEqual(['boundary', 'end']);

    const second = collect(client);
    await vi.waitFor(() => expect(FakeAudioContext.instances[0]?.sources).toHaveLength(2));
    // The successful AAC bytes are cached and the session remains pinned; no
    // second Opus request or network request is made for the repeated sentence.
    expect(speechFormats).toEqual(['opus', 'aac']);
    await FakeAudioContext.instances[0]!.advanceTo(2);
    await expect(second.done).resolves.toBeUndefined();
  });

  it('falls back on an explicit unsupported-format HTTP response', async () => {
    speechResponse = (format) =>
      format === 'opus'
        ? new Response('Unsupported response_format opus', {
            status: 415,
            statusText: 'Unsupported Media Type',
          })
        : new Response(new Uint8Array([0xaa]), {
            status: 200,
            headers: { 'Content-Type': 'audio/mp4' },
          });
    const { client } = await startClient();
    const { done } = collect(client);

    await vi.waitFor(() => expect(FakeAudioContext.instances[0]?.sources).toHaveLength(1));
    expect(speechFormats).toEqual(['opus', 'aac']);
    await FakeAudioContext.instances[0]!.advanceTo(1);
    await expect(done).resolves.toBeUndefined();
  });

  it('surfaces authentication failure as a session error without downgrading', async () => {
    speechResponse = () =>
      new Response('bad credentials', { status: 401, statusText: 'Unauthorized' });
    const { client } = await startClient();
    const { done } = collect(client);

    await expect(done).rejects.toThrow(/401 Unauthorized/);
    expect(speechFormats).toEqual(['opus']);
    expect(FakeAudioContext.instances[0]!.sources).toHaveLength(0);
  });

  it('fills the rolling phone-side buffer after the first real codec is pinned', async () => {
    const lookahead = Array.from({ length: 15 }, (_, index) => ({
      mark: { offset: index, name: String(index), text: `Ahead ${index}.`, language: 'en' },
      sectionIndex: 0,
      playbackSeconds: 10,
    }));
    const { client, controller } = await startClient(lookahead);
    const { done } = collect(client);

    await vi.waitFor(() => expect(controller.getOpenAITTSLookahead).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(speechInputs.filter((input) => input.startsWith('Ahead '))).toHaveLength(12),
    );
    expect(speechInputs.filter((input) => input.startsWith('Ahead '))).toEqual(
      lookahead.slice(0, 12).map((item) => item.mark.text),
    );
    expect(speechFormats.slice(-12)).toEqual(Array(12).fill('aac'));

    await client.shutdown();
    await expect(done).rejects.toThrow('Aborted');
  });
});
