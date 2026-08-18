import { useCallback, useState } from 'react';
import { AGENT_STATUS } from '@shared/agentStatus';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { agentClient } from '../lib/agentClient';
import { getAccessToken } from '../lib/authSession';
import { resolveQuickReplyAgent, resolveQuickReplyBase } from '../lib/quickReply';
import type { Message, Workspace } from '../stores/workspaceStore';
import { sendHeadlessComposerReply } from '../composer/headlessComposerSend';
import { useAgents } from './useAgents';
import { useSendMessage } from './useMessages';
import { useWorkspaces } from './useWorkspaces';

type QuickReplyStatus = 'idle' | 'sending' | 'error';

export function useHeadlessQuickReply() {
  const { data: agents = [] } = useAgents();
  const { data: workspaces = [] } = useWorkspaces();
  const sendMessageMutation = useSendMessage();
  const [status, setStatus] = useState<QuickReplyStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const sendQuickReply = useCallback(async (input: {
    workspaceId: string;
    replyParentId: string;
    prompt: string;
    messages: Message[];
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

    setStatus('sending');
    setError(null);

    let assistantNodeId: string | null = null;
    try {
      const response = await sendHeadlessComposerReply({
        workspaceId: input.workspaceId,
        prompt,
        replyParentId: input.replyParentId,
        messages: input.messages,
        agent,
        base,
        workspaces: workspaces as Workspace[],
        sendMessage: (payload) => sendMessageMutation.mutateAsync(payload as any),
        hasRuntime: () => agentClient.hasRuntime(),
        startAgentRun: (payload) => agentClient.startAgentRun(payload as any),
        getAccessToken,
        seedAgentRun: (message) => agentRunManager.seed(message),
        dispatchAgentRun: (nodeId, event) => agentRunManager.dispatch(nodeId, event as any),
        onAssistantMessageCreated: (message) => {
          assistantNodeId = message.id;
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
      }
      setStatus('error');
      setError(message);
      throw caught;
    }
  }, [agents, sendMessageMutation, workspaces]);

  return {
    sendQuickReply,
    isSending: status === 'sending',
    error,
  };
}
