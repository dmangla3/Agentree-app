export const ACTIVE_AGENT_RUN_STATUSES = new Set([
  'pending',
  'creating',
  'initializing',
  'running',
  'streaming',
]);

const clean = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
);

export const isActiveAgentRunStatus = (status: unknown): boolean => {
  const normalized = clean(status);
  return Boolean(normalized && ACTIVE_AGENT_RUN_STATUSES.has(normalized));
};

export interface SteerableAssistantNodeInput {
  nodeId: string | null | undefined;
  role: string | null | undefined;
  status: string | null | undefined;
  runStatus?: string | null | undefined;
}

export const isSteerableAssistantNode = (input: SteerableAssistantNodeInput): boolean => {
  const nodeId = typeof input.nodeId === 'string' ? input.nodeId.trim() : '';
  if (!nodeId) return false;
  if (clean(input.role) !== 'assistant') return false;
  return isActiveAgentRunStatus(input.runStatus ?? input.status);
};

export const getSteerableAgentNodeId = (input: SteerableAssistantNodeInput): string | null => (
  isSteerableAssistantNode(input) ? input.nodeId!.trim() : null
);
