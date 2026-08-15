// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForOptimisticSendPaint } from './composerSendPaint';

describe('waitForOptimisticSendPaint', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for two animation frames before allowing send setup to continue', async () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    let resolved = false;
    const waitPromise = waitForOptimisticSendPaint({ frameCount: 2, timeoutMs: 10_000 }).then(() => {
      resolved = true;
    });

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    callbacks.shift()?.(16);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    callbacks.shift()?.(32);
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it('keeps the timeout fallback inside the 300ms feedback budget without preempting a near-term paint', async () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);

    let resolved = false;
    const waitPromise = waitForOptimisticSendPaint().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(31);
    await waitPromise;
    expect(resolved).toBe(true);
  });
});
