import { describe, expect, it, vi } from 'vitest';
import { sendHeadlessComposerMessage, sendHeadlessComposerReply } from './headlessComposerSend';
import type { Message, Workspace } from '../stores/workspaceStore';

const message = (input: Partial<Message> & Pick<Message, 'id'>): Message => ({
  id: input.id,
  role: input.role ?? 'assistant',
  content: input.content ?? '',
  parentId: input.parentId ?? null,
  workspaceId: input.workspaceId ?? 'workspace-1',
  status: input.status ?? null,
  execution_data: input.execution_data ?? null,
  threadId: input.threadId,
  thread_id: input.thread_id,
  createdAt: input.createdAt ?? '2026-05-27T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-27T00:00:00.000Z',
});

describe('sendHeadlessComposerReply', () => {
  it('creates a reply message and starts the runtime from the supplied base commit', async () => {
    const seedAgentRun = vi.fn();
    const dispatchAgentRun = vi.fn();
    const onAssistantMessageCreated = vi.fn();
    const startAgentRun = vi.fn().mockResolvedValue(undefined);

    const response = await sendHeadlessComposerReply({
      workspaceId: 'workspace-1',
      replyParentId: 'parent-1',
      prompt: 'Ship it',
      messages: [
        message({ id: 'root', output_commit_sha: 'root-output' }),
        message({ id: 'parent-1', parentId: 'root' }),
      ],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '--model gpt-5.5',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'root-output',
        selectedFromNodeId: 'root',
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun,
      dispatchAgentRun,
      onAssistantMessageCreated,
      createRunId: () => 'run-1',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(response.userMessage).toEqual(expect.objectContaining({
      role: 'user',
      content: 'Ship it',
      parentId: 'parent-1',
    }));
    expect(response.assistantMessages?.[0]).toEqual(expect.objectContaining({
      role: 'assistant',
      parentId: response.userMessage?.id,
      agent_id: 'codex-agent',
      base_commit_sha: 'root-output',
      base_selected_from_node_id: 'root',
    }));
    const localUserMessage = response.userMessage!;
    const localAssistantMessage = response.assistantMessages![0];
    expect(seedAgentRun).toHaveBeenCalledWith(localUserMessage);
    expect(seedAgentRun).toHaveBeenCalledWith(localAssistantMessage);
    expect(onAssistantMessageCreated).toHaveBeenCalledWith(localAssistantMessage);
    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      assistantNodeId: localAssistantMessage.id,
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      parentCommit: 'root-output',
      agentType: 'codex',
      authToken: 'token-1',
      runContext: expect.objectContaining({
        gitBranchName: `agentree/${localAssistantMessage.id}`,
        parentCommit: 'root-output',
        promptFallback: 'Ship it',
        executionData: expect.objectContaining({
          agent_id: 'codex-agent',
          meta: expect.objectContaining({
            agent_id: 'codex-agent',
          }),
        }),
      }),
    }));
    expect(startAgentRun.mock.calls[0][0].args[0]).toBe('--model');
    expect(startAgentRun.mock.calls[0][0].args.at(-1)).toContain('Ship it');
    expect(dispatchAgentRun).toHaveBeenCalledWith(localAssistantMessage.id, {
      type: 'status',
      status: 'running',
    });
  });

  it('supports fresh root sends without quick-reply metadata', async () => {
    const startAgentRun = vi.fn().mockResolvedValue(undefined);
    const dispatchAgentRun = vi.fn();

    const response = await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: null,
      contextParentId: null,
      contextPolicy: 'fresh',
      prompt: 'Start a new direction',
      messages: [],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'workspace-base',
        selectedFromNodeId: null,
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun,
      createRunId: () => 'run-root',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(response.userMessage).toEqual(expect.objectContaining({
      parentId: null,
      content: 'Start a new direction',
    }));
    expect(response.assistantMessages?.[0]).toEqual(expect.objectContaining({
      parentId: response.userMessage?.id,
      base_selected_from_node_id: null,
    }));
    expect(response.assistantMessages?.[0]?.execution_data?.meta?.quick_reply).toBeUndefined();
    expect(response.assistantMessages?.[0]?.execution_data?.meta?.base_commit_sha).toBe('workspace-base');
    expect(response.assistantMessages?.[0]?.execution_data?.context_profile).toEqual(expect.objectContaining({
      base_node_id: null,
      context_parent_node_id: null,
    }));
    const executionDataEvent = dispatchAgentRun.mock.calls.find(([nodeId, event]) => (
      nodeId === response.assistantMessages?.[0]?.id && event.type === 'execution_data'
    ));
    expect(executionDataEvent?.[1].patch.meta.quick_reply).toBeUndefined();
    expect(executionDataEvent?.[1].patch.meta.base_commit_sha).toBe('workspace-base');
  });

  it('passes selected login profile id into native agent run intent', async () => {
    const startAgentRun = vi.fn().mockResolvedValue(undefined);
    const result = await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: null,
      contextParentId: null,
      contextPolicy: 'fresh',
      prompt: 'Ship it',
      messages: [],
      agent: {
        id: 'codex:gpt-5.5:high',
        type: 'codex',
        name: 'Codex',
        cliArgs: '--model gpt-5.5',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'workspace-base',
        selectedFromNodeId: null,
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      selectedLoginProfileId: 'profile-codex-work',
      createRunId: () => 'run-login-profile',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    } as any);

    expect(result).toBeDefined();
    expect(startAgentRun).toHaveBeenCalledTimes(1);
    const intent = startAgentRun.mock.calls[0][0];
    expect(intent.loginProfileId).toBe('profile-codex-work');
    expect(intent.runContext.executionData.meta.login_profile_id).toBe('profile-codex-work');
  });

  it('lets the composer permission mode override stored agent cli permission flags', async () => {
    const startAgentRun = vi.fn().mockResolvedValue(undefined);
    await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: null,
      contextParentId: null,
      contextPolicy: 'fresh',
      prompt: 'Use isolated permissions',
      messages: [],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '--model gpt-5.5 --permission-mode auto',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'workspace-base',
        selectedFromNodeId: null,
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      permissionMode: 'fully-isolated',
      createRunId: () => 'run-permissions',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    const intent = startAgentRun.mock.calls[0][0];
    expect(intent.args).toEqual(expect.arrayContaining(['--permission-mode', 'fully-isolated']));
    expect(intent.args).not.toContain('auto');
    expect(intent.runContext.executionData.meta.composer_permission_mode).toBe('fully-isolated');
  });

  it('sends the first-class thread id and legacy thread origin for new graph threads', async () => {
    const response = await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: null,
      contextParentId: null,
      contextPolicy: 'fresh',
      prompt: 'Start persisted thread',
      messages: [],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'workspace-base',
        selectedFromNodeId: null,
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun: vi.fn().mockResolvedValue(undefined),
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      threadId: 'thread-session-1',
      threadOriginId: 'thread-session-1',
      createRunId: () => 'run-thread',
    });

    expect(response.userMessage?.threadId).toBe('thread-session-1');
    expect(response.assistantMessages?.[0]?.threadId).toBe('thread-session-1');
    expect(response.userMessage?.execution_data?.meta?.thread_origin_id).toBe('thread-session-1');
  });

  it('inherits first-class thread ids for replies', async () => {
    const response = await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: 'parent-1',
      contextParentId: 'parent-1',
      contextPolicy: 'continue',
      prompt: 'Continue thread',
      messages: [message({ id: 'parent-1', threadId: 'thread-session-1' })],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'base-sha',
        selectedFromNodeId: 'parent-1',
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun: vi.fn().mockResolvedValue(undefined),
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      createRunId: () => 'run-thread-reply',
    });

    expect(response.userMessage?.threadId).toBe('thread-session-1');
    expect(response.assistantMessages?.[0]?.threadId).toBe('thread-session-1');
  });

  it('creates local runtime nodes for native graph sends', async () => {
    const startAgentRun = vi.fn().mockResolvedValue(undefined);
    const persistLocalNode = vi.fn().mockResolvedValue(undefined);
    const onMessagesCreated = vi.fn();
    const seedAgentRun = vi.fn();
    const dispatchAgentRun = vi.fn();

    await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: 'parent-1',
      contextParentId: 'parent-1',
      contextPolicy: 'continue',
      prompt: 'Use local first',
      messages: [message({ id: 'parent-1', output_commit_sha: 'base-sha' })],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'base-sha',
        selectedFromNodeId: 'parent-1',
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun,
      dispatchAgentRun,
      persistLocalNode,
      onMessagesCreated,
      createRunId: () => 'run-local',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(persistLocalNode).toHaveBeenCalledTimes(2);
    const userMessage = persistLocalNode.mock.calls[0][2] as Message;
    const assistantMessage = persistLocalNode.mock.calls[1][2] as Message;
    expect(userMessage.role).toBe('user');
    expect(userMessage.content).toBe('Use local first');
    expect(userMessage.parentId).toBe('parent-1');
    expect(assistantMessage.role).toBe('assistant');
    expect(assistantMessage.parentId).toBe(userMessage.id);
    expect(assistantMessage.base_commit_sha).toBe('base-sha');
    expect(onMessagesCreated).toHaveBeenCalledWith([userMessage, assistantMessage]);
    expect(seedAgentRun).toHaveBeenCalledWith(userMessage);
    expect(seedAgentRun).toHaveBeenCalledWith(assistantMessage);
    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-local',
      assistantNodeId: assistantMessage.id,
      parentCommit: 'base-sha',
    }));
    expect(dispatchAgentRun).toHaveBeenCalledWith(assistantMessage.id, {
      type: 'status',
      status: 'running',
    });
  });

  it('starts native graph sends from locally created nodes', async () => {
    const startAgentRun = vi.fn().mockResolvedValue(undefined);
    const persistLocalNode = vi.fn().mockResolvedValue(undefined);

    await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: null,
      contextParentId: null,
      contextPolicy: 'fresh',
      prompt: 'Start locally',
      messages: [],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'base-sha',
        selectedFromNodeId: null,
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      persistLocalNode,
      createRunId: () => 'run-local-preferred',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(persistLocalNode).toHaveBeenCalledTimes(2);
    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-local-preferred',
      parentCommit: 'base-sha',
    }));
  });

  it('creates local runtime nodes for new thread sends', async () => {
    const startAgentRun = vi.fn().mockResolvedValue(undefined);
    const persistLocalNode = vi.fn().mockResolvedValue(undefined);
    const onMessagesCreated = vi.fn();

    const response = await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: null,
      contextParentId: null,
      contextPolicy: 'fresh',
      prompt: 'Start local thread',
      messages: [],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'main-tip',
        selectedFromNodeId: null,
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      persistLocalNode,
      onMessagesCreated,
      threadId: 'thread-session-1',
      threadOriginId: 'thread-session-1',
      createRunId: () => 'run-local-thread',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(persistLocalNode).toHaveBeenCalledTimes(2);
    const userMessage = persistLocalNode.mock.calls[0][2] as Message;
    const assistantMessage = persistLocalNode.mock.calls[1][2] as Message;
    expect(userMessage.threadId).toBe('thread-session-1');
    expect(assistantMessage.threadId).toBe('thread-session-1');
    expect(assistantMessage.base_commit_sha).toBe('main-tip');
    expect(onMessagesCreated).toHaveBeenCalledWith([userMessage, assistantMessage]);
    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-local-thread',
      assistantNodeId: assistantMessage.id,
      parentCommit: 'main-tip',
    }));
    expect(response.userMessage?.id).toBe(userMessage.id);
    expect(response.assistantMessages?.[0]?.id).toBe(assistantMessage.id);
  });

  it('uses the selected context start when building the runtime prompt', async () => {
    const startAgentRun = vi.fn().mockResolvedValue(undefined);

    await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: 'assistant-2',
      contextParentId: 'assistant-2',
      contextPolicy: 'continue',
      contextStartId: 'user-2',
      prompt: 'Continue from here',
      messages: [
        message({ id: 'user-1', role: 'user', content: 'old context', parentId: null }),
        message({ id: 'assistant-1', role: 'assistant', content: 'old answer', parentId: 'user-1' }),
        message({ id: 'user-2', role: 'user', content: 'new context', parentId: 'assistant-1' }),
        message({ id: 'assistant-2', role: 'assistant', content: 'new answer', parentId: 'user-2' }),
      ],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'base-sha',
        selectedFromNodeId: null,
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      createRunId: () => 'run-context-start',
    });

    const runtimePrompt = startAgentRun.mock.calls[0][0].args.at(-1);
    expect(runtimePrompt).toContain('new context');
    expect(runtimePrompt).toContain('new answer');
    expect(runtimePrompt).not.toContain('old context');
    expect(runtimePrompt).toContain('Continue from here');
  });

  it('starts orchestration sends as persisted orchestrator runs and records a preview', async () => {
    const order: string[] = [];
    const startAgentRun = vi.fn(async () => {
      order.push('startAgentRun');
      return undefined;
    });
    const persistLocalNode = vi.fn(async () => undefined);
    const onMessagesCreated = vi.fn();

    const response = await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: 'parent-1',
      contextParentId: 'parent-1',
      contextPolicy: 'continue',
      prompt: 'Create three parallel #planner.',
      messages: [message({ id: 'parent-1', output_commit_sha: 'base-sha' })],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'base-sha',
        selectedFromNodeId: 'parent-1',
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      persistLocalNode,
      onMessagesCreated,
      orchestrationMode: true,
      createRunId: () => 'run-orchestrator',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    const assistantMessage = response.assistantMessages?.[0];
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage?.controlled_by_node_id).toBeNull();
    expect(assistantMessage?.execution_data?.meta).toEqual(expect.objectContaining({
      node_kind: 'orchestrator',
      orchestrator_run_id: 'run-orchestrator',
      base_commit_sha: 'base-sha',
    }));
    expect((assistantMessage?.execution_data?.meta as Record<string, unknown>).controlled_by_node_id).toBeUndefined();
    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-orchestrator',
      assistantNodeId: assistantMessage?.id,
      parentCommit: 'base-sha',
      runContext: expect.objectContaining({
        promptFallback: 'Create three parallel #planner.',
      }),
    }));
    expect(onMessagesCreated).toHaveBeenCalledWith([response.userMessage, assistantMessage]);
    expect(order).toEqual(['startAgentRun']);
    expect(response).not.toHaveProperty('orchestrationPreview');
    expect(response).not.toHaveProperty('orchestrationExecutionContext');
    expect(response).not.toHaveProperty('orchestrationExecutionResult');
  });

  it('passes saved orchestration template mentions through to the orchestrator without app-side expansion', async () => {
    const startAgentRun = vi.fn(async () => undefined);

    const response = await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: 'parent-1',
      contextParentId: 'parent-1',
      contextPolicy: 'continue',
      prompt: '#migration_review Agentree orchestration migration',
      messages: [message({ id: 'parent-1', output_commit_sha: 'base-sha' })],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'base-sha',
        selectedFromNodeId: 'parent-1',
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      persistLocalNode: vi.fn().mockResolvedValue(undefined),
      orchestrationMode: true,
      createRunId: () => 'run-orchestrator',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(startAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-orchestrator',
        assistantNodeId: response.assistantMessages?.[0]?.id,
        runContext: expect.objectContaining({
          promptFallback: '#migration_review Agentree orchestration migration',
        }),
      }),
    );
    expect(response).not.toHaveProperty('orchestrationPreview');
  });

  it('does not execute simple orchestration children from the composer', async () => {
    const order: string[] = [];
    const startAgentRun = vi.fn(async (intent: any) => {
      order.push(`startAgentRun:${intent.assistantNodeId}`);
      return {
        runId: intent.runId,
        assistantNodeId: intent.assistantNodeId,
        worktreePath: `/repo/.agentree/worktrees/${intent.assistantNodeId}`,
        branchName: `agentree/${intent.assistantNodeId}`,
        pid: 123,
        initialStatus: 'running',
      };
    });

    const response = await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: 'parent-1',
      contextParentId: 'parent-1',
      contextPolicy: 'continue',
      prompt: 'Create a node that checks validation steps',
      messages: [message({ id: 'parent-1', output_commit_sha: 'base-sha' })],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '',
        promptFlag: null,
        model_config: { model: 'gpt-5.5' },
      },
      base: {
        commitSha: 'base-sha',
        selectedFromNodeId: 'parent-1',
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      persistLocalNode: vi.fn().mockResolvedValue(undefined),
      orchestrationMode: true,
      createRunId: () => 'run-orchestrator',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(order).toEqual([
      `startAgentRun:${response.assistantMessages?.[0]?.id}`,
    ]);
    expect(response).not.toHaveProperty('orchestrationExecutionResult');
  });
});
