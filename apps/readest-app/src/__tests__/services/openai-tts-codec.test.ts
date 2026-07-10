import { describe, expect, it, vi } from 'vitest';
import type { OpenAITTSPayload, OpenAITTSResponseFormat } from '@/libs/openaiTTS';
import {
  decodeOpenAITTSAudioWithFallback,
  getOpenAITTSProbeData,
  OPENAI_TTS_FORMAT_ORDER,
  OpenAITTSCodecNegotiator,
} from '@/services/tts/openaiTTSCodec';

const identifyContainer = (data: ArrayBuffer): OpenAITTSResponseFormat => {
  const bytes = new Uint8Array(data);
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (ascii(0, 4) === 'OggS') return 'opus';
  if (ascii(4, 4) === 'ftyp') return 'aac';
  throw new DOMException('Invalid fixture', 'EncodingError');
};

class FakeAudioContext {
  readonly attempted: OpenAITTSResponseFormat[] = [];

  constructor(readonly unsupported = new Set<OpenAITTSResponseFormat>()) {}

  async decodeAudioData(data: ArrayBuffer): Promise<{ format: OpenAITTSResponseFormat }> {
    const format = identifyContainer(data);
    this.attempted.push(format);
    if (this.unsupported.has(format)) throw new DOMException('Unsupported codec', 'EncodingError');
    return { format };
  }
}

const payload = (format: OpenAITTSResponseFormat): OpenAITTSPayload => ({
  model: 'tts-1',
  text: 'Same sentence',
  voice: 'voice-1',
  responseFormat: format,
  speed: 1,
});

describe('OpenAI TTS codec negotiation', () => {
  it('negotiates only compressed Ogg Opus and AAC/M4A streams', () => {
    expect(OPENAI_TTS_FORMAT_ORDER).toEqual(['opus', 'aac']);
    expect(identifyContainer(getOpenAITTSProbeData('opus'))).toBe('opus');
    expect(identifyContainer(getOpenAITTSProbeData('aac'))).toBe('aac');
    expect(getOpenAITTSProbeData('opus').byteLength).toBe(312);
    expect(getOpenAITTSProbeData('aac').byteLength).toBe(4692);
  });

  it('defaults to Opus and pins it after a real stream succeeds', async () => {
    const context = new FakeAudioContext();
    const negotiator = new OpenAITTSCodecNegotiator((data) => context.decodeAudioData(data));

    expect(await negotiator.nextFormat()).toBe('opus');
    expect(context.attempted).toEqual(['opus']);
    negotiator.pin('opus');
    expect(await negotiator.nextFormat()).toBe('opus');
    expect(context.attempted).toEqual(['opus']);
  });

  it('uses AAC when the same AudioContext rejects Ogg Opus', async () => {
    const context = new FakeAudioContext(new Set(['opus']));
    const negotiator = new OpenAITTSCodecNegotiator((data) => context.decodeAudioData(data));

    expect(await negotiator.nextFormat()).toBe('aac');
    expect(context.attempted).toEqual(['opus', 'aac']);
    expect(negotiator.minimumFormat).toBe('aac');
  });

  it('fails clearly when the same AudioContext rejects both compressed containers', async () => {
    const context = new FakeAudioContext(new Set(['opus', 'aac']));
    const negotiator = new OpenAITTSCodecNegotiator((data) => context.decodeAudioData(data));

    await expect(negotiator.nextFormat()).rejects.toThrow(/Opus or AAC/);
    expect(context.attempted).toEqual(['opus', 'aac']);
  });

  it('falls through when decodeAudioData hangs on a container', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const negotiator = new OpenAITTSCodecNegotiator(async (data) => {
        const format = identifyContainer(data);
        context.attempted.push(format);
        if (format === 'opus') return await new Promise(() => {});
        return { format };
      });

      const selected = negotiator.nextFormat();
      await vi.advanceTimersByTimeAsync(2000);
      await expect(selected).resolves.toBe('aac');
      expect(context.attempted).toEqual(['opus', 'aac']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts a real undecodable Opus sentence, refetches it as AAC, and pins AAC', async () => {
    const context = new FakeAudioContext();
    const negotiator = new OpenAITTSCodecNegotiator((data) => context.decodeAudioData(data));
    expect(await negotiator.nextFormat()).toBe('opus');
    const evict = vi.fn();
    const refetch = vi.fn(async () => ({
      format: (await negotiator.nextFormat()) as OpenAITTSResponseFormat,
      payload: payload('aac'),
      audio: { data: new Uint8Array([2]).buffer, contentType: 'audio/mp4' },
    }));
    const realDecode = vi.fn(async (data: ArrayBuffer) => {
      const marker = new Uint8Array(data)[0];
      if (marker === 1) throw new DOMException('Bad Ogg stream', 'EncodingError');
      return { marker };
    });

    const result = await decodeOpenAITTSAudioWithFallback(
      {
        format: 'opus',
        payload: payload('opus'),
        audio: { data: new Uint8Array([1]).buffer, contentType: 'audio/ogg; codecs=opus' },
      },
      { negotiator, decode: realDecode, refetch, evict },
    );

    expect(evict).toHaveBeenCalledOnce();
    expect(evict).toHaveBeenCalledWith(expect.objectContaining({ responseFormat: 'opus' }));
    expect(refetch).toHaveBeenCalledOnce();
    expect(result.fetched.format).toBe('aac');
    expect(result.decoded).toEqual({ marker: 2 });
    expect(negotiator.pinnedFormat).toBe('aac');
    expect(await negotiator.nextFormat()).toBe('aac');
  });

  it('discards an already-fetched stale format after another job advances the ladder', async () => {
    const context = new FakeAudioContext();
    const negotiator = new OpenAITTSCodecNegotiator((data) => context.decodeAudioData(data));
    expect(await negotiator.nextFormat()).toBe('opus');
    negotiator.reject('opus');
    const evict = vi.fn();
    const decode = vi.fn(async () => ({ ok: true }));
    const refetch = vi.fn(async () => ({
      format: (await negotiator.nextFormat()) as OpenAITTSResponseFormat,
      payload: payload('aac'),
      audio: { data: new Uint8Array([2]).buffer, contentType: 'audio/mp4' },
    }));

    const result = await decodeOpenAITTSAudioWithFallback(
      {
        format: 'opus',
        payload: payload('opus'),
        audio: { data: new Uint8Array([1]).buffer, contentType: 'audio/ogg' },
      },
      { negotiator, decode, refetch, evict },
    );

    expect(evict).toHaveBeenCalledWith(expect.objectContaining({ responseFormat: 'opus' }));
    expect(decode).toHaveBeenCalledOnce();
    expect(result.fetched.format).toBe('aac');
  });
});
