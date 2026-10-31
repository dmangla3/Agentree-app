import type { CommitEntity, Message } from '../../stores/workspaceStore';

export interface CommitStats {
  filesChanged: number;
  totalAdditions: number;
  totalDeletions: number;
}

const numeric = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const sumFileStat = (files: unknown, key: 'additions' | 'deletions'): number | null => {
  if (!Array.isArray(files)) return null;
  return files.reduce((sum, file) => {
    if (!file || typeof file !== 'object') return sum;
    return sum + (numeric((file as Record<string, unknown>)[key]) ?? 0);
  }, 0);
};

export const getCommitStatsFromRow = (
  commit: CommitEntity | null | undefined,
): CommitStats | null => {
  if (!commit) return null;
  const filesChanged = numeric(commit.files_changed_count);
  const totalAdditions = numeric(commit.total_additions);
  const totalDeletions = numeric(commit.total_deletions);

  if (filesChanged === null && totalAdditions === null && totalDeletions === null) return null;

  return {
    filesChanged: filesChanged ?? 0,
    totalAdditions: totalAdditions ?? 0,
    totalDeletions: totalDeletions ?? 0,
  };
};

export const getCommitStatsForMessage = (message: Message | null | undefined): CommitStats => {
  const executionData = (message?.execution_data ?? {}) as Record<string, unknown>;
  const meta = (executionData.meta ?? {}) as Record<string, unknown>;
  const files = executionData.files_changed;
  const commit = message?.commit;

  return {
    filesChanged:
      numeric(commit?.files_changed_count)
      ?? numeric(meta.files_changed_count)
      ?? numeric(executionData.files_changed_count)
      ?? (Array.isArray(files) ? files.length : 0),
    totalAdditions:
      numeric(commit?.total_additions)
      ?? numeric(meta.total_additions)
      ?? numeric(executionData.total_additions)
      ?? sumFileStat(files, 'additions')
      ?? 0,
    totalDeletions:
      numeric(commit?.total_deletions)
      ?? numeric(meta.total_deletions)
      ?? numeric(executionData.total_deletions)
      ?? sumFileStat(files, 'deletions')
      ?? 0,
  };
};
