import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { agentClient } from '../lib/agentClient';
import { useWorkspaceStore, Message } from '../stores/workspaceStore';
import { GitMergeApplyResult, GitMergeSession, useMergeStore } from '../stores/mergeStore';
import { scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import { getMessageOutputCommitSha } from '../lib/graph/commitAccessors';

function getMessagesForWorkspace(queryClient: ReturnType<typeof useQueryClient>, workspaceId: string | null): Message[] {
  if (!workspaceId) return [];
  return (queryClient.getQueryData(['messages', workspaceId]) as Message[] | undefined) ?? [];
}

function findMessage(messages: Message[], messageId: string): Message | null {
  return messages.find((message) => message.id === messageId) ?? null;
}

function labelForMessage(message: Message | null, fallbackId: string): string {
  if (message?.aiLabel?.trim()) return message.aiLabel.trim();
  return fallbackId.slice(0, 8);
}

export function useMergeNodes() {
  const queryClient = useQueryClient();
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const { setPreviewSession } = useMergeStore();

  const mutation = useMutation({
    mutationFn: async ({
      repoPath,
      sourceNodeId,
      targetNodeId,
    }: {
      repoPath: string;
      sourceNodeId: string;
      targetNodeId: string;
    }): Promise<GitMergeSession> => {
      const messages = getMessagesForWorkspace(queryClient, selectedWorkspaceId);
      const sourceMessage = findMessage(messages, sourceNodeId);
      const targetMessage = findMessage(messages, targetNodeId);

      const sourceBranch = getMessageOutputCommitSha(sourceMessage) || sourceMessage?.git_branch_name;
      const targetBranch = getMessageOutputCommitSha(targetMessage) || targetMessage?.git_branch_name;
      if (!sourceBranch || !targetBranch) {
        throw new Error('Both nodes must have finalized git commits before they can be merged.');
      }

      const preview = await agentClient.mergePreview(repoPath, [sourceBranch], targetBranch);
      return {
        repoPath,
        sourceNodeId,
        targetNodeId,
        sourceBranch,
        targetBranch,
        sourceLabel: labelForMessage(sourceMessage, sourceNodeId),
        targetLabel: labelForMessage(targetMessage, targetNodeId),
        preview,
      };
    },
    onSuccess: (session) => {
      setPreviewSession(session);
    },
  });

  return {
    ...mutation,
    mergeNodes: async (repoPath: string, sourceNodeId: string, targetNodeId: string) =>
      mutation.mutateAsync({ repoPath, sourceNodeId, targetNodeId }),
  };
}

export function useApplyGitMerge() {
  const queryClient = useQueryClient();
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const {
    previewSession,
    setPreviewDialogOpen,
    setProgressDialogOpen,
    setIsApplying,
    setApplyResult,
    setApplyError,
  } = useMergeStore();

  return useMutation({
    mutationFn: async ({
      conflictStrategy,
    }: {
      conflictStrategy?: 'source' | 'target';
    }): Promise<GitMergeApplyResult> => {
      if (!previewSession) {
        throw new Error('No merge preview is available.');
      }

      const resultNodeId = crypto.randomUUID();
      const conflictResolutions = conflictStrategy
        ? previewSession.preview.conflicted_files.map((path) => ({
            path,
            action: conflictStrategy,
          }))
        : undefined;

      const commitMessage = `Merge ${previewSession.sourceBranch} into ${previewSession.targetBranch}`;
      const result = await agentClient.mergeApply(
        previewSession.repoPath,
        [previewSession.sourceBranch],
        previewSession.targetBranch,
        resultNodeId,
        commitMessage,
        conflictResolutions
      );

      return {
        ...result,
        resultNodeId,
      };
    },
    onMutate: () => {
      setPreviewDialogOpen(false);
      setProgressDialogOpen(true);
      setIsApplying(true);
      setApplyError(null);
    },
    onSuccess: async (result) => {
      if (!previewSession) {
        setApplyResult(result);
        return;
      }

      if (result.commit_sha && selectedWorkspaceId && result.resultNodeId) {
        await api.post(`/workspaces/${selectedWorkspaceId}/messages`, {
          id: result.resultNodeId,
          role: 'assistant',
          content: `Merged ${previewSession.sourceLabel} into ${previewSession.targetLabel}`,
          parentId: previewSession.targetNodeId,
          skipAssistant: true,
        });
        await api.patch(`/messages/${result.resultNodeId}`, {
          output_commit_sha: result.commit_sha,
          git_branch_name: null,
        });
        void scheduleMessagesRefreshWhenGraphIdle(queryClient, selectedWorkspaceId, {
          refetchActive: true,
          reason: 'merge-apply',
        });
      }

      setApplyResult(result);
    },
    onError: (error: Error) => {
      setApplyError(error.message || 'Merge failed');
    },
  });
}
