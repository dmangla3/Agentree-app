// @vitest-environment jsdom
import '../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScopedNodeContextMenu } from './ScopedNodeContextMenu';
import type { ProjectedCommitEntity, ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';

const makeGeneratedCommit = (): ProjectedCommitEntity => ({
  entityId: 'commit:abc123456789',
  kind: 'generated_commit',
  sha: 'abc123456789',
  shortSha: 'abc1234',
  subject: 'Agent generated commit',
  sourceKind: 'agent',
  ownerKind: 'agentree',
  placement: 'commit_lineage',
  producedByNodeId: 'assistant-1',
  visualOwnerNodeId: 'assistant-1',
  parentShas: ['parent123'],
  parentRows: [],
  isMerge: false,
  isProminentMerge: false,
  layoutParentSha: 'parent123',
  secondaryParentShas: [],
  observations: [],
  sortTs: 0,
  commit: {
    sha: 'abc123456789',
    workspace_id: 'workspace-1',
    subject: 'Agent generated commit',
  } as ProjectedCommitEntity['commit'],
});

const makeProjection = (commit: ProjectedCommitEntity, entities: ProjectedNodeEntity[] = []): WorkspaceProjection => ({
  messages: [],
  scopes: [],
  summaries: [],
  messageMap: new Map(),
  scopeColorById: new Map(),
  scopeNameById: new Map(),
  summaryMap: new Map(),
  entities,
  entitiesById: new Map(entities.map((entity) => [entity.entityId, entity])),
  entitiesByMessageId: new Map(entities.flatMap((entity) => entity.messageId ? [[entity.messageId, entity] as const] : [])),
  entitiesBySummaryId: new Map(),
  childEntityIdsByParentEntityId: new Map(),
  commitEntityIdsByAssistantEntityId: new Map(),
  commitBySha: new Map([[commit.sha, commit]]),
  commitLaneRows: [],
  layoutDerivedCommitGroups: [],
  groupIdByCommitSha: new Map(),
  threadRootIds: [],
  threadRootIdByMessageId: new Map(),
  turnGroups: [],
  turnGroupById: new Map(),
  originMessage: null,
  originMessageId: null,
} as unknown as WorkspaceProjection);

describe('ScopedNodeContextMenu', () => {
  it('adds a generated canonical commit sha to the merge panel', () => {
    const onAddCommitShasToMergePanel = vi.fn();
    const commit = makeGeneratedCommit();

    render(
      <ScopedNodeContextMenu
        contextMenu={{ x: 20, y: 30, scopedIds: [`commit:${commit.sha}`] }}
        projection={makeProjection(commit)}
        onClose={() => {}}
        onAddCommitShasToMergePanel={onAddCommitShasToMergePanel}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to merge panel' }));

    expect(onAddCommitShasToMergePanel).toHaveBeenCalledWith([commit.sha]);
  });

  it('does not show add-to-merge for conversation nodes', () => {
    const assistantEntity: ProjectedNodeEntity = {
      entityId: 'assistant_message:assistant-1',
      kind: 'assistant_message',
      messageId: 'assistant-1',
      focusMessageId: 'assistant-1',
      sortTs: 0,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Conversation reply',
        parentId: 'user-1',
        createdAt: '2026-05-19T00:00:00.000Z',
        updatedAt: '2026-05-19T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
      preview: 'Conversation reply',
      shortLabel: 'Assistant',
    };

    render(
      <ScopedNodeContextMenu
        contextMenu={{ x: 20, y: 30, scopedIds: ['assistant-1'] }}
        projection={makeProjection(makeGeneratedCommit(), [assistantEntity])}
        onClose={() => {}}
        onAddCommitShasToMergePanel={() => {}}
        onViewSubgraph={() => {}}
      />
    );

    expect(screen.queryByRole('menuitem', { name: 'Add to merge panel' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'View subgraph' })).toBeTruthy();
  });

  it('shows thread actions for a node with thread root metadata', () => {
    const onFocusThread = vi.fn();
    const onHideThread = vi.fn();
    const onHideSubgraph = vi.fn();
    const assistantEntity: ProjectedNodeEntity = {
      entityId: 'assistant_message:assistant-1',
      kind: 'assistant_message',
      messageId: 'assistant-1',
      focusMessageId: 'assistant-1',
      sortTs: 0,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Conversation reply',
        parentId: 'user-1',
        createdAt: '2026-05-19T00:00:00.000Z',
        updatedAt: '2026-05-19T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
      preview: 'Conversation reply',
      shortLabel: 'Assistant',
      threadRootId: 'user-root',
      isThreadRoot: false,
    };

    render(
      <ScopedNodeContextMenu
        contextMenu={{ x: 20, y: 30, scopedIds: ['assistant-1'] }}
        projection={makeProjection(makeGeneratedCommit(), [assistantEntity])}
        onClose={() => {}}
        onFocusThread={onFocusThread}
        onHideThread={onHideThread}
        onHideSubgraph={onHideSubgraph}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: 'Focus thread' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide thread' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide subgraph' }));

    expect(onFocusThread).toHaveBeenCalledWith('user-root');
    expect(onHideThread).toHaveBeenCalledWith('user-root');
    expect(onHideSubgraph).toHaveBeenCalledWith('assistant-1');
  });
});
