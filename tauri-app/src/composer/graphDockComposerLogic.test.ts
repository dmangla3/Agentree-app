import { describe, expect, it } from 'vitest';
import type { Agent } from '../hooks/useAgents';
import type { Message, Workspace } from '../stores/workspaceStore';
import {
  resolveGraphDockComposerAgent,
  resolveGraphDockComposerBase,
  resolveGraphDockComposerTarget,
} from './graphDockComposerLogic';

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
  createdAt: input.createdAt ?? '2026-05-27T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-27T00:00:00.000Z',
});

const agents: Agent[] = [
  {
    id: 'codex:gpt-5.5:high',
    name: 'Codex High',
    type: 'codex',
    model_config: { model: 'gpt-5.5' },
    cliArgs: '',
    promptFlag: null,
  },
  {
    id: 'claude-sonnet',
    name: 'Claude',
    type: 'claude',
    model_config: { model: 'claude-sonnet' },
    cliArgs: '',
    promptFlag: '--prompt',
  },
];

describe('graph dock composer logic', () => {
  it('targets the focused node for replies', () => {
    expect(resolveGraphDockComposerTarget({
      focusedMessageId: 'node-1',
      lastFocusSource: 'graph',
      lastFocusMetadata: null,
    })).toEqual({
      parentMessageId: 'node-1',
      selectedNodeId: 'node-1',
      focusedCommitSha: null,
    });
  });

  it('uses the reply parent output commit as the base without loading commit lists', () => {
    const messages = [
      message({ id: 'root', output_commit_sha: 'root-output' }),
      message({ id: 'parent', parentId: 'root', output_commit_sha: 'parent-output' }),
    ];

    expect(resolveGraphDockComposerBase({
      replyParentMessageId: 'parent',
      selectedNodeId: 'parent',
      focusedCommitSha: null,
      messages,
      workspace: { id: 'workspace-1', base_commit_sha: 'workspace-base' } as Workspace,
      override: null,
    })).toEqual({
      commitSha: 'parent-output',
      selectedFromNodeId: 'parent',
      source: 'reply-parent-output',
    });
  });

  it('does not use graph thread creation base rules when no reply parent is selected', () => {
    expect(resolveGraphDockComposerBase({
      replyParentMessageId: null,
      selectedNodeId: 'parent',
      focusedCommitSha: null,
      messages: [
        message({ id: 'thread-root', base_commit_sha: 'thread-root-base' }),
        message({ id: 'parent', parentId: 'thread-root' }),
      ],
      refs: [{ git_ref: 'refs/heads/main', short_name: 'main', commit_sha: 'main-tip' }],
      workspace: { id: 'workspace-1', base_commit_sha: 'workspace-base' } as Workspace,
      override: null,
    })).toEqual({
      commitSha: 'workspace-base',
      selectedFromNodeId: null,
      source: 'workspace-base',
    });
  });

  it('uses workspace base when no reply parent base is available', () => {
    expect(resolveGraphDockComposerBase({
      replyParentMessageId: null,
      selectedNodeId: 'parent',
      focusedCommitSha: null,
      messages: [message({ id: 'parent' })],
      workspace: { id: 'workspace-1', base_commit_sha: 'workspace-base' } as Workspace,
      override: null,
    })).toEqual({
      commitSha: 'workspace-base',
      selectedFromNodeId: null,
      source: 'workspace-base',
    });
  });

  it('uses the selected agent before parent defaults so model changes take effect', () => {
    const parent = message({
      id: 'parent',
      role: 'assistant',
      llmProvider: 'claude',
      llmModel: 'claude-sonnet',
    });

    expect(resolveGraphDockComposerAgent({
      agents,
      selectedAgentId: 'codex:gpt-5.5:high',
      parentMessage: parent,
    })?.id).toBe('codex:gpt-5.5:high');
  });

  it('uses parent agent preferences when there is no selected agent', () => {
    const parent = message({
      id: 'parent',
      role: 'assistant',
      llmProvider: 'claude',
      llmModel: 'claude-sonnet',
    });

    expect(resolveGraphDockComposerAgent({
      agents,
      selectedAgentId: null,
      parentMessage: parent,
    })?.id).toBe('claude-sonnet');
  });
});
