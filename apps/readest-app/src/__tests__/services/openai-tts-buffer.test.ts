import { describe, expect, it, vi } from 'vitest';
import {
  OPENAI_TTS_BUFFER_MAX_BACKGROUND,
  OPENAI_TTS_BUFFER_MAX_SENTENCES,
  OPENAI_TTS_BUFFER_TARGET_SECONDS,
  OpenAITTSResilienceBuffer,
  selectOpenAITTSBufferCandidates,
} from '@/services/tts/openaiTTSBuffer';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const candidates = (count: number, playbackSeconds: number) =>
  Array.from({ length: count }, (_, index) => ({
    key: `sentence-${index}`,
    value: index,
    playbackSeconds,
  }));

describe('OpenAI TTS resilience buffer', () => {
  it('targets two wall-clock minutes but never exceeds fifty sentences', () => {
    expect(OPENAI_TTS_BUFFER_TARGET_SECONDS).toBe(120);
    expect(OPENAI_TTS_BUFFER_MAX_SENTENCES).toBe(50);
    expect(selectOpenAITTSBufferCandidates(candidates(100, 10))).toHaveLength(12);
    expect(selectOpenAITTSBufferCandidates(candidates(100, 1))).toHaveLength(50);
  });

  it('continuously admits source-ordered work with nine background requests', async () => {
    expect(OPENAI_TTS_BUFFER_MAX_BACKGROUND).toBe(9);
    const gates = Array.from({ length: 15 }, deferred);
    const started: number[] = [];
    const buffer = new OpenAITTSResilienceBuffer<number>({
      load: async (item) => {
        started.push(item.value);
        await gates[item.value]!.promise;
      },
      evict: vi.fn(),
    });

    buffer.reconcile(candidates(15, 10));
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    gates[8]!.resolve();
    await vi.waitFor(() => expect(started).toContain(9));
    gates[0]!.resolve();
    await vi.waitFor(() => expect(started).toContain(10));
    buffer.stop();
  });

  it('keeps only the previous ten consumed sentences for replay', () => {
    const evict = vi.fn();
    const buffer = new OpenAITTSResilienceBuffer<number>({
      load: async () => {},
      evict,
    });
    const items = candidates(12, 10);
    buffer.reconcile(items);
    for (const item of items) buffer.consume(item.key);

    expect(buffer.replayTail).toEqual(items.slice(2).map((item) => item.key));
    expect(evict).toHaveBeenCalledWith(items[0]);
    expect(evict).toHaveBeenCalledWith(items[1]);
    buffer.stop();
  });

  it('cancels stale future work when the reading horizon changes', async () => {
    const aborted: string[] = [];
    const buffer = new OpenAITTSResilienceBuffer<number>({
      load: async (item, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted.push(item.key);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      evict: vi.fn(),
    });
    buffer.reconcile(candidates(12, 10));
    buffer.reconcile(candidates(2, 10).map((item) => ({ ...item, key: `new-${item.key}` })));

    await vi.waitFor(() => expect(aborted).toHaveLength(9));
    buffer.stop();
  });
});
