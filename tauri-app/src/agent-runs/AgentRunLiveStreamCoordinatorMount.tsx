import { useCallback, useEffect, useRef } from 'react';
import { isActiveAgentStatus } from '@shared/agentStatus';
import { useMessages } from '../hooks/useMessages';
import { useWorkspaceStore } from '../stores/workspaceStore';
import {
  startAgentRunLiveStreamCoordinator,
  trackAgentRunLiveStreamMessage,
} from './agentRunLiveStreamCoordinator';
import { useToast } from '../components/Toast';

export const buildLandingWarningToast = (warning: {
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
  const { data: messages = [] } = useMessages(selectedWorkspaceId || '', {
    enabled: Boolean(selectedWorkspaceId),
  });
  const { addToast } = useToast();
  const shownLandingWarningsRef = useRef(new Set<string>());

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
