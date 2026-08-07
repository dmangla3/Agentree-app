import type { ProjectedCommitEntity, ProjectedNodeEntity } from '../../../domain/workspaceProjection';
import type { Message } from '../../../stores/workspaceStore';

export function createCommitHoverEntity(commit: ProjectedCommitEntity): ProjectedNodeEntity {
  const authoredAt = commit.commit.authored_at ?? commit.commit.committed_at ?? commit.commit.createdAt ?? null;
  const message: Message = {
    id: `commit:${commit.sha}:hover`,
    role: 'assistant',
    content: commit.subject,
    parentId: null,
    workspaceId: commit.commit.workspace_id ?? '',
    createdAt: commit.commit.createdAt ?? commit.commit.committed_at ?? authoredAt ?? '',
    updatedAt: commit.commit.updatedAt ?? commit.commit.committed_at ?? authoredAt ?? '',
    output_commit_sha: commit.sha,
    commit: {
      ...commit.commit,
      parents: commit.parentRows,
    },
    execution_data: {
      meta: {
        git_author_name: commit.commit.author_name ?? commit.commit.committer_name ?? null,
        git_authored_at: authoredAt,
        files_changed_count: commit.commit.files_changed_count ?? null,
        total_additions: commit.commit.total_additions ?? null,
        total_deletions: commit.commit.total_deletions ?? null,
      },
    },
    branchPointers: [],
  };

  return {
    entityId: `commit_message:${commit.sha}:hover`,
    kind: 'commit_message',
    messageId: message.id,
    focusMessageId: message.id,
    turnGroupId: `commit:${commit.sha}:hover`,
    sortTs: commit.sortTs,
    message,
    preview: commit.subject,
    shortLabel: commit.shortSha,
    shortSha: commit.shortSha,
    status: null,
    parentShas: commit.parentShas,
    authorName: commit.commit.author_name ?? commit.commit.committer_name ?? null,
    authoredAt,
    importedFromRef: commit.ownerKind === 'external' ? commit.observations[0]?.git_ref ?? commit.sourceKind : null,
    scopeId: null,
  };
}
