// @vitest-environment jsdom
import '../../../test/setup';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectedNodeEntity } from '../../../domain/workspaceProjection';
import { GraphCommitNode } from './GraphCommitNode';

vi.mock('@xyflow/react', () => ({
  Handle: ({ id }: { id: string }) => <div data-testid={`handle-${id}`} />,
  Position: {
    Top: 'top',
    Bottom: 'bottom',
    Left: 'left',
    Right: 'right',
  },
}));

const makeGeneratedCommitEntity = (): ProjectedNodeEntity => ({
  entityId: 'commit_message:assistant-1:output',
  kind: 'commit_message',
  messageId: 'assistant-1:commit',
  focusMessageId: 'assistant-1',
  parentEntityId: 'assistant_message:assistant-1',
  turnGroupId: 'turn:user-1',
  sortTs: 0,
  preview: 'Generated commit',
  shortLabel: 'abc12345',
  shortSha: 'abc12345',
  status: null,
  parentShas: ['parent123'],
  message: {
    id: 'assistant-1:commit',
    role: 'assistant',
    content: 'Generated commit',
    parentId: 'assistant-1',
    workspaceId: 'workspace-1',
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    execution_data: {},
    output_commit_sha: 'abc12345def',
    commit: {
      sha: 'abc12345def',
      workspace_id: 'workspace-1',
      subject: 'Generated commit',
      source_kind: 'agent',
      produced_by_node_id: 'assistant-1',
      first_parent_sha: 'parent123',
      files_changed_count: 3,
      total_additions: 12,
      total_deletions: 4,
    },
  },
});

describe('GraphCommitNode', () => {
  it('renders authoritative commit metadata attached to the message', () => {
    const { container } = render(
      <GraphCommitNode
        nodeId="commit:assistant-1"
        entity={makeGeneratedCommitEntity()}
        isFocused={false}
        isSelected={false}
        layout="graph"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(container.querySelector('[title="3 files changed"]')).not.toBeNull();
    expect(container.querySelector('[title="12 added lines"]')).not.toBeNull();
    expect(container.querySelector('[title="4 deleted lines"]')).not.toBeNull();
  });
});
