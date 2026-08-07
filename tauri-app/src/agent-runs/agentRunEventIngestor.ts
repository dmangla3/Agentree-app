import { AGENT_STATUS } from '@shared/agentStatus';

export type ProviderStopSummary = {
  providerTerminalStatus: string;
  providerStopReason: string | null;
};

export type FinalizeAckSummary = {
  outputCommitSha: string | null;
  commitCreated: boolean;
};

export type ParsedStdoutEvent =
  | { kind: 'json'; event: Record<string, any> }
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

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
  const outputCommitSha = typeof event.output_commit_sha === 'string' && event.output_commit_sha
    ? event.output_commit_sha
    : typeof event.outputCommitSha === 'string' && event.outputCommitSha
      ? event.outputCommitSha
      : typeof event.commit_sha === 'string' && event.commit_sha
        ? event.commit_sha
        : null;
  return {
    outputCommitSha,
    commitCreated: event.commit_created !== false,
  };
};

export const shouldAcceptFinalizeAckForRun = (
  event: Record<string, any>,
  currentRunId: string,
) => (
  typeof event.run_id !== 'string' || event.run_id === currentRunId
);
