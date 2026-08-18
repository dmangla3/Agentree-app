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
  createdAt: input.createdAt ?? '2026-05-27T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-27T00:00:00.000Z',
});

describe('sendHeadlessComposerReply', () => {
  it('creates a reply message and starts the runtime from the supplied base commit', async () => {
    const userMessage = message({ id: 'user-1', role: 'user', parentId: 'parent-1' });
    const assistantMessage = message({ id: 'assistant-1', role: 'assistant', parentId: 'user-1' });
    const sendMessage = vi.fn().mockResolvedValue({
      userMessage,
      assistantMessages: [assistantMessage],
    });
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
      workspaces: [{ id: 'workspace-1', git_repo_path: '/repo' } as Workspace],
      sendMessage,
      hasRuntime: () => true,
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun,
      dispatchAgentRun,
      onAssistantMessageCreated,
      createRunId: () => 'run-1',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(response).toEqual({ userMessage, assistantMessages: [assistantMessage] });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      prompt: 'Ship it',
      parentId: 'parent-1',
      contextPolicy: 'continue',
      contextParentId: 'parent-1',
      agentId: 'codex-agent',
      agentProvider: 'codex',
      llmModel: 'gpt-5.5',
      baseCommitSha: 'root-output',
      baseSelectedFromNodeId: 'root',
    }));
    expect(seedAgentRun).toHaveBeenCalledWith(userMessage);
    expect(seedAgentRun).toHaveBeenCalledWith(assistantMessage);
    expect(onAssistantMessageCreated).toHaveBeenCalledWith(assistantMessage);
    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      assistantNodeId: 'assistant-1',
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      parentCommit: 'root-output',
      agentType: 'codex',
      authToken: 'token-1',
      runContext: expect.objectContaining({
        gitBranchName: 'agentree/assistant-1',
        parentCommit: 'root-output',
        promptFallback: 'Ship it',
      }),
    }));
    expect(startAgentRun.mock.calls[0][0].args[0]).toBe('--model');
    expect(startAgentRun.mock.calls[0][0].args.at(-1)).toContain('Ship it');
    expect(dispatchAgentRun).toHaveBeenCalledWith('assistant-1', {
      type: 'status',
      status: 'running',
    });
  });

  it('supports fresh root sends without quick-reply metadata', async () => {
    const assistantMessage = message({ id: 'assistant-root', role: 'assistant', parentId: 'user-root' });
    const sendMessage = vi.fn().mockResolvedValue({
      userMessage: message({ id: 'user-root', role: 'user', parentId: null }),
      assistantMessages: [assistantMessage],
    });
    const startAgentRun = vi.fn().mockResolvedValue(undefined);
    const dispatchAgentRun = vi.fn();

    await sendHeadlessComposerMessage({
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
      workspaces: [{ id: 'workspace-1', git_repo_path: '/repo' } as Workspace],
      sendMessage,
      hasRuntime: () => true,
      startAgentRun,
      getAccessToken: vi.fn().mockResolvedValue('token-1'),
      seedAgentRun: vi.fn(),
      dispatchAgentRun,
      createRunId: () => 'run-root',
      nowIso: () => '2026-05-27T01:02:03.000Z',
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      parentId: null,
      contextPolicy: 'fresh',
      contextParentId: null,
      baseSelectedFromNodeId: null,
      threadOriginId: undefined,
    }));
    const executionDataEvent = dispatchAgentRun.mock.calls.find(([nodeId, event]) => (
      nodeId === 'assistant-root' && event.type === 'execution_data'
    ));
    expect(executionDataEvent?.[1].patch.meta.quick_reply).toBeUndefined();
    expect(executionDataEvent?.[1].patch.meta.base_commit_sha).toBe('workspace-base');
  });

  it('uses the selected context start when building the runtime prompt', async () => {
    const assistantMessage = message({ id: 'assistant-new', role: 'assistant', parentId: 'user-new' });
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
      workspaces: [{ id: 'workspace-1', git_repo_path: '/repo' } as Workspace],
      sendMessage: vi.fn().mockResolvedValue({
        userMessage: message({ id: 'user-new', role: 'user', parentId: 'assistant-2' }),
        assistantMessages: [assistantMessage],
      }),
      hasRuntime: () => true,
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
});
