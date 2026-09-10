// @vitest-environment jsdom
import '../test/setup';
import { describe, expect, it } from 'vitest';
import { buildWorkspaceProjection } from '../domain/workspaceProjection';
import type { Message } from '../stores/workspaceStore';
import { mapMessagesToGraphElements } from './graphUtils';

const workspaceId = 'workspace-orchestration-graph';
const baseTime = Date.parse('2026-05-10T05:00:00.000Z');
const isoAt = (index: number) => new Date(baseTime + index * 1000).toISOString();

const message = (
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
  threadId: input.threadId ?? null,
  thread_id: input.thread_id ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  base_commit_sha: input.base_commit_sha ?? null,
  createdAt: input.createdAt ?? isoAt(index),
  updatedAt: input.updatedAt ?? isoAt(index),
});

const mapWithOrchestration = (messages: Message[], collapsedControllerIds: Set<string>) => {
  const projection = buildWorkspaceProjection({
    messages,
    summaries: [],
    focusedMessageId: 'orchestrator',
  });

  return mapMessagesToGraphElements(
    projection,
    messages,
    [],
    'orchestrator',
    new Set(),
    new Set(),
    false,
    false,
    true,
    true,
    new Set(),
    () => {},
    new Map(),
    [],
    false,
    new Map(),
    new Map(),
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    new Set(['conversation', 'commits']),
    false,
    new Set(),
    new Set(),
    () => {},
    () => {},
    collapsedControllerIds,
  );
};

const mapWithCollapsedOrchestration = (messages: Message[]) => (
  mapWithOrchestration(messages, new Set(['orchestrator']))
);

describe('orchestration graph mapping', () => {
  it('collapses orchestration into one parent-connected node with dots only for generated assistant children', () => {
    const messages = [
      message({
        id: 'root-user',
        role: 'user',
        parentId: null,
        content: 'Coordinate the work.',
      }, 0),
      message({
        id: 'orchestrator',
        role: 'assistant',
        parentId: 'root-user',
        content: 'I will orchestrate this.',
        aiLabel: 'Migration Plan',
        status: 'running' as any,
        execution_data: { meta: { node_kind: 'orchestrator' } },
      }, 1),
      message({
        id: 'child-user-1',
        role: 'user',
        parentId: 'root-user',
        content: 'Run planner child.',
        execution_data: { meta: { controlled_by_node_id: 'orchestrator' } },
      }, 2),
      message({
        id: 'child-assistant-1',
        role: 'assistant',
        parentId: 'child-user-1',
        content: 'Cancelled planner child.',
        status: 'cancelled' as any,
        output_commit_sha: '1111111111111111111111111111111111111111',
        execution_data: { meta: { controlled_by_node_id: 'orchestrator' } },
      }, 3),
      message({
        id: 'child-user-2',
        role: 'user',
        parentId: 'child-assistant-1',
        content: 'Run reviewer child.',
        execution_data: { meta: { controlled_by_node_id: 'orchestrator' } },
      }, 4),
      message({
        id: 'child-assistant-2',
        role: 'assistant',
        parentId: 'child-user-2',
        content: 'Reviewing now.',
        status: 'running' as any,
        output_commit_sha: '2222222222222222222222222222222222222222',
        execution_data: { meta: { controlled_by_node_id: 'orchestrator' } },
      }, 5),
    ];

    const mapped = mapWithCollapsedOrchestration(messages);
    const nodeById = new Map(mapped.nodes.map((node) => [node.id, node]));
    const rootUser = nodeById.get('root-user');
    const orchestrationNode = nodeById.get('orchestration:orchestrator');
    const orchestrator = nodeById.get('orchestrator');
    const childAssistant1 = nodeById.get('child-assistant-1');
    const childAssistant2 = nodeById.get('child-assistant-2');
    const childCommit1 = nodeById.get('commit:child-assistant-1');
    const childCommit2 = nodeById.get('commit:child-assistant-2');
    const finalCommit = nodeById.get('commit:orchestration:orchestrator');
    const rootTurnHull = nodeById.get('hull:turn:root-user');
    const childTurnHull2 = nodeById.get('hull:turn:child-user-2');

    expect(rootUser?.hidden).not.toBe(true);
    expect(orchestrationNode?.hidden).not.toBe(true);
    expect(orchestrator?.hidden).toBe(true);
    expect(childAssistant1?.hidden).toBe(true);
    expect(childAssistant2?.hidden).toBe(true);
    expect(childCommit1?.hidden).toBe(true);
    expect(childCommit2?.hidden).not.toBe(true);
    expect(finalCommit).toBeUndefined();
    expect((childCommit2?.data as any)?.entity?.shortSha).toBe('22222222');
    expect((childCommit2?.data as any)?.entity?.turnGroupId).toBe('turn:root-user');
    expect((childCommit2?.data as any)?.entity?.focusMessageId).toBe('orchestrator');
    expect((rootTurnHull?.data as any)?.memberIds).toContain('commit:child-assistant-2');
    expect(childTurnHull2?.hidden).toBe(true);

    expect(mapped.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      relationship: (edge.data as any)?.relationship,
      routedThroughOrchestration: (edge.data as any)?.routedThroughOrchestration,
    }))).toContainEqual({
      source: 'root-user',
      target: 'orchestration:orchestrator',
      relationship: 'conversation',
      routedThroughOrchestration: true,
    });
    expect(mapped.edges.some((edge) => (
      edge.source === 'root-user' &&
      edge.target === 'orchestration:orchestrator' &&
      (edge.data as any)?.routedThroughOrchestration === true
    ))).toBe(true);

    const miniChildren = ((orchestrationNode?.data as any).miniChildren ?? []) as Array<{
      status: string | null;
      entity?: { messageId?: string | null };
    }>;
    expect(miniChildren.map((child) => child.entity?.messageId)).toEqual([
      'child-assistant-1',
      'child-assistant-2',
    ]);
    expect(miniChildren.map((child) => child.status)).toEqual(['cancelled', 'running']);
    expect(miniChildren.some((child) => child.entity?.messageId === 'orchestrator')).toBe(false);
    expect((orchestrationNode?.data as any).miniAnchors).toEqual([
      expect.objectContaining({ id: 'orchestration-root:assistant_message:orchestrator' }),
    ]);
    expect((orchestrationNode?.data as any).miniEdges).toEqual([
      expect.objectContaining({ sourceId: 'orchestration-root:assistant_message:orchestrator', targetId: 'assistant_message:child-assistant-1' }),
      expect.objectContaining({ sourceId: 'assistant_message:child-assistant-1', targetId: 'assistant_message:child-assistant-2' }),
    ]);
    expect((orchestrationNode?.data as any).totalOrchestrationRuns).toBe(2);
    expect((orchestrationNode?.data as any).cancelledOrchestrationRuns).toBe(1);
    expect((orchestrationNode?.data as any).activeOrchestrationRuns).toBe(1);
  });

  it('connects expanded first-level orchestration runs to the assistant the user replied to', () => {
    const messages = [
      message({
        id: 'root-user',
        role: 'user',
        parentId: null,
        content: 'Initial request.',
      }, 0),
      message({
        id: 'parent-assistant',
        role: 'assistant',
        parentId: 'root-user',
        content: 'Initial answer.',
      }, 1),
      message({
        id: 'orchestration-user',
        role: 'user',
        parentId: 'parent-assistant',
        content: 'Coordinate the work.',
      }, 2),
      message({
        id: 'orchestrator',
        role: 'assistant',
        parentId: 'orchestration-user',
        content: 'I will orchestrate this.',
        aiLabel: 'Migration Plan',
        status: 'running' as any,
        execution_data: { meta: { node_kind: 'orchestrator' } },
      }, 3),
      message({
        id: 'run-user-1',
        role: 'user',
        parentId: 'parent-assistant',
        content: 'Run planner.',
        execution_data: { meta: { controlled_by_node_id: 'orchestrator' } },
      }, 4),
      message({
        id: 'run-assistant-1',
        role: 'assistant',
        parentId: 'run-user-1',
        content: 'Planning now.',
        status: 'running' as any,
        execution_data: { meta: { controlled_by_node_id: 'orchestrator' } },
      }, 5),
    ];

    const mapped = mapWithOrchestration(messages, new Set());
    const nodeById = new Map(mapped.nodes.map((node) => [node.id, node]));

    expect(nodeById.get('orchestrator')?.hidden).toBe(true);
    expect(nodeById.get('orchestration:orchestrator')?.type).toBe('orchestration_hull');
    expect(nodeById.get('run-user-1')?.hidden).not.toBe(true);
    expect(nodeById.get('run-assistant-1')?.hidden).not.toBe(true);
    expect(mapped.edges).toContainEqual(expect.objectContaining({
      source: 'parent-assistant',
      target: 'run-user-1',
      data: expect.objectContaining({
        relationship: 'conversation',
      }),
    }));
  });

  it('keeps legacy expanded orchestration runs parented to the request connected', () => {
    const messages = [
      message({
        id: 'root-user',
        role: 'user',
        parentId: null,
        content: 'Coordinate the work.',
      }, 0),
      message({
        id: 'orchestrator',
        role: 'assistant',
        parentId: 'root-user',
        content: 'I will orchestrate this.',
        aiLabel: 'Migration Plan',
        status: 'running' as any,
        execution_data: { meta: { node_kind: 'orchestrator' } },
      }, 1),
      message({
        id: 'run-user-1',
        role: 'user',
        parentId: 'root-user',
        content: 'Run planner.',
        execution_data: { meta: { controlled_by_node_id: 'orchestrator' } },
      }, 2),
      message({
        id: 'run-assistant-1',
        role: 'assistant',
        parentId: 'run-user-1',
        content: 'Planning now.',
        status: 'running' as any,
        execution_data: { meta: { controlled_by_node_id: 'orchestrator' } },
      }, 3),
    ];

    const mapped = mapWithOrchestration(messages, new Set());

    expect(mapped.edges).toContainEqual(expect.objectContaining({
      source: 'root-user',
      target: 'run-user-1',
      data: expect.objectContaining({
        relationship: 'conversation',
        routedThroughOrchestration: true,
        orchestrationControllerMessageId: 'orchestrator',
      }),
    }));
  });

  it('connects new-thread orchestration runs to the thread node when no assistant target exists', () => {
    const messages = [
      message({
        id: 'orchestration-user',
        role: 'user',
        parentId: null,
        threadId: 'thread-1',
        content: 'Coordinate the work.',
        execution_data: { meta: { thread_origin_id: 'thread-1' } },
      }, 0),
      message({
        id: 'orchestrator',
        role: 'assistant',
        parentId: 'orchestration-user',
        threadId: 'thread-1',
        content: 'I will orchestrate this.',
        aiLabel: 'Migration Plan',
        status: 'running' as any,
        execution_data: { meta: { node_kind: 'orchestrator', thread_origin_id: 'thread-1' } },
      }, 1),
      message({
        id: 'run-user-1',
        role: 'user',
        parentId: 'thread-origin:thread-1',
        threadId: 'thread-1',
        content: 'Run planner.',
        execution_data: { meta: { controlled_by_node_id: 'orchestrator', thread_origin_id: 'thread-1' } },
      }, 2),
      message({
        id: 'run-assistant-1',
        role: 'assistant',
        parentId: 'run-user-1',
        threadId: 'thread-1',
        content: 'Planning now.',
        status: 'running' as any,
        execution_data: { meta: { controlled_by_node_id: 'orchestrator', thread_origin_id: 'thread-1' } },
      }, 3),
    ];

    const mapped = mapWithOrchestration(messages, new Set());
    const nodeById = new Map(mapped.nodes.map((node) => [node.id, node]));

    expect(nodeById.get('thread-origin:thread-1')?.type).toBe('thread_origin');
    expect(mapped.edges).toContainEqual(expect.objectContaining({
      source: 'thread-origin:thread-1',
      target: 'run-user-1',
      data: expect.objectContaining({
        relationship: 'conversation',
      }),
    }));
  });
});
