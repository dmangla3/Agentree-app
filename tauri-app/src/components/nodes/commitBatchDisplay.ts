import type { ProjectedExternalCommitBatch } from '../../domain/workspaceProjection';
import type { BranchPointer, Message } from '../../stores/workspaceStore';
import { getMessageOutputCommitSha } from '../../lib/graph/commitAccessors';

export interface CommitBatchDisplayRow {
  id: string;
  focusMessageId: string;
  sha: string | null;
  subject: string;
  authorName: string | null;
  authoredAt: string | null;
  parentShas: string[];
  filesChangedCount?: number | null;
  filesAdded?: number | null;
  filesModified?: number | null;
  filesDeleted?: number | null;
  totalAdditions?: number | null;
  totalDeletions?: number | null;
  branchPointers: BranchPointer[];
  sourceMessage: Message;
}

const getMeta = (message: Message | null | undefined): Record<string, any> => (
  ((message?.execution_data as any)?.meta || {}) as Record<string, any>
);

const getNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const getTopLevelFilesChangedCount = (message: Message): number | null => {
  const executionData = (message.execution_data || {}) as Record<string, any>;
  if (Array.isArray(executionData.files_changed)) return executionData.files_changed.length;
  return getNumber(executionData.files_changed_count);
};

const getMessageCommitParentShas = (message: Message): string[] => (
  Array.isArray(message.commit?.parents)
    ? message.commit.parents
      .map((parent) => parent.parent_sha)
      .filter((parent): parent is string => typeof parent === 'string' && parent.trim().length > 0)
    : []
);

const getFilesChangedTotals = (filesChanged: unknown): { additions: number | null; deletions: number | null } => {
  if (!Array.isArray(filesChanged)) return { additions: null, deletions: null };
  return filesChanged.reduce(
    (totals, file) => ({
      additions: totals.additions + (typeof file?.additions === 'number' ? file.additions : 0),
      deletions: totals.deletions + (typeof file?.deletions === 'number' ? file.deletions : 0),
    }),
    { additions: 0, deletions: 0 }
  );
};

export function getCommitBatchDisplayRows(batch: ProjectedExternalCommitBatch): CommitBatchDisplayRow[] {
  const representative = batch.batch.messages.find((message) => message.id === batch.representativeMessageId)
    ?? batch.batch.messages[batch.batch.messages.length - 1]
    ?? null;
  const meta = getMeta(representative);

  if (batch.sourceKind === 'manual' && representative && Array.isArray(meta.commits) && meta.commits.length > 0) {
    return meta.commits.map((commit: any) => {
      const sha = typeof commit.sha === 'string' ? commit.sha : null;
      return {
        id: `${representative.id}:${sha ?? 'commit'}`,
        focusMessageId: representative.id,
        sha,
        subject: typeof commit.subject === 'string' && commit.subject.trim()
          ? commit.subject
          : `Commit ${String(sha || representative.id).slice(0, 8)}`,
        authorName: typeof commit.author_name === 'string' ? commit.author_name : null,
        authoredAt: typeof commit.authored_at === 'string' ? commit.authored_at : representative.createdAt ?? null,
        parentShas: Array.isArray(commit.parents)
          ? commit.parents.filter((parent: unknown): parent is string => typeof parent === 'string' && parent.trim().length > 0)
          : [],
        filesChangedCount: getNumber(commit.files_changed_count) ?? (Array.isArray(commit.files_changed) ? commit.files_changed.length : null),
        filesAdded: getNumber(commit.files_added),
        filesModified: getNumber(commit.files_modified),
        filesDeleted: getNumber(commit.files_deleted),
        totalAdditions: getNumber(commit.total_additions),
        totalDeletions: getNumber(commit.total_deletions),
        branchPointers: sha && getMessageOutputCommitSha(representative) === sha ? representative.branchPointers || [] : [],
        sourceMessage: representative,
      };
    });
  }

  return batch.batch.messages.map((message) => {
    const rowMeta = getMeta(message);
    const commitSha = getMessageOutputCommitSha(message);
    const topLevelFilesChanged = ((message.execution_data as any) || {}).files_changed;
    const topLevelTotals = getFilesChangedTotals(topLevelFilesChanged);
    return {
      id: message.id,
      focusMessageId: message.id,
      sha: commitSha,
      subject: message.aiLabel || message.content || `Commit ${(commitSha || message.id).slice(0, 8)}`,
      authorName: typeof rowMeta.git_author_name === 'string' ? rowMeta.git_author_name : null,
      authoredAt: typeof rowMeta.git_authored_at === 'string' ? rowMeta.git_authored_at : message.createdAt ?? null,
      parentShas: getMessageCommitParentShas(message),
      filesChangedCount: getNumber(rowMeta.files_changed_count) ?? getTopLevelFilesChangedCount(message),
      filesAdded: getNumber(rowMeta.files_added),
      filesModified: getNumber(rowMeta.files_modified),
      filesDeleted: getNumber(rowMeta.files_deleted),
      totalAdditions: getNumber(rowMeta.total_additions) ?? topLevelTotals.additions,
      totalDeletions: getNumber(rowMeta.total_deletions) ?? topLevelTotals.deletions,
      branchPointers: message.branchPointers || [],
      sourceMessage: message,
    };
  });
}

export function getCommitBatchRowFocusMetadata(
  batch: ProjectedExternalCommitBatch,
  row: CommitBatchDisplayRow
): Record<string, unknown> | undefined {
  if (batch.sourceKind !== 'manual') return undefined;
  return {
    reason: 'manual-commit-row',
    manualCommitBatchId: batch.batchId,
    manualCommitBatchMessageId: batch.representativeMessageId,
    selectedCommitSha: row.sha,
    selectedCommitSubject: row.subject,
    selectedCommitLabel: row.subject,
  };
}
