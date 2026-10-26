const LEGACY_STORAGE_PREFIX = 'agentree.converted-subgraph-threads.v1';

const keyForWorkspace = (workspaceId: string): string => `${LEGACY_STORAGE_PREFIX}.workspace.${workspaceId}`;

export const readLegacySubgraphThreadRoots = (workspaceId: string): string[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(keyForWorkspace(workspaceId));
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed?.rootMessageIds)
      ? Array.from(new Set(parsed.rootMessageIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)))
      : [];
  } catch {
    return [];
  }
};

export const clearLegacySubgraphThreadRoots = (workspaceId: string): void => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(keyForWorkspace(workspaceId)); } catch { /* migration cleanup is best effort */ }
};
