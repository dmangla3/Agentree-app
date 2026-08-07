import type { CommitEntity } from '../stores/workspaceStore';
import type { LocalCommitGraphSnapshot } from './agentClient';

type LocalCommit = LocalCommitGraphSnapshot['commits'][number];

export function mapLocalCommitToCommitEntity(commit: LocalCommit, workspaceId: string): CommitEntity {
  return {
    workspace_id: workspaceId,
    sha: commit.sha,
    subject: commit.subject ?? null,
    author_name: commit.authorName ?? null,
    author_email: commit.authorEmail ?? null,
    authored_at: commit.authoredAt ?? null,
    committed_at: commit.committedAt ?? null,
    source_kind: commit.sourceKind ?? 'unknown',
    produced_by_node_id: commit.producedByNodeId ?? null,
    first_parent_sha: commit.firstParentSha ?? null,
    files_changed_count: commit.filesChangedCount ?? null,
    total_additions: commit.totalAdditions ?? null,
    total_deletions: commit.totalDeletions ?? null,
  };
}
