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

const makeOrchestrationMessages = (): Message[] => [
  makeMessage({
    id: 'parent-user',
    role: 'user',
    parentId: null,
    content: 'Initial request.',
  }, 0),
  makeMessage({
    id: 'parent-assistant',
    role: 'assistant',
    parentId: 'parent-user',
    content: 'Initial answer.',
  }, 1),
  makeMessage({
    id: 'root-user',
    role: 'user',
    parentId: 'parent-assistant',
    content: 'Coordinate this work.',
    execution_data: { meta: { node_kind: 'orchestrator' } },
  }, 2),
  makeMessage({
    id: 'assistant-orchestrator',
    role: 'assistant',
    parentId: 'root-user',
    content: 'Orchestration controller.',
    aiLabel: 'Security Review',
    llmModel: 'gpt-5.5',
    execution_data: { meta: { node_kind: 'orchestrator' } },
  }, 3),
  makeMessage({
    id: 'child-user-1',
    role: 'user',
    parentId: 'root-user',
    content: 'Plan one.',
    controlled_by_node_id: 'assistant-orchestrator',
  }, 4),
  makeMessage({
    id: 'child-assistant-1',
    role: 'assistant',
    parentId: 'child-user-1',
    content: 'Plan result.',
    status: 'running',
    controlled_by_node_id: 'assistant-orchestrator',
    execution_data: { meta: { orchestration_decision_id: 'planner-1' } },
  }, 5),
  makeMessage({
    id: 'child-user-2',
    role: 'user',
    parentId: 'child-assistant-1',
    content: 'Review plan.',
    controlled_by_node_id: 'assistant-orchestrator',
  }, 6),
  makeMessage({
    id: 'child-assistant-2',
    role: 'assistant',
    parentId: 'child-user-2',
    content: 'Review result.',
    status: 'completed',
    controlled_by_node_id: 'assistant-orchestrator',
    execution_data: {
      meta: {
        orchestration_decision_id: 'reviewer-1',
      },
    },
  }, 7),
  makeMessage({
    id: 'child-user-3',
    role: 'user',
    parentId: 'child-assistant-2',
    content: 'Fix issue.',
    controlled_by_node_id: 'assistant-orchestrator',
  }, 8),
  makeMessage({
    id: 'child-assistant-3',
    role: 'assistant',
    parentId: 'child-user-3',
    content: 'Fix failed.',
    status: 'failed_runtime',
    controlled_by_node_id: 'assistant-orchestrator',
    execution_data: { meta: { orchestration_decision_id: 'fixer-1' } },
  }, 9),
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
  collapsedOrchestrationControllerIds = new Set<string>(),
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
    collapsedOrchestrationControllerIds,
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

  it('renders one expanded orchestration hull that represents the hidden controller around controlled messages', () => {
    const orchestrationMessages = makeOrchestrationMessages();

    const { result } = renderHook(() => renderLayout(
      'assistant-orchestrator',
      ['parent-user', 'parent-assistant', 'root-user', 'assistant-orchestrator'],
      orchestrationMessages,
      'orchestration-hull',
    ));

    const hulls = result.current.nodes.filter((node) => node.type === 'orchestration_hull');
    expect(hulls).toHaveLength(1);
    expect(result.current.nodes.filter((node) => node.type === 'orchestration_node')).toHaveLength(0);
    expect(result.current.nodes.find((node) => node.id === 'assistant-orchestrator')?.hidden).toBe(true);
    expect((hulls[0].data as any).controllerMessageId).toBe('assistant-orchestrator');
    expect((hulls[0].data as any).memberIds).toEqual(expect.arrayContaining([
      'child-user-1',
      'child-assistant-1',
      'child-user-2',
      'child-assistant-2',
      'child-user-3',
      'child-assistant-3',
    ]));
    expect((hulls[0].data as any).memberIds).not.toContain('assistant-orchestrator');
    expect((hulls[0].data as any).memberIds).not.toContain('parent-assistant');
    expect(result.current.edges.some((edge) => edge.source === 'assistant-orchestrator' || edge.target === 'assistant-orchestrator')).toBe(false);
    expect(result.current.edges.some((edge) => (edge.data as any)?.relationship === 'orchestration-control')).toBe(false);
  });

  it('reroutes legacy expanded orchestration runs away from the hidden controller', () => {
    const orchestrationMessages = makeOrchestrationMessages().map((message) => (
      message.id === 'child-user-1'
        ? { ...message, parentId: 'assistant-orchestrator' }
        : message
    ));

    const { result } = renderHook(() => renderLayout(
      'assistant-orchestrator',
      ['parent-user', 'parent-assistant', 'root-user', 'assistant-orchestrator'],
      orchestrationMessages,
      'orchestration-hull-legacy-parent',
    ));

    expect(result.current.nodes.find((node) => node.id === 'assistant-orchestrator')?.hidden).toBe(true);
    expect(result.current.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'root-user',
        target: 'child-user-1',
        data: expect.objectContaining({
          relationship: 'conversation',
          routedThroughOrchestration: true,
          orchestrationControllerMessageId: 'assistant-orchestrator',
        }),
      }),
    ]));
    expect(result.current.edges.some((edge) => edge.source === 'assistant-orchestrator' || edge.target === 'assistant-orchestrator')).toBe(false);
  });

  it('renders collapsed orchestration as a graph node with hidden member messages', () => {
    const orchestrationMessages = makeOrchestrationMessages();

    const { result } = renderHook(() => renderLayout(
      'assistant-orchestrator',
      ['parent-user', 'parent-assistant', 'root-user', 'assistant-orchestrator'],
      orchestrationMessages,
      'orchestration-hull-collapsed',
      new Set(['assistant-orchestrator']),
    ));

    expect(result.current.nodes.filter((node) => node.type === 'orchestration_hull')).toHaveLength(0);
    const orchestrationNodes = result.current.nodes.filter((node) => node.type === 'orchestration_node');
    expect(orchestrationNodes).toHaveLength(1);
    const orchestrationNode = orchestrationNodes[0];
    expect(orchestrationNode).toBeTruthy();
    expect(orchestrationNode?.id).toBe('orchestration:assistant-orchestrator');
    expect(orchestrationNode?.hidden).not.toBe(true);
    expect(orchestrationNode?.style?.width).toBe(200);
    expect((orchestrationNode?.data as any).label).toBe('Security Review');
    expect((orchestrationNode?.data as any).miniChildren).toEqual([
      expect.objectContaining({ label: 'Plan result.', status: 'running' }),
      expect.objectContaining({ label: 'Review result.', status: 'completed' }),
      expect.objectContaining({ label: 'Fix failed.', status: 'failed_runtime' }),
    ]);
    expect((orchestrationNode?.data as any).miniAnchors).toEqual([
      expect.objectContaining({ id: 'orchestration-root:assistant_message:assistant-orchestrator' }),
    ]);
    expect((orchestrationNode?.data as any).miniEdges).toEqual([
      expect.objectContaining({ sourceId: 'orchestration-root:assistant_message:assistant-orchestrator', targetId: 'assistant_message:child-assistant-1' }),
      expect.objectContaining({ sourceId: 'assistant_message:child-assistant-1', targetId: 'assistant_message:child-assistant-2' }),
      expect.objectContaining({ sourceId: 'assistant_message:child-assistant-2', targetId: 'assistant_message:child-assistant-3' }),
    ]);
    expect((orchestrationNode?.data as any).activeOrchestrationRuns).toBe(1);
    expect((orchestrationNode?.data as any).completedOrchestrationRuns).toBe(1);
    expect((orchestrationNode?.data as any).failedOrchestrationRuns).toBe(1);
    expect((orchestrationNode?.data as any).cancelledOrchestrationRuns).toBe(0);
    expect((orchestrationNode?.data as any).totalOrchestrationRuns).toBe(3);

    for (const messageId of [
      'assistant-orchestrator',
      'child-user-1',
      'child-assistant-1',
      'child-user-2',
      'child-assistant-2',
      'child-user-3',
      'child-assistant-3',
    ]) {
      expect(result.current.nodes.find((node) => node.id === messageId)?.hidden).toBe(true);
    }

    expect(result.current.nodes.find((node) => node.id === 'root-user')?.hidden).not.toBe(true);
    expect(result.current.nodes.find((node) => node.id === 'parent-assistant')?.hidden).not.toBe(true);
    expect(result.current.nodes.find((node) => node.id === 'hull:turn:root-user')?.hidden).not.toBe(true);
    expect(result.current.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'root-user',
        target: 'orchestration:assistant-orchestrator',
        sourceHandle: 'bottom-source',
      }),
    ]));
  });

  it('refreshes collapsed orchestration mini data through the visual-only path', () => {
    const orchestrationMessages = makeOrchestrationMessages();
    const completedMessages = orchestrationMessages.map((message) => (
      message.id === 'child-assistant-1'
        ? {
          ...message,
          content: 'Plan completed.',
          status: 'completed' as const,
          updatedAt: isoAt(20),
        }
        : message
    ));

    const { result, rerender } = renderHook(
      ({ inputMessages }) => renderLayout(
        'assistant-orchestrator',
        ['parent-user', 'parent-assistant', 'root-user', 'assistant-orchestrator'],
        inputMessages,
        'orchestration-visual-refresh',
        new Set(['assistant-orchestrator']),
      ),
      { initialProps: { inputMessages: orchestrationMessages } },
    );

    const initialNode = result.current.nodes.find((node) => node.type === 'orchestration_node');
    expect((initialNode?.data as any).activeOrchestrationRuns).toBe(1);
    expect((initialNode?.data as any).completedOrchestrationRuns).toBe(1);
    expect((initialNode?.data as any).miniChildren).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Plan result.', status: 'running' }),
    ]));

    rerender({ inputMessages: completedMessages });

    const refreshedNode = result.current.nodes.find((node) => node.type === 'orchestration_node');
    expect((refreshedNode?.data as any).activeOrchestrationRuns).toBe(0);
    expect((refreshedNode?.data as any).completedOrchestrationRuns).toBe(2);
    expect((refreshedNode?.data as any).miniChildren).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Plan completed.', status: 'completed' }),
    ]));
  });

  it('shows cancelled generated assistant turns as collapsed orchestration dots', () => {
    const inputMessages: Message[] = [
      makeMessage({ id: 'parent-user', role: 'user', parentId: null, content: 'Initial request.' }, 0),
      makeMessage({ id: 'parent-assistant', role: 'assistant', parentId: 'parent-user', content: 'Initial answer.' }, 1),
      makeMessage({
        id: 'orchestration-user',
        role: 'user',
        parentId: 'parent-assistant',
        content: '#security_reviewer',
        execution_data: { meta: { node_kind: 'orchestrator' } },
      }, 2),
      makeMessage({
        id: 'generated-assistant',
        role: 'assistant',
        parentId: 'orchestration-user',
        content: 'Security review was cancelled.',
        status: 'cancelled',
        execution_data: { meta: { node_kind: 'orchestrator' } },
      }, 3),
    ];

    const { result } = renderHook(() => renderLayout(
      'generated-assistant',
      ['parent-user', 'parent-assistant', 'orchestration-user', 'generated-assistant'],
      inputMessages,
      'orchestration-cancelled-generated-dot',
      new Set(['generated-assistant']),
    ));

    const orchestrationNodes = result.current.nodes.filter((node) => node.type === 'orchestration_node');
    expect(orchestrationNodes).toHaveLength(1);
    expect(orchestrationNodes[0].id).toBe('orchestration:generated-assistant');
    expect((orchestrationNodes[0].data as any).miniChildren).toEqual([
      expect.objectContaining({ label: 'Security review was cancelled.', status: 'cancelled' }),
    ]);
    expect((orchestrationNodes[0].data as any).totalOrchestrationRuns).toBe(1);
    expect((orchestrationNodes[0].data as any).cancelledOrchestrationRuns).toBe(1);
    expect(result.current.nodes.find((node) => node.id === 'orchestration-user')?.hidden).not.toBe(true);
    expect(result.current.nodes.find((node) => node.id === 'generated-assistant')?.hidden).toBe(true);
    expect(result.current.nodes.find((node) => node.id === 'hull:turn:orchestration-user')?.hidden).not.toBe(true);
  });
});
