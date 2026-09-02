import { useEffect, useRef } from 'react';
import { isActiveAgentStatus } from '@shared/agentStatus';
import { useMessages } from '../hooks/useMessages';
import { useWorkspaceStore } from '../stores/workspaceStore';
import {
  startAgentRunLiveStreamCoordinator,
  trackAgentRunLiveStreamMessage,
} from './agentRunLiveStreamCoordinator';

export function AgentRunLiveStreamCoordinator() {
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const selectedWorkspaceIdRef = useRef<string | null>(selectedWorkspaceId);
  const { data: messages = [] } = useMessages(selectedWorkspaceId || '', {
    enabled: Boolean(selectedWorkspaceId),
  });

  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  useEffect(() => (
    startAgentRunLiveStreamCoordinator({
      getSelectedWorkspaceId: () => selectedWorkspaceIdRef.current,
    })
  ), []);

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
