import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getOpenAITTSCacheKey,
  OpenAISpeechTTS,
  OpenAITTSPayload,
  OpenAITTSRequestError,
} from '@/libs/openaiTTS';

const payload = (text: string, responseFormat: OpenAITTSPayload['responseFormat'] = 'opus') => ({
  model: 'tts-1',
  text,
  voice: 'voice-1',
  responseFormat,
  speed: 1,
});

const audioResponse = (bytes: number[], contentType = 'audio/ogg; codecs=opus') =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': contentType } });

describe('OpenAISpeechTTS transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the real response content type and supports bounded-cache eviction', async () => {
    const fetchMock = vi.fn(async () => audioResponse([1, 2, 3], 'audio/mp4; codecs=mp4a.40.2'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new OpenAISpeechTTS('https://content-type.example/v1/', 'key-a');
    const request = payload('content-type-test', 'aac');

    const first = await client.createAudioData(request);
    const cached = await client.createAudioData(request);

    expect(first.contentType).toBe('audio/mp4; codecs=mp4a.40.2');
    expect([...new Uint8Array(first.data)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(cached.data)]).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(client.evictAudio(request)).toBe(true);
    await client.createAudioData(request);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('isolates cache entries by normalized endpoint, auth fingerprint, and format', async () => {
    let responseByte = 0;
    const fetchMock = vi.fn(async () => audioResponse([++responseByte]));
    vi.stubGlobal('fetch', fetchMock);
    const request = payload('cache-isolation');
    const endpointA = new OpenAISpeechTTS('https://cache-a.example/v1/', 'secret-a');
    const endpointANormalized = new OpenAISpeechTTS('https://cache-a.example', 'secret-a');
    const endpointB = new OpenAISpeechTTS('https://cache-b.example', 'secret-a');
    const authB = new OpenAISpeechTTS('https://cache-a.example', 'secret-b');

    await endpointA.createAudioData(request);
    await endpointANormalized.createAudioData(request);
    await endpointB.createAudioData(request);
    await authB.createAudioData(request);
    await endpointA.createAudioData({ ...request, responseFormat: 'aac' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const key = getOpenAITTSCacheKey('https://cache-a.example', 'secret-a', request);
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(key).not.toContain('secret-a');
    expect(getOpenAITTSCacheKey('https://cache-a.example/v1/', 'secret-a', request)).toBe(key);
    expect(getOpenAITTSCacheKey('https://cache-a.example', 'secret-b', request)).not.toBe(key);
  });

  it('evicts the least-recently-used audio when the 200-entry cache is full', async () => {
    const fetchMock = vi.fn(async () => audioResponse([1]));
    vi.stubGlobal('fetch', fetchMock);
    const client = new OpenAISpeechTTS('https://bounded-cache.example', 'key');

    for (let index = 0; index <= 200; index++) {
      await client.createAudioData(payload(`bounded-${index}`));
    }
    expect(fetchMock).toHaveBeenCalledTimes(201);

    await client.createAudioData(payload('bounded-200'));
    expect(fetchMock).toHaveBeenCalledTimes(201);
    await client.createAudioData(payload('bounded-0'));
    expect(fetchMock).toHaveBeenCalledTimes(202);
  });

  it('lets one shared consumer abort without cancelling the remaining consumer', async () => {
    let release!: (response: Response) => void;
    let underlyingSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((resolve, reject) => {
          release = resolve;
          underlyingSignal = init?.signal ?? undefined;
          underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal?.reason));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new OpenAISpeechTTS('https://shared-cancel.example', 'key');
    const request = payload('shared-cancel');
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = client.createAudioData(request, firstController.signal);
    const second = client.createAudioData(request, secondController.signal);
    firstController.abort(new DOMException('first left', 'AbortError'));

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(underlyingSignal?.aborted).toBe(false);
    release(audioResponse([7, 8, 9]));
    await expect(second).resolves.toMatchObject({ contentType: 'audio/ogg; codecs=opus' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the shared HTTP request after its final consumer leaves', async () => {
    let underlyingSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          underlyingSignal = init?.signal ?? undefined;
          underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal?.reason));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new OpenAISpeechTTS('https://last-cancel.example', 'key');
    const controller = new AbortController();

    const request = client.createAudioData(payload('last-cancel'), controller.signal);
    controller.abort(new DOMException('all consumers left', 'AbortError'));

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(underlyingSignal?.aborted).toBe(true));
  });

  it('returns structured errors and only classifies explicit format rejection as fallback-safe', async () => {
    const responses = [
      new Response('unsupported response_format opus', { status: 415, statusText: 'Unsupported' }),
      new Response('bad credentials', { status: 401, statusText: 'Unauthorized' }),
      new Response('slow down', { status: 429, statusText: 'Too Many Requests' }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift()!),
    );
    const client = new OpenAISpeechTTS('https://errors.example', 'key');

    const unsupported = await client
      .createAudioData(payload('unsupported'))
      .catch((error) => error);
    const auth = await client.createAudioData(payload('auth')).catch((error) => error);
    const throttled = await client.createAudioData(payload('throttled')).catch((error) => error);

    expect(unsupported).toBeInstanceOf(OpenAITTSRequestError);
    expect(unsupported).toMatchObject({ status: 415, responseFormat: 'opus' });
    expect((unsupported as OpenAITTSRequestError).isUnsupportedFormat).toBe(true);
    expect((auth as OpenAITTSRequestError).isUnsupportedFormat).toBe(false);
    expect((auth as OpenAITTSRequestError).isRetryable).toBe(false);
    expect((auth as OpenAITTSRequestError).isSkippableInput).toBe(false);
    expect((throttled as OpenAITTSRequestError).isUnsupportedFormat).toBe(false);
    expect((throttled as OpenAITTSRequestError).isRetryable).toBe(true);
    expect((throttled as OpenAITTSRequestError).isSkippableInput).toBe(false);

    const invalidSentence = new OpenAITTSRequestError({
      status: 422,
      statusText: 'Unprocessable Content',
      body: 'The input text is empty',
      responseFormat: 'opus',
    });
    const unsupportedAt400 = new OpenAITTSRequestError({
      status: 400,
      statusText: 'Bad Request',
      body: 'Unsupported response_format opus',
      responseFormat: 'opus',
    });
    const invalidModel = new OpenAITTSRequestError({
      status: 400,
      statusText: 'Bad Request',
      body: 'Unknown model tts-missing',
      responseFormat: 'opus',
    });
    expect(invalidSentence.isSkippableInput).toBe(true);
    expect(unsupportedAt400.isUnsupportedFormat).toBe(true);
    expect(unsupportedAt400.isSkippableInput).toBe(false);
    expect(invalidModel.isSkippableInput).toBe(false);
  });

  it('connection verification synthesizes and decodes through the codec fallback ladder', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { response_format: string };
      if (body.response_format === 'opus') {
        return audioResponse([1], 'audio/ogg; codecs=opus');
      }
      return audioResponse([2], 'audio/mp4; codecs=mp4a.40.2');
    });
    vi.stubGlobal('fetch', fetchMock);
    const decode = vi.fn(async (data: ArrayBuffer) => {
      if (new Uint8Array(data)[0] === 1) throw new Error('Opus unavailable');
    });
    const client = new OpenAISpeechTTS('https://verification.example');

    await expect(client.verifySynthesis('tts-1', 'voice-1', decode)).resolves.toBe('aac');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(
        (call) =>
          (JSON.parse(String(call[1]?.body)) as { response_format: string }).response_format,
      ),
    ).toEqual(['opus', 'aac']);
  });
});
