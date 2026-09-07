import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestQueryClient } from '../test/queryTestUtils';
import { localNodeKeys, type LocalNodeMessage } from './useLocalNodes';
import { materializeHeadlessQuickReplyMessages, selectQuickReplyLoginProfile } from './useHeadlessQuickReply';
import type { Message } from '../stores/workspaceStore';
import type { LoginProfileSummary } from '../lib/loginProfiles';

const makeMessage = (input: Partial<Message> & Pick<Message, 'id' | 'role'>): Message => ({
  id: input.id,
  role: input.role,
  content: input.content ?? '',
  parentId: input.parentId ?? null,
  workspaceId: input.workspaceId ?? 'workspace-1',
  status: input.status ?? null,
  createdAt: input.createdAt ?? '2026-05-28T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-28T00:00:00.000Z',
});

const makeProfile = (input: Partial<LoginProfileSummary> & Pick<LoginProfileSummary, 'id' | 'provider'>): LoginProfileSummary => ({
  id: input.id,
  provider: input.provider,
  displayName: input.displayName ?? input.id,
  authType: input.authType ?? 'codex_chatgpt_session',
  status: input.status ?? 'ready',
  isDefault: input.isDefault ?? false,
  redactedHint: input.redactedHint ?? null,
  config: input.config ?? null,
  statusMessage: input.statusMessage ?? null,
  planType: input.planType ?? null,
  lastCheckedAt: input.lastCheckedAt ?? null,
});

describe('useHeadlessQuickReply', () => {
  it('selects the ready default login profile for quick replies', () => {
    const selected = selectQuickReplyLoginProfile([
      makeProfile({ id: 'claude-1', provider: 'claude', isDefault: true }),
      makeProfile({ id: 'codex-1', provider: 'codex', status: 'expired', isDefault: true }),
      makeProfile({ id: 'codex-2', provider: 'codex', status: 'ready' }),
    ], 'codex');

    expect(selected?.id).toBe('codex-2');
  });

  it('does not select an inactive quick-reply login profile', () => {
    const selected = selectQuickReplyLoginProfile([
      makeProfile({ id: 'codex-1', provider: 'codex', status: 'usage_limited', isDefault: true }),
    ], 'codex');

    expect(selected).toBeNull();
  });

  it('materializes local fallback quick-reply nodes into query caches', () => {
    const queryClient = createTestQueryClient();
    const createdMessages = [
      makeMessage({
        id: 'user-1',
        role: 'user',
        content: 'Continue this',
        parentId: 'parent-1',
        createdAt: '2026-05-28T00:00:02.000Z',
      }),
      makeMessage({
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        status: 'pending' as any,
        createdAt: '2026-05-28T00:00:03.000Z',
      }),
    ];

    materializeHeadlessQuickReplyMessages(queryClient, 'workspace-1', createdMessages, {
      finalizedAt: 1779912000,
    });

    const cachedMessages = queryClient.getQueryData<Message[]>(['messages', 'workspace-1']) ?? [];
    const localRows = queryClient.getQueryData<LocalNodeMessage[]>(localNodeKeys.workspace('workspace-1')) ?? [];

    expect(cachedMessages.map((message) => message.id)).toEqual(['user-1', 'assistant-1']);
    expect(localRows.map((row) => row.nodeId)).toEqual(['user-1', 'assistant-1']);
    expect(localRows.every((row) => row.syncStatus === 'local_only')).toBe(true);
    expect(localRows.every((row) => row.finalizedAt === 1779912000)).toBe(true);
  });

  it('wires the quick-reply headless sender to local persistence callbacks', () => {
    const source = readFileSync(join(process.cwd(), 'src/hooks/useHeadlessQuickReply.ts'), 'utf8');

    expect(source).toContain('persistLocalNode:');
    expect(source).toContain('onMessagesCreated:');
    expect(source).toContain('materializeHeadlessQuickReplyMessages');
    expect(source).toContain('selectedLoginProfileId: selectedLoginProfile?.id ?? null');
    expect(source).toContain('markLocalAgentNodeTerminal');
  });
});
