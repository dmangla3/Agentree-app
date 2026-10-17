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
  aiLabel: input.aiLabel ?? null,
  status: input.status ?? null,
  agent_id: input.agent_id ?? null,
  execution_data: input.execution_data ?? null,
  controlled_by_node_id: input.controlled_by_node_id ?? null,
  controlledByNodeId: input.controlledByNodeId ?? null,
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
  layoutCacheScopeKey = 'default',
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
    layoutCacheScopeKey,
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

    const unchangedNode = result.current.nodes.find((node) => node.id === 'assistant-2');
    const previouslyFocusedNode = result.current.nodes.find((node) => node.id === 'assistant-1');
    const unchangedPathEdge = result.current.edges[0];

    expect(unchangedNode).toBeTruthy();
    expect(previouslyFocusedNode).toBeTruthy();
    expect(unchangedPathEdge).toBeTruthy();

    rerender({
      focusedMessageId: 'user-2',
      path: ['user-1', 'assistant-1'],
    });

    expect(result.current.nodes.find((node) => node.id === 'assistant-2')).toBe(unchangedNode);
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

  it('recomputes layout when an assistant output preview appears', () => {
    const withoutPreview: Message[] = [
      messages[0],
      makeMessage({
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        content: 'First reply.',
        status: 'completed',
        agent_id: 'codex:test',
      }, 1),
    ];
    const withPreview: Message[] = [
      withoutPreview[0],
      {
        ...withoutPreview[1],
        execution_data: {
          artifacts: [{
            id: 'artifact-1',
            role: 'output',
            kind: 'screenshot',
            mimeType: 'image/png',
            title: 'Screenshot preview',
            storage: { backend: 'local', path: '/tmp/screenshot.png' },
            isPrimary: true,
          }],
        },
      },
    ];

    const { result, rerender } = renderHook(
      ({ inputMessages }) => renderLayout('assistant-1', ['user-1', 'assistant-1'], inputMessages),
      { initialProps: { inputMessages: withoutPreview } },
    );

    expect(result.current.nodes.find((node) => node.id === 'assistant-1')?.style?.height).toBe(112);

    rerender({ inputMessages: withPreview });

    const node = result.current.nodes.find((candidate) => candidate.id === 'assistant-1');
    expect(node?.style?.height).toBe(168);
    expect(node?.data.heightKey).toContain('outputPreview:1');
  });

  it('keeps separate layout cache entries for repeated thread scopes', () => {
    const threadAMessages: Message[] = [
      makeMessage({ id: 'thread-a', role: 'user', parentId: null, content: 'Thread A task.' }, 0),
      makeMessage({ id: 'assistant-a', role: 'assistant', parentId: 'thread-a', content: 'Thread A result.' }, 1),
    ];
    const threadBMessages: Message[] = [
      makeMessage({ id: 'thread-b', role: 'user', parentId: null, content: 'Thread B task.' }, 2),
      makeMessage({ id: 'assistant-b', role: 'assistant', parentId: 'thread-b', content: 'Thread B result.' }, 3),
    ];

    const { result, rerender } = renderHook(
      ({ inputMessages, focusedMessageId, path, cacheScopeKey }) => (
        renderLayout(focusedMessageId, path, inputMessages, cacheScopeKey)
      ),
      {
        initialProps: {
          inputMessages: threadAMessages,
          focusedMessageId: 'assistant-a',
          path: ['thread-a', 'assistant-a'],
          cacheScopeKey: 'workspace-1:thread-a',
        },
      },
    );

    const firstNodes = result.current.nodes;

    rerender({
      inputMessages: threadBMessages,
      focusedMessageId: 'assistant-b',
      path: ['thread-b', 'assistant-b'],
      cacheScopeKey: 'workspace-1:thread-b',
    });
    rerender({
      inputMessages: threadAMessages,
      focusedMessageId: 'assistant-a',
      path: ['thread-a', 'assistant-a'],
      cacheScopeKey: 'workspace-1:thread-a',
    });

    expect(result.current.nodes).toBe(firstNodes);
  });

  it('renders delegated agents as ordinary thread message nodes', () => {
    const delegatedMessages: Message[] = [
      makeMessage({ id: 'task', role: 'user', parentId: null, content: 'Coordinate this task.' }, 0),
      makeMessage({ id: 'controller', role: 'assistant', parentId: 'task', content: 'Delegating.' }, 1),
      makeMessage({
        id: 'worker-task',
        role: 'user',
        parentId: 'controller',
        content: 'Inspect the storage layer.',
        controlled_by_node_id: 'controller',
      }, 2),
      makeMessage({
        id: 'worker',
        role: 'assistant',
        parentId: 'worker-task',
        content: 'Storage review complete.',
        controlled_by_node_id: 'controller',
      }, 3),
    ];

    const { result } = renderHook(() => renderLayout(
      'worker',
      ['task', 'controller', 'worker-task', 'worker'],
      delegatedMessages,
      'delegated-thread',
    ));

    expect(result.current.nodes.find((node) => node.id === 'worker-task')?.type).toBe('user_message');
    expect(result.current.nodes.find((node) => node.id === 'worker')?.type).toBe('assistant_message');
    expect(result.current.nodes.every((node) => !node.type?.includes('orchestration'))).toBe(true);
  });

});
