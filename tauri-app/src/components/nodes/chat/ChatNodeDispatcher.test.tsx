// @vitest-environment jsdom
import '../../../test/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatNodeDispatcher } from './ChatNodeDispatcher';
import type { ProjectedNodeEntity } from '../../../domain/workspaceProjection';

vi.mock('./ChatUserCard', () => ({
  ChatUserCard: ({ entity }: { entity: ProjectedNodeEntity }) => <div>User card: {entity.preview}</div>,
}));

vi.mock('./ChatAssistantCard', () => ({
  ChatAssistantCard: ({ entity }: { entity: ProjectedNodeEntity }) => <div>Assistant card: {entity.preview}</div>,
}));

vi.mock('./ChatCommitCard', () => ({
  ChatCommitCard: ({ entity }: { entity: ProjectedNodeEntity }) => <div>Commit card: {entity.preview}</div>,
}));

vi.mock('./ChatSummaryCard', () => ({
  ChatSummaryCard: ({ entity }: { entity: ProjectedNodeEntity }) => <div>Summary card: {entity.preview}</div>,
}));

const makeProjection = () => ({
  entitiesById: new Map<string, ProjectedNodeEntity>(),
});

describe('ChatNodeDispatcher', () => {
  it('renders an override entity even when it is absent from projection maps', () => {
    const syntheticCommitEntity: ProjectedNodeEntity = {
      entityId: 'commit_message:assistant-1:output',
      kind: 'commit_message',
      messageId: 'commit:assistant-1',
      focusMessageId: 'assistant-1',
      parentEntityId: 'message:assistant-1',
      turnGroupId: 'turn-1',
      sortTs: 1,
      preview: 'Generated sidecar commit',
      shortLabel: 'abc12345',
      shortSha: 'abc12345',
      status: null,
      message: {
        id: 'commit:assistant-1',
        role: 'assistant',
        content: 'Generated sidecar commit',
        workspaceId: 'workspace-1',
        parentId: 'assistant-1',
        createdAt: '2026-05-16T00:00:00.000Z',
        updatedAt: '2026-05-16T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
    };

    render(
      <ChatNodeDispatcher
        entityId={syntheticCommitEntity.entityId}
        entityOverride={syntheticCommitEntity}
        projection={makeProjection()}
        focusedMessageId={null}
        isSelected={false}
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByText('Commit card: Generated sidecar commit')).toBeTruthy();
  });
});
