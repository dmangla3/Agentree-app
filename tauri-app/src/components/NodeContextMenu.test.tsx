// @vitest-environment jsdom
import '../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NodeContextMenu, resolveNodeContextMenuActions } from './NodeContextMenu';
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
  ownerThreadRootId: 'user-root',
  parentShas: ['parent123'],
  parentRows: [],
  isMerge: false,
  isProminentMerge: false,
  layoutParentSha: 'parent123',
  secondaryParentShas: [],
  observations: [],
  sortTs: 0,
  representedThreadRootIds: [],
  commit: {
    sha: 'abc123456789',
    workspace_id: 'workspace-1',
    subject: 'Agent generated commit',
  } as ProjectedCommitEntity['commit'],
});

const makeProjection = (commit: ProjectedCommitEntity | null, entities: ProjectedNodeEntity[] = []): WorkspaceProjection => {
  const messages = entities.flatMap((entity) => entity.message ? [entity.message] : []);
  return {
    messages,
    summaries: [],
    messageMap: new Map(messages.map((message) => [message.id, message])),
    summaryMap: new Map(),
    entities,
    entitiesById: new Map(entities.map((entity) => [entity.entityId, entity])),
    entitiesByMessageId: new Map(entities.flatMap((entity) => entity.messageId ? [[entity.messageId, entity] as const] : [])),
    entitiesBySummaryId: new Map(),
    childEntityIdsByParentEntityId: new Map(),
    commitEntityIdsByAssistantEntityId: new Map(),
    commitBySha: new Map(commit ? [[commit.sha, commit]] : []),
    commitLaneRows: [],
    layoutDerivedCommitGroups: [],
    groupIdByCommitSha: new Map(),
    threadRootIds: [],
    threadRootIdByMessageId: new Map(entities.flatMap((entity) => (
      entity.messageId && entity.threadRootId ? [[entity.messageId, entity.threadRootId] as const] : []
    ))),
    rootMessageIdByThreadRootId: new Map(),
    turnGroups: [],
    turnGroupById: new Map(),
    originMessage: null,
    originMessageId: null,
  } as unknown as WorkspaceProjection;
};

describe('NodeContextMenu', () => {
  it('opens a terminal at the selected canonical commit', () => {
    const onOpenTerminal = vi.fn();
    const onClose = vi.fn();
    const commit = makeGeneratedCommit();

    render(
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: [`commit:${commit.sha}`] }}
        projection={makeProjection(commit)}
        onClose={onClose}
        onOpenTerminal={onOpenTerminal}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: 'Open terminal here' }));

    expect(onOpenTerminal).toHaveBeenCalledWith(commit.sha);
    expect(onClose).toHaveBeenCalled();
  });

  it('adds a generated canonical commit sha to the merge panel', () => {
    const onAddCommitShasToMergePanel = vi.fn();
    const commit = makeGeneratedCommit();

    render(
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: [`commit:${commit.sha}`] }}
        projection={makeProjection(commit)}
        onClose={() => {}}
        onAddCommitShasToMergePanel={onAddCommitShasToMergePanel}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to merge panel' }));

    expect(onAddCommitShasToMergePanel).toHaveBeenCalledWith([commit.sha]);
  });

  it('closes the action owner thread by default when adding a graph commit to the merge panel', () => {
    const onAddCommitShasToMergePanel = vi.fn();
    const onMarkThreadDone = vi.fn();
    const commit = makeGeneratedCommit();
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
        parentId: 'user-root',
        createdAt: '2026-05-19T00:00:00.000Z',
        updatedAt: '2026-05-19T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
      preview: 'Conversation reply',
      shortLabel: 'Assistant',
      threadRootId: 'user-root',
      isThreadRoot: false,
    };

    render(
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: [`commit:${commit.sha}`] }}
        projection={makeProjection(commit, [assistantEntity])}
        onClose={() => {}}
        onAddCommitShasToMergePanel={onAddCommitShasToMergePanel}
        onMarkThreadDone={onMarkThreadDone}
      />
    );

    const markDoneCheckbox = screen.getByRole('menuitemcheckbox', { name: 'Close thread' });
    expect(markDoneCheckbox.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to merge panel' }));

    expect(onAddCommitShasToMergePanel).toHaveBeenCalledWith([commit.sha]);
    expect(onMarkThreadDone).toHaveBeenCalledWith('user-root');
  });

  it('keeps the action owner thread open when the merge-panel close-thread option is unchecked', () => {
    const onAddCommitShasToMergePanel = vi.fn();
    const onMarkThreadDone = vi.fn();
    const commit = makeGeneratedCommit();
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
        parentId: 'user-root',
        createdAt: '2026-05-19T00:00:00.000Z',
        updatedAt: '2026-05-19T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
      preview: 'Conversation reply',
      shortLabel: 'Assistant',
      threadRootId: 'user-root',
      isThreadRoot: false,
    };

    render(
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: [`commit:${commit.sha}`] }}
        projection={makeProjection(commit, [assistantEntity])}
        onClose={() => {}}
        onAddCommitShasToMergePanel={onAddCommitShasToMergePanel}
        onMarkThreadDone={onMarkThreadDone}
      />
    );

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Close thread' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to merge panel' }));

    expect(onAddCommitShasToMergePanel).toHaveBeenCalledWith([commit.sha]);
    expect(onMarkThreadDone).not.toHaveBeenCalled();
  });

  it('does not infer a close-thread owner from represented merge threads', () => {
    const onMarkThreadDone = vi.fn();
    const externalMerge: ProjectedCommitEntity = {
      ...makeGeneratedCommit(),
      sha: 'merge123456789',
      entityId: 'commit:merge123456789',
      sourceKind: 'external',
      ownerKind: 'external',
      producedByNodeId: null,
      visualOwnerNodeId: null,
      ownerThreadRootId: null,
      isMerge: true,
      representedThreadRootIds: ['thread-a', 'thread-b'],
    };

    render(
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: [`commit:${externalMerge.sha}`] }}
        projection={makeProjection(externalMerge)}
        onClose={() => {}}
        onAddCommitShasToMergePanel={() => {}}
        onMarkThreadDone={onMarkThreadDone}
      />
    );

    expect(screen.queryByRole('menuitemcheckbox', { name: 'Close thread' })).toBeNull();
  });

  it('resolves commit-message merge ownership without a canonical commit row', () => {
    const commitSha = '4b1a8a1ce0a05626fbe975b6de73770dcb9755a4';
    const commitEntity: ProjectedNodeEntity = {
      entityId: 'commit_message:assistant-commit',
      kind: 'commit_message',
      messageId: 'assistant-commit',
      focusMessageId: 'assistant-commit',
      sortTs: 0,
      message: {
        id: 'assistant-commit',
        role: 'assistant',
        content: 'Generated commit',
        parentId: 'user-root',
        output_commit_sha: commitSha,
        createdAt: '2026-05-31T00:00:00.000Z',
        updatedAt: '2026-05-31T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
      preview: 'Generated commit',
      shortLabel: 'Commit',
      threadRootId: 'user-root',
      isThreadRoot: false,
    };

    expect(resolveNodeContextMenuActions(makeProjection(null, [commitEntity]), [`commit:${commitSha}`]).mergeThreadRootId)
      .toBe('user-root');
  });

  it('closes the visible commit-message thread when the commit row is missing', () => {
    const onAddCommitShasToMergePanel = vi.fn();
    const onMarkThreadDone = vi.fn();
    const commitSha = '4b1a8a1ce0a05626fbe975b6de73770dcb9755a4';
    const commitEntity: ProjectedNodeEntity = {
      entityId: 'commit_message:assistant-commit',
      kind: 'commit_message',
      messageId: 'assistant-commit',
      focusMessageId: 'assistant-commit',
      sortTs: 0,
      message: {
        id: 'assistant-commit',
        role: 'assistant',
        content: 'Generated commit',
        parentId: 'user-root',
        output_commit_sha: commitSha,
        createdAt: '2026-05-31T00:00:00.000Z',
        updatedAt: '2026-05-31T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
      preview: 'Generated commit',
      shortLabel: 'Commit',
      threadRootId: 'user-root',
      isThreadRoot: false,
    };

    render(
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: [`commit:${commitSha}`] }}
        projection={makeProjection(null, [commitEntity])}
        onClose={() => {}}
        onAddCommitShasToMergePanel={onAddCommitShasToMergePanel}
        onMarkThreadDone={onMarkThreadDone}
      />
    );

    expect(screen.getByRole('menuitemcheckbox', { name: 'Close thread' })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to merge panel' }));

    expect(onAddCommitShasToMergePanel).toHaveBeenCalledWith([commitSha]);
    expect(onMarkThreadDone).toHaveBeenCalledWith('user-root');
  });

  it('resolves synthetic assistant commit node ids to the assistant output commit', () => {
    const onAddCommitShasToMergePanel = vi.fn();
    const onMarkThreadDone = vi.fn();
    const commitSha = '3f162b1234567890';
    const assistantEntity: ProjectedNodeEntity = {
      entityId: 'assistant_message:assistant-output',
      kind: 'assistant_message',
      messageId: 'assistant-output',
      focusMessageId: 'assistant-output',
      sortTs: 0,
      message: {
        id: 'assistant-output',
        role: 'assistant',
        content: 'Created a file.',
        parentId: 'user-root',
        output_commit_sha: commitSha,
        createdAt: '2026-06-14T00:00:00.000Z',
        updatedAt: '2026-06-14T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
      preview: 'Created a file.',
      shortLabel: 'Assistant',
      threadRootId: 'user-root',
      isThreadRoot: false,
    };

    render(
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: ['commit:assistant-output'] }}
        projection={makeProjection(null, [assistantEntity])}
        onClose={() => {}}
        onAddCommitShasToMergePanel={onAddCommitShasToMergePanel}
        onMarkThreadDone={onMarkThreadDone}
      />
    );

    expect(screen.getByRole('menuitemcheckbox', { name: 'Close thread' })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to merge panel' }));

    expect(onAddCommitShasToMergePanel).toHaveBeenCalledWith([commitSha]);
    expect(onMarkThreadDone).toHaveBeenCalledWith('user-root');
  });

  it('resolves output commit sha ownership from a visible assistant node without a canonical commit row', () => {
    const onAddCommitShasToMergePanel = vi.fn();
    const onMarkThreadDone = vi.fn();
    const commitSha = '3f162b1234567890';
    const assistantEntity: ProjectedNodeEntity = {
      entityId: 'assistant_message:assistant-output',
      kind: 'assistant_message',
      messageId: 'assistant-output',
      focusMessageId: 'assistant-output',
      sortTs: 0,
      message: {
        id: 'assistant-output',
        role: 'assistant',
        content: 'Created a file.',
        parentId: 'user-root',
        output_commit_sha: commitSha,
        createdAt: '2026-06-14T00:00:00.000Z',
        updatedAt: '2026-06-14T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
      preview: 'Created a file.',
      shortLabel: 'Assistant',
      threadRootId: 'user-root',
      isThreadRoot: false,
    };

    render(
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: [`commit:${commitSha}`] }}
        projection={makeProjection(null, [assistantEntity])}
        onClose={() => {}}
        onAddCommitShasToMergePanel={onAddCommitShasToMergePanel}
        onMarkThreadDone={onMarkThreadDone}
      />
    );

    expect(screen.getByRole('menuitemcheckbox', { name: 'Close thread' })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to merge panel' }));

    expect(onAddCommitShasToMergePanel).toHaveBeenCalledWith([commitSha]);
    expect(onMarkThreadDone).toHaveBeenCalledWith('user-root');
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
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: ['assistant-1'] }}
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
    const onMarkThreadDone = vi.fn();
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
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: ['assistant-1'] }}
        projection={makeProjection(makeGeneratedCommit(), [assistantEntity])}
        onClose={() => {}}
        onFocusThread={onFocusThread}
        onMarkThreadDone={onMarkThreadDone}
        onHideSubgraph={onHideSubgraph}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: 'Focus thread' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close thread' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide subgraph' }));

    expect(onFocusThread).toHaveBeenCalledWith('user-root');
    expect(onMarkThreadDone).toHaveBeenCalledWith('user-root');
    expect(onHideSubgraph).toHaveBeenCalledWith('assistant-1');
  });

  it('shows convert-subgraph only for nested user nodes', () => {
    const onConvertSubgraphToThread = vi.fn();
    const userEntity: ProjectedNodeEntity = {
      entityId: 'user_message:user-2',
      kind: 'user_message',
      messageId: 'user-2',
      focusMessageId: 'user-2',
      sortTs: 0,
      message: {
        id: 'user-2',
        role: 'user',
        content: 'Nested follow-up',
        parentId: 'assistant-1',
        createdAt: '2026-05-19T00:00:00.000Z',
        updatedAt: '2026-05-19T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
      preview: 'Nested follow-up',
      shortLabel: 'User',
      threadRootId: 'user-root',
      isThreadRoot: false,
    };

    render(
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: ['user-2'] }}
        projection={makeProjection(makeGeneratedCommit(), [userEntity])}
        onClose={() => {}}
        onConvertSubgraphToThread={onConvertSubgraphToThread}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert subgraph to thread' }));

    expect(onConvertSubgraphToThread).toHaveBeenCalledWith('user-2');
  });

  it('does not show convert-subgraph for assistant nodes or root user nodes', () => {
    const onConvertSubgraphToThread = vi.fn();
    const assistantEntity: ProjectedNodeEntity = {
      entityId: 'assistant_message:assistant-1',
      kind: 'assistant_message',
      messageId: 'assistant-1',
      focusMessageId: 'assistant-1',
      sortTs: 0,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Assistant reply',
        parentId: 'user-root',
        createdAt: '2026-05-19T00:00:00.000Z',
        updatedAt: '2026-05-19T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
      preview: 'Assistant reply',
      shortLabel: 'Assistant',
      threadRootId: 'user-root',
      isThreadRoot: false,
    };
    const rootUserEntity: ProjectedNodeEntity = {
      entityId: 'user_message:user-root',
      kind: 'user_message',
      messageId: 'user-root',
      focusMessageId: 'user-root',
      sortTs: 0,
      message: {
        id: 'user-root',
        role: 'user',
        content: 'Root prompt',
        parentId: null,
        createdAt: '2026-05-19T00:00:00.000Z',
        updatedAt: '2026-05-19T00:00:00.000Z',
      } as ProjectedNodeEntity['message'],
      preview: 'Root prompt',
      shortLabel: 'User',
      threadRootId: 'user-root',
      isThreadRoot: true,
    };

    const { rerender } = render(
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: ['assistant-1'] }}
        projection={makeProjection(makeGeneratedCommit(), [assistantEntity])}
        onClose={() => {}}
        onConvertSubgraphToThread={onConvertSubgraphToThread}
        onViewSubgraph={() => {}}
      />
    );
    expect(screen.queryByRole('menuitem', { name: 'Convert subgraph to thread' })).toBeNull();

    rerender(
      <NodeContextMenu
        contextMenu={{ x: 20, y: 30, targetIds: ['user-root'] }}
        projection={makeProjection(makeGeneratedCommit(), [rootUserEntity])}
        onClose={() => {}}
        onConvertSubgraphToThread={onConvertSubgraphToThread}
        onViewSubgraph={() => {}}
      />
    );
    expect(screen.queryByRole('menuitem', { name: 'Convert subgraph to thread' })).toBeNull();
  });

});
