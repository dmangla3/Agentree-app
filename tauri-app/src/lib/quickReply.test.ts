import { describe, expect, it, vi } from 'vitest';
import type { ProjectedNodeEntity } from '../domain/workspaceProjection';
import type { Message } from '../stores/workspaceStore';
import {
  canShowHoverQuickReply,
  resolveQuickReplyAgent,
  resolveQuickReplyBase,
  stopQuickReplyControlEvent,
} from './quickReply';

const message = (input: Partial<Message> & Pick<Message, 'id'>): Message => ({
  id: input.id,
  role: input.role ?? 'assistant',
  content: input.content ?? '',
  parentId: input.parentId ?? null,
  workspaceId: input.workspaceId ?? 'workspace-1',
  status: input.status ?? null,
  agent_id: input.agent_id ?? null,
  llmProvider: input.llmProvider ?? null,
  llmModel: input.llmModel ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  base_commit_sha: input.base_commit_sha ?? null,
  execution_data: input.execution_data ?? null,
  createdAt: input.createdAt ?? '2026-05-26T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-26T00:00:00.000Z',
});

const entity = (input: {
  kind?: ProjectedNodeEntity['kind'];
  status?: ProjectedNodeEntity['status'];
  message?: Message;
}): ProjectedNodeEntity => ({
  entityId: 'entity-1',
  kind: input.kind ?? 'assistant_message',
  messageId: input.message?.id ?? 'message-1',
  focusMessageId: input.message?.id ?? 'message-1',
  turnGroupId: 'turn-1',
  sortTs: 1,
  preview: 'preview',
  shortLabel: 'label',
  status: input.status ?? input.message?.status ?? null,
  message: input.message ?? message({ id: 'message-1' }),
});

const agents = [
  { id: 'codex:gpt-5.4-mini:medium', type: 'codex', model_config: { model: 'gpt-5.4-mini' } },
  { id: 'codex:gpt-5.5:low', type: 'codex', model_config: { model: 'gpt-5.5' } },
  { id: 'claude:claude-sonnet-4-6:high', type: 'claude', model_config: { model: 'claude-sonnet-4-6' } },
];

describe('quick reply helpers', () => {
  it('contains quick reply control events without blocking default input behavior', () => {
    const event = { stopPropagation: vi.fn() };

    stopQuickReplyControlEvent(event);

    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it('hides quick reply for commit and active running hover nodes', () => {
    expect(canShowHoverQuickReply(entity({ kind: 'commit_message' }))).toBe(false);
    expect(canShowHoverQuickReply(entity({ kind: 'thread_link' }))).toBe(false);
    expect(canShowHoverQuickReply(entity({ status: 'pending' as any }))).toBe(false);
    expect(canShowHoverQuickReply(entity({ status: 'initializing' as any }))).toBe(false);
    expect(canShowHoverQuickReply(entity({ status: 'running' as any }))).toBe(false);
    expect(canShowHoverQuickReply(entity({ status: 'streaming' as any }))).toBe(false);
    expect(canShowHoverQuickReply(entity({ status: 'completed' as any }))).toBe(true);
  });

  it('uses the hovered assistant model before falling back to an assistant ancestor', () => {
    const parent = message({
      id: 'parent',
      role: 'assistant',
      agent_id: 'claude:claude-sonnet-4-6:high',
      llmProvider: 'claude',
      llmModel: 'claude-sonnet-4-6',
    });
    const child = message({ id: 'child', role: 'user', parentId: 'parent' });
    const messageMap = new Map([parent, child].map((entry) => [entry.id, entry]));

    expect(resolveQuickReplyAgent({
      replyParentId: 'parent',
      messageMap,
      agents,
    })).toEqual(agents[2]);
    expect(resolveQuickReplyAgent({
      replyParentId: 'child',
      messageMap,
      agents,
    })).toEqual(agents[2]);
  });

  it('falls back to runtime metadata when persisted assistant columns do not include model details', () => {
    const parent = message({
      id: 'parent',
      role: 'assistant',
      llmProvider: null,
      llmModel: null,
      execution_data: {
        meta: {
          provider: 'codex',
          provider_model: 'gpt-5.5',
        },
      },
    });
    const messageMap = new Map([[parent.id, parent]]);

    expect(resolveQuickReplyAgent({
      replyParentId: 'parent',
      messageMap,
      agents,
    })).toEqual(agents[1]);
  });

  it('uses the latest ancestor output commit as the quick reply base', () => {
    const root = message({ id: 'root', output_commit_sha: 'root-output' });
    const parent = message({ id: 'parent', parentId: 'root', output_commit_sha: 'parent-output' });
    const child = message({ id: 'child', role: 'user', parentId: 'parent' });
    const messageMap = new Map([root, parent, child].map((entry) => [entry.id, entry]));

    expect(resolveQuickReplyBase({ replyParentId: 'parent', messageMap })).toEqual({
      commitSha: 'parent-output',
      selectedFromNodeId: 'parent',
    });
    expect(resolveQuickReplyBase({ replyParentId: 'child', messageMap })).toEqual({
      commitSha: 'parent-output',
      selectedFromNodeId: 'parent',
    });
  });
});
