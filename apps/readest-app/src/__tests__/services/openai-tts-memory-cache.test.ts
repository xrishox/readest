import { describe, expect, it, vi } from 'vitest';
import {
  OPENAI_TTS_AUDIO_CACHE_MAX_BYTES,
  OPENAI_TTS_AUDIO_CACHE_MAX_ENTRIES,
  OPENAI_TTS_AUDIO_CACHE_TTL_MS,
  OpenAITTSAudioMemoryCache,
} from '@/services/tts/openaiTTSAudioCache';

const audio = (size: number) => ({
  bytes: new Uint8Array(size),
  contentType: 'audio/ogg; codecs=opus',
});

describe('OpenAI TTS volatile audio cache', () => {
  it('uses the fixed mobile memory and expiry limits', () => {
    expect(OPENAI_TTS_AUDIO_CACHE_MAX_ENTRIES).toBe(64);
    expect(OPENAI_TTS_AUDIO_CACHE_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(OPENAI_TTS_AUDIO_CACHE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('evicts least-recently-used entries by count and byte size', () => {
    const cache = new OpenAITTSAudioMemoryCache({ maxEntries: 2, maxBytes: 5 });
    cache.set('one', audio(2));
    cache.set('two', audio(2));
    expect(cache.get('one')).toBeDefined();

    cache.set('three', audio(2));
    expect(cache.get('two')).toBeUndefined();
    expect(cache.get('one')).toBeDefined();
    expect(cache.get('three')).toBeDefined();
    expect(cache.byteSize).toBe(4);

    cache.set('large', audio(4));
    expect(cache.get('one')).toBeUndefined();
    expect(cache.get('three')).toBeUndefined();
    expect(cache.get('large')).toBeDefined();
    expect(cache.byteSize).toBe(4);
  });

  it('expires abandoned entries after ten minutes without persistent storage', () => {
    let now = 0;
    const cache = new OpenAITTSAudioMemoryCache({
      maxEntries: 2,
      maxBytes: 10,
      ttlMs: 100,
      now: () => now,
    });
    cache.set('sentence', audio(2));
    now = 99;
    expect(cache.get('sentence')).toBeDefined();
    now = 200;
    expect(cache.get('sentence')).toBeUndefined();
    expect(cache.byteSize).toBe(0);
  });

  it('releases expired bytes without waiting for another cache access', async () => {
    vi.useFakeTimers();
    try {
      const cache = new OpenAITTSAudioMemoryCache({ maxEntries: 2, maxBytes: 10, ttlMs: 100 });
      cache.set('sentence', audio(2));
      expect(cache.byteSize).toBe(2);

      await vi.advanceTimersByTimeAsync(100);

      expect(cache.byteSize).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
