import { describe, expect, it, vi } from 'vitest';
import {
  OPENAI_TTS_MAX_FETCHES,
  OpenAITTSOrderedWindow,
  OpenAITTSTaskPool,
} from '@/services/tts/openaiTTSWindow';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('OpenAI TTS ordered fetch window', () => {
  it('starts current plus nine, admits one per consumed item, and returns source order', async () => {
    const items = Array.from({ length: 15 }, (_, index) => index);
    const gates = items.map(() => deferred<string>());
    const started: number[] = [];
    const controller = new AbortController();
    const window = new OpenAITTSOrderedWindow({
      items,
      signal: controller.signal,
      load: async (_item, index) => {
        started.push(index);
        return gates[index]!.promise;
      },
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(window.outstandingCount).toBe(OPENAI_TTS_MAX_FETCHES);

    gates[9]!.resolve('nine');
    let firstSettled = false;
    const first = window.next().finally(() => {
      firstSettled = true;
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    gates[0]!.resolve('zero');
    await expect(first).resolves.toEqual({ index: 0, item: 0, value: 'zero' });
    await vi.waitFor(() => expect(started).toContain(10));
    expect(window.outstandingCount).toBe(OPENAI_TTS_MAX_FETCHES);

    gates[1]!.resolve('one');
    await expect(window.next()).resolves.toEqual({ index: 1, item: 1, value: 'one' });
    controller.abort();
  });

  it('stops admitting stale jobs and rejects the next ordered result on cancellation', async () => {
    const controller = new AbortController();
    const pool = new OpenAITTSTaskPool(2);
    let started = 0;
    const window = new OpenAITTSOrderedWindow({
      items: Array.from({ length: 20 }, (_, index) => index),
      signal: controller.signal,
      load: (_item) =>
        pool.run(
          async () => {
            started++;
            return await new Promise<number>((_resolve, reject) => {
              controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
                once: true,
              });
            });
          },
          controller.signal,
          'playback',
        ),
    });

    const next = window.next();
    await vi.waitFor(() => expect(started).toBe(2));
    controller.abort(new DOMException('stale generation', 'AbortError'));

    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(pool.activeCount).toBe(0));
    expect(started).toBe(2);
  });
});

describe('OpenAI TTS task pool', () => {
  it('never exceeds ten active fetch jobs', async () => {
    const pool = new OpenAITTSTaskPool();
    const controller = new AbortController();
    const gates = Array.from({ length: 25 }, () => deferred<void>());
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const jobs = gates.map((gate) =>
      pool.run(
        async () => {
          started++;
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            await gate.promise;
          } finally {
            active--;
          }
        },
        controller.signal,
        'playback',
      ),
    );

    await vi.waitFor(() => expect(started).toBe(10));
    expect(maxActive).toBe(10);
    gates.slice(0, 10).forEach((gate) => gate.resolve());
    await vi.waitFor(() => expect(started).toBe(20));
    expect(maxActive).toBe(10);
    gates.slice(10, 20).forEach((gate) => gate.resolve());
    await vi.waitFor(() => expect(started).toBe(25));
    gates.slice(20).forEach((gate) => gate.resolve());

    await Promise.all(jobs);
    expect(maxActive).toBe(10);
    expect(pool.activeCount).toBe(0);
  });

  it('starts queued playback before queued preload work', async () => {
    const pool = new OpenAITTSTaskPool(1);
    const controller = new AbortController();
    const firstGate = deferred<void>();
    const order: string[] = [];
    const first = pool.run(
      async () => {
        order.push('active-preload');
        await firstGate.promise;
      },
      controller.signal,
      'preload',
    );
    const secondPreload = pool.run(
      async () => {
        order.push('queued-preload');
      },
      controller.signal,
      'preload',
    );
    const playback = pool.run(
      async () => {
        order.push('playback');
      },
      controller.signal,
      'playback',
    );

    await vi.waitFor(() => expect(order).toEqual(['active-preload']));
    firstGate.resolve();
    await Promise.all([first, secondPreload, playback]);
    expect(order).toEqual(['active-preload', 'playback', 'queued-preload']);
  });
});
