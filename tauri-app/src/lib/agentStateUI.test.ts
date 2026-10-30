import { describe, expect, it } from 'vitest';
import { getAgentVisualState } from './agentStateUI';

describe('getAgentVisualState', () => {
  it.each([
    ['pending', 'Pending', false],
    ['creating', 'Creating', true],
    ['initializing', 'Initializing', true],
    ['preparing_worktree', 'Preparing worktree', true],
    ['running', 'Running', true],
    ['streaming', 'Running', true],
    ['finalizing', 'Finalizing', true],
    ['completed', 'Completed', false],
    ['failed', 'Failed', false],
    ['error', 'Error', false],
    ['failed_setup', 'Setup failed', false],
    ['failed_spawn', 'Spawn failed', false],
    ['failed_finalization', 'Finalization failed', false],
    ['failed_runtime', 'Runtime failed', false],
    ['cancelled', 'Cancelled', false],
  ])('maps %s to its user-facing status', (status, label, animate) => {
    const state = getAgentVisualState(status);

    expect(state.label).toBe(label);
    expect(state.animate).toBe(animate);
  });
});
