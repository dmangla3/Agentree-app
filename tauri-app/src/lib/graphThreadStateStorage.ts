import { getGraphThreadVisibilityStorageKey, readHiddenThreadRootIds } from './graphThreadVisibilityStorage';

const GRAPH_THREAD_STATE_STORAGE_PREFIX = 'agentree.graph-thread-state.v1';

export interface GraphThreadState {
  activeThreadRootId: string | null;
  doneThreadRootIds: Set<string>;
  doneThreadsCollapsed: boolean;
  threadBarCollapsed: boolean;
  lastVisitedAtByThreadRootId: Map<string, number>;
}

export const EMPTY_GRAPH_THREAD_STATE: GraphThreadState = {
  activeThreadRootId: null,
  doneThreadRootIds: new Set(),
  doneThreadsCollapsed: true,
  threadBarCollapsed: false,
  lastVisitedAtByThreadRootId: new Map(),
};

const createEmptyGraphThreadState = (): GraphThreadState => ({
  activeThreadRootId: null,
  doneThreadRootIds: new Set(),
  doneThreadsCollapsed: true,
  threadBarCollapsed: false,
  lastVisitedAtByThreadRootId: new Map(),
});

export const getGraphThreadStateStorageKey = (workspaceId: string): string => (
  `${GRAPH_THREAD_STATE_STORAGE_PREFIX}.workspace.${workspaceId}`
);

const normalizeString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

const normalizeStringSet = (value: unknown): Set<string> => {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0));
};

const normalizeNumberMap = (value: unknown): Map<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => (
      entry[0].trim().length > 0 &&
      typeof entry[1] === 'number' &&
      Number.isFinite(entry[1]) &&
      entry[1] > 0
    ));
  return new Map(entries);
};

export const pruneGraphThreadState = (
  state: GraphThreadState,
  availableThreadRootIds: Iterable<string>,
): GraphThreadState => {
  const available = new Set(availableThreadRootIds);
  const activeThreadRootId = state.activeThreadRootId && available.has(state.activeThreadRootId)
    ? state.activeThreadRootId
    : null;
  return {
    activeThreadRootId,
    doneThreadRootIds: new Set(Array.from(state.doneThreadRootIds).filter((threadRootId) => available.has(threadRootId))),
    doneThreadsCollapsed: state.doneThreadsCollapsed,
    threadBarCollapsed: state.threadBarCollapsed,
    lastVisitedAtByThreadRootId: new Map(
      Array.from(state.lastVisitedAtByThreadRootId.entries())
        .filter(([threadRootId]) => available.has(threadRootId)),
    ),
  };
};

export const readGraphThreadState = (
  workspaceId: string | null | undefined,
  availableThreadRootIds?: Iterable<string>,
): GraphThreadState => {
  if (!workspaceId || typeof window === 'undefined') return createEmptyGraphThreadState();

  try {
    const raw = window.localStorage.getItem(getGraphThreadStateStorageKey(workspaceId));
    if (raw) {
      const parsed = JSON.parse(raw) as {
        activeThreadRootId?: unknown;
        doneThreadRootIds?: unknown;
        doneThreadsCollapsed?: unknown;
        threadBarCollapsed?: unknown;
        lastVisitedAtByThreadRootId?: unknown;
      };
      const state = {
        activeThreadRootId: normalizeString(parsed.activeThreadRootId),
        doneThreadRootIds: normalizeStringSet(parsed.doneThreadRootIds),
        doneThreadsCollapsed: parsed.doneThreadsCollapsed !== false,
        threadBarCollapsed: parsed.threadBarCollapsed === true,
        lastVisitedAtByThreadRootId: normalizeNumberMap(parsed.lastVisitedAtByThreadRootId),
      };
      return availableThreadRootIds ? pruneGraphThreadState(state, availableThreadRootIds) : state;
    }

    const migratedDoneThreadRootIds = readHiddenThreadRootIds(workspaceId, availableThreadRootIds);
    if (migratedDoneThreadRootIds.size === 0) return createEmptyGraphThreadState();
    return {
      activeThreadRootId: null,
      doneThreadRootIds: migratedDoneThreadRootIds,
      doneThreadsCollapsed: true,
      threadBarCollapsed: false,
      lastVisitedAtByThreadRootId: new Map(),
    };
  } catch {
    return createEmptyGraphThreadState();
  }
};

export const rememberGraphThreadState = (
  workspaceId: string | null | undefined,
  state: GraphThreadState,
): void => {
  if (!workspaceId || typeof window === 'undefined') return;

  try {
    const key = getGraphThreadStateStorageKey(workspaceId);
    const hasState = Boolean(state.activeThreadRootId) ||
      state.doneThreadRootIds.size > 0 ||
      state.doneThreadsCollapsed === false ||
      state.threadBarCollapsed === true ||
      state.lastVisitedAtByThreadRootId.size > 0;
    if (!hasState) {
      window.localStorage.removeItem(key);
      window.localStorage.removeItem(getGraphThreadVisibilityStorageKey(workspaceId));
      return;
    }

    window.localStorage.setItem(key, JSON.stringify({
      activeThreadRootId: state.activeThreadRootId,
      doneThreadRootIds: Array.from(state.doneThreadRootIds).sort(),
      doneThreadsCollapsed: state.doneThreadsCollapsed,
      threadBarCollapsed: state.threadBarCollapsed,
      lastVisitedAtByThreadRootId: Object.fromEntries(
        Array.from(state.lastVisitedAtByThreadRootId.entries())
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    }));
    window.localStorage.removeItem(getGraphThreadVisibilityStorageKey(workspaceId));
  } catch {
    // Thread state is a best-effort local preference.
  }
};
