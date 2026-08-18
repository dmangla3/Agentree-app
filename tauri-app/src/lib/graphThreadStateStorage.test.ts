// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGraphThreadStateStorageKey,
  pruneGraphThreadState,
  readGraphThreadState,
  rememberGraphThreadState,
} from './graphThreadStateStorage';

const installLocalStorage = () => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      }),
      clear: vi.fn(() => values.clear()),
      key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
      get length() {
        return values.size;
      },
    },
  });
};

describe('graph thread state storage', () => {
  beforeEach(() => {
    installLocalStorage();
  });

  it('round trips active and done thread state', () => {
    rememberGraphThreadState('workspace-1', {
      activeThreadRootId: 'thread-b',
      doneThreadRootIds: new Set(['thread-a']),
      doneThreadsCollapsed: true,
      threadBarCollapsed: true,
      lastVisitedAtByThreadRootId: new Map([['thread-b', 1770000000000]]),
    });

    expect(readGraphThreadState('workspace-1')).toEqual({
      activeThreadRootId: 'thread-b',
      doneThreadRootIds: new Set(['thread-a']),
      doneThreadsCollapsed: true,
      threadBarCollapsed: true,
      lastVisitedAtByThreadRootId: new Map([['thread-b', 1770000000000]]),
    });
  });

  it('prunes unavailable active and done thread ids', () => {
    expect(pruneGraphThreadState({
      activeThreadRootId: 'thread-x',
      doneThreadRootIds: new Set(['thread-a', 'thread-x']),
      doneThreadsCollapsed: true,
      threadBarCollapsed: true,
      lastVisitedAtByThreadRootId: new Map([
        ['thread-a', 1770000000000],
        ['thread-x', 1770000001000],
      ]),
    }, ['thread-a', 'thread-b'])).toEqual({
      activeThreadRootId: null,
      doneThreadRootIds: new Set(['thread-a']),
      doneThreadsCollapsed: true,
      threadBarCollapsed: true,
      lastVisitedAtByThreadRootId: new Map([['thread-a', 1770000000000]]),
    });
  });

  it('migrates old hidden thread ids to done thread ids', () => {
    window.localStorage.setItem(
      'agentree.graph-thread-visibility.v1.workspace.workspace-1',
      JSON.stringify({ hiddenThreadRootIds: ['thread-a'] }),
    );

    expect(readGraphThreadState('workspace-1')).toEqual({
      activeThreadRootId: null,
      doneThreadRootIds: new Set(['thread-a']),
      doneThreadsCollapsed: true,
      threadBarCollapsed: false,
      lastVisitedAtByThreadRootId: new Map(),
    });
  });

  it('removes empty state records', () => {
    rememberGraphThreadState('workspace-1', {
      activeThreadRootId: null,
      doneThreadRootIds: new Set(),
      doneThreadsCollapsed: true,
      threadBarCollapsed: false,
      lastVisitedAtByThreadRootId: new Map(),
    });

    expect(window.localStorage.getItem(getGraphThreadStateStorageKey('workspace-1'))).toBeNull();
  });
});
