import { describe, expect, it } from 'vitest';
import { shouldRefreshHeldGraphMessagesForStructuralChange } from './graphComputationHold';
import type { Message } from '../../stores/workspaceStore';

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'assistant-1',
  role: 'assistant',
  content: 'draft',
  parentId: 'user-1',
  workspaceId: 'workspace-1',
  status: 'running',
  createdAt: '2026-05-19T00:00:00.000Z',
  updatedAt: '2026-05-19T00:00:01.000Z',
  execution_data: {},
  ...overrides,
});

describe('graph computation active hold structural refresh', () => {
  it('ignores same-count non-structural message changes while the graph is held', () => {
    expect(shouldRefreshHeldGraphMessagesForStructuralChange(
      [message({ content: 'streaming chunk 1' })],
      [message({ content: 'streaming chunk 2' })],
    )).toBe(false);
  });

  it('ignores non-terminal status churn while the graph is held', () => {
    expect(shouldRefreshHeldGraphMessagesForStructuralChange(
      [message({ status: 'running' })],
      [message({ status: 'streaming' })],
    )).toBe(false);
  });

  it('refreshes when a held message receives an output commit sha', () => {
    expect(shouldRefreshHeldGraphMessagesForStructuralChange(
      [message()],
      [message({ output_commit_sha: 'commit-1' })],
    )).toBe(true);
  });

  it('refreshes when synthetic commit metadata label changes after the sha is already present', () => {
    expect(shouldRefreshHeldGraphMessagesForStructuralChange(
      [message({ output_commit_sha: 'commit-1', execution_data: { meta: {} } })],
      [message({
        output_commit_sha: 'commit-1',
        execution_data: { meta: { commit_message: 'Generated commit label' } },
      })],
    )).toBe(true);
  });

  it('refreshes when aiLabel becomes the synthetic commit label after the sha is already present', () => {
    expect(shouldRefreshHeldGraphMessagesForStructuralChange(
      [message({ output_commit_sha: 'commit-1' })],
      [message({ output_commit_sha: 'commit-1', aiLabel: 'AI generated label' })],
    )).toBe(true);
  });

  it('refreshes when terminal status changes without changing message count', () => {
    expect(shouldRefreshHeldGraphMessagesForStructuralChange(
      [message({ status: 'failed', execution_data: { last_terminal_status: 'failed' } })],
      [message({ status: 'completed', execution_data: { last_terminal_status: 'completed' } })],
    )).toBe(true);
  });

  it('refreshes when base or commit metadata changes', () => {
    expect(shouldRefreshHeldGraphMessagesForStructuralChange(
      [message({ base_selected_from_node_id: 'old-base' })],
      [message({
        base_selected_from_node_id: 'new-base',
        commit: {
          sha: 'commit-1',
          first_parent_sha: 'base-1',
          subject: 'Generated commit',
        },
      })],
    )).toBe(true);
  });
});
