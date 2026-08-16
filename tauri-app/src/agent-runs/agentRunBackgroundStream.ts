import { AGENT_STATUS } from '@shared/agentStatus';
import { useRunStatusStore, type RunStatus } from '../stores/runStatusStore';

interface BackgroundProjectionContext {
  nodeId: string;
  workspaceId: string | null;
  role: string | null;
}

interface BackgroundProjectionResult {
  terminalHydration: boolean;
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'error']);

const normalizeTerminalStatus = (value: unknown): RunStatus | null => {
  if (typeof value !== 'string') return null;
  if (value === 'error') return AGENT_STATUS.failed as RunStatus;
  if (terminalStatuses.has(value)) return value as RunStatus;
  return null;
};

const progressText = (event: Record<string, any>): string | null => {
  if (typeof event.message === 'string' && event.message.trim()) return event.message.trim();
  if (typeof event.progress === 'string' && event.progress.trim()) return event.progress.trim();
  return null;
};

export const projectBackgroundAgentEvent = (
  context: BackgroundProjectionContext,
  event: Record<string, any>,
): BackgroundProjectionResult => {
  const type = typeof event.type === 'string' ? event.type : 'unknown';
  const terminalStatus = type === 'finalize_ack' || type === 'exit'
    ? normalizeTerminalStatus(event.status) ?? (type === 'finalize_ack' ? AGENT_STATUS.completed : AGENT_STATUS.failed)
    : null;

  if (terminalStatus) {
    useRunStatusStore.getState().setRunStatus(context.nodeId, {
      workspaceId: context.workspaceId,
      role: context.role,
      status: terminalStatus,
      progress: terminalStatus === AGENT_STATUS.completed
        ? 'Completed'
        : terminalStatus === AGENT_STATUS.cancelled
          ? 'Cancelled'
          : 'Failed',
    });
    return { terminalHydration: true };
  }

  if (type === 'finalize_progress') {
    useRunStatusStore.getState().setRunStatus(context.nodeId, {
      workspaceId: context.workspaceId,
      role: context.role,
      status: AGENT_STATUS.running as RunStatus,
      progress: progressText(event) ?? 'Finalizing run...',
    });
    return { terminalHydration: false };
  }

  if (type === 'provider_stop' || type === 'stop') {
    useRunStatusStore.getState().setRunStatus(context.nodeId, {
      workspaceId: context.workspaceId,
      role: context.role,
      status: AGENT_STATUS.running as RunStatus,
      progress: 'Finalizing run...',
    });
    return { terminalHydration: false };
  }

  useRunStatusStore.getState().setRunStatus(context.nodeId, {
    workspaceId: context.workspaceId,
    role: context.role,
    status: AGENT_STATUS.running as RunStatus,
    progress: progressText(event) ?? 'Running...',
  });
  return { terminalHydration: false };
};
