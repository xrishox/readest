import { parseSSMLMarks } from '@/utils/ssml';
import { estimateSentenceSeconds } from './ttsDuration';
import type { TTSGranularity, TTSMark } from './types';
import {
  OPENAI_TTS_BUFFER_MAX_SENTENCES,
  OPENAI_TTS_BUFFER_TARGET_SECONDS,
} from './openaiTTSBuffer';

const INTER_SENTENCE_GAP_SECONDS = 0.15;

interface BookSection {
  createDocument?: () => Document | Promise<Document>;
}

interface LookaheadOptions {
  currentDocument: Document;
  currentRange: Range;
  currentSectionIndex: number;
  sections: readonly BookSection[];
  granularity: TTSGranularity;
  nodeFilter: (node: Node) => number;
  preprocess: (ssml: string) => Promise<string | undefined>;
  voiceId: string;
  playbackRate: number;
  signal: AbortSignal;
}

export interface OpenAITTSLookaheadCandidate {
  mark: TTSMark;
  sectionIndex: number;
  playbackSeconds: number;
}

const abortIfNeeded = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('TTS lookahead aborted', 'AbortError');
  }
};

export const collectOpenAITTSLookahead = async (
  options: LookaheadOptions,
): Promise<OpenAITTSLookaheadCandidate[]> => {
  const { TTS } = await import('foliate-js/tts.js');
  const { textWalker } = await import('foliate-js/text-walker.js');
  const candidates: OpenAITTSLookaheadCandidate[] = [];
  let bufferedSeconds = 0;
  const rate = Math.max(0.1, options.playbackRate);

  const addSSML = async (raw: string | undefined, sectionIndex: number, skipFirst = false) => {
    if (!raw) return false;
    abortIfNeeded(options.signal);
    const processed = await options.preprocess(raw);
    abortIfNeeded(options.signal);
    if (!processed) return false;
    const marks = parseSSMLMarks(processed).marks.slice(skipFirst ? 1 : 0);
    for (const mark of marks) {
      const sourceSeconds =
        estimateSentenceSeconds(mark.text, mark.language, options.voiceId) +
        INTER_SENTENCE_GAP_SECONDS;
      const playbackSeconds = sourceSeconds / rate;
      candidates.push({ mark, sectionIndex, playbackSeconds });
      bufferedSeconds += playbackSeconds;
      if (
        candidates.length >= OPENAI_TTS_BUFFER_MAX_SENTENCES ||
        bufferedSeconds >= OPENAI_TTS_BUFFER_TARGET_SECONDS
      ) {
        return true;
      }
    }
    return false;
  };

  const makeShadow = (doc: Document) =>
    new TTS(doc, textWalker, options.nodeFilter, () => {}, options.granularity);

  abortIfNeeded(options.signal);
  const current = makeShadow(options.currentDocument);
  if (await addSSML(current.from(options.currentRange), options.currentSectionIndex, true)) {
    return candidates;
  }
  for (let raw = current.next(); raw; raw = current.next()) {
    if (await addSSML(raw, options.currentSectionIndex)) return candidates;
  }

  for (
    let sectionIndex = options.currentSectionIndex + 1;
    sectionIndex < options.sections.length;
    sectionIndex++
  ) {
    abortIfNeeded(options.signal);
    const section = options.sections[sectionIndex];
    if (!section?.createDocument) continue;
    const doc = await section.createDocument();
    abortIfNeeded(options.signal);
    const html = doc.querySelector('html');
    if (html && !html.getAttribute('lang') && !html.getAttribute('xml:lang')) {
      html.setAttribute('lang', options.currentDocument.documentElement.lang || 'en');
    }
    const shadow = makeShadow(doc);
    for (let raw = shadow.start(); raw; raw = shadow.next()) {
      if (await addSSML(raw, sectionIndex)) return candidates;
    }
  }

  return candidates;
};
