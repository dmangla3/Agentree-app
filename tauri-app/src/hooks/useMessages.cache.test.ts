// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import { cleanupMessageBranchRunState, removeMessageBranchFromCache } from './useMessages';

const message = (overrides: Partial<Message> & Pick<Message, 'id'>): Message => ({
  id: overrides.id,
  role: overrides.role ?? 'assistant',
  content: overrides.content ?? '',
  parentId: overrides.parentId ?? null,
  workspaceId: overrides.workspaceId ?? 'workspace-1',
  createdAt: overrides.createdAt ?? '2026-05-28T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-05-28T00:00:00.000Z',
  status: overrides.status ?? null,
  execution_data: overrides.execution_data ?? null,
});

describe('removeMessageBranchFromCache', () => {
  afterEach(() => {
    agentRunManager.clearAll();
  });

  it('removes the deleted root and all cached descendants', () => {
    const messages = [
      message({ id: 'root' }),
      message({ id: 'deleted-root', parentId: 'root' }),
      message({ id: 'deleted-child', parentId: 'deleted-root' }),
      message({ id: 'deleted-grandchild', parentId: 'deleted-child' }),
      message({ id: 'sibling', parentId: 'root' }),
    ];

    const remaining = removeMessageBranchFromCache(messages, 'deleted-root');

    expect(remaining.map((item) => item.id)).toEqual(['root', 'sibling']);
  });

  it('clears deleted user and descendant projections so they cannot reappear', () => {
    const deletedUser = message({ id: 'deleted-user', role: 'user', parentId: 'root' });
    const deletedAssistant = message({ id: 'deleted-assistant', parentId: 'deleted-user' });
    const siblingUser = message({ id: 'sibling-user', role: 'user', parentId: 'root' });

    agentRunManager.seed(deletedUser);
    agentRunManager.seed(deletedAssistant);
    agentRunManager.seed(siblingUser);

    cleanupMessageBranchRunState(
      [siblingUser],
      deletedUser.id,
    );

    const projections = useAgentRunProjectionStore.getState().projectionsById;
    expect(projections[deletedUser.id]).toBeUndefined();
    expect(projections[deletedAssistant.id]).toBeUndefined();
    expect(projections[siblingUser.id]).toBeDefined();
  });
});
