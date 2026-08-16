// @vitest-environment jsdom
import '../test/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NodeHoverCardContent } from './NodeHoverCardContent';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';

vi.mock('./nodes/chat/ChatNodeDispatcher', () => ({
  ChatNodeDispatcher: ({ entityOverride }: { entityOverride?: ProjectedNodeEntity }) => (
    <div>hover body: {entityOverride?.preview}</div>
  ),
}));

const makeProjection = (): WorkspaceProjection => ({
  messages: [],
  summaries: [],
  messageMap: new Map(),
  summaryMap: new Map(),
  entities: [],
  entitiesById: new Map(),
  entitiesByMessageId: new Map(),
  entitiesBySummaryId: new Map(),
  childEntityIdsByParentEntityId: new Map(),
  commitEntityIdsByAssistantEntityId: new Map(),
  commitBySha: new Map(),
  commitLaneRows: [],
  layoutDerivedCommitGroups: [],
  groupIdByCommitSha: new Map(),
  threadRootIds: [],
  threadRootIdByMessageId: new Map(),
  rootMessageIdByThreadRootId: new Map(),
  turnGroups: [],
  turnGroupById: new Map(),
  originMessage: null,
  originMessageId: null,
  branchPathMessageIds: new Set(),
  focusRoute: { baseNodeId: null, messageIds: [], edges: [] },
  timelineItems: [],
  chatItems: [],
});

const makeEntity = (kind: ProjectedNodeEntity['kind']): ProjectedNodeEntity => ({
  entityId: `${kind}:entity-1`,
  kind,
  messageId: 'message-1',
  focusMessageId: 'message-1',
  turnGroupId: 'turn-1',
  sortTs: 1,
  preview: `${kind} preview`,
  shortLabel: 'label',
  status: null,
  message: {
    id: 'message-1',
    role: 'assistant',
    content: `${kind} preview`,
    parentId: null,
    workspaceId: 'workspace-1',
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
  },
});

describe('NodeHoverCardContent', () => {
  it('does not show Reply for commit hover cards', () => {
    render(<NodeHoverCardContent entity={makeEntity('commit_message')} projection={makeProjection()} />);

    expect(screen.getByText('hover body: commit_message preview')).toBeTruthy();
    expect(screen.queryByText('Reply')).toBeNull();
  });

  it('keeps Reply for non-commit hover cards', () => {
    render(<NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />);

    expect(screen.getByText('hover body: assistant_message preview')).toBeTruthy();
    expect(screen.getByText('Reply')).toBeTruthy();
  });
});
