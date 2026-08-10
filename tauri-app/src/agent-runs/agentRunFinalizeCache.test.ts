import { describe, expect, it } from 'vitest';
import {
  patchFinalizedLocalNodes,
  patchFinalizedMessages,
} from './agentRunFinalizeCache';
import type { Message } from '../stores/workspaceStore';
import type { LocalNodeMessage } from '../hooks/useLocalNodes';

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'assistant-1',
  role: 'assistant',
  workspaceId: 'workspace-1',
  parentId: 'user-1',
  content: 'final text',
  status: 'running',
  createdAt: '2026-05-19T00:00:00.000Z',
  updatedAt: '2026-05-19T00:00:01.000Z',
  execution_data: {
    current_run_id: 'run-1',
    meta: { existing: true },
  },
  output_commit_sha: null,
  ...overrides,
});

const localNode = (overrides: Partial<LocalNodeMessage> = {}): LocalNodeMessage => ({
  nodeId: 'assistant-1',
  workspaceId: 'workspace-1',
  syncStatus: 'local_only',
  finalizedAt: 1_779_120_000,
  retryAttempt: 0,
  message: message(),
  ...overrides,
});

describe('agent run finalize cache patching', () => {
  it('marks cached messages terminal even when no commit was created', () => {
    const [patched] = patchFinalizedMessages([message()], {
      nodeId: 'assistant-1',
      status: 'completed',
    })!;

    expect(patched.status).toBe('completed');
    expect(patched.execution_data.last_terminal_status).toBe('completed');
    expect(patched.output_commit_sha).toBeNull();
  });

  it('adds generated commit data to message and execution metadata', () => {
    const [patched] = patchFinalizedMessages([message()], {
      nodeId: 'assistant-1',
      status: 'completed',
      outputCommitSha: 'commit-1',
      gitBranchName: 'agent/branch',
      commitCreated: true,
    })!;

    expect(patched.status).toBe('completed');
    expect(patched.output_commit_sha).toBe('commit-1');
    expect(patched.git_branch_name).toBe('agent/branch');
    expect(patched.execution_data.output_commit_sha).toBe('commit-1');
    expect(patched.execution_data.meta).toEqual({
      existing: true,
      output_commit_sha: 'commit-1',
      git_branch_name: 'agent/branch',
      commit_created: true,
    });
  });

  it('patches local-node query data so graph projection cannot reintroduce stale running state', () => {
    const [patched] = patchFinalizedLocalNodes([localNode()], {
      nodeId: 'assistant-1',
      status: 'completed',
      outputCommitSha: 'commit-1',
      commitCreated: true,
    })!;

    expect(patched.message.status).toBe('completed');
    expect(patched.message.output_commit_sha).toBe('commit-1');
    expect(patched.message.execution_data?.last_terminal_status).toBe('completed');
  });
});
