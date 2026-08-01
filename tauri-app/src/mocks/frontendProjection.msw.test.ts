// @vitest-environment jsdom
import '../test/setup';
import { describe, expect, it } from 'vitest';
import { buildWorkspaceProjection, type ProjectedChatItem, type WorkspaceProjection } from '../domain/workspaceProjection';
import { mapMessagesToGraphElements } from '../lib/graphUtils';
import type { Message } from '../stores/workspaceStore';

const workspaceId = 'workspace-projection-msw';
const baseTime = Date.parse('2026-05-09T05:00:00.000Z');

const isoAt = (index: number) => new Date(baseTime + index * 1000).toISOString();

const makeMessage = (input: Partial<Message> & Pick<Message, 'id' | 'role' | 'parentId'>, index: number): Message => ({
  id: input.id,
  role: input.role,
  content: input.content ?? `${input.role} ${input.id}`,
  parentId: input.parentId,
  workspaceId,
  status: input.status ?? null,
  agent_id: input.agent_id ?? null,
  execution_data: input.execution_data ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  git_branch_name: input.git_branch_name ?? null,
  createdAt: input.createdAt ?? isoAt(index),
  updatedAt: input.updatedAt ?? isoAt(index),
});

const buildLinearConversation = (turnCount: number): Message[] => {
  const messages: Message[] = [];
  let parentId: string | null = null;
  for (let index = 0; index < turnCount; index += 1) {
    const userId = `user-${index}`;
    const assistantId = `assistant-${index}`;
    messages.push(makeMessage({ id: userId, role: 'user', parentId }, index * 2));
    messages.push(makeMessage({
      id: assistantId,
      role: 'assistant',
      parentId: userId,
      status: index === turnCount - 1 ? 'running' : 'completed',
      agent_id: `agent-${index}`,
      output_commit_sha: `commit${String(index).padStart(5, '0')}`,
    }, index * 2 + 1));
    parentId = assistantId;
  }
  return messages;
};

const lastMessageId = (messages: Message[]) => messages.length > 0 ? messages[messages.length - 1].id : null;

const buildProjection = (messages: Message[], focusedMessageId: string | null = lastMessageId(messages)) =>
  buildWorkspaceProjection({
    messages,
    summaries: [],
    focusedMessageId,
  });

const mapProjectionToGraph = (
  projection: WorkspaceProjection,
  messages = projection.messages,
  focusedMessageId: string | null = lastMessageId(messages),
) =>
  mapMessagesToGraphElements(
    projection,
    messages,
    [],
    focusedMessageId,
    new Set(),
    false,
  );

const graphMessageNodeIds = (graph: ReturnType<typeof mapProjectionToGraph>, messages: Message[]): string[] => {
  const messageIds = new Set(messages.map((message) => message.id));
  return graph.nodes
    .map((node) => node.id)
    .filter((nodeId) => messageIds.has(nodeId));
};

const chatMessageIds = (projection: WorkspaceProjection): Set<string> => {
  const ids = new Set<string>();
  const addEntity = (entityId: string | undefined) => {
    if (!entityId) return;
    const messageId = projection.entitiesById.get(entityId)?.messageId;
    if (messageId) ids.add(messageId);
  };

  projection.chatItems.forEach((item: ProjectedChatItem) => {
    if (item.type === 'turn') {
      addEntity(item.userEntityId);
      item.assistantEntityIds.forEach(addEntity);
      Object.values(item.commitEntityIdsByAssistantEntityId).flat().forEach(addEntity);
      return;
    }
    if (item.type === 'turn_user_only') {
      addEntity(item.userEntityId);
      return;
    }
    if (item.type === 'summary' || item.type === 'entity') {
      addEntity(item.entityId);
      return;
    }
    const batch = projection.externalCommitBatchById.get(item.batchId);
    batch?.entityIds.forEach(addEntity);
  });

  return ids;
};

describe('MSW projection/perf contracts', () => {
  it('keeps terminal status consistent between projection, graph nodes, and message state', () => {
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0),
      makeMessage({
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        status: 'running',
        agent_id: 'agent-terminal',
        execution_data: {
          last_terminal_status: 'completed',
          last_agent_event_seq: 99,
        },
      }, 1),
    ];

    const projection = buildProjection(messages, 'assistant-1');
    const graph = mapProjectionToGraph(projection);
    const projectedEntity = projection.entitiesByMessageId.get('assistant-1');
    const graphNode = graph.nodes.find((node) => node.id === 'assistant-1');

    expect(messages.find((message) => message.id === 'assistant-1')?.status).toBe('running');
    expect(projectedEntity?.status).toBe('completed');
    expect(graphNode?.data.agentStatus).toBe('completed');
    expect(graphNode?.data.isAgentRunning).toBe(false);
  });

  it('does not drop focused branch messages between chat projection and graph mapping', () => {
    const messages = buildLinearConversation(30);
    const focusedMessageId = messages[messages.length - 1].id;
    const projection = buildProjection(messages, focusedMessageId);
    const graph = mapProjectionToGraph(projection, messages, focusedMessageId);
    const graphMessageIds = graphMessageNodeIds(graph, messages);
    const graphIds = new Set(graphMessageIds);
    const visibleChatIds = chatMessageIds(projection);

    expect(projection.entities).toHaveLength(messages.length);
    expect(graphMessageIds).toHaveLength(messages.length);
    expect(graph.edges.length).toBeGreaterThanOrEqual(messages.length - 1);
    expect(graphIds.has(focusedMessageId)).toBe(true);
    expect(visibleChatIds.has(focusedMessageId)).toBe(true);

    for (const message of messages) {
      expect(projection.entitiesByMessageId.has(message.id), `missing projection entity for ${message.id}`).toBe(true);
      expect(graphIds.has(message.id), `missing graph node for ${message.id}`).toBe(true);
    }
  });

  it('keeps large graph projection inside a deterministic perf budget', () => {
    const messages = buildLinearConversation(500);
    const startedAt = performance.now();
    const focusedMessageId = messages[messages.length - 1].id;
    const projection = buildProjection(messages, focusedMessageId);
    const graph = mapProjectionToGraph(projection, messages, focusedMessageId);
    const durationMs = performance.now() - startedAt;

    expect(projection.entities).toHaveLength(messages.length);
    expect(graphMessageNodeIds(graph, messages)).toHaveLength(messages.length);
    expect(graph.edges.length).toBeGreaterThanOrEqual(messages.length - 1);
    expect(durationMs).toBeLessThan(1500);
  });
});
