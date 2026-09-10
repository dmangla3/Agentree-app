// @vitest-environment jsdom
import '../test/setup';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppNodeHoverPreview } from './AppNodeHoverPreview';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';

vi.mock('./NodePreviewRenderer', () => ({
  NodePreviewRenderer: ({ entity }: { entity: ProjectedNodeEntity }) => (
    <div data-testid="hover-preview-content">
      {entity.message?.content ?? ''}
    </div>
  ),
}));

const entity = (): ProjectedNodeEntity => ({
  entityId: 'message:assistant-1',
  kind: 'assistant_message',
  messageId: 'assistant-1',
  focusMessageId: 'assistant-1',
  turnGroupId: 'turn-1',
  sortTs: 1,
  preview: 'Persisted content',
  shortLabel: 'Persisted content',
  status: 'running' as any,
  message: {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Persisted content',
    parentId: 'user-1',
    workspaceId: 'workspace-1',
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
    status: 'running' as any,
    tags: [],
  } as any,
});

// User node whose click-navigation target (focusMessageId) is the child assistant
// message, mirroring how workspaceProjection redirects user clicks to the reply.
const userEntity = (): ProjectedNodeEntity => ({
  entityId: 'message:user-1',
  kind: 'user_message',
  messageId: 'user-1',
  focusMessageId: 'assistant-1',
  turnGroupId: 'turn-1',
  sortTs: 0,
  preview: 'User prompt',
  shortLabel: 'User prompt',
  status: 'running' as any,
  message: {
    id: 'user-1',
    role: 'user',
    content: 'User prompt',
    parentId: null,
    workspaceId: 'workspace-1',
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
    status: 'running' as any,
    tags: [],
  } as any,
});

describe('AppNodeHoverPreview', () => {
  afterEach(() => {
    useAgentRunProjectionStore.getState().clearAllProjections();
  });

  it('updates an open hover preview from live projection store changes', () => {
    render(
      <AppNodeHoverPreview
        entity={entity()}
        projection={{} as WorkspaceProjection}
      />
    );

    expect(screen.getByTestId('hover-preview-content').textContent).toBe('Persisted content');

    act(() => {
      useAgentRunProjectionStore.getState().setProjectionForNode('assistant-1', {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Live projection update',
        parentId: 'user-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-05-16T00:00:00.000Z',
        updatedAt: '2026-05-16T00:00:01.000Z',
        status: 'streaming' as any,
        _optimisticStatus: 'streaming' as any,
        tags: [],
      } as any);
    });

    expect(screen.getByTestId('hover-preview-content').textContent).toBe('Live projection update');
  });

  it('does not borrow live content from a user node focus target (regression)', () => {
    // Prime the assistant message slot, as hovering the assistant node would.
    act(() => {
      useAgentRunProjectionStore.getState().setProjectionForNode('assistant-1', {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Assistant live reply',
        parentId: 'user-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-05-16T00:00:00.000Z',
        updatedAt: '2026-05-16T00:00:01.000Z',
        status: 'streaming' as any,
        _optimisticStatus: 'streaming' as any,
        tags: [],
      } as any);
    });

    render(
      <AppNodeHoverPreview
        entity={userEntity()}
        projection={{} as WorkspaceProjection}
      />
    );

    // The user node must show its own prompt, not the assistant's live content.
    expect(screen.getByTestId('hover-preview-content').textContent).toBe('User prompt');
  });
});
