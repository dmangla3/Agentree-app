import { agentClient } from './agentClient';

interface PersistMergeCommitGraphInput {
  workspaceId: string;
  repoPath: string;
  commitSha: string;
  resultNodeId: string;
  fallbackParents: string[];
  fallbackSubject: string;
}

const normalizeShaList = (values: string[]): string[] => (
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
);

export const persistMergeCommitGraph = async ({
  workspaceId,
  repoPath,
  commitSha,
  resultNodeId,
  fallbackParents,
  fallbackSubject,
}: PersistMergeCommitGraphInput): Promise<void> => {
  const normalizedCommitSha = commitSha.trim();
  if (!normalizedCommitSha) return;

  let metadata: Awaited<ReturnType<typeof agentClient.readCommitMetadata>> | null = null;
  try {
    metadata = await agentClient.readCommitMetadata(repoPath, normalizedCommitSha);
  } catch {
    metadata = null;
  }

  await agentClient.importLocalCommits(workspaceId, [{
    sha: metadata?.sha || normalizedCommitSha,
    parents: normalizeShaList(metadata?.parents?.length ? metadata.parents : fallbackParents),
    subject: metadata?.subject || fallbackSubject,
    authorName: metadata?.author_name ?? null,
    authorEmail: metadata?.author_email ?? null,
    authoredAt: metadata?.authored_at ?? null,
    committedAt: metadata?.authored_at ?? null,
    sourceKind: 'merge',
    producedByNodeId: resultNodeId,
    filesChangedCount: metadata?.files_changed_count ?? null,
    totalAdditions: metadata?.total_additions ?? null,
    totalDeletions: metadata?.total_deletions ?? null,
  }], null, repoPath);
};
