import { describe, expect, it } from 'vitest';
import {
  materializePersistedOptimisticUserMessage,
  shouldClearPersistedOptimisticUserProjection,
} from './agentRunOptimisticProjectionCleanup';

const projection = (overrides: Record<string, any> = {}) => ({
  id: 'user-1',
  workspaceId: 'workspace-1',
  parentId: 'parent-1',
  role: 'user',
  content: 'hello',
  status: 'initializing',
  createdAt: '2026-05-19T00:00:00.000Z',
  updatedAt: '2026-05-19T00:00:00.000Z',
  _optimistic: true,
  _optimisticStatus: 'initializing',
  ...overrides,
}) as any;

const persisted = (overrides: Record<string, any> = {}) => ({
  id: 'user-1',
  workspaceId: 'workspace-1',
  parentId: 'parent-1',
  role: 'user',
  content: 'hello',
  status: null,
  createdAt: '2026-05-19T00:00:00.000Z',
  updatedAt: '2026-05-19T00:00:00.000Z',
  ...overrides,
}) as any;

describe('optimistic projection cleanup', () => {
  it('materializes optimistic users as neutral persisted messages', () => {
    const message = materializePersistedOptimisticUserMessage(projection({
      status: 'initializing',
      execution_data: undefined,
      _setupProgress: 'Starting locally...',
    }));

    expect(message).toMatchObject({
      id: 'user-1',
      role: 'user',
      status: null,
      execution_data: null,
    });
    expect(message).not.toHaveProperty('_optimistic');
    expect(message).not.toHaveProperty('_optimisticStatus');
    expect(message).not.toHaveProperty('_setupProgress');
  });

  it('clears local-first optimistic user overlays once the user message is persisted', () => {
    expect(shouldClearPersistedOptimisticUserProjection(
      projection(),
      persisted(),
      'workspace-1',
    )).toBe(true);
  });

  it('does not clear assistant overlays or non-persisted user overlays', () => {
    expect(shouldClearPersistedOptimisticUserProjection(
      projection({ role: 'assistant' }),
      persisted({ role: 'assistant' }),
      'workspace-1',
    )).toBe(false);

    expect(shouldClearPersistedOptimisticUserProjection(
      projection(),
      null,
      'workspace-1',
    )).toBe(false);

    expect(shouldClearPersistedOptimisticUserProjection(
      projection({ _optimistic: false }),
      persisted(),
      'workspace-1',
    )).toBe(false);
  });

  it('keeps projections tied to the selected workspace and same persisted node id', () => {
    expect(shouldClearPersistedOptimisticUserProjection(
      projection(),
      persisted({ id: 'other-user' }),
      'workspace-1',
    )).toBe(false);

    expect(shouldClearPersistedOptimisticUserProjection(
      projection(),
      persisted({ workspaceId: 'workspace-2' }),
      'workspace-1',
    )).toBe(false);

    expect(shouldClearPersistedOptimisticUserProjection(
      projection({ workspaceId: 'workspace-2' }),
      persisted(),
      'workspace-1',
    )).toBe(false);
  });
});
