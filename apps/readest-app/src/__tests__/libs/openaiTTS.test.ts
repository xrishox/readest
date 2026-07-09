import { describe, expect, it } from 'vitest';
import {
  inferVoiceFromId,
  normalizeOpenAITTSEndpoint,
  parseOpenAITTSModelIds,
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
