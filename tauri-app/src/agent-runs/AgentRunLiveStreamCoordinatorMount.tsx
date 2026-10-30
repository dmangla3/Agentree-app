import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isActiveAgentStatus } from '@shared/agentStatus';
import { useMessages } from '../hooks/useMessages';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { agentClient } from '../lib/agentClient';
import { resolveLocalWorkspaceRepoPath } from '../lib/workspaceRepoPath';
import { describeCheckoutFailure } from '../lib/checkoutFailure';
import { scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import { branchKeys } from '../hooks/useBranches';
import { gitRefSnapshotKeys } from '../hooks/useGitRefSnapshot';
import {
  startAgentRunLiveStreamCoordinator,
  trackAgentRunLiveStreamMessage,
} from './agentRunLiveStreamCoordinator';
import { createAgentRunAutoCheckoutCoordinator } from './agentRunAutoCheckout';
import { registerAgentRunFinalizeListener } from './agentRunEffects';
import type { AgentRunSnapshot } from './agentRun.types';
import { finishComposerSendFocus } from '../composer/composerSendFocus';
import { useToast } from '../components/Toast';

const buildLandingWarningToast = (warning: {
  message: string;
  outputCommitSha: string | null;
}) => {
  const commitLabel = warning.outputCommitSha
    ? `Commit ${warning.outputCommitSha.slice(0, 8)} was saved. `
    : '';
  return {
    title: 'Commit created, but target branch was not updated',
    description: `${commitLabel}${warning.message}`,
    variant: 'warning' as const,
    persistent: true,
  };
};

export function AgentRunLiveStreamCoordinator() {
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const selectedWorkspaceIdRef = useRef<string | null>(selectedWorkspaceId);
  const queryClient = useQueryClient();
  const { data: workspaces = [] } = useWorkspaces();
  const workspacesRef = useRef(workspaces);
  const { data: messages = [] } = useMessages(selectedWorkspaceId || '', {
    enabled: Boolean(selectedWorkspaceId),
  });
  const { addToast } = useToast();
  const shownLandingWarningsRef = useRef(new Set<string>());
  const autoCheckoutCoordinatorRef = useRef<ReturnType<typeof createAgentRunAutoCheckoutCoordinator> | null>(null);
  if (!autoCheckoutCoordinatorRef.current) {
    autoCheckoutCoordinatorRef.current = createAgentRunAutoCheckoutCoordinator({
      checkoutCommit: (repoPath, commitSha) => agentClient.checkoutCommitDetached(repoPath, commitSha),
      onCheckedOut: (input, checkedOutCommit) => {
        if (input.workspaceId) {
          void scheduleMessagesRefreshWhenGraphIdle(queryClient, input.workspaceId, {
            reason: 'agent-auto-checkout',
          });
          void queryClient.invalidateQueries({ queryKey: branchKeys.workspace(input.workspaceId) });
        }
        void queryClient.invalidateQueries({ queryKey: gitRefSnapshotKeys.all });
        addToast({
          title: 'Auto Checkout Complete',
          description: `Detached HEAD at ${checkedOutCommit.slice(0, 7)}.`,
          variant: 'success',
        });
      },
      onSkipped: (_input, outcome) => {
        addToast({
          title: 'Auto Checkout Skipped',
          description: outcome.message,
          variant: 'warning',
          duration: 9000,
        });
      },
      onFailed: (_input, error) => {
        addToast({
          ...describeCheckoutFailure(error, 'auto'),
          duration: 9000,
        });
      },
    });
  }

  const showLandingWarning = useCallback((warning: {
    nodeId: string;
    message: string;
    outputCommitSha: string | null;
  }) => {
    const warningKey = `${warning.nodeId}:${warning.outputCommitSha ?? warning.message}`;
    if (shownLandingWarningsRef.current.has(warningKey)) return;
    shownLandingWarningsRef.current.add(warningKey);
    addToast(buildLandingWarningToast(warning));
  }, [addToast]);

  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  const handleRunFinalized = useCallback((snapshot: AgentRunSnapshot) => {
    const executionData = (snapshot.executionData ?? {}) as Record<string, unknown>;
    const meta = executionData.meta && typeof executionData.meta === 'object'
      ? executionData.meta as Record<string, unknown>
      : {};
    const outputCommitSha = snapshot.finalizeAck?.outputCommitSha
      ?? (typeof executionData.output_commit_sha === 'string' ? executionData.output_commit_sha : null)
      ?? (typeof meta.output_commit_sha === 'string' ? meta.output_commit_sha : null);
    const terminalStatus = snapshot.finalizeAck?.status ?? snapshot.terminalStatus ?? snapshot.status;
    finishComposerSendFocus({
      assistantMessageId: snapshot.nodeId,
      workspaceId: snapshot.workspaceId,
      terminalStatus,
      outputCommitSha,
    });

    const workspace = workspacesRef.current.find((candidate) => candidate.id === snapshot.workspaceId) ?? null;
    void autoCheckoutCoordinatorRef.current?.handleFinalizedRun({
      nodeId: snapshot.nodeId,
      workspaceId: snapshot.workspaceId,
      terminalStatus,
      outputCommitSha,
      executionData,
      repoPath: resolveLocalWorkspaceRepoPath(workspace),
    });
  }, []);

  useEffect(() => registerAgentRunFinalizeListener(handleRunFinalized), [handleRunFinalized]);

  useEffect(() => (
    startAgentRunLiveStreamCoordinator({
      getSelectedWorkspaceId: () => selectedWorkspaceIdRef.current,
      onLandingWarning: showLandingWarning,
    })
  ), [showLandingWarning]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    for (const message of messages) {
      if (message.workspaceId !== selectedWorkspaceId) continue;
      if (message.role !== 'assistant') continue;
      if (!isActiveAgentStatus(message.status)) continue;
      trackAgentRunLiveStreamMessage(message);
    }
  }, [messages, selectedWorkspaceId]);

  return null;
}
