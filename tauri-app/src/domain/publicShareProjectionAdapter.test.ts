import { describe, expect, it } from 'vitest';
import { publicPayloadToWorkspaceProjectionInput, type PublicShareProjectionPayload } from './publicShareProjectionAdapter';

const makePayload = (): PublicShareProjectionPayload => ({
  workspace: {
    id: 'workspace-1',
  },
  graph: {
    rootNodeId: 'assistant-1',
    messages: [
      {
        id: 'user-1',
        role: 'user',
        parentId: null,
        workspaceId: 'workspace-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        contentPreview: 'Build this',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-01-01T00:00:02.000Z',
        updatedAt: '2026-01-01T00:00:05.000Z',
        contentPreview: 'Done',
        agent_id: 'codex:gpt-5.5:xhigh',
        output_commit_sha: 'abc123456789',
        execution: {
          startedAt: '2026-01-01T00:00:02.000Z',
          endedAt: '2026-01-01T00:00:05.000Z',
          usage: {
            input_tokens: 1200,
            output_tokens: 345,
            total_tokens: 1545,
            cached_input_tokens: 512,
          },
        },
        commit: {
          sync_source: 'external_git',
          imported_from_ref: 'origin/main',
          source_ref: 'refs/heads/main',
          git_author_name: 'Agentree',
          git_authored_at: '2026-01-01T00:00:04.000Z',
          files_changed_count: 1,
          total_additions: 12,
          total_deletions: 2,
          files_changed: [{ additions: 12, deletions: 2, status: 'modified' }],
          commits: [
            {
              sha: 'abc123456789',
              subject: 'Implement feature',
              author_name: 'Agentree',
              authored_at: '2026-01-01T00:00:04.000Z',
              parents: ['parent0001'],
              files_changed_count: 1,
              total_additions: 12,
              total_deletions: 2,
              files_changed: [{ additions: 12, deletions: 2, status: 'modified' }],
            },
          ],
        },
      },
    ],
  },
});

describe('publicPayloadToWorkspaceProjectionInput', () => {
  it('creates workspace messages and public commit metadata', () => {
    const input = publicPayloadToWorkspaceProjectionInput(makePayload());

    expect(input.focusedMessageId).toBe('assistant-1');
    expect(input.messages).toHaveLength(2);
    expect(input.messages[1]).toMatchObject({
      id: 'assistant-1',
      role: 'assistant',
      parentId: 'user-1',
      output_commit_sha: 'abc123456789',
      llmProvider: 'codex',
      llmModel: 'codex/gpt-5.5-xhigh',
      promptTokens: 1200,
      completionTokens: 345,
      totalTokens: 1545,
    });
    expect(input.commits).toHaveLength(1);
    expect(input.commits?.[0]).toMatchObject({
      sha: 'abc123456789',
      subject: 'Implement feature',
      produced_by_node_id: 'assistant-1',
    });
    expect(input.commitParents?.[0]).toMatchObject({
      child_sha: 'abc123456789',
      parent_sha: 'parent0001',
    });
  });

  it('keeps public timing but does not reconstruct raw execution timelines', () => {
    const input = publicPayloadToWorkspaceProjectionInput(makePayload());
    const executionData = input.messages[1].execution_data as Record<string, unknown>;

    expect(executionData.started_at).toBe('2026-01-01T00:00:02.000Z');
    expect(executionData.ended_at).toBe('2026-01-01T00:00:05.000Z');
    expect(executionData.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 345,
      total_tokens: 1545,
      cached_input_tokens: 512,
    });
    expect(executionData.timeline).toBeUndefined();
    expect(executionData.tool_calls).toBeUndefined();
  });

  it('preserves public artifact references on projected messages', () => {
    const payload = makePayload();
    payload.graph.messages[1].artifacts = [{
      id: 'artifact-1',
      nodeId: 'assistant-1',
      role: 'output',
      kind: 'screenshot',
      mimeType: 'image/png',
      title: 'Landing preview',
      storage: {
        backend: 'remote',
        url: 'https://cdn.example.com/landing.png',
      },
      thumbnail: {
        url: 'https://cdn.example.com/landing-thumb.png',
      },
      isPrimary: true,
      publicSafe: true,
    }];

    const input = publicPayloadToWorkspaceProjectionInput(payload);
    const executionData = input.messages[1].execution_data as Record<string, any>;

    expect(executionData.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-1',
        nodeId: 'assistant-1',
        title: 'Landing preview',
        publicSafe: true,
      }),
    ]);
  });
});
