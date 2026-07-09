import { describe, expect, it } from 'vitest';
import {
  compareVoiceQuality,
  inferVoiceFromId,
  normalizeOpenAITTSEndpoint,
  parseOpenAITTSModelIds,
  parseOpenAITTSVoicesAll,
} from '@/libs/openaiTTS';

describe('normalizeOpenAITTSEndpoint', () => {
  it('strips trailing slashes', () => {
    expect(normalizeOpenAITTSEndpoint('http://mac:8787/')).toBe('http://mac:8787');
    expect(normalizeOpenAITTSEndpoint('http://mac:8787//')).toBe('http://mac:8787');
  });

  it('strips a trailing /v1 with or without a slash', () => {
    expect(normalizeOpenAITTSEndpoint('http://mac:8787/v1')).toBe('http://mac:8787');
    expect(normalizeOpenAITTSEndpoint('http://mac:8787/v1/')).toBe('http://mac:8787');
  });

  it('trims whitespace and keeps plain endpoints untouched', () => {
    expect(normalizeOpenAITTSEndpoint('  http://localhost:8787 ')).toBe('http://localhost:8787');
    expect(normalizeOpenAITTSEndpoint('https://tts.example.com')).toBe('https://tts.example.com');
  });
});

describe('inferVoiceFromId', () => {
  it('parses Apple-style voice identifiers', () => {
    expect(inferVoiceFromId('com.apple.voice.premium.en-US.Zoe')).toEqual({
      id: 'com.apple.voice.premium.en-US.Zoe',
      name: 'Zoe',
      lang: 'en-US',
      quality: 'premium',
    });
    expect(inferVoiceFromId('com.apple.voice.super-compact.ar-001.Maged')).toEqual({
      id: 'com.apple.voice.super-compact.ar-001.Maged',
      name: 'Maged',
      lang: 'ar-001',
      quality: 'super-compact',
    });
  });

  it('parses other Apple identifiers with an embedded locale', () => {
    expect(inferVoiceFromId('com.apple.eloquence.en-GB.Eddy')).toEqual({
      id: 'com.apple.eloquence.en-GB.Eddy',
      name: 'Eddy',
      lang: 'en-GB',
    });
  });

  it('parses Kokoro-style ids', () => {
    expect(inferVoiceFromId('af_heart')).toEqual({
      id: 'af_heart',
      name: 'Heart',
      lang: 'en-US',
    });
    expect(inferVoiceFromId('bm_george')).toEqual({
      id: 'bm_george',
      name: 'George',
      lang: 'en-GB',
    });
  });

  it('falls back to the raw id', () => {
    expect(inferVoiceFromId('some-voice')).toEqual({
      id: 'some-voice',
      name: 'some-voice',
      lang: 'en-US',
    });
  });
});

describe('compareVoiceQuality', () => {
  it('orders premium before enhanced before everything else', () => {
    const voices = [
      { quality: undefined },
      { quality: 'default' },
      { quality: 'premium' },
      { quality: 'enhanced' },
      { quality: 'super-compact' },
    ];
    const sorted = [...voices].sort(compareVoiceQuality);
    expect(sorted.map((v) => v.quality)).toEqual([
      'premium',
      'enhanced',
      undefined,
      'default',
      'super-compact',
    ]);
  });

  it('is stable (returns 0) within the same tier', () => {
    expect(compareVoiceQuality({ quality: 'default' }, { quality: 'compact' })).toBe(0);
    expect(compareVoiceQuality({ quality: 'premium' }, { quality: 'premium' })).toBe(0);
  });
});

describe('parseOpenAITTSModelIds', () => {
  it('extracts ids from an OpenAI-style model list', () => {
    expect(
      parseOpenAITTSModelIds({
        object: 'list',
        data: [
          { id: 'tts-1', object: 'model' },
          { id: 'tts-1-hd', object: 'model' },
        ],
      }),
    ).toEqual(['tts-1', 'tts-1-hd']);
  });

  it('ignores malformed entries', () => {
    expect(
      parseOpenAITTSModelIds({ data: [{ id: 'tts-1' }, { id: 42 }, 'nope', null, {}] }),
    ).toEqual(['tts-1']);
  });

  it('returns empty for non-list payloads', () => {
    expect(parseOpenAITTSModelIds(null)).toEqual([]);
    expect(parseOpenAITTSModelIds({})).toEqual([]);
    expect(parseOpenAITTSModelIds({ data: 'x' })).toEqual([]);
  });
});

describe('parseOpenAITTSVoicesAll', () => {
  it('derives quality from Apple-style ids when the server omits it', () => {
    expect(
      parseOpenAITTSVoicesAll({
        voices: [
          { id: 'com.apple.voice.premium.en-US.Zoe', name: 'Zoe', lang: 'en-US' },
          { id: 'com.apple.voice.enhanced.ar-001.Majed', name: 'Majed', lang: 'ar-001' },
          { id: 'com.apple.voice.super-compact.ar-001.Maged', name: 'Maged', lang: 'ar-001' },
          { id: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', lang: 'en-US' },
        ],
      }).map((v) => v.quality),
    ).toEqual(['premium', 'enhanced', 'super-compact', 'compact']);
  });

  it('keeps a meaningful server-provided quality over the id-derived one', () => {
    expect(
      parseOpenAITTSVoicesAll({
        voices: [
          {
            id: 'com.apple.voice.compact.en-US.Sam',
            name: 'Sam',
            lang: 'en-US',
            quality: 'premium',
          },
        ],
      })[0]!.quality,
    ).toBe('premium');
  });

  it("derives from the id when the server reports a blanket 'default'", () => {
    // Real-world shape: macos-speech-server sends quality='default' for every
    // voice, including ones whose Apple id encodes a real tier.
    expect(
      parseOpenAITTSVoicesAll({
        voices: [
          {
            id: 'com.apple.voice.premium.en-US.Zoe',
            name: 'Zoe',
            lang: 'en-US',
            quality: 'default',
          },
          { id: 'af_heart', name: 'Heart', lang: 'en-US', quality: 'default' },
        ],
      }).map((v) => v.quality),
    ).toEqual(['premium', 'default']);
  });

  it('leaves quality undefined for ids that encode no tier', () => {
    expect(
      parseOpenAITTSVoicesAll({ voices: [{ id: 'af_heart', name: 'Heart', lang: 'en-US' }] })[0]!
        .quality,
    ).toBeUndefined();
  });

  it('filters bare strings and malformed entries so callers fall back to the flat list', () => {
    expect(
      parseOpenAITTSVoicesAll({
        voices: ['com.apple.voice.premium.en-US.Zoe', { id: 'x' }, null, 42],
      }),
    ).toEqual([]);
    expect(parseOpenAITTSVoicesAll(null)).toEqual([]);
    expect(parseOpenAITTSVoicesAll({})).toEqual([]);
  });
});
