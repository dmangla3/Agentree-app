export const AGENT_STATUSES = [
  'pending',
  'streaming',
  'running',
  'completed',
  'error',
  'failed',
  'cancelled',
] as const;

export type AgentStatus = typeof AGENT_STATUSES[number];

export const AGENT_STATUS: Record<AgentStatus, AgentStatus> = {
  pending: 'pending',
  streaming: 'streaming',
  running: 'running',
  completed: 'completed',
  error: 'error',
  failed: 'failed',
  cancelled: 'cancelled',
};

export const RUNNING_STATUSES = ['running', 'streaming'] as const;
export type RunningStatus = typeof RUNNING_STATUSES[number];

export const ACTIVE_STATUSES = ['pending', 'running', 'streaming'] as const;
export type ActiveStatus = typeof ACTIVE_STATUSES[number];

export const TERMINAL_STATUSES = ['completed', 'error', 'failed', 'cancelled'] as const;
export type TerminalStatus = typeof TERMINAL_STATUSES[number];

export const MOUNT_STATUSES = ['running', 'completed', 'error', 'failed', 'cancelled'] as const;
export type MountStatus = typeof MOUNT_STATUSES[number];
