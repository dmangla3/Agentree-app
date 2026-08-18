import { agentRunManager } from '../agent-runs/agentRunManager';
import { isTerminalAgentRunStatus } from '../agent-runs/agentRun.machine';
import { useRunStatusStore } from '../stores/runStatusStore';
import type { Message } from '../stores/workspaceStore';

const ACTIVE_RUN_STATUSES = new Set(['pending', 'creating', 'initializing', 'running', 'streaming']);

const cleanStatus = (status: unknown): string | null => {
  if (typeof status !== 'string') return null;
  const trimmed = status.trim();
  return trimmed ? trimmed : null;
};

const terminalStatusFromMessage = (message: Message): string | null => {
  const executionData = (message.execution_data ?? {}) as Record<string, unknown>;
  const terminalStatus = cleanStatus(executionData.last_terminal_status);
  if (terminalStatus && isTerminalAgentRunStatus(terminalStatus)) return terminalStatus;
  const status = cleanStatus(message.status);
  return status && isTerminalAgentRunStatus(status) ? status : null;
};

const isActiveStatus = (status: unknown) => {
  const normalized = cleanStatus(status);
  return Boolean(normalized && ACTIVE_RUN_STATUSES.has(normalized));
};

export const reconcileTerminalAgentRunsFromMessages = (messages: Message[]) => {
  let reconciledCount = 0;
  const runStatusByNodeId = useRunStatusStore.getState().byNodeId;

  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const terminalStatus = terminalStatusFromMessage(message);
    if (!terminalStatus) continue;

    const actorSnapshot = agentRunManager.snapshot(message.id);
    const runStatus = runStatusByNodeId[message.id]?.status ?? null;
    if (!isActiveStatus(actorSnapshot?.status) && !isActiveStatus(runStatus)) continue;

    agentRunManager.dispatch(message.id, {
      type: 'terminal',
      status: terminalStatus as any,
      content: message.content ?? '',
      reason: 'persisted-terminal-reconciliation',
      holdMs: 3000,
    }, {
      workspaceId: message.workspaceId ?? actorSnapshot?.workspaceId ?? null,
      parentId: message.parentId ?? actorSnapshot?.parentId ?? null,
      role: 'assistant',
      agentId: message.agent_id ?? actorSnapshot?.agentId ?? null,
      message,
      content: message.content ?? actorSnapshot?.content ?? '',
      executionData: (message.execution_data ?? actorSnapshot?.executionData ?? {}) as Record<string, any>,
    });
    reconciledCount += 1;
  }

  return reconciledCount;
};
