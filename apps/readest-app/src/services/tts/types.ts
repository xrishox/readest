export type TTSGranularity = 'sentence' | 'word';

export type TTSHighlightGranularity = 'word' | 'sentence';

export type TTSMediaMetadataMode = 'sentence' | 'paragraph' | 'chapter';

export type TTSHighlightOptions = {
  style: 'highlight' | 'underline' | 'strikethrough' | 'squiggly' | 'outline';
  color: string;
};

export type TTSVoice = {
  id: string;
  name: string;
  lang: string;
  disabled?: boolean;
  /** Above-default quality tier, shown as a badge in the voice picker. */
  quality?: 'premium' | 'enhanced';
};

export type TTSVoicesGroup = {
  id: string;
  name: string;
  voices: TTSVoice[];
  disabled?: boolean;
};

export type TTSMark = {
  offset: number;
  name: string;
  text: string;
  language: string;
};
