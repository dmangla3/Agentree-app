import { describe, expect, it } from 'vitest';
import {
  parseStdoutAgentEvent,
  shouldAcceptFinalizeAckForRun,
  summarizeFinalizeAck,
  summarizeProviderStop,
} from './agentRunEventIngestor';

describe('agentRunEventIngestor helpers', () => {
  it('parses JSON stdout envelopes and preserves plain text stderr/stdout payloads', () => {
    expect(parseStdoutAgentEvent('{"type":"message_delta","delta":"hi"}')).toEqual({
      kind: 'json',
      event: { type: 'message_delta', delta: 'hi' },
    });
    expect(parseStdoutAgentEvent('not json')).toEqual({
      kind: 'text',
      text: 'not json',
    });
    expect(parseStdoutAgentEvent('   ')).toEqual({ kind: 'empty' });
  });

  it('summarizes provider stop status and reason without terminalizing by itself', () => {
    expect(summarizeProviderStop({
      type: 'provider_stop',
      provider_status: 'cancelled',
      provider_stop_reason: 'user',
    })).toEqual({
      providerTerminalStatus: 'cancelled',
      providerStopReason: 'user',
    });
    expect(summarizeProviderStop({ type: 'stop', status: 'completed' })).toEqual({
      providerTerminalStatus: 'completed',
      providerStopReason: null,
    });
  });

  it('summarizes finalize ack commit metadata variants', () => {
    expect(summarizeFinalizeAck({ output_commit_sha: 'commit-1' })).toMatchObject({
      status: 'completed',
      outputCommitSha: 'commit-1',
      commitCreated: true,
      gitBranchName: null,
      persisted: null,
      serverAckAt: null,
    });
    expect(summarizeFinalizeAck({ outputCommitSha: 'commit-2' })).toMatchObject({
      outputCommitSha: 'commit-2',
      commitCreated: true,
    });
    expect(summarizeFinalizeAck({ commit_sha: 'commit-3', commit_created: false })).toMatchObject({
      outputCommitSha: 'commit-3',
      commitCreated: false,
    });
    expect(summarizeFinalizeAck({ commit_created: false })).toMatchObject({
      outputCommitSha: null,
      commitCreated: false,
    });
    expect(summarizeFinalizeAck({ commitCreated: false })).toMatchObject({
      outputCommitSha: null,
      commitCreated: false,
    });
    expect(summarizeFinalizeAck({
      status: 'failed',
      git_branch_name: 'agent/run-1',
      persisted: true,
      server_ack_at: '2026-05-19T10:00:00.000Z',
    })).toMatchObject({
      status: 'failed',
      gitBranchName: 'agent/run-1',
      persisted: true,
      serverAckAt: '2026-05-19T10:00:00.000Z',
    });
  });

  it('filters finalize ack events for stale run ids', () => {
    expect(shouldAcceptFinalizeAckForRun({ run_id: 'run-1' }, 'run-1')).toBe(true);
    expect(shouldAcceptFinalizeAckForRun({ run_id: 'old-run' }, 'run-1')).toBe(false);
    expect(shouldAcceptFinalizeAckForRun({}, 'run-1')).toBe(true);
  });
});
