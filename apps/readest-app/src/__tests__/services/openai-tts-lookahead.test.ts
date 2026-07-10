import { describe, expect, it } from 'vitest';
import { collectOpenAITTSLookahead } from '@/services/tts/openaiTTSLookahead';
import { getSentences } from 'foliate-js/tts.js';
import { textWalker } from 'foliate-js/text-walker.js';

const makeDocument = (body: string) => {
  const doc = document.implementation.createHTMLDocument('TTS lookahead test');
  doc.documentElement.lang = 'en';
  doc.body.innerHTML = body;
  return doc;
};

const acceptAll = () => NodeFilter.FILTER_ACCEPT;

describe('OpenAI TTS cross-section lookahead', () => {
  it('starts after the audible sentence and crosses into later sections', async () => {
    const currentDocument = makeDocument(
      '<p>First sentence. Second sentence. Third sentence.</p><p>Fourth sentence.</p>',
    );
    const nextDocument = makeDocument('<p>Fifth sentence. Sixth sentence.</p>');
    const ranges = [...getSentences(currentDocument, textWalker, acceptAll, 'sentence')];
    const currentRange = ranges[1]!.range;

    const result = await collectOpenAITTSLookahead({
      currentDocument,
      currentRange,
      currentSectionIndex: 0,
      sections: [
        { createDocument: async () => currentDocument },
        { createDocument: async () => nextDocument },
      ],
      granularity: 'sentence',
      nodeFilter: acceptAll,
      preprocess: async (ssml) => ssml,
      voiceId: 'voice-1',
      playbackRate: 1,
      signal: new AbortController().signal,
    });

    expect(result.map((candidate) => candidate.mark.text.trim())).toEqual([
      'Third sentence.',
      'Fourth sentence.',
      'Fifth sentence.',
      'Sixth sentence.',
    ]);
    expect(result.map((candidate) => candidate.sectionIndex)).toEqual([0, 0, 1, 1]);
  });

  it('expresses candidate duration in wall-clock playback seconds', async () => {
    const currentDocument = makeDocument('<p>Current sentence. A much longer future sentence.</p>');
    const ranges = [...getSentences(currentDocument, textWalker, acceptAll, 'sentence')];

    const atOne = await collectOpenAITTSLookahead({
      currentDocument,
      currentRange: ranges[0]!.range,
      currentSectionIndex: 0,
      sections: [{ createDocument: async () => currentDocument }],
      granularity: 'sentence',
      nodeFilter: acceptAll,
      preprocess: async (ssml) => ssml,
      voiceId: 'voice-1',
      playbackRate: 1,
      signal: new AbortController().signal,
    });
    const atTwo = await collectOpenAITTSLookahead({
      currentDocument,
      currentRange: ranges[0]!.range,
      currentSectionIndex: 0,
      sections: [{ createDocument: async () => currentDocument }],
      granularity: 'sentence',
      nodeFilter: acceptAll,
      preprocess: async (ssml) => ssml,
      voiceId: 'voice-1',
      playbackRate: 2,
      signal: new AbortController().signal,
    });

    expect(atTwo[0]!.playbackSeconds).toBeCloseTo(atOne[0]!.playbackSeconds / 2);
  });
});
