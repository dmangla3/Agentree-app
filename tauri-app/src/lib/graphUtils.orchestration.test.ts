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
  output_commit_sha: input.output_commit_sha ?? null,
  base_commit_sha: input.base_commit_sha ?? null,
  createdAt: input.createdAt ?? isoAt(index),
  updatedAt: input.updatedAt ?? isoAt(index),
});

const mapWithCollapsedOrchestration = (messages: Message[]) => {
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
    new Set(['orchestrator']),
  );
};

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

    expect(rootUser?.hidden).not.toBe(true);
    expect(orchestrationNode?.hidden).not.toBe(true);
    expect(orchestrator?.hidden).toBe(true);
    expect(childAssistant1?.hidden).toBe(true);
    expect(childAssistant2?.hidden).toBe(true);

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
    expect((orchestrationNode?.data as any).totalChildRuns).toBe(2);
    expect((orchestrationNode?.data as any).cancelledChildRuns).toBe(1);
    expect((orchestrationNode?.data as any).activeChildRuns).toBe(1);
  });
});
