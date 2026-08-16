// @vitest-environment jsdom
import '../../test/setup';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkspaceProjection } from '../../domain/workspaceProjection';
import { useGraphLayout } from './useGraphLayout';
import type { Message } from '../../stores/workspaceStore';

const workspaceId = 'workspace-graph-visual-reuse';
const baseTime = Date.parse('2026-05-19T08:00:00.000Z');

const isoAt = (index: number) => new Date(baseTime + index * 1000).toISOString();

const makeMessage = (
  input: Partial<Message> & Pick<Message, 'id' | 'role' | 'parentId'>,
  index: number,
): Message => ({
  id: input.id,
  role: input.role,
  content: input.content ?? `${input.role} ${input.id}`,
  parentId: input.parentId,
  workspaceId,
  status: input.status ?? null,
  agent_id: input.agent_id ?? null,
  execution_data: input.execution_data ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  base_commit_sha: input.base_commit_sha ?? null,
  base_selected_from_node_id: input.base_selected_from_node_id ?? null,
  git_branch_name: input.git_branch_name ?? null,
  commit: input.commit ?? undefined,
  createdAt: input.createdAt ?? isoAt(index),
  updatedAt: input.updatedAt ?? isoAt(index),
});

const messages: Message[] = [
  makeMessage({ id: 'user-1', role: 'user', parentId: null, content: 'Start from here.' }, 0),
  makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', content: 'First reply.' }, 1),
  makeMessage({ id: 'user-2', role: 'user', parentId: 'assistant-1', content: 'Continue.' }, 2),
  makeMessage({ id: 'assistant-2', role: 'assistant', parentId: 'user-2', content: 'Second reply.' }, 3),
];

const callbacks = {
  onToggleSummary: vi.fn(),
  onToggleCollapse: vi.fn(),
  onFocus: vi.fn(),
  onSelect: vi.fn(),
  onContextMenu: vi.fn(),
  onMeasureNodeHeight: vi.fn(),
};

const renderLayout = (
  focusedMessageId: string,
  contextPathMessageIds: string[],
  inputMessages: Message[] = messages,
) => {
  const projection = buildWorkspaceProjection({
    messages: inputMessages,
    summaries: [],
    focusedMessageId,
  });

  return useGraphLayout({
    projection,
    messages: inputMessages,
    summaries: [],
    measuredNodeHeights: new Map(),
    layoutMode: 'dagre',
    laneStrategy: 'right',
    disabledSummaryIds: new Set(),
    focusedMessageId,
    contextPathMessageIds: new Set(contextPathMessageIds),
    composerBaseCommitSha: null,
    matchingMessageIds: new Set(),
    filterActive: false,
    hasNodeTypeFilter: false,
    keepAncestors: true,
    keepDescendants: true,
    constrainedCommitFiltering: false,
    pinnedCommitShas: new Set(),
    visibleNodeSections: new Set(['conversation', 'commits']),
    insights: [],
    showInsightsInGraph: false,
    workspaceRepoMap: new Map(),
    branchPointersByNodeId: new Map(),
    resetNonce: 0,
    ...callbacks,
  });
};

describe('useGraphLayout visual reuse', () => {
  it('preserves object identity for nodes and edges whose focus visuals did not change', () => {
    const { result, rerender } = renderHook(
      ({ focusedMessageId, path }) => renderLayout(focusedMessageId, path),
      {
        initialProps: {
          focusedMessageId: 'assistant-1',
          path: ['user-1', 'assistant-1'],
        },
      },
    );

    const unchangedNode = result.current.nodes.find((node) => node.id === 'user-1');
    const previouslyFocusedNode = result.current.nodes.find((node) => node.id === 'assistant-1');
    const unchangedPathEdge = result.current.edges[0];

    expect(unchangedNode).toBeTruthy();
    expect(previouslyFocusedNode).toBeTruthy();
    expect(unchangedPathEdge).toBeTruthy();

    rerender({
      focusedMessageId: 'user-2',
      path: ['user-1', 'assistant-1'],
    });

    expect(result.current.nodes.find((node) => node.id === 'user-1')).toBe(unchangedNode);
    expect(result.current.edges[0]).toBe(unchangedPathEdge);
    expect(result.current.nodes.find((node) => node.id === 'assistant-1')).not.toBe(previouslyFocusedNode);
  });

  it('updates message height keys when status changes through the visual-only path', () => {
    const runningMessages: Message[] = [
      messages[0],
      makeMessage({
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        content: 'First reply.',
        status: 'running',
        agent_id: 'codex:test',
      }, 1),
    ];
    const completedMessages: Message[] = [
      runningMessages[0],
      {
        ...runningMessages[1],
        status: 'completed' as const,
        updatedAt: isoAt(4),
      },
    ];

    const { result, rerender } = renderHook(
      ({ inputMessages }) => renderLayout('assistant-1', ['user-1', 'assistant-1'], inputMessages),
      { initialProps: { inputMessages: runningMessages } },
    );

    expect(result.current.nodes.find((node) => node.id === 'assistant-1')?.data.heightKey)
      .toContain('status:running');

    rerender({ inputMessages: completedMessages });

    const node = result.current.nodes.find((candidate) => candidate.id === 'assistant-1');
    expect(node?.data.message.status).toBe('completed');
    expect(node?.data.heightKey).toContain('status:completed');
  });
});
