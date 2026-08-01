import type { QueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { api } from './api';
import { agentClient, type GitLocalRefInfo } from './agentClient';
import type { Message } from '../stores/workspaceStore';
import { trackedRefKeys } from '../hooks/useTrackedRefs';
import { branchKeys } from '../hooks/useBranches';
import { getMessageOutputCommitSha } from './graph/commitAccessors';

const INITIAL_IMPORT_COMMIT_LIMIT = 11;

const displayNameForRef = (gitRef: string): string => {
  if (gitRef.startsWith('refs/heads/')) return gitRef.replace('refs/heads/', '');
  if (gitRef === 'HEAD') return 'Checked out commit';
  return gitRef;
};

const findRef = (refs: GitLocalRefInfo[], gitRef: string): GitLocalRefInfo | null =>
  refs.find((ref) => ref.git_ref === gitRef) ?? null;

const createTrackedRef = async (
  workspaceId: string,
  gitRef: string,
  options?: { lastSeenCommitSha?: string | null }
) => {
  try {
    const response = await api.post(`/workspaces/${workspaceId}/tracked-refs`, {
      gitRef,
      displayName: displayNameForRef(gitRef),
      enabled: true,
    });
    const refId = response.data?.id;
    if (refId && options?.lastSeenCommitSha) {
      await api.patch(`/workspaces/${workspaceId}/tracked-refs/${refId}`, {
        lastSeenCommitSha: options.lastSeenCommitSha,
      });
    }
  } catch (error) {
    if (!axios.isAxiosError(error) || error.response?.status !== 409) {
      throw error;
    }
  }
};

export async function bootstrapWorkspaceInitialGitImport({
  workspaceId,
  repoPath,
  queryClient,
}: {
  workspaceId: string;
  repoPath: string;
  queryClient: QueryClient;
}): Promise<{ focusedMessageId: string | null; importedCount: number }> {
  const [localRefs, headCommitSha, currentBranchRef] = await Promise.all([
    agentClient.listLocalRefs(repoPath),
    agentClient.resolveRefTip(repoPath, 'HEAD'),
    agentClient.resolveCurrentBranchRef(repoPath).catch(() => null),
  ]);

  const mainRef = findRef(localRefs, 'refs/heads/main');
  const masterRef = findRef(localRefs, 'refs/heads/master');
  const importGitRef = currentBranchRef ?? 'HEAD';
  const refsToTrack = new Map<string, string | null>();

  if (mainRef) refsToTrack.set(mainRef.git_ref, mainRef.commit_sha);
  if (masterRef) refsToTrack.set(masterRef.git_ref, masterRef.commit_sha);
  refsToTrack.set(importGitRef, null);

  await Promise.all(Array.from(refsToTrack.entries()).map(([gitRef, lastSeenCommitSha]) =>
    createTrackedRef(workspaceId, gitRef, {
      lastSeenCommitSha: gitRef === importGitRef ? null : lastSeenCommitSha,
    })
  ));

  const commits = await agentClient.listMissingCommits(
    repoPath,
    null,
    headCommitSha,
    INITIAL_IMPORT_COMMIT_LIMIT
  );

  const ingestResponse = await api.post(`/workspaces/${workspaceId}/git-sync/ingest`, {
    refs: [{
      gitRef: importGitRef,
      tipCommitSha: headCommitSha,
      commits: commits.map((commit) => ({
        sha: commit.sha,
        parents: commit.parents,
        subject: commit.subject,
        authorName: commit.author_name ?? null,
        authorEmail: commit.author_email ?? null,
        authoredAt: commit.authored_at ?? null,
      })),
    }],
  });

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['messages', workspaceId] }),
    queryClient.invalidateQueries({ queryKey: trackedRefKeys.workspace(workspaceId) }),
    queryClient.invalidateQueries({ queryKey: branchKeys.workspace(workspaceId) }),
    queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
  ]);

  const [messagesResponse] = await Promise.all([
    api.get<Message[]>(`/workspaces/${workspaceId}/messages`),
    queryClient.refetchQueries({ queryKey: trackedRefKeys.workspace(workspaceId), type: 'active' }),
    queryClient.refetchQueries({ queryKey: branchKeys.workspace(workspaceId), type: 'active' }),
  ]);

  if (Array.isArray(messagesResponse.data)) {
    await agentClient.hydrateLocalNodesFromServer(workspaceId, messagesResponse.data);
  }
  await queryClient.invalidateQueries({ queryKey: ['messages', workspaceId] });

  const focusedMessageId =
    messagesResponse.data.find((message) => getMessageOutputCommitSha(message) === headCommitSha)?.id ?? null;

  return {
    focusedMessageId,
    importedCount: ingestResponse.data?.importedCount ?? 0,
  };
}
