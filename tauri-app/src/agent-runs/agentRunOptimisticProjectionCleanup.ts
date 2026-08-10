import type { AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import type { Message } from '../stores/workspaceStore';

export const materializePersistedOptimisticUserMessage = (
  message: AgentRunProjectedMessage,
): Message => {
  const {
    _optimistic,
    _optimisticStatus,
    _optimisticError,
    _setupProgress,
    _rollbackOnFail,
    _terminalHoldUntil,
    _terminalContentLength,
    ...persisted
  } = message;

  return {
    ...persisted,
    status: null,
    execution_data: persisted.execution_data ?? null,
  } as Message;
};

export const shouldClearPersistedOptimisticUserProjection = (
  projection: AgentRunProjectedMessage | null | undefined,
  persisted: Message | null | undefined,
  workspaceId: string | null | undefined,
) => {
  if (!workspaceId || !projection || !persisted) return false;
  return projection.workspaceId === workspaceId
    && projection.role === 'user'
    && projection._optimistic === true
    && persisted.id === projection.id
    && persisted.workspaceId === workspaceId
    && persisted.role === 'user';
};
