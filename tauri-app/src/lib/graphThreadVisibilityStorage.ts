const GRAPH_THREAD_VISIBILITY_STORAGE_PREFIX = 'agentree.graph-thread-visibility.v1';

export const getGraphThreadVisibilityStorageKey = (workspaceId: string): string => (
  `${GRAPH_THREAD_VISIBILITY_STORAGE_PREFIX}.workspace.${workspaceId}`
);

const normalizeHiddenThreadRootIds = (value: unknown): Set<string> => {
  const rawIds = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { hiddenThreadRootIds?: unknown }).hiddenThreadRootIds)
      ? (value as { hiddenThreadRootIds: unknown[] }).hiddenThreadRootIds
      : [];

  return new Set(rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0));
};

export const pruneHiddenThreadRootIds = (
  hiddenThreadRootIds: Set<string>,
  availableThreadRootIds: Iterable<string>,
): Set<string> => {
  const available = new Set(availableThreadRootIds);
  return new Set(Array.from(hiddenThreadRootIds).filter((threadRootId) => available.has(threadRootId)));
};

export const readHiddenThreadRootIds = (
  workspaceId: string | null | undefined,
  availableThreadRootIds?: Iterable<string>,
): Set<string> => {
  if (!workspaceId || typeof window === 'undefined') return new Set();

  try {
    const raw = window.localStorage.getItem(getGraphThreadVisibilityStorageKey(workspaceId));
    if (!raw) return new Set();

    const ids = normalizeHiddenThreadRootIds(JSON.parse(raw));
    return availableThreadRootIds ? pruneHiddenThreadRootIds(ids, availableThreadRootIds) : ids;
  } catch {
    return new Set();
  }
};
