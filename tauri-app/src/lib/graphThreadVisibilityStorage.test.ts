import { beforeEach, describe, expect, it } from 'vitest';
import {
  getGraphThreadVisibilityStorageKey,
  pruneHiddenThreadRootIds,
  readHiddenThreadRootIds,
} from './graphThreadVisibilityStorage';

const sorted = (ids: Set<string>) => Array.from(ids).sort();

const installMemoryLocalStorage = () => {
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  });
};

describe('graph thread visibility storage', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
  });

  it('ignores corrupt payloads and non-string ids', () => {
    window.localStorage.setItem(
      getGraphThreadVisibilityStorageKey('workspace-a'),
      JSON.stringify({ hiddenThreadRootIds: ['thread-a', 42, '', null, 'thread-b'] }),
    );
    window.localStorage.setItem(getGraphThreadVisibilityStorageKey('workspace-b'), '{not-json');

    expect(sorted(readHiddenThreadRootIds('workspace-a'))).toEqual(['thread-a', 'thread-b']);
    expect(sorted(readHiddenThreadRootIds('workspace-b'))).toEqual([]);
  });

  it('prunes hidden ids that are no longer thread roots', () => {
    expect(sorted(pruneHiddenThreadRootIds(
      new Set(['thread-a', 'thread-stale', 'thread-b']),
      ['thread-b', 'thread-c'],
    ))).toEqual(['thread-b']);
  });
});
