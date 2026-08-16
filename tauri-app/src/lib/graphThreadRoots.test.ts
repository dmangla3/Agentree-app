import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import {
  buildThreadRootIndex,
  getHiddenConversationMessageIds,
  getLatestThreadMessageId,
  getThreadDescendantIds,
  getThreadRootId,
} from './graphThreadRoots';

const makeMessage = (
  id: string,
  role: Message['role'],
  parentId: string | null,
  outputCommitSha?: string | null,
): Message => ({
  id,
  parentId,
  role,
  content: id,
  workspaceId: 'workspace-1',
  status: null,
  agent_id: null,
  output_commit_sha: outputCommitSha ?? null,
  execution_data: null,
  createdAt: '2026-05-19T00:00:00.000Z',
  updatedAt: '2026-05-19T00:00:00.000Z',
});

describe('graph thread roots', () => {
  it('assigns conversation nodes to their root user thread by parentId only', () => {
    const messages = [
      makeMessage('thread-a', 'user', null),
      makeMessage('assistant-a', 'assistant', 'thread-a', 'commit-a'),
      makeMessage('thread-b', 'user', null),
      makeMessage('assistant-b', 'assistant', 'thread-b'),
    ];
    const messageMap = new Map(messages.map((message) => [message.id, message]));

    expect(getThreadRootId('assistant-a', messageMap)).toBe('thread-a');
    expect(getThreadRootId('assistant-b', messageMap)).toBe('thread-b');
  });

  it('does not let shared commits change thread ownership', () => {
    const messages = [
      makeMessage('thread-a', 'user', null),
      makeMessage('assistant-a', 'assistant', 'thread-a', 'commit-a'),
      {
        ...makeMessage('thread-b', 'user', null),
        base_commit_sha: 'commit-a',
      },
      {
        ...makeMessage('assistant-b', 'assistant', 'thread-b'),
        base_commit_sha: 'commit-a',
      },
    ];
    const messageMap = new Map(messages.map((message) => [message.id, message]));

    expect(getThreadRootId('thread-b', messageMap)).toBe('thread-b');
    expect(getThreadRootId('assistant-b', messageMap)).toBe('thread-b');
  });

  it('indexes only root user messages as threads', () => {
    const messages = [
      makeMessage('welcome', 'assistant', null),
      makeMessage('thread-a', 'user', null),
      makeMessage('assistant-a', 'assistant', 'thread-a'),
      makeMessage('commit-row', 'assistant', null, 'external-commit'),
      makeMessage('thread-b', 'user', null),
    ];

    const index = buildThreadRootIndex(messages);

    expect(index.threadRootIds).toEqual(['thread-a', 'thread-b']);
    expect(index.threadRootIdByMessageId.get('assistant-a')).toBe('thread-a');
    expect(index.threadRootIdByMessageId.has('welcome')).toBe(false);
    expect(index.threadRootIdByMessageId.has('commit-row')).toBe(false);
  });

  it('groups multiple root user messages that share a thread origin id', () => {
    const messages = [
      {
        ...makeMessage('user-codex', 'user', null),
        createdAt: '2026-05-26T10:00:00.000Z',
        execution_data: { meta: { thread_origin_id: 'thread-origin-1' } },
      },
      {
        ...makeMessage('assistant-codex', 'assistant', 'user-codex'),
        createdAt: '2026-05-26T10:00:01.000Z',
      },
      {
        ...makeMessage('user-claude', 'user', null),
        createdAt: '2026-05-26T10:00:02.000Z',
        execution_data: { meta: { thread_origin_id: 'thread-origin-1' } },
      },
      {
        ...makeMessage('assistant-claude', 'assistant', 'user-claude'),
        createdAt: '2026-05-26T10:00:03.000Z',
      },
    ];

    const index = buildThreadRootIndex(messages);

    expect(index.threadRootIds).toEqual(['thread-origin-1']);
    expect(index.rootMessageIdByThreadRootId.get('thread-origin-1')).toBe('user-codex');
    expect(index.threadRootIdByMessageId.get('assistant-codex')).toBe('thread-origin-1');
    expect(index.threadRootIdByMessageId.get('assistant-claude')).toBe('thread-origin-1');
    expect(Array.from(getThreadDescendantIds('thread-origin-1', messages)).sort()).toEqual([
      'assistant-claude',
      'assistant-codex',
      'user-claude',
      'user-codex',
    ]);
  });

  it('collects descendants for one thread root without crossing into another root', () => {
    const messages = [
      makeMessage('thread-a', 'user', null),
      makeMessage('assistant-a', 'assistant', 'thread-a'),
      makeMessage('thread-a-child', 'user', 'assistant-a'),
      makeMessage('assistant-a-child', 'assistant', 'thread-a-child'),
      makeMessage('thread-b', 'user', null),
      makeMessage('assistant-b', 'assistant', 'thread-b'),
    ];

    expect(Array.from(getThreadDescendantIds('thread-a', messages)).sort()).toEqual([
      'assistant-a',
      'assistant-a-child',
      'thread-a',
      'thread-a-child',
    ]);
  });

  it('treats the first user below a synthetic assistant root as a thread root', () => {
    const messages = [
      makeMessage('welcome', 'assistant', null),
      makeMessage('thread-a', 'user', 'welcome'),
      makeMessage('assistant-a', 'assistant', 'thread-a'),
      makeMessage('thread-a-child', 'user', 'assistant-a'),
      makeMessage('assistant-a-child', 'assistant', 'thread-a-child'),
      makeMessage('thread-b', 'user', null),
      makeMessage('assistant-b', 'assistant', 'thread-b'),
    ];
    const messageMap = new Map(messages.map((message) => [message.id, message]));
    const index = buildThreadRootIndex(messages);

    expect(getThreadRootId('assistant-a-child', messageMap)).toBe('thread-a');
    expect(index.threadRootIds).toEqual(['thread-a', 'thread-b']);
    expect(Array.from(getThreadDescendantIds('thread-a', messages)).sort()).toEqual([
      'assistant-a',
      'assistant-a-child',
      'thread-a',
      'thread-a-child',
    ]);
  });

  it('combines hidden thread roots and hidden subgraph descendants', () => {
    const messages = [
      makeMessage('thread-a', 'user', null),
      makeMessage('assistant-a', 'assistant', 'thread-a'),
      makeMessage('thread-a-child', 'user', 'assistant-a'),
      makeMessage('assistant-a-child', 'assistant', 'thread-a-child'),
      makeMessage('thread-b', 'user', null),
      makeMessage('assistant-b', 'assistant', 'thread-b'),
    ];

    expect(Array.from(getHiddenConversationMessageIds({
      messages,
      hiddenThreadRootIds: new Set(['thread-b']),
      hiddenSubgraphRootIds: new Set(['thread-a-child']),
    })).sort()).toEqual([
      'assistant-a-child',
      'assistant-b',
      'thread-a-child',
      'thread-b',
    ]);
  });

  it('returns the newest conversation message in a thread', () => {
    const messages = [
      {
        ...makeMessage('thread-a', 'user', null),
        createdAt: '2026-05-19T00:00:00.000Z',
      },
      {
        ...makeMessage('assistant-a', 'assistant', 'thread-a'),
        createdAt: '2026-05-19T00:01:00.000Z',
      },
      {
        ...makeMessage('thread-a-followup', 'user', 'assistant-a'),
        createdAt: '2026-05-19T00:02:00.000Z',
      },
      {
        ...makeMessage('assistant-a-followup', 'assistant', 'thread-a-followup'),
        createdAt: '2026-05-19T00:03:00.000Z',
      },
      {
        ...makeMessage('thread-b', 'user', null),
        createdAt: '2026-05-19T00:04:00.000Z',
      },
    ];

    expect(getLatestThreadMessageId('thread-a', messages)).toBe('assistant-a-followup');
  });
});
