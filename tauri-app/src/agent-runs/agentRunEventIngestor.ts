import { AGENT_STATUS } from '@shared/agentStatus';

export type ProviderStopSummary = {
  providerTerminalStatus: string;
  providerStopReason: string | null;
};

export type FinalizeAckSummary = {
  status: string;
  outputCommitSha: string | null;
  commitCreated: boolean;
  gitBranchName: string | null;
  persisted: boolean | null;
  serverAckAt: string | null;
};

export type ParsedStdoutEvent =
  | { kind: 'json'; event: Record<string, any> }
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

const cleanString = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const parseStdoutAgentEvent = (payload: unknown): ParsedStdoutEvent => {
  if (typeof payload !== 'string') return { kind: 'empty' };
  const text = payload.trim();
  if (!text) return { kind: 'empty' };
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { kind: 'json', event: parsed as Record<string, any> };
    }
    return { kind: 'text', text: payload };
  } catch {
    return { kind: 'text', text: payload };
  }
};

export const summarizeProviderStop = (event: Record<string, any>): ProviderStopSummary => ({
  providerTerminalStatus: typeof event.provider_status === 'string'
    ? event.provider_status
    : typeof event.status === 'string'
      ? event.status
      : AGENT_STATUS.completed,
  providerStopReason: typeof event.provider_stop_reason === 'string'
    ? event.provider_stop_reason
    : typeof event.stop_reason === 'string'
      ? event.stop_reason
      : null,
});

export const summarizeFinalizeAck = (event: Record<string, any>): FinalizeAckSummary => {
  const outputCommitSha = cleanString(event.output_commit_sha)
    ?? cleanString(event.outputCommitSha)
    ?? cleanString(event.commit_sha);
  const gitBranchName = cleanString(event.git_branch_name) ?? cleanString(event.gitBranchName);
  const serverAckAt = cleanString(event.server_ack_at) ?? cleanString(event.serverAckAt);
  return {
    status: typeof event.status === 'string' ? event.status : AGENT_STATUS.completed,
    outputCommitSha,
    commitCreated: event.commit_created !== false && event.commitCreated !== false,
    gitBranchName,
    persisted: typeof event.persisted === 'boolean' ? event.persisted : null,
    serverAckAt,
  };
};

export const shouldAcceptFinalizeAckForRun = (
  event: Record<string, any>,
  currentRunId: string,
) => (
  typeof event.run_id !== 'string' || event.run_id === currentRunId
);
