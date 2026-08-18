import type { Agent } from '../hooks/useAgents';
import type { ProjectedNodeEntity } from '../domain/workspaceProjection';
import type { Message } from '../stores/workspaceStore';
import { isActiveAgentRunStatus, isSteerableAssistantNode } from './agentRunSteering';

type QuickReplyAgent = Pick<Agent, 'id' | 'type' | 'model_config'>;
export type HoverReplyMode = 'reply' | 'steer';

export const QUICK_REPLY_KEEP_HOVER_OPEN_EVENT = 'agentree:quick-reply-keep-hover-open';

const clean = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const cleanLower = (value: unknown): string | null => (
  clean(value)?.toLowerCase() ?? null
);

const executionMeta = (message: Message | null | undefined): Record<string, unknown> => (
  ((message?.execution_data as any)?.meta ?? {}) as Record<string, unknown>
);

const quickReplyProvider = (message: Message): string | null => (
  cleanLower(message.llmProvider)
  ?? cleanLower(executionMeta(message).provider)
);

const quickReplyModel = (message: Message): string | null => {
  const meta = executionMeta(message);
  return (
    clean(message.llmModel)
    ?? clean(meta.provider_model)
    ?? clean(meta.llmModel)
    ?? clean(meta.model)
  );
};

export const stopQuickReplyControlEvent = (event: { stopPropagation: () => void }): void => {
  event.stopPropagation();
};

export const canShowHoverQuickReply = (
  entity: ProjectedNodeEntity | null | undefined,
  runStatus?: string | null | undefined,
): boolean => {
  return getHoverReplyMode(entity, runStatus) !== null;
};

export const getHoverReplyMode = (
  entity: ProjectedNodeEntity | null | undefined,
  runStatus?: string | null | undefined,
): HoverReplyMode | null => {
  if (!entity) return null;
  if (entity.kind === 'thread_link') return null;
  if (entity.kind === 'commit_message') return null;
  const replyParentId = entity.focusMessageId || entity.messageId;
  if (!replyParentId) return null;
  const status = clean(runStatus ?? entity.status ?? entity.message?.status)?.toLowerCase();

  if (isSteerableAssistantNode({
    nodeId: replyParentId,
    role: entity.message?.role ?? (entity.kind === 'assistant_message' ? 'assistant' : null),
    status,
  })) {
    return 'steer';
  }

  if (isActiveAgentRunStatus(status)) return null;
  return 'reply';
};

const findNearestAssistantMessage = (
  replyParentId: string | null | undefined,
  messageMap: Map<string, Message>,
): Message | null => {
  let cursorId = replyParentId ?? null;
  const visited = new Set<string>();

  while (cursorId && !visited.has(cursorId)) {
    visited.add(cursorId);
    const message = messageMap.get(cursorId);
    if (!message) return null;
    if (message.role === 'assistant') return message;
    cursorId = message.parentId ?? null;
  }

  return null;
};

export const resolveQuickReplyAgent = <TAgent extends QuickReplyAgent>(input: {
  replyParentId: string | null | undefined;
  messageMap: Map<string, Message>;
  agents: TAgent[];
}): TAgent | null => {
  const sourceMessage = findNearestAssistantMessage(input.replyParentId, input.messageMap);
  if (!sourceMessage) return null;

  const parentAgentId = clean(sourceMessage.agent_id);
  if (parentAgentId) {
    const exactAgent = input.agents.find((agent) => agent.id === parentAgentId);
    if (exactAgent) return exactAgent;
  }

  const provider = quickReplyProvider(sourceMessage);
  const model = quickReplyModel(sourceMessage);
  if (!provider || !model) return null;

  return input.agents.find((agent) => (
    agent.type === provider && clean(agent.model_config?.model) === model
  )) ?? null;
};

export const resolveQuickReplyBase = (input: {
  replyParentId: string | null | undefined;
  messageMap: Map<string, Message>;
}): { commitSha: string; selectedFromNodeId: string } | null => {
  let cursorId = input.replyParentId ?? null;
  const visited = new Set<string>();

  while (cursorId && !visited.has(cursorId)) {
    visited.add(cursorId);
    const message = input.messageMap.get(cursorId);
    if (!message) return null;

    const outputCommitSha = clean(message.output_commit_sha);
    if (outputCommitSha) {
      return {
        commitSha: outputCommitSha,
        selectedFromNodeId: message.id,
      };
    }

    cursorId = message.parentId ?? null;
  }

  return null;
};
