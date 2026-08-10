// @vitest-environment jsdom
import '../../../test/setup';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphNodeDispatcher } from './GraphNodeDispatcher';
import type { ProjectedCommitEntity, ProjectedCommitGroup, ProjectedNodeEntity } from '../../../domain/workspaceProjection';
import type { FocusTriggerMetrics } from '../../../types/nodes';

const workspaceStoreMock = vi.hoisted(() => ({
  selectedWorkspaceId: 'workspace-1',
  setComposerBaseCommitOverride: vi.fn(),
}));

vi.mock('./GraphCanonicalCommitNode', () => ({
  GraphCanonicalCommitNode: ({
    hoverCardContent,
    onFocus,
    onContextMenu,
  }: {
    hoverCardContent?: React.ReactNode;
    onFocus?: (metrics?: FocusTriggerMetrics) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onFocus?.({ clickAt: 10, pointerDownAt: 5 })}>canonical node</button>
      <button type="button" onContextMenu={(event) => onContextMenu?.(event)}>canonical menu target</button>
      {hoverCardContent}
    </div>
  ),
}));

vi.mock('./GraphUserNode', () => ({ GraphUserNode: () => <div /> }));
vi.mock('./GraphAssistantNode', () => ({ GraphAssistantNode: () => <div /> }));
vi.mock('./GraphCommitNode', () => ({
  GraphCommitNode: ({
    onContextMenu,
  }: {
    onContextMenu?: (event: React.MouseEvent) => void;
  }) => (
    <button type="button" onContextMenu={(event) => onContextMenu?.(event)}>commit message menu target</button>
  ),
}));
vi.mock('./GraphDerivedCommitGroupNode', () => ({
  GraphDerivedCommitGroupNode: ({
    onCommitSelectBase,
  }: {
    group: ProjectedCommitGroup;
    onCommitSelectBase?: (commit: ProjectedCommitEntity) => void;
  }) => (
    <button
      type="button"
      onClick={() => onCommitSelectBase?.({
        entityId: 'commit:abc123456789',
        kind: 'imported_commit',
        sha: 'abc123456789',
        shortSha: 'abc12345',
        subject: 'Imported canonical commit',
        sourceKind: 'external',
        ownerKind: 'external',
        placement: 'commit_lineage',
        producedByNodeId: null,
        visualOwnerNodeId: null,
        parentShas: [],
        parentRows: [],
        isMerge: false,
        isProminentMerge: false,
        layoutParentSha: null,
        secondaryParentShas: [],
        observations: [],
        sortTs: 0,
        commit: {
          sha: 'abc123456789',
          workspace_id: 'workspace-1',
          subject: 'Imported canonical commit',
        } as ProjectedCommitEntity['commit'],
      })}
    >
      derived commit group
    </button>
  ),
}));
vi.mock('./GraphSummaryNode', () => ({ GraphSummaryNode: () => <div /> }));

vi.mock('../../NodeHoverCardContent', () => ({
  NodeHoverCardContent: ({ entity }: { entity?: ProjectedNodeEntity }) => (
    <div>hover entity kind: {entity?.kind}</div>
  ),
}));

vi.mock('../../graph/GraphInteractionContext', () => ({
  useGraphInteractionContext: () => ({
    isSelectionGestureActive: false,
    isViewportInteracting: false,
  }),
}));

vi.mock('../../graph/GraphHoverProjectionContext', () => ({
  useGraphHoverProjectionInput: () => ({
    messages: [],
    scopes: [],
    summaries: [],
    disabledSummaryIds: new Set<string>(),
  }),
}));

vi.mock('../../../hooks/useWorkspaceProjection', () => ({
  useWorkspaceProjection: () => ({
    entitiesByMessageId: new Map(),
    entitiesBySummaryId: new Map(),
  }),
}));

vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: any) => selector({
    selectedWorkspaceId: workspaceStoreMock.selectedWorkspaceId,
    setComposerBaseCommitOverride: workspaceStoreMock.setComposerBaseCommitOverride,
  }),
}));

const makeCommit = (): ProjectedCommitEntity => ({
  entityId: 'commit:abc123456789',
  kind: 'imported_commit',
  sha: 'abc123456789',
  shortSha: 'abc12345',
  subject: 'Imported canonical commit',
  sourceKind: 'external',
  ownerKind: 'external',
  placement: 'commit_lineage',
  producedByNodeId: null,
  visualOwnerNodeId: null,
  parentShas: [],
  parentRows: [],
  isMerge: false,
  isProminentMerge: false,
  layoutParentSha: null,
  secondaryParentShas: [],
  observations: [],
  sortTs: 0,
  commit: {
    sha: 'abc123456789',
    workspace_id: 'workspace-1',
    subject: 'Imported canonical commit',
  } as ProjectedCommitEntity['commit'],
});

const makeGroup = (): ProjectedCommitGroup => ({
  groupId: 'commit-group:external:abc123456789:def987654321',
  kind: 'layout_derived_commit_group',
  sourceKind: 'external',
  commitShas: ['abc123456789', 'def987654321'],
  firstSha: 'abc123456789',
  lastSha: 'def987654321',
  parentSha: null,
  childSha: null,
  sortTs: 0,
  expanded: false,
});

describe('GraphNodeDispatcher', () => {
  beforeEach(() => {
    workspaceStoreMock.setComposerBaseCommitOverride.mockClear();
  });

  it('routes canonical commit hover content through the commit_message entity path', () => {
    const props = {
      id: 'abc123456789',
      type: 'canonical_commit',
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        commit: makeCommit(),
        isSelected: false,
        onFocus: () => {},
        onSelect: () => {},
        onContextMenu: () => {},
      },
    };

    render(
      React.createElement(GraphNodeDispatcher as any, props)
    );

    expect(screen.getByText('canonical node')).toBeTruthy();
    expect(screen.getByText('hover entity kind: commit_message')).toBeTruthy();
  });

  it('focuses canonical commits with commit metadata for composer base resolution', () => {
    const onFocus = vi.fn();
    const props = {
      id: 'abc123456789',
      type: 'canonical_commit',
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        commit: makeCommit(),
        isSelected: false,
        onFocus,
        onSelect: () => {},
        onContextMenu: () => {},
      },
    };

    render(
      React.createElement(GraphNodeDispatcher as any, props)
    );

    fireEvent.click(screen.getByRole('button', { name: 'canonical node' }));

    expect(onFocus).toHaveBeenCalledWith('abc123456789', {
      clickAt: 10,
      pointerDownAt: 5,
      metadata: { commitSha: 'abc123456789' },
    });
  });

  it('opens the scoped context menu for canonical commits by commit token', () => {
    const onContextMenu = vi.fn();
    const props = {
      id: 'abc123456789',
      type: 'canonical_commit',
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        commit: makeCommit(),
        isSelected: false,
        onFocus: () => {},
        onSelect: () => {},
        onContextMenu,
      },
    };

    render(
      React.createElement(GraphNodeDispatcher as any, props)
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: 'canonical menu target' }));

    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0][0]).toBe('commit:abc123456789');
  });

  it('opens the scoped context menu for commit-message cards by commit token, not parent conversation node', () => {
    const onContextMenu = vi.fn();
    const props = {
      id: 'assistant-1:output-commit',
      type: 'commit_message',
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        entity: {
          entityId: 'commit_message:assistant-1:output',
          kind: 'commit_message',
          messageId: 'assistant-1:commit',
          focusMessageId: 'assistant-1',
          sortTs: 0,
          message: {
            id: 'assistant-1:commit',
            role: 'assistant',
            content: 'Generated commit',
            parentId: 'assistant-1',
            output_commit_sha: 'feedface12345678',
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
          },
          preview: 'Generated commit',
          shortLabel: 'feedface',
          shortSha: 'feedface',
        },
        isSelected: false,
        onFocus: () => {},
        onSelect: () => {},
        onContextMenu,
      },
    };

    render(
      React.createElement(GraphNodeDispatcher as any, props)
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: 'commit message menu target' }));

    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0][0]).toBe('commit:feedface12345678');
  });

  it('selects a clicked derived commit group row as composer base without changing graph focus', () => {
    const onFocus = vi.fn();
    const props = {
      id: 'commit-group:external:abc123456789:def987654321',
      type: 'layout_derived_commit_group',
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        group: makeGroup(),
        isSelected: false,
        onFocus,
        onSelect: () => {},
        onContextMenu: () => {},
      },
    };

    render(
      React.createElement(GraphNodeDispatcher as any, props)
    );

    fireEvent.click(screen.getByRole('button', { name: 'derived commit group' }));

    expect(onFocus).not.toHaveBeenCalled();
    expect(workspaceStoreMock.setComposerBaseCommitOverride).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      commitSha: 'abc123456789',
      label: 'Imported canonical commit',
      source: 'graph-header',
    });
  });
});
