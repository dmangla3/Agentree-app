import { describe, expect, it, vi } from 'vitest';
import { ComposerSendAcceptanceQueue } from './composerSendAcceptanceQueue';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('ComposerSendAcceptanceQueue', () => {
  it('starts the next send after durable acceptance without waiting for runtime launch completion', async () => {
    const queue = new ComposerSendAcceptanceQueue<{ prompt: string }, string>();
    const firstLaunch = deferred<string>();
    const secondLaunch = deferred<string>();
    const started: string[] = [];
    let acceptFirst!: () => void;

    const first = queue.submit({ prompt: 'first' }, async (snapshot, accepted) => {
      started.push(snapshot.prompt);
      acceptFirst = accepted;
      return firstLaunch.promise;
    }, 'send-1');
    const second = queue.submit({ prompt: 'second' }, async (snapshot, accepted) => {
      started.push(snapshot.prompt);
      accepted();
      return secondLaunch.promise;
    }, 'send-2');

    await vi.waitFor(() => expect(started).toEqual(['first']));
    expect(first.queued).toBe(false);
    expect(second.queued).toBe(true);
    expect(queue.getState()).toEqual({ acceptingId: 'send-1', queuedCount: 1 });

    acceptFirst();
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    expect(queue.getState()).toEqual({ acceptingId: null, queuedCount: 0 });

    secondLaunch.resolve('second-done');
    firstLaunch.resolve('first-done');
    await expect(first.completion).resolves.toBe('first-done');
    await expect(second.completion).resolves.toBe('second-done');
  });

  it('releases acceptance when a send fails before it can acknowledge persistence', async () => {
    const queue = new ComposerSendAcceptanceQueue<string>();
    const started: string[] = [];
    const first = queue.submit('first', async (snapshot) => {
      started.push(snapshot);
      throw new Error('persistence failed');
    }, 'send-1');
    const second = queue.submit('second', async (snapshot, accepted) => {
      started.push(snapshot);
      accepted();
    }, 'send-2');

    await expect(first.completion).rejects.toThrow('persistence failed');
    await expect(second.completion).resolves.toBeUndefined();
    expect(started).toEqual(['first', 'second']);
    expect(queue.getState()).toEqual({ acceptingId: null, queuedCount: 0 });
  });

  it('reports queue state changes for compact composer feedback', async () => {
    const queue = new ComposerSendAcceptanceQueue<string>();
    const launch = deferred<void>();
    const states: Array<{ acceptingId: string | null; queuedCount: number }> = [];
    const unsubscribe = queue.subscribe((state) => states.push(state));
    let accepted!: () => void;

    const handle = queue.submit('first', async (_snapshot, release) => {
      accepted = release;
      return launch.promise;
    }, 'send-1');

    await vi.waitFor(() => expect(queue.getState().acceptingId).toBe('send-1'));
    accepted();
    launch.resolve();
    await handle.completion;
    unsubscribe();

    expect(states).toContainEqual({ acceptingId: 'send-1', queuedCount: 0 });
    expect(states[states.length - 1]).toEqual({ acceptingId: null, queuedCount: 0 });
  });
});
