import { useCallback, useState } from 'react';
import { AGENT_STATUS } from '@shared/agentStatus';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { agentClient } from '../lib/agentClient';
import { getOptionalCloudAuthToken } from '../lib/authSession';
import {
  providerRequiresLoginProfile,
  resolveLoginProfileSelection,
} from '../lib/loginProfiles';
import { markLocalAgentNodeTerminal } from '../lib/localAgentRunTerminal';
import { resolveQuickReplyAgent, resolveQuickReplyBase } from '../lib/quickReply';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';
import type { Message, Workspace } from '../stores/workspaceStore';
import { sendHeadlessComposerReply } from '../composer/headlessComposerSend';
import { useAgents } from './useAgents';
import { localNodeKeys, upsertMessagesIntoLocalNodeCache, type LocalNodeMessage } from './useLocalNodes';
import { useWorkspaces } from './useWorkspaces';

type QuickReplyStatus = 'idle' | 'sending' | 'error';

export const materializeHeadlessQuickReplyMessages = (
  queryClient: QueryClient,
  workspaceId: string,
  createdMessages: Message[],
  options: { finalizedAt?: number } = {},
): void => {
  if (!workspaceId || createdMessages.length === 0) return;

  queryClient.setQueryData<Message[]>(['messages', workspaceId], (current) => {
    const existing = current ?? [];
    const ids = new Set(createdMessages.map((message) => message.id));
    return [...existing.filter((message) => !ids.has(message.id)), ...createdMessages]
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  });
  queryClient.setQueryData<LocalNodeMessage[]>(
    localNodeKeys.workspace(workspaceId),
    (current) => upsertMessagesIntoLocalNodeCache(current, workspaceId, createdMessages, {
      syncStatus: 'local_only',
      finalizedAt: options.finalizedAt ?? Math.floor(Date.now() / 1000),
    })
  );
  void queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(workspaceId) });
};

export function useHeadlessQuickReply() {
  const queryClient = useQueryClient();
  const { data: agents = [] } = useAgents();
  const { data: workspaces = [] } = useWorkspaces();
  const loginProfiles = useLoginProfilesStore((state) => state.profiles);
  const [status, setStatus] = useState<QuickReplyStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const sendSteeringReply = useCallback(async (input: {
    assistantNodeId: string;
    prompt: string;
  }) => {
    const prompt = input.prompt.trim();
    const assistantNodeId = input.assistantNodeId.trim();
    if (!assistantNodeId || !prompt) return;

    setStatus('sending');
    setError(null);

    try {
      await agentClient.steerAgentRun(assistantNodeId, prompt, crypto.randomUUID());
      setStatus('idle');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Steering failed.';
      setStatus('error');
      setError(message);
      throw caught;
    }
  }, []);

  const sendQuickReply = useCallback(async (input: {
    workspaceId: string;
    replyParentId: string;
    prompt: string;
    messages: Message[];
    onMessagesCreated?: (messages: Message[]) => void;
  }) => {
    const prompt = input.prompt.trim();
    if (!prompt) return;

    const messageMap = new Map(input.messages.map((message) => [message.id, message]));
    const agent = resolveQuickReplyAgent({
      replyParentId: input.replyParentId,
      messageMap,
      agents,
    });
    const base = resolveQuickReplyBase({
      replyParentId: input.replyParentId,
      messageMap,
      workspaceBaseCommitSha: workspaces.find((workspace) => workspace.id === input.workspaceId)?.base_commit_sha ?? null,
    });

    if (!agent) {
      setStatus('error');
      setError('The parent does not have a model Agentree can reuse.');
      return;
    }
    if (!base) {
      setStatus('error');
      setError('The parent does not have an ancestor output commit to run from.');
      return;
    }
    const loginProfileSelection = resolveLoginProfileSelection({
      profiles: loginProfiles,
      provider: agent.type,
      agentName: agent.name ?? agent.type,
    });
    const selectedLoginProfile = loginProfileSelection.selectedProfile;
    if (providerRequiresLoginProfile(agent.type) && !loginProfileSelection.isReady) {
      setStatus('error');
      setError(loginProfileSelection.failureMessage ?? `${agent.name ?? agent.type} needs a ready login profile before it can run.`);
      return;
    }

    setStatus('sending');
    setError(null);

    let assistantNodeId: string | null = null;
    let assistantMessage: Message | null = null;
    try {
      const response = await sendHeadlessComposerReply({
        workspaceId: input.workspaceId,
        prompt,
        replyParentId: input.replyParentId,
        messages: input.messages,
        agent,
        base,
        workspaces: workspaces as Workspace[],
        selectedLoginProfileId: selectedLoginProfile?.id ?? null,
        startAgentRun: (payload) => agentClient.launchAgentMessage(payload as any),
        getAccessToken: getOptionalCloudAuthToken,
        seedAgentRun: (message) => agentRunManager.seed(message),
        dispatchAgentRun: (nodeId, event) => agentRunManager.dispatch(nodeId, event as any),
        persistLocalNode: (workspaceId, nodeId, message) => agentClient.upsertLocalNode(workspaceId, nodeId, message),
        onMessagesCreated: (createdMessages) => {
          materializeHeadlessQuickReplyMessages(queryClient, input.workspaceId, createdMessages);
          input.onMessagesCreated?.(createdMessages);
        },
        onAssistantMessageCreated: (message) => {
          assistantNodeId = message.id;
          assistantMessage = message;
        },
      });

      setStatus('idle');
      return response;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Quick reply failed.';
      if (assistantNodeId) {
        agentRunManager.dispatch(assistantNodeId, {
          type: 'terminal',
          status: AGENT_STATUS.failed,
          reason: message,
        });
        if (assistantMessage) {
          await markLocalAgentNodeTerminal({
            queryClient,
            workspaceId: input.workspaceId,
            nodeId: assistantNodeId,
            node: assistantMessage,
            status: AGENT_STATUS.failed,
            reason: message,
          }).catch(() => undefined);
        }
      }
      setStatus('error');
      setError(message);
      throw caught;
    }
  }, [agents, loginProfiles, queryClient, workspaces]);

  return {
    sendQuickReply,
    sendSteeringReply,
    isSending: status === 'sending',
    error,
  };
}
