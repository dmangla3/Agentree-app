import { describe, expect, it, vi } from 'vitest';
import {
  createAgentRunAutoCheckoutCoordinator,
  isAgentRunAutoCheckoutRequested,
  type AgentRunAutoCheckoutInput,
} from './agentRunAutoCheckout';

const run = (overrides: Partial<AgentRunAutoCheckoutInput> = {}): AgentRunAutoCheckoutInput => ({
  nodeId: 'assistant-1',
  workspaceId: 'workspace-1',
  repoPath: '/repo',
  terminalStatus: 'completed',
  outputCommitSha: 'commit-1',
  executionData: { meta: { auto_checkout_requested: true } },
  ...overrides,
});

describe('agent run auto checkout', () => {
  it('reads the persisted per-run request instead of current composer state', () => {
    expect(isAgentRunAutoCheckoutRequested({ auto_checkout_requested: true })).toBe(true);
    expect(isAgentRunAutoCheckoutRequested({ meta: { auto_checkout_requested: true } })).toBe(true);
    expect(isAgentRunAutoCheckoutRequested({ meta: { auto_checkout_requested: false } })).toBe(false);
  });

  it('checks out a completed generated commit once', async () => {
    const checkoutCommit = vi.fn(async () => 'commit-1');
    const onCheckedOut = vi.fn();
    const coordinator = createAgentRunAutoCheckoutCoordinator({ checkoutCommit, onCheckedOut });

    await expect(coordinator.handleFinalizedRun(run())).resolves.toEqual({
      kind: 'checked-out',
      commitSha: 'commit-1',
    });
    await expect(coordinator.handleFinalizedRun(run())).resolves.toEqual({
      kind: 'ignored',
      reason: 'duplicate',
    });
    expect(checkoutCommit).toHaveBeenCalledOnce();
    expect(onCheckedOut).toHaveBeenCalledOnce();
  });

  it('serializes checkout mutations from concurrently finishing runs', async () => {
    let active = 0;
    let maxActive = 0;
    const checkoutCommit = vi.fn(async (_repoPath: string, commitSha: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return commitSha;
    });
    const coordinator = createAgentRunAutoCheckoutCoordinator({ checkoutCommit });

    await Promise.all([
      coordinator.handleFinalizedRun(run()),
      coordinator.handleFinalizedRun(run({ nodeId: 'assistant-2', outputCommitSha: 'commit-2' })),
    ]);

    expect(maxActive).toBe(1);
    expect(checkoutCommit).toHaveBeenCalledTimes(2);
  });

  it('surfaces terminal failures, missing commits, and missing repositories without invoking git', async () => {
    const checkoutCommit = vi.fn();
    const onSkipped = vi.fn();
    const coordinator = createAgentRunAutoCheckoutCoordinator({ checkoutCommit, onSkipped });

    await expect(coordinator.handleFinalizedRun(run({ nodeId: 'failed', terminalStatus: 'failed' })))
      .resolves.toMatchObject({ kind: 'skipped', reason: 'run-not-completed' });
    await expect(coordinator.handleFinalizedRun(run({ nodeId: 'no-commit', outputCommitSha: null })))
      .resolves.toMatchObject({ kind: 'skipped', reason: 'no-commit' });
    await expect(coordinator.handleFinalizedRun(run({ nodeId: 'no-repo', repoPath: null })))
      .resolves.toMatchObject({ kind: 'skipped', reason: 'missing-repo' });

    expect(checkoutCommit).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledTimes(3);
  });
});

