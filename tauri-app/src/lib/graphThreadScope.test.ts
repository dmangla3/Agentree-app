import { describe, expect, it } from 'vitest';
import type { CommitEntity, CommitObservationEntity, CommitParentEntity, Message, Summary } from '../stores/workspaceStore';
import { buildThreadRootIndex } from './graphThreadRoots';
import {
  filterCommitContextForThreadScope,
  filterSummariesForThreadScope,
  getThreadScopeKey,
  resolveDoneThreadsReopenedByUserMessages,
  resolveActiveThreadAfterDoneChange,
  resolveInitialActiveThreadRootId,
  resolveThreadGraphScope,
} from './graphThreadScope';

const message = (
  id: string,
  role: Message['role'],
  parentId: string | null,
  createdAt = '2026-05-27T00:00:00.000Z',
): Message => ({
  id,
  role,
  content: `${role} ${id}`,
  parentId,
  conversationId: 'workspace-1',
  workspaceId: 'workspace-1',
  createdAt,
  updatedAt: createdAt,
  status: 'completed',
} as Message);

const summary = (id: string, startMessageId: string, endMessageId: string): Summary => ({
  id,
  conversationId: 'workspace-1',
  workspaceId: 'workspace-1',
  startMessageId,
  endMessageId,
  content: `summary ${id}`,
  tokenCountBefore: 100,
  tokenCountAfter: 40,
  createdAt: '2026-05-27T00:00:00.000Z',
  updatedAt: '2026-05-27T00:00:00.000Z',
} as Summary);

const commit = (sha: string, producedByNodeId: string | null = null, sourceKind: CommitEntity['source_kind'] = 'agent'): CommitEntity => ({
  workspace_id: 'workspace-1',
  sha,
  subject: sha,
  source_kind: sourceKind,
  produced_by_node_id: producedByNodeId,
});

describe('graph thread scope', () => {
  const messages = [
    message('thread-a', 'user', null, '2026-05-27T00:00:01.000Z'),
    message('assistant-a', 'assistant', 'thread-a', '2026-05-27T00:00:02.000Z'),
    message('thread-b', 'user', null, '2026-05-27T00:00:03.000Z'),
    message('assistant-b', 'assistant', 'thread-b', '2026-05-27T00:00:04.000Z'),
    message('assistant-b-2', 'assistant', 'thread-b', '2026-05-27T00:00:05.000Z'),
  ];
  const index = buildThreadRootIndex(messages);

  it('selects the newest active thread when no saved thread exists', () => {
    expect(resolveInitialActiveThreadRootId({
      preferredThreadRootId: null,
      threadRootIds: index.threadRootIds,
      threadItems: [
        { threadRootId: 'thread-a', lastUpdatedAt: 2, done: false, runningCount: 0 },
        { threadRootId: 'thread-b', lastUpdatedAt: 5, done: false, runningCount: 0 },
      ],
    })).toBe('thread-b');
  });

  it('keeps a running done thread eligible for initial selection', () => {
    expect(resolveInitialActiveThreadRootId({
      preferredThreadRootId: null,
      threadRootIds: index.threadRootIds,
      threadItems: [
        { threadRootId: 'thread-a', lastUpdatedAt: 2, done: false, runningCount: 0 },
        { threadRootId: 'thread-b', lastUpdatedAt: 5, done: true, runningCount: 1 },
      ],
    })).toBe('thread-b');
  });

  it('selects another active thread when the current thread is marked done', () => {
    expect(resolveActiveThreadAfterDoneChange({
      changedThreadRootId: 'thread-b',
      done: true,
      activeThreadRootId: 'thread-b',
      threadRootIds: index.threadRootIds,
      threadItems: [
        { threadRootId: 'thread-a', lastUpdatedAt: 2, done: false, runningCount: 0 },
        { threadRootId: 'thread-b', lastUpdatedAt: 5, done: true, runningCount: 0 },
      ],
    })).toBe('thread-a');
  });

  it('reopens a done thread when a user sends another message in it', () => {
    expect(resolveDoneThreadsReopenedByUserMessages({
      doneThreadRootIds: new Set(['thread-a', 'thread-b']),
      previousUserMessageCountsByThreadRootId: new Map([
        ['thread-a', 1],
        ['thread-b', 1],
      ]),
      currentUserMessageCountsByThreadRootId: new Map([
        ['thread-a', 2],
        ['thread-b', 1],
      ]),
    })).toEqual(['thread-a']);
  });

  it('keeps an empty active thread scoped so its origin remains visible', () => {
    const emptyIndex = buildThreadRootIndex([], {
      emptyThreadRootId: 'workspace-empty-thread:workspace-1',
    });

    const scope = resolveThreadGraphScope({
      messages: [],
      threadRootIndex: emptyIndex,
      activeThreadRootId: 'workspace-empty-thread:workspace-1',
    });

    expect(scope.activeThreadRootId).toBe('workspace-empty-thread:workspace-1');
    expect(scope.rootMessageId).toBe(null);
    expect(scope.scopedMessages).toEqual([]);
    expect(scope.isThreadScoped).toBe(true);
  });

  it('returns only messages for the active thread', () => {
    const scope = resolveThreadGraphScope({
      messages,
      threadRootIndex: index,
      activeThreadRootId: 'thread-b',
    });

    expect(scope.isThreadScoped).toBe(true);
    expect(scope.activeThreadRootId).toBe('thread-b');
    expect(scope.rootMessageId).toBe('thread-b');
    expect(scope.latestMessageId).toBe('assistant-b-2');
    expect(scope.scopedMessages.map((item) => item.id)).toEqual(['thread-b', 'assistant-b', 'assistant-b-2']);
    expect(Array.from(scope.scopedMessageIds).sort()).toEqual(['assistant-b', 'assistant-b-2', 'thread-b']);
  });

  it('falls back to all messages when the active thread is missing', () => {
    const scope = resolveThreadGraphScope({
      messages,
      threadRootIndex: index,
      activeThreadRootId: 'missing-thread',
    });

    expect(scope.isThreadScoped).toBe(false);
    expect(scope.activeThreadRootId).toBeNull();
    expect(scope.scopedMessages).toBe(messages);
  });

  it('filters summaries to summaries fully inside the active thread', () => {
    const scope = resolveThreadGraphScope({
      messages,
      threadRootIndex: index,
      activeThreadRootId: 'thread-b',
    });
    const summaries = [
      summary('thread-b-summary', 'thread-b', 'assistant-b-2'),
      summary('cross-thread-summary', 'thread-a', 'assistant-b-2'),
    ];

    expect(filterSummariesForThreadScope(summaries, scope).map((item) => item.id)).toEqual(['thread-b-summary']);
  });

  it('filters commit context to commits produced by the active thread messages', () => {
    const scopedMessages: Message[] = [
      message('thread-a', 'user', null, '2026-05-27T00:00:01.000Z'),
      {
        ...message('assistant-a', 'assistant', 'thread-a', '2026-05-27T00:00:02.000Z'),
        output_commit_sha: 'agent-a',
      },
    ];
    const allMessages: Message[] = [
      ...scopedMessages,
      message('thread-b', 'user', null, '2026-05-27T00:00:03.000Z'),
      {
        ...message('assistant-b', 'assistant', 'thread-b', '2026-05-27T00:00:04.000Z'),
        output_commit_sha: 'agent-b',
      },
    ];
    const scope = resolveThreadGraphScope({
      messages: allMessages,
      threadRootIndex: buildThreadRootIndex(allMessages),
      activeThreadRootId: 'thread-a',
    });
    const commits: CommitEntity[] = [
      commit('imported-base', null, 'external'),
      commit('agent-a', 'assistant-a', 'agent'),
      commit('agent-b', 'assistant-b', 'agent'),
      commit('external-merge', null, 'external'),
    ];
    const commitParents: CommitParentEntity[] = [
      { child_sha: 'agent-a', parent_sha: 'imported-base', parent_index: 0 },
      { child_sha: 'agent-b', parent_sha: 'imported-base', parent_index: 0 },
      { child_sha: 'external-merge', parent_sha: 'agent-a', parent_index: 0 },
      { child_sha: 'external-merge', parent_sha: 'agent-b', parent_index: 1 },
    ];
    const commitObservations: CommitObservationEntity[] = [
      { commit_sha: 'agent-a', source_kind: 'agent' },
      { commit_sha: 'external-merge', source_kind: 'external', git_ref: 'refs/heads/main' },
    ];

    const filtered = filterCommitContextForThreadScope({
      messages: scopedMessages,
      scope,
      commits,
      commitParents,
      commitObservations,
    });

    expect(filtered.commits.map((item) => item.sha)).toEqual(['agent-a']);
    expect(filtered.commitParents).toEqual([
      { child_sha: 'agent-a', parent_sha: 'imported-base', parent_index: 0 },
    ]);
    expect(filtered.commitObservations).toEqual([
      { commit_sha: 'agent-a', source_kind: 'agent' },
    ]);
  });

  it('keeps full commit context when the graph is not thread scoped', () => {
    const scope = resolveThreadGraphScope({
      messages,
      threadRootIndex: index,
      activeThreadRootId: null,
    });
    const commits = [commit('external-a', null, 'external')];
    const commitParents: CommitParentEntity[] = [];
    const commitObservations: CommitObservationEntity[] = [];

    const filtered = filterCommitContextForThreadScope({
      messages,
      scope,
      commits,
      commitParents,
      commitObservations,
    });

    expect(filtered.commits).toBe(commits);
    expect(filtered.commitParents).toBe(commitParents);
    expect(filtered.commitObservations).toBe(commitObservations);
  });

  it('creates stable scope cache keys', () => {
    expect(getThreadScopeKey('workspace-1', 'thread-b')).toBe('workspace-1:thread-b');
    expect(getThreadScopeKey('workspace-1', null)).toBe('workspace-1:all');
  });
});
