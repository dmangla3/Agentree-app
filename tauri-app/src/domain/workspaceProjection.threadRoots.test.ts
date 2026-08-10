import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import { buildWorkspaceProjection } from './workspaceProjection';

const makeMessage = (
  id: string,
  role: Message['role'],
  parentId: string | null,
  createdAt: string,
  overrides: Partial<Message> = {},
): Message => ({
  id,
  parentId,
  role,
  content: id,
  workspaceId: 'workspace-1',
  status: null,
  agent_id: null,
  execution_data: null,
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

describe('workspace projection thread roots', () => {
  it('derives thread ownership from conversation roots instead of commit bases', () => {
    const messages = [
      makeMessage('thread-a', 'user', null, '2026-05-19T00:00:00.000Z'),
      makeMessage('assistant-a', 'assistant', 'thread-a', '2026-05-19T00:01:00.000Z', {
        output_commit_sha: 'commit-a',
      }),
      makeMessage('thread-b', 'user', null, '2026-05-19T00:02:00.000Z', {
        base_commit_sha: 'commit-a',
      }),
      makeMessage('assistant-b', 'assistant', 'thread-b', '2026-05-19T00:03:00.000Z', {
        base_commit_sha: 'commit-a',
      }),
    ];

    const projection = buildWorkspaceProjection({
      messages,
      summaries: [],
      focusedMessageId: null,
    });

    expect(projection.threadRootIds).toEqual(['thread-a', 'thread-b']);
    expect(projection.entitiesByMessageId.get('thread-a')?.isThreadRoot).toBe(true);
    expect(projection.entitiesByMessageId.get('assistant-a')?.threadRootId).toBe('thread-a');
    expect(projection.entitiesByMessageId.get('thread-b')?.isThreadRoot).toBe(true);
    expect(projection.entitiesByMessageId.get('assistant-b')?.threadRootId).toBe('thread-b');
  });
});
