import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_STATUSES } from '@shared/agentStatus';
import type { ProjectedNodeEntity } from '../domain/workspaceProjection';
import type { Message } from '../stores/workspaceStore';
import {
  getHoverReplyMode,
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

  it('hides quick reply for non-message and active non-assistant hover nodes', () => {
    expect(getHoverReplyMode(entity({ kind: 'commit_message' }))).toBeNull();
    expect(getHoverReplyMode(entity({ kind: 'thread_link' }))).toBeNull();
    expect(getHoverReplyMode(entity({
      status: 'running' as any,
      message: message({ id: 'user-running', role: 'user', status: 'running' as any }),
    }))).toBeNull();
    expect(getHoverReplyMode(entity({
      kind: 'user_message',
      status: 'completed' as any,
      message: message({ id: 'user-completed', role: 'user', status: 'completed' as any }),
    }))).toBeNull();
    expect(getHoverReplyMode(entity({
      kind: 'user_message',
      status: 'completed' as any,
      message: message({ id: 'user-completed', role: 'user', status: 'completed' as any }),
    }))).toBeNull();
    expect(getHoverReplyMode(entity({ status: 'completed' as any }))).toBe('reply');
  });

  it('shows steering for active assistant hover nodes', () => {
    for (const status of ACTIVE_STATUSES) {
      const hoverEntity = entity({
        status: status as any,
        message: message({ id: `assistant-${status}`, role: 'assistant', status: status as any }),
      });

      expect(getHoverReplyMode(hoverEntity)).toBe('steer');
    }
  });

  it('lets live run status override stale projected hover status', () => {
    const hoverEntity = entity({
      status: 'completed' as any,
      message: message({ id: 'assistant-live', role: 'assistant', status: 'completed' as any }),
    });

    expect(getHoverReplyMode(hoverEntity)).toBe('reply');
    expect(getHoverReplyMode(hoverEntity, 'running')).toBe('steer');
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

  it('falls back to the reply parent base and workspace base when no output commit exists', () => {
    const parent = message({ id: 'parent', base_commit_sha: 'parent-base' });
    const child = message({ id: 'child', role: 'user', parentId: 'parent' });
    const messageMap = new Map([parent, child].map((entry) => [entry.id, entry]));

    expect(resolveQuickReplyBase({ replyParentId: 'parent', messageMap, workspaceBaseCommitSha: 'workspace-base' })).toEqual({
      commitSha: 'parent-base',
      selectedFromNodeId: 'parent',
    });
    expect(resolveQuickReplyBase({ replyParentId: 'missing', messageMap, workspaceBaseCommitSha: 'workspace-base' })).toEqual({
      commitSha: 'workspace-base',
      selectedFromNodeId: null,
    });
  });
});
