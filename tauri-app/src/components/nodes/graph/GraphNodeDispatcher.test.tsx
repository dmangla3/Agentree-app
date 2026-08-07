// @vitest-environment jsdom
import '../../../test/setup';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphNodeDispatcher } from './GraphNodeDispatcher';
import type { ProjectedCommitEntity, ProjectedNodeEntity } from '../../../domain/workspaceProjection';

vi.mock('./GraphCanonicalCommitNode', () => ({
  GraphCanonicalCommitNode: ({ hoverCardContent }: { hoverCardContent?: React.ReactNode }) => (
    <div>
      <div>canonical node</div>
      {hoverCardContent}
    </div>
  ),
}));

vi.mock('./GraphUserNode', () => ({ GraphUserNode: () => <div /> }));
vi.mock('./GraphAssistantNode', () => ({ GraphAssistantNode: () => <div /> }));
vi.mock('./GraphCommitNode', () => ({ GraphCommitNode: () => <div /> }));
vi.mock('./GraphDerivedCommitGroupNode', () => ({ GraphDerivedCommitGroupNode: () => <div /> }));
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

describe('GraphNodeDispatcher', () => {
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
});
