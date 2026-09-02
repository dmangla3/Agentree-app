export const AGENT_STATUSES = [
  'pending',
  'creating',
  'initializing',
  'preparing_worktree',
  'streaming',
  'running',
  'finalizing',
  'completed',
  'error',
  'failed',
  'failed_setup',
  'failed_spawn',
  'failed_finalization',
  'failed_runtime',
  'cancelled',
] as const;

export type AgentStatus = typeof AGENT_STATUSES[number];

export const AGENT_STATUS: Record<AgentStatus, AgentStatus> = {
  pending: 'pending',
  creating: 'creating',
  initializing: 'initializing',
  preparing_worktree: 'preparing_worktree',
  streaming: 'streaming',
  running: 'running',
  finalizing: 'finalizing',
  completed: 'completed',
  error: 'error',
  failed: 'failed',
  failed_setup: 'failed_setup',
  failed_spawn: 'failed_spawn',
  failed_finalization: 'failed_finalization',
  failed_runtime: 'failed_runtime',
  cancelled: 'cancelled',
};

export const SETUP_STATUSES = ['pending', 'creating', 'initializing', 'preparing_worktree'] as const;
export type SetupStatus = typeof SETUP_STATUSES[number];

export const ACTIVE_STATUSES = ['pending', 'creating', 'initializing', 'preparing_worktree', 'running', 'streaming', 'finalizing'] as const;
export type ActiveStatus = typeof ACTIVE_STATUSES[number];

export const TERMINAL_STATUSES = ['completed', 'error', 'failed', 'failed_setup', 'failed_spawn', 'failed_finalization', 'failed_runtime', 'cancelled'] as const;
export type TerminalStatus = typeof TERMINAL_STATUSES[number];

export const FAILURE_STATUSES = ['error', 'failed', 'failed_setup', 'failed_spawn', 'failed_finalization', 'failed_runtime'] as const;
export type FailureStatus = typeof FAILURE_STATUSES[number];

const cleanAgentStatus = (status: unknown): string | null => {
  if (typeof status !== 'string') return null;
  const normalized = status.trim().toLowerCase();
  return normalized || null;
};

export const normalizeAgentStatus = (status: unknown): AgentStatus | null => {
  const normalized = cleanAgentStatus(status);
  return normalized && (AGENT_STATUSES as readonly string[]).includes(normalized)
    ? normalized as AgentStatus
    : null;
};

export const isSetupAgentStatus = (status: unknown): status is SetupStatus => {
  const normalized = cleanAgentStatus(status);
  return Boolean(normalized && (SETUP_STATUSES as readonly string[]).includes(normalized));
};

export const isActiveAgentStatus = (status: unknown): status is ActiveStatus => {
  const normalized = cleanAgentStatus(status);
  return Boolean(normalized && (ACTIVE_STATUSES as readonly string[]).includes(normalized));
};

export const isTerminalAgentStatus = (status: unknown): status is TerminalStatus => {
  const normalized = cleanAgentStatus(status);
  return Boolean(normalized && (TERMINAL_STATUSES as readonly string[]).includes(normalized));
};

export const isFailureAgentStatus = (status: unknown): status is FailureStatus => {
  const normalized = cleanAgentStatus(status);
  return Boolean(normalized && (FAILURE_STATUSES as readonly string[]).includes(normalized));
};
