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
  it('redirects user message focus to the first assistant in the same turn', () => {
    const projection = buildWorkspaceProjection({
      messages: [
        makeMessage('user-a', 'user', null, '2026-05-28T00:00:00.000Z'),
        makeMessage('assistant-a', 'assistant', 'user-a', '2026-05-28T00:01:00.000Z'),
      ],
      summaries: [],
      focusedMessageId: 'assistant-a',
    });

    expect(projection.entitiesByMessageId.get('user-a')).toEqual(expect.objectContaining({
      kind: 'user_message',
      focusMessageId: 'assistant-a',
    }));
  });

  it('leaves user message focus empty until the turn has an assistant response', () => {
    const projection = buildWorkspaceProjection({
      messages: [
        makeMessage('user-a', 'user', null, '2026-05-28T00:00:00.000Z'),
      ],
      summaries: [],
      focusedMessageId: null,
    });

    expect(projection.entitiesByMessageId.get('user-a')).toEqual(expect.objectContaining({
      kind: 'user_message',
      focusMessageId: null,
    }));
  });

  it('refreshes assistant execution data when only the persisted failure reason changes', () => {
    const failedAssistant = makeMessage(
      'assistant-a',
      'assistant',
      'user-a',
      '2026-05-28T00:01:00.000Z',
      {
        status: 'failed' as any,
        content: 'Assistant failed.',
        execution_data: { last_terminal_status: 'failed' },
      },
    );

    buildWorkspaceProjection({
      messages: [
        makeMessage('user-a', 'user', null, '2026-05-28T00:00:00.000Z'),
        failedAssistant,
      ],
      summaries: [],
      focusedMessageId: 'assistant-a',
    });

    const projection = buildWorkspaceProjection({
      messages: [
        makeMessage('user-a', 'user', null, '2026-05-28T00:00:00.000Z'),
        {
          ...failedAssistant,
          execution_data: {
            last_terminal_status: 'failed',
            failure_reason: "ImportError: cannot import name 'ParamSpec' from 'typing'",
          },
        },
      ],
      summaries: [],
      focusedMessageId: 'assistant-a',
    });

    expect((projection.entitiesByMessageId.get('assistant-a')?.message?.execution_data as any)?.failure_reason)
      .toBe("ImportError: cannot import name 'ParamSpec' from 'typing'");
  });

  it('indexes orchestrator-controlled children separately from graph parentage', () => {
    const projection = buildWorkspaceProjection({
      messages: [
        makeMessage('root-user', 'user', null, '2026-05-28T00:00:00.000Z'),
        makeMessage('orchestrator', 'assistant', 'root-user', '2026-05-28T00:01:00.000Z', {
          execution_data: { meta: { node_kind: 'orchestrator' } },
        }),
        makeMessage('child-user', 'user', 'root-user', '2026-05-28T00:02:00.000Z', {
          controlled_by_node_id: 'orchestrator',
        }),
        makeMessage('child-assistant', 'assistant', 'child-user', '2026-05-28T00:03:00.000Z', {
          controlledByNodeId: 'orchestrator',
        }),
      ],
      summaries: [],
      focusedMessageId: 'child-assistant',
    });

    expect(projection.entitiesByMessageId.get('orchestrator')).toEqual(expect.objectContaining({
      nodeKind: 'orchestrator',
      controlledByNodeId: null,
    }));
    expect(projection.controlledEntityIdsByControllerMessageId.get('orchestrator')).toEqual([
      'user_message:child-user',
      'assistant_message:child-assistant',
    ]);
    expect(projection.childEntityIdsByParentEntityId.get('assistant_message:orchestrator')).toBeUndefined();
  });

  it('derives orchestration child run status counts on orchestrator entities', () => {
    const projection = buildWorkspaceProjection({
      messages: [
        makeMessage('root-user', 'user', null, '2026-05-28T00:00:00.000Z'),
        makeMessage('orchestrator', 'assistant', 'root-user', '2026-05-28T00:01:00.000Z', {
          execution_data: { meta: { node_kind: 'orchestrator' } },
        }),
        makeMessage('child-user-1', 'user', 'root-user', '2026-05-28T00:02:00.000Z', {
          controlled_by_node_id: 'orchestrator',
        }),
        makeMessage('child-assistant-1', 'assistant', 'child-user-1', '2026-05-28T00:03:00.000Z', {
          status: 'running' as any,
          controlled_by_node_id: 'orchestrator',
        }),
        makeMessage('child-user-2', 'user', 'root-user', '2026-05-28T00:04:00.000Z', {
          controlled_by_node_id: 'orchestrator',
        }),
        makeMessage('child-assistant-2', 'assistant', 'child-user-2', '2026-05-28T00:05:00.000Z', {
          status: 'completed' as any,
          controlled_by_node_id: 'orchestrator',
        }),
        makeMessage('child-user-3', 'user', 'root-user', '2026-05-28T00:06:00.000Z', {
          controlled_by_node_id: 'orchestrator',
        }),
        makeMessage('child-assistant-3', 'assistant', 'child-user-3', '2026-05-28T00:07:00.000Z', {
          status: 'failed_runtime' as any,
          controlled_by_node_id: 'orchestrator',
        }),
        makeMessage('child-user-4', 'user', 'root-user', '2026-05-28T00:08:00.000Z', {
          controlled_by_node_id: 'orchestrator',
        }),
        makeMessage('child-assistant-4', 'assistant', 'child-user-4', '2026-05-28T00:09:00.000Z', {
          status: 'cancelled' as any,
          controlled_by_node_id: 'orchestrator',
        }),
      ],
      summaries: [],
      focusedMessageId: 'orchestrator',
    });

    expect(projection.entitiesByMessageId.get('orchestrator')?.orchestrationSummary).toEqual({
      controllerMessageId: 'orchestrator',
      controlledEntityIds: [
        'user_message:child-user-1',
        'assistant_message:child-assistant-1',
        'user_message:child-user-2',
        'assistant_message:child-assistant-2',
        'user_message:child-user-3',
        'assistant_message:child-assistant-3',
        'user_message:child-user-4',
        'assistant_message:child-assistant-4',
      ],
      childAssistantEntityIds: [
        'assistant_message:child-assistant-1',
        'assistant_message:child-assistant-2',
        'assistant_message:child-assistant-3',
        'assistant_message:child-assistant-4',
      ],
      totalChildRuns: 4,
      activeChildRuns: 1,
      terminalChildRuns: 3,
      completedChildRuns: 1,
      failedChildRuns: 1,
      cancelledChildRuns: 1,
    });
  });

  it('derives an empty orchestration summary before children are created', () => {
    const projection = buildWorkspaceProjection({
      messages: [
        makeMessage('root-user', 'user', null, '2026-05-28T00:00:00.000Z'),
        makeMessage('orchestrator', 'assistant', 'root-user', '2026-05-28T00:01:00.000Z', {
          execution_data: { meta: { node_kind: 'orchestrator' } },
        }),
      ],
      summaries: [],
      focusedMessageId: 'orchestrator',
    });

    expect(projection.entitiesByMessageId.get('orchestrator')?.orchestrationSummary).toEqual({
      controllerMessageId: 'orchestrator',
      controlledEntityIds: [],
      childAssistantEntityIds: [],
      totalChildRuns: 0,
      activeChildRuns: 0,
      terminalChildRuns: 0,
      completedChildRuns: 0,
      failedChildRuns: 0,
      cancelledChildRuns: 0,
    });
  });

  it('projects an empty workspace thread origin when there are no messages', () => {
    const projection = buildWorkspaceProjection({
      messages: [],
      summaries: [],
      focusedMessageId: null,
      emptyThreadRoot: {
        threadRootId: 'workspace-empty-thread:workspace-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-05-28T00:00:00.000Z',
      },
    });

    expect(projection.threadRootIds).toEqual(['workspace-empty-thread:workspace-1']);
    expect(projection.rootMessageIdByThreadRootId.has('workspace-empty-thread:workspace-1')).toBe(false);
    expect(projection.entitiesById.get('thread_origin:workspace-empty-thread:workspace-1')).toEqual(expect.objectContaining({
      kind: 'thread_origin',
      preview: 'New thread',
      threadRootId: 'workspace-empty-thread:workspace-1',
    }));
  });

  it('projects a pending synthetic thread origin beside existing threads', () => {
    const projection = buildWorkspaceProjection({
      messages: [
        makeMessage('thread-a', 'user', null, '2026-05-28T00:00:00.000Z'),
      ],
      summaries: [],
      focusedMessageId: null,
      syntheticThreadRoots: [{
        threadRootId: 'pending-thread',
        workspaceId: 'workspace-1',
        createdAt: '2026-05-28T00:01:00.000Z',
      }],
    });

    expect(projection.threadRootIds).toEqual(['thread-a', 'pending-thread']);
    expect(projection.rootMessageIdByThreadRootId.has('pending-thread')).toBe(false);
    expect(projection.entitiesById.get('thread_origin:pending-thread')).toEqual(expect.objectContaining({
      kind: 'thread_origin',
      preview: 'New thread',
      threadRootId: 'pending-thread',
    }));
  });

  it('projects empty persisted thread sessions as thread origins', () => {
    const projection = buildWorkspaceProjection({
      messages: [],
      summaries: [],
      focusedMessageId: null,
      threadSessions: [{
        id: 'thread-session-1',
        workspaceId: 'workspace-1',
        title: 'Explore approach',
        status: 'active',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
        baseCommitSha: 'base-sha',
        firstMessageId: null,
        source: 'user',
      }],
    });

    expect(projection.threadRootIds).toEqual(['thread-session-1']);
    expect(projection.rootMessageIdByThreadRootId.has('thread-session-1')).toBe(false);
    expect(projection.entitiesById.get('thread_origin:thread-session-1')).toEqual(expect.objectContaining({
      kind: 'thread_origin',
      preview: 'Explore approach',
      threadRootId: 'thread-session-1',
    }));
  });

  it('marks a persisted session first message as the thread root', () => {
    const projection = buildWorkspaceProjection({
      messages: [
        makeMessage('user-a', 'user', null, '2026-05-28T00:00:00.000Z', {
          thread_id: 'thread-session-1',
        }),
        makeMessage('assistant-a', 'assistant', 'user-a', '2026-05-28T00:01:00.000Z', {
          thread_id: 'thread-session-1',
        }),
      ],
      summaries: [],
      focusedMessageId: null,
      threadSessions: [{
        id: 'thread-session-1',
        workspaceId: 'workspace-1',
        title: null,
        status: 'active',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:01:00.000Z',
        baseCommitSha: null,
        firstMessageId: 'user-a',
        source: 'user',
      }],
    });

    expect(projection.threadRootIds).toEqual(['thread-session-1']);
    expect(projection.rootMessageIdByThreadRootId.get('thread-session-1')).toBe('user-a');
    expect(projection.entitiesByMessageId.get('user-a')?.isThreadRoot).toBe(true);
    expect(projection.entitiesByMessageId.get('assistant-a')?.threadRootId).toBe('thread-session-1');
  });

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

  it('assigns external merges that integrate Agentree commits to the Agentree parent thread', () => {
    const messages = [
      makeMessage('thread-a', 'user', null, '2026-05-19T00:00:00.000Z'),
      makeMessage('assistant-a', 'assistant', 'thread-a', '2026-05-19T00:01:00.000Z', {
        output_commit_sha: 'agent-a',
      }),
      makeMessage('thread-b', 'user', null, '2026-05-19T00:02:00.000Z'),
      makeMessage('assistant-b', 'assistant', 'thread-b', '2026-05-19T00:03:00.000Z', {
        output_commit_sha: 'agent-b',
      }),
    ];

    const projection = buildWorkspaceProjection({
      messages,
      summaries: [],
      focusedMessageId: null,
      commits: [
        {
          workspace_id: 'workspace-1',
          sha: 'main-before',
          subject: 'Main before merge',
          source_kind: 'external',
          produced_by_node_id: null,
          first_parent_sha: null,
        },
        {
          workspace_id: 'workspace-1',
          sha: 'agent-a',
          subject: 'Thread A output',
          source_kind: 'agent',
          produced_by_node_id: 'assistant-a',
          first_parent_sha: 'main-before',
        },
        {
          workspace_id: 'workspace-1',
          sha: 'agent-b',
          subject: 'Thread B output',
          source_kind: 'agent',
          produced_by_node_id: 'assistant-b',
          first_parent_sha: 'main-before',
        },
        {
          workspace_id: 'workspace-1',
          sha: 'external-merge',
          subject: 'Merge Agentree work into main',
          source_kind: 'external',
          produced_by_node_id: null,
          first_parent_sha: 'main-before',
        },
      ],
      commitParents: [
        { child_sha: 'agent-a', parent_sha: 'main-before', parent_index: 0 },
        { child_sha: 'agent-b', parent_sha: 'main-before', parent_index: 0 },
        { child_sha: 'external-merge', parent_sha: 'main-before', parent_index: 0 },
        { child_sha: 'external-merge', parent_sha: 'agent-a', parent_index: 1 },
        { child_sha: 'external-merge', parent_sha: 'agent-b', parent_index: 2 },
      ],
      commitObservations: [
        { commit_sha: 'external-merge', source_kind: 'external', git_ref: 'refs/heads/main' },
      ],
    });

    expect(projection.commitBySha.get('agent-a')?.ownerThreadRootId).toBe('thread-a');
    expect(projection.commitBySha.get('agent-a')?.representedThreadRootIds).toEqual(['thread-a']);
    expect(projection.commitBySha.get('external-merge')?.ownerThreadRootId).toBeNull();
    expect(projection.commitBySha.get('external-merge')?.isProminentMerge).toBe(true);
    expect(projection.commitBySha.get('external-merge')?.layoutParentSha).toBe('agent-a');
    expect(projection.commitBySha.get('external-merge')?.representedThreadRootIds).toEqual(['thread-a', 'thread-b']);
  });
});
