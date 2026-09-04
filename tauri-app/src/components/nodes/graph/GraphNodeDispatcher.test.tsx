// @vitest-environment jsdom
import '../../../test/setup';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphNodeDispatcher } from './GraphNodeDispatcher';
import type { ProjectedCommitEntity, ProjectedCommitGroup, ProjectedNodeEntity } from '../../../domain/workspaceProjection';
import type { FocusTriggerMetrics } from '../../../types/nodes';
import { GRAPH_COMPOSER_DOCK_EXPAND_EVENT } from '../../../lib/graphComposerDockEvents';

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

vi.mock('./GraphUserNode', () => ({
  GraphUserNode: ({
    detailLevel,
    focusFeedbackEnabled,
    hoverCardContent,
    onFocus,
    onContextMenu,
  }: {
    detailLevel?: string;
    focusFeedbackEnabled?: boolean;
    hoverCardContent?: React.ReactNode;
    onFocus?: (metrics?: FocusTriggerMetrics) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
  }) => (
    <div>
      <div data-testid="user-detail">{detailLevel ?? 'none'}</div>
      <div data-testid="user-focus-feedback">{String(focusFeedbackEnabled ?? true)}</div>
      <button type="button" onClick={() => onFocus?.({ clickAt: 12, pointerDownAt: 8 })}>user node</button>
      <button type="button" onContextMenu={(event) => onContextMenu?.(event)}>user menu target</button>
      {hoverCardContent}
    </div>
  ),
}));
vi.mock('./GraphAssistantNode', () => ({
  GraphAssistantNode: ({
    onFocus,
  }: {
    onFocus?: (metrics?: FocusTriggerMetrics) => void;
  }) => (
    <button type="button" onClick={() => onFocus?.({ clickAt: 14, pointerDownAt: 9 })}>assistant node</button>
  ),
}));
vi.mock('./GraphThreadOriginNode', () => ({
  GraphThreadOriginNode: ({
    hoverCardContent,
  }: {
    hoverCardContent?: React.ReactNode;
  }) => (
    <div>
      <div>thread origin node</div>
      {hoverCardContent}
    </div>
  ),
}));
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
        ownerThreadRootId: null,
        parentShas: [],
        parentRows: [],
        isMerge: false,
        isProminentMerge: false,
        layoutParentSha: null,
        secondaryParentShas: [],
        observations: [],
        sortTs: 0,
        representedThreadRootIds: [],
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
vi.mock('./GraphThreadLinkNode', () => ({
  GraphThreadLinkNode: ({
    onFocus,
  }: {
    onFocus?: (metrics?: FocusTriggerMetrics) => void;
  }) => (
    <button type="button" onClick={() => onFocus?.({ clickAt: 16, pointerDownAt: 11 })}>thread link node</button>
  ),
}));

vi.mock('../../NodeHoverCardContent', () => ({
  NodeHoverCardContent: ({ entity }: { entity?: ProjectedNodeEntity }) => (
    <div>hover entity kind: {entity?.kind}</div>
  ),
  preloadNodeHoverPreview: vi.fn(),
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
  ownerThreadRootId: null,
  parentShas: [],
  parentRows: [],
  isMerge: false,
  isProminentMerge: false,
  layoutParentSha: null,
  secondaryParentShas: [],
  observations: [],
  sortTs: 0,
  representedThreadRootIds: [],
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

  it('opens the context menu for canonical commits by commit token', () => {
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

  it('opens the context menu for commit-message cards by commit token, not parent conversation node', () => {
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

  it('opens redirected user-node context menus by concrete message id, not focus target', () => {
    const onContextMenu = vi.fn();
    const props = {
      id: 'user-1',
      type: 'user_message',
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        entity: {
          entityId: 'user_message:user-1',
          kind: 'user_message',
          messageId: 'user-1',
          focusMessageId: 'assistant-1',
          sortTs: 0,
          message: {
            id: 'user-1',
            role: 'user',
            content: 'Continue',
            parentId: 'assistant-parent',
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
          },
          preview: 'Continue',
          shortLabel: 'User',
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

    fireEvent.contextMenu(screen.getByRole('button', { name: 'user menu target' }));

    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0][0]).toBe('user-1');
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

  it('passes graph detail level to rendered node cards and keeps low-detail hover content available', () => {
    const props = {
      id: 'user-1',
      type: 'user_message',
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        entity: {
          entityId: 'message:user-1',
          kind: 'user_message',
          messageId: 'user-1',
          focusMessageId: 'user-1',
          sortTs: 0,
          message: {
            id: 'user-1',
            role: 'user',
            content: 'Create a dense graph',
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
          },
          preview: 'Create a dense graph',
          shortLabel: 'User',
        },
        detailLevel: 'minimal',
        isSelected: false,
        onFocus: () => {},
        onSelect: () => {},
        onContextMenu: () => {},
      },
    };

    render(
      React.createElement(GraphNodeDispatcher as any, props)
    );

    expect(screen.getByTestId('user-detail').textContent).toBe('minimal');
    expect(screen.getByText('hover entity kind: user_message')).toBeTruthy();
  });

  it('does not show local focus feedback on user nodes that redirect focus to an assistant', () => {
    const props = {
      id: 'user-1',
      type: 'user_message',
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        entity: {
          entityId: 'message:user-1',
          kind: 'user_message',
          messageId: 'user-1',
          focusMessageId: 'assistant-1',
          sortTs: 0,
          message: {
            id: 'user-1',
            role: 'user',
            content: 'Create a dense graph',
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
          },
          preview: 'Create a dense graph',
          shortLabel: 'User',
        },
        isSelected: false,
        onFocus: () => {},
        onSelect: () => {},
        onContextMenu: () => {},
      },
    };

    render(
      React.createElement(GraphNodeDispatcher as any, props)
    );

    expect(screen.getByTestId('user-focus-feedback').textContent).toBe('false');
  });

  it('expands the graph composer dock when user and assistant message cards receive focus', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const makeProps = (kind: 'user_message' | 'assistant_message', id: string) => ({
      id,
      type: kind,
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        entity: {
          entityId: `message:${id}`,
          kind,
          messageId: id,
          focusMessageId: id,
          sortTs: 0,
          message: {
            id,
            role: kind === 'user_message' ? 'user' : 'assistant',
            content: 'Conversation message',
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
          },
          preview: 'Conversation message',
          shortLabel: kind === 'user_message' ? 'User' : 'Assistant',
        },
        isSelected: false,
        onFocus: () => {},
        onSelect: () => {},
        onContextMenu: () => {},
      },
    });

    render(
      <>
        {React.createElement(GraphNodeDispatcher as any, makeProps('user_message', 'user-1'))}
        {React.createElement(GraphNodeDispatcher as any, makeProps('assistant_message', 'assistant-1'))}
      </>
    );

    fireEvent.click(screen.getByRole('button', { name: 'user node' }));
    fireEvent.click(screen.getByRole('button', { name: 'assistant node' }));

    expect(dispatchSpy.mock.calls.filter(([event]) => event.type === GRAPH_COMPOSER_DOCK_EXPAND_EVENT)).toHaveLength(2);
  });

  it('opens converted subgraph thread links through the thread switch callback', () => {
    const onFocus = vi.fn();
    const onOpenThread = vi.fn();
    const props = {
      id: 'thread-link:user-2',
      type: 'thread_link',
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        entity: {
          entityId: 'thread_link:user-2',
          kind: 'thread_link',
          messageId: 'thread-link:user-2',
          focusMessageId: 'user-2',
          sortTs: 0,
          message: {
            id: 'thread-link:user-2',
            role: 'user',
            content: 'Nested follow-up',
            parentId: 'assistant-1',
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
          },
          preview: 'Nested follow-up',
          shortLabel: 'Thread',
          threadRootId: 'user-2',
        },
        isSelected: false,
        onFocus,
        onOpenThread,
        onSelect: () => {},
        onContextMenu: () => {},
      },
    };

    render(
      React.createElement(GraphNodeDispatcher as any, props)
    );

    fireEvent.click(screen.getByRole('button', { name: 'thread link node' }));

    expect(onOpenThread).toHaveBeenCalledWith('user-2');
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('does not provide graph hover content for thread origin nodes', () => {
    const props = {
      id: 'thread-origin:user-2',
      type: 'thread_origin',
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        entity: {
          entityId: 'thread_origin:user-2',
          kind: 'thread_origin',
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
          },
          preview: 'Nested follow-up',
          shortLabel: 'Thread',
          threadRootId: 'user-2',
        },
        isSelected: false,
        onFocus: () => {},
        onSelect: () => {},
        onContextMenu: () => {},
      },
    };

    render(
      React.createElement(GraphNodeDispatcher as any, props)
    );

    expect(screen.getByText('thread origin node')).toBeTruthy();
    expect(screen.queryByText('hover entity kind: thread_origin')).toBeNull();
  });

  it('keeps hover content for focused low-detail nodes', () => {
    const props = {
      id: 'user-1',
      type: 'user_message',
      selected: false,
      isConnectable: false,
      dragging: false,
      zIndex: 0,
      xPos: 0,
      yPos: 0,
      data: {
        entity: {
          entityId: 'message:user-1',
          kind: 'user_message',
          messageId: 'user-1',
          focusMessageId: 'user-1',
          sortTs: 0,
          message: {
            id: 'user-1',
            role: 'user',
            content: 'Create a dense graph',
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
          },
          preview: 'Create a dense graph',
          shortLabel: 'User',
        },
        detailLevel: 'minimal',
        isFocused: true,
        isSelected: false,
        onFocus: () => {},
        onSelect: () => {},
        onContextMenu: () => {},
      },
    };

    render(
      React.createElement(GraphNodeDispatcher as any, props)
    );

    expect(screen.getByTestId('user-detail').textContent).toBe('minimal');
    expect(screen.getByText('hover entity kind: user_message')).toBeTruthy();
  });
});
