const STORAGE_PREFIX = 'agentree.deleted-graph-commits.v1';

const keyForWorkspace = (workspaceId: string) => `${STORAGE_PREFIX}.${workspaceId}`;

const normalizeSha = (sha: string | null | undefined): string | null => {
  const trimmed = sha?.trim();
  return trimmed ? trimmed : null;
};

export function readDeletedGraphCommitShas(workspaceId: string | null | undefined): Set<string> {
  if (!workspaceId || typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(keyForWorkspace(workspaceId));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((sha) => normalizeSha(String(sha))).filter((sha): sha is string => Boolean(sha)));
  } catch {
    return new Set();
  }
}

export function writeDeletedGraphCommitShas(workspaceId: string, shas: Iterable<string>): Set<string> {
  const normalized = Array.from(new Set(
    Array.from(shas)
      .map(normalizeSha)
      .filter((sha): sha is string => Boolean(sha))
  )).sort();
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(keyForWorkspace(workspaceId), JSON.stringify(normalized));
  }
  return new Set(normalized);
}

export function addDeletedGraphCommitShas(workspaceId: string, shas: Iterable<string>): Set<string> {
  const current = readDeletedGraphCommitShas(workspaceId);
  for (const sha of shas) {
    const normalized = normalizeSha(sha);
    if (normalized) current.add(normalized);
  }
  return writeDeletedGraphCommitShas(workspaceId, current);
}
