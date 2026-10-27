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
      userNodeId: localUserMessage.id,
      assistantNodeId: localAssistantMessage.id,
      workspaceId: 'workspace-1',
      baseCommit: 'root-output',
      agentType: 'codex',
      authToken: 'token-1',
      userPrompt: 'Ship it',
      assistantNode: expect.objectContaining({
        execution_data: expect.objectContaining({
          agent_id: 'codex-agent',
        }),
      }),
    }));
    expect(startAgentRun.mock.calls[0][0].agentCliArgs).toContain('--model');
    expect(dispatchAgentRun).toHaveBeenCalledWith(localAssistantMessage.id, {
      type: 'status',
      status: 'running',
    });
  });

  it('starts local reply runs when Agentree Cloud auth is disconnected', async () => {
    const startAgentRun = vi.fn().mockResolvedValue(undefined);

    const response = await sendHeadlessComposerReply({
      workspaceId: 'workspace-1',
      replyParentId: 'parent-1',
      prompt: 'Ship it',
      messages: [
        message({ id: 'parent-1', output_commit_sha: 'root-output' }),
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
        commitSha: 'root-output',
        selectedFromNodeId: 'parent-1',
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockRejectedValue(new Error('No access token available')),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      createRunId: () => 'run-1',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      assistantNodeId: response.assistantMessages?.[0]?.id,
      authToken: '',
    }));
  });

  it('persists current attachments and includes immutable input artifacts in the runtime launch', async () => {
    const startAgentRun = vi.fn().mockResolvedValue(undefined);
    const persistLocalNode = vi.fn().mockResolvedValue(undefined);
    const attachment = {
      path: 'attachments/screenshot.png',
      publicUrl: null,
      filename: 'screenshot.png',
      contentType: 'image/png',
      localPath: '/tmp/screenshot.png',
      sizeBytes: 42,
      width: 10,
      height: 20,
    };

    const response = await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: null,
      contextParentId: null,
      contextPolicy: 'fresh',
      prompt: 'Inspect this',
      attachments: [attachment],
      messages: [],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '',
        promptFlag: null,
        model_config: {
          model: 'gpt-5.5',
          capabilities: {
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            reasoningEffort: true,
          },
        },
      },
      base: { commitSha: 'base-sha', selectedFromNodeId: null },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      persistLocalNode,
      createRunId: () => 'run-with-attachment',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(response.userMessage?.attachments).toEqual([attachment]);
    expect(persistLocalNode).toHaveBeenCalledWith(
      'workspace-1',
      response.userMessage?.id,
      expect.objectContaining({ attachments: [attachment] }),
    );
    const request = startAgentRun.mock.calls[0][0];
    expect(request.userPrompt).toContain('[Current User Uploaded Files]');
    expect(request.userPrompt).toContain('/tmp/screenshot.png');
    expect(request.contextManifest.artifactInputs).toEqual([
      expect.objectContaining({
        nodeId: response.userMessage?.id,
        mimeType: 'image/png',
        storage: expect.objectContaining({ path: '/tmp/screenshot.png' }),
      }),
    ]);
  });

  it('resumes same-provider Claude provider threads for quick replies', async () => {
    const startAgentRun = vi.fn().mockResolvedValue(undefined);

    await sendHeadlessComposerReply({
      workspaceId: 'workspace-1',
      replyParentId: 'parent-claude',
      prompt: 'Continue natively',
      messages: [
        message({
          id: 'parent-claude',
          execution_data: {
            meta: {
              provider: 'claude',
              provider_thread_id: 'claude-thread-1',
              provider_turn_id: 'turn-1',
            },
          },
        }),
      ],
      agent: {
        id: 'claude-agent',
        type: 'claude',
        name: 'Claude',
        cliArgs: '',
        promptFlag: '--prompt',
        model_config: { model: 'opus' },
      },
      base: {
        commitSha: 'base-sha',
        selectedFromNodeId: 'parent-claude',
      },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      createRunId: () => 'run-claude',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    const request = startAgentRun.mock.calls[0][0];
    expect(request).toEqual(expect.objectContaining({
      agentType: 'claude',
      contextParentNodeId: 'parent-claude',
      contextPolicy: 'continue',
      contextMode: 'active',
    }));
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
    expect(intent.assistantNode.execution_data.meta.login_profile_id).toBe('profile-codex-work');
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
    expect(intent.permissionMode).toBe('fully-isolated');
    expect(intent.agentCliArgs).toContain('--permission-mode auto');
    expect(intent.assistantNode.execution_data.meta.composer_permission_mode).toBe('fully-isolated');
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
    const getAccessToken = vi.fn().mockResolvedValue('token-1');

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
      getAccessToken,
      seedAgentRun,
      dispatchAgentRun,
      persistLocalNode,
      onMessagesCreated,
      createRunId: () => 'run-local',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(persistLocalNode).toHaveBeenCalledTimes(2);
    expect(Math.max(...persistLocalNode.mock.invocationCallOrder)).toBeLessThan(
      getAccessToken.mock.invocationCallOrder[0],
    );
    const launchRequest = startAgentRun.mock.calls[0][0];
    const userMessage = launchRequest.userNode as Message;
    const assistantMessage = launchRequest.assistantNode as Message;
    expect(userMessage.role).toBe('user');
    expect(userMessage.content).toBe('Use local first');
    expect(userMessage.parentId).toBe('parent-1');
    expect(assistantMessage.role).toBe('assistant');
    expect(assistantMessage.parentId).toBe(userMessage.id);
    expect(assistantMessage.base_commit_sha).toBe('base-sha');
    expect(onMessagesCreated).toHaveBeenCalledWith([
      expect.objectContaining({ id: userMessage.id }),
      expect.objectContaining({ id: assistantMessage.id }),
    ]);
    expect(seedAgentRun).toHaveBeenCalledWith(userMessage);
    expect(seedAgentRun).toHaveBeenCalledWith(expect.objectContaining({ id: assistantMessage.id }));
    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-local',
      assistantNodeId: assistantMessage.id,
      baseCommit: 'base-sha',
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
      baseCommit: 'base-sha',
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
    const launchRequest = startAgentRun.mock.calls[0][0];
    const userMessage = launchRequest.userNode as Message;
    const assistantMessage = launchRequest.assistantNode as Message;
    expect(userMessage.threadId).toBe('thread-session-1');
    expect(assistantMessage.threadId).toBe('thread-session-1');
    expect(assistantMessage.base_commit_sha).toBe('main-tip');
    expect(onMessagesCreated).toHaveBeenCalledWith([
      expect.objectContaining({ id: userMessage.id }),
      expect.objectContaining({ id: assistantMessage.id }),
    ]);
    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-local-thread',
      assistantNodeId: assistantMessage.id,
      baseCommit: 'main-tip',
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

    const request = startAgentRun.mock.calls[0][0];
    expect(request.contextManifest.contextText).toContain('new context');
    expect(request.contextManifest.contextText).toContain('new answer');
    expect(request.contextManifest.contextText).not.toContain('old context');
    expect(request.userPrompt).toBe('Continue from here');
  });

  it('starts delegation-capable requests as normal agent sends', async () => {
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
      threadId: 'parent-thread',
      createRunId: () => 'run-orchestrator',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    const assistantMessage = response.assistantMessages?.[0] as Message;
    expect(assistantMessage).toBeDefined();
    expect(response.assistantMessages).toEqual([assistantMessage]);
    expect(response.userMessage?.parentId).toBe('parent-1');
    expect(response.userMessage?.threadId).toBe('parent-thread');
    expect(assistantMessage?.parentId).toBe(response.userMessage?.id);
    expect(assistantMessage?.threadId).toBe('parent-thread');
    expect(assistantMessage?.controlled_by_node_id).toBeUndefined();
    expect(assistantMessage?.execution_data?.meta).toEqual(expect.objectContaining({
      base_commit_sha: 'base-sha',
    }));
    expect(assistantMessage?.execution_data?.meta).not.toEqual(expect.objectContaining({
      node_kind: 'orchestrator',
    }));
    expect((assistantMessage?.execution_data?.meta as Record<string, unknown>).controlled_by_node_id).toBeUndefined();
    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-orchestrator',
      assistantNodeId: assistantMessage?.id,
      baseCommit: 'base-sha',
      parentNodeId: 'parent-1',
      contextParentNodeId: 'parent-1',
      threadId: 'parent-thread',
      userPrompt: 'Create three parallel #planner.',
    }));
    const createdMessages = onMessagesCreated.mock.calls.flatMap(([items]) => items as Message[]);
    expect(createdMessages).toEqual(expect.arrayContaining([response.userMessage, assistantMessage]));
    expect(response).not.toHaveProperty('orchestrationThreadId');
    expect(order).toEqual(['startAgentRun']);
    expect(response).not.toHaveProperty('orchestrationPreview');
    expect(response).not.toHaveProperty('orchestrationExecutionContext');
    expect(response).not.toHaveProperty('orchestrationExecutionResult');
  });

  it('starts normal agents when cloud auth is disconnected', async () => {
    const startAgentRun = vi.fn(async (_request: Record<string, unknown>) => undefined);
    const persistLocalNode = vi.fn(async () => undefined);

    const response = await sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: null,
      contextParentId: null,
      contextPolicy: 'fresh',
      prompt: 'Create three parallel #planner.',
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
      getAccessToken: vi.fn().mockRejectedValue(new Error('No access token available')),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      persistLocalNode,
      threadId: 'parent-thread',
      createRunId: () => 'run-orchestrator',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    const assistantMessage = response.assistantMessages?.[0] as Message;
    expect(assistantMessage?.execution_data?.meta).not.toEqual(expect.objectContaining({
      node_kind: 'orchestrator',
    }));
    expect(persistLocalNode).toHaveBeenCalledWith(
      'workspace-1',
      response.userMessage?.id,
      expect.objectContaining({ id: response.userMessage?.id, role: 'user', threadId: 'parent-thread' }),
    );
    expect((startAgentRun.mock.calls[0]?.[0] as any).assistantNode).toEqual(expect.objectContaining({
      id: assistantMessage?.id,
      role: 'assistant',
    }));
    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-orchestrator',
      assistantNodeId: assistantMessage?.id,
      authToken: '',
    }));
  });

  it('keeps a failed normal send durable in its source thread', async () => {
    const order: string[] = [];
    const persistLocalNode = vi.fn(async (_workspaceId: string, nodeId: string, _message: Message) => {
      order.push(`persist:${nodeId}`);
    });
    const startAgentRun = vi.fn(async () => {
      order.push('start');
      throw new Error('provider process failed to start');
    });
    const onMessagesCreated = vi.fn();

    await expect(sendHeadlessComposerMessage({
      workspaceId: 'workspace-1',
      parentMessageId: null,
      contextParentId: null,
      contextPolicy: 'fresh',
      prompt: 'Coordinate a migration.',
      messages: [],
      agent: {
        id: 'codex-agent',
        type: 'codex',
        name: 'Codex',
        cliArgs: '--model gpt-5.5 --reasoning-effort high',
        promptFlag: null,
        model_config: { model: 'gpt-5.5', reasoningEffort: 'high' },
      },
      base: { commitSha: 'base-sha', selectedFromNodeId: null },
      workspaces: [{ id: 'workspace-1', local_repo_path: '/repo' } as Workspace],
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun: vi.fn(),
      persistLocalNode,
      onMessagesCreated,
      threadId: 'parent-thread',
      createRunId: () => 'run-orchestrator',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    })).rejects.toThrow('provider process failed to start');

    const persistedMessages = persistLocalNode.mock.calls.map(([, , persisted]) => persisted as Message);
    expect(persistedMessages).toHaveLength(2);
    expect(persistedMessages.every((message) => message.threadId === 'parent-thread')).toBe(true);
    expect(persistedMessages.some((message) => (
      (message.execution_data?.meta as Record<string, unknown> | undefined)?.orchestration_thread_link === true
    ))).toBe(false);
    expect(order.findIndex((entry) => entry.startsWith('persist:'))).toBeLessThan(order.indexOf('start'));
    expect(onMessagesCreated.mock.calls.flatMap(([items]) => items as Message[])).toEqual(
      expect.arrayContaining(persistedMessages),
    );
  });

  it('passes saved orchestration template mentions through without app-side expansion', async () => {
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
      threadId: 'parent-thread',
      createRunId: () => 'run-orchestrator',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(startAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-orchestrator',
        assistantNodeId: (response.assistantMessages?.[0] as Message)?.id,
        userPrompt: '#migration_review Agentree orchestration migration',
      }),
    );
    expect(response).not.toHaveProperty('orchestrationPreview');
  });

  it('launches requests as one normal agent run', async () => {
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
      threadId: 'parent-thread',
      createRunId: () => 'run-orchestrator',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(order).toEqual([
      `startAgentRun:${(response.assistantMessages?.[0] as Message)?.id}`,
    ]);
    expect(response).not.toHaveProperty('orchestrationExecutionResult');
  });
});
