import { describe, expect, it } from 'vitest';
import { getAgentVisualState } from './agentStateUI';

describe('getAgentVisualState', () => {
  it.each([
    ['pending', 'Pending', false, 'text-amber-500'],
    ['creating', 'Creating', true, 'text-amber-500'],
    ['initializing', 'Initializing', true, 'text-amber-500'],
    ['preparing_worktree', 'Preparing worktree', true, 'text-amber-500'],
    ['running', 'Running', true, 'text-blue-500'],
    ['streaming', 'Running', true, 'text-blue-500'],
    ['finalizing', 'Finalizing', true, 'text-blue-500'],
    ['completed', 'Completed', false, 'text-emerald-500'],
    ['failed', 'Failed', false, 'text-red-500'],
    ['error', 'Error', false, 'text-red-500'],
    ['failed_setup', 'Setup failed', false, 'text-red-500'],
    ['failed_spawn', 'Spawn failed', false, 'text-red-500'],
    ['failed_finalization', 'Finalization failed', false, 'text-red-500'],
    ['failed_runtime', 'Runtime failed', false, 'text-red-500'],
    ['cancelled', 'Cancelled', false, 'text-slate-500'],
  ])('maps %s to an explicit visual state', (status, label, animate, colorClass) => {
    const state = getAgentVisualState(status);

    expect(state.label).toBe(label);
    expect(state.animate).toBe(animate);
    expect(state.colorClass).toBe(colorClass);
  });
});
