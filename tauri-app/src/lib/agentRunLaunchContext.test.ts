import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_COMPOSER_CONTEXT_MANIFEST } from './prompts';
import { buildAgentRunLaunchContext } from './agentRunLaunchContext';
import type { Message } from '../stores/workspaceStore';
import { useDefaultPromptStore } from '../stores/defaultPromptStore';

const message = (input: Partial<Message> & Pick<Message, 'id'>): Message => ({
  id: input.id,
  role: input.role ?? 'assistant',
  content: input.content ?? '',
  parentId: input.parentId ?? null,
  workspaceId: input.workspaceId ?? 'workspace-1',
  execution_data: input.execution_data ?? null,
  createdAt: input.createdAt ?? '2026-06-01T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-06-01T00:00:00.000Z',
});

describe('buildAgentRunLaunchContext', () => {
  beforeEach(() => {
    useDefaultPromptStore.getState().clearUserPrompts();
  });

  it('resumes same-provider Claude threads from the parent provider thread', () => {
    const result = buildAgentRunLaunchContext({
      agentType: 'claude',
      userPrompt: 'Continue',
      messages: [
        message({
          id: 'assistant-parent',
          execution_data: {
            meta: {
              provider: 'claude',
              provider_thread_id: 'claude-thread-1',
              provider_turn_id: 'turn-1',
            },
          },
        }),
      ],
      contextParentMessageId: 'assistant-parent',
      baseMessageId: 'assistant-parent',
      nodeId: 'assistant-new',
      targetNodeId: 'assistant-parent',
    });

    expect(result.providerThreadStrategy).toBe('resume');
    expect(result.providerInternalArgs).toEqual(expect.arrayContaining([
      '--provider-thread-strategy',
      'resume',
      '--provider-thread-id',
      'claude-thread-1',
      '--node-id',
      'assistant-new',
    ]));
    expect(result.meta.provider_thread_id).toBe('claude-thread-1');
    expect(result.meta.provider_context_routing_mode).toBe('provider_native_only');
  });

  it('forks Claude from an interior parent turn when the parent already has children', () => {
    const result = buildAgentRunLaunchContext({
      agentType: 'claude',
      userPrompt: 'Branch',
      messages: [
        message({
          id: 'assistant-parent',
          execution_data: {
            meta: {
              provider: 'claude',
              provider_thread_id: 'claude-thread-1',
              provider_turn_id: 'turn-1',
            },
          },
        }),
        message({ id: 'existing-child', role: 'user', parentId: 'assistant-parent' }),
      ],
      contextParentMessageId: 'assistant-parent',
      baseMessageId: 'assistant-parent',
      nodeId: 'assistant-branch',
      targetNodeId: 'assistant-parent',
    });

    expect(result.providerThreadStrategy).toBe('fork_at_turn');
    expect(result.providerInternalArgs).toEqual(expect.arrayContaining([
      '--source-provider-thread-id',
      'claude-thread-1',
      '--target-provider-turn-id',
      'turn-1',
    ]));
    expect(result.meta.provider_target_turn_id).toBe('turn-1');
  });

  it('forks Codex from the exact interior parent turn', () => {
    const result = buildAgentRunLaunchContext({
      agentType: 'codex',
      userPrompt: 'Branch',
      messages: [
        message({
          id: 'assistant-parent',
          execution_data: {
            meta: {
              provider: 'codex',
              provider_thread_id: 'codex-thread-1',
              provider_turn_id: 'turn-1',
            },
          },
        }),
        message({ id: 'existing-child', role: 'user', parentId: 'assistant-parent' }),
      ],
      contextParentMessageId: 'assistant-parent',
      baseMessageId: 'assistant-parent',
      nodeId: 'assistant-branch',
      targetNodeId: 'assistant-parent',
    });

    expect(result.providerThreadStrategy).toBe('fork_at_turn');
    expect(result.providerInternalArgs).toEqual(expect.arrayContaining([
      '--source-provider-thread-id',
      'codex-thread-1',
      '--target-provider-turn-id',
      'turn-1',
    ]));
    expect(result.meta.provider_target_turn_id).toBe('turn-1');
  });

  it('forks OpenCode from the exact interior message', () => {
    const result = buildAgentRunLaunchContext({
      agentType: 'opencode',
      userPrompt: 'Branch',
      messages: [
        message({
          id: 'assistant-parent',
          execution_data: {
            meta: {
              provider: 'opencode',
              provider_thread_id: 'session-1',
              provider_turn_id: 'message-1',
            },
          },
        }),
        message({ id: 'existing-child', role: 'user', parentId: 'assistant-parent' }),
      ],
      contextParentMessageId: 'assistant-parent',
      baseMessageId: 'assistant-parent',
    });

    expect(result.providerThreadStrategy).toBe('fork_at_turn');
    expect(result.providerInternalArgs).toEqual(expect.arrayContaining([
      '--source-provider-thread-id',
      'session-1',
      '--target-provider-turn-id',
      'message-1',
    ]));
  });

  it('does not fall back when an interior Codex parent is missing its provider turn id', () => {
    const result = buildAgentRunLaunchContext({
      agentType: 'codex',
      userPrompt: 'Branch',
      messages: [
        message({
          id: 'assistant-parent',
          execution_data: {
            meta: {
              provider: 'codex',
              provider_thread_id: 'codex-thread-1',
            },
          },
        }),
        message({ id: 'existing-child', role: 'user', parentId: 'assistant-parent' }),
      ],
      contextParentMessageId: 'assistant-parent',
      baseMessageId: 'assistant-parent',
      nodeId: 'assistant-branch',
      targetNodeId: 'assistant-parent',
    });

    expect(result.providerThreadStrategy).toBe('fork_at_turn');
    expect(result.providerInternalArgs).toEqual(expect.arrayContaining([
      '--source-provider-thread-id',
      'codex-thread-1',
    ]));
    expect(result.providerInternalArgs).not.toContain('--target-provider-turn-id');
    expect(result.meta.provider_target_turn_id).toBeNull();
  });

  it('uses Agentree context for cross-provider starts instead of native continuation', () => {
    const result = buildAgentRunLaunchContext({
      agentType: 'codex',
      userPrompt: 'Continue in Codex',
      contextPolicy: 'continue',
      contextManifest: {
        ...EMPTY_COMPOSER_CONTEXT_MANIFEST,
        contextText: 'Prior Claude work',
      },
      providerParentMeta: {
        provider: 'claude',
        provider_thread_id: 'claude-thread-1',
        provider_turn_id: 'turn-1',
      },
      nodeId: 'assistant-new',
    });

    expect(result.providerThreadStrategy).toBe('fresh_thread');
    expect(result.providerThreadStrategyRequested).toBe('cross_provider_fresh_thread');
    expect(result.providerInternalArgs).not.toContain('--provider-thread-id');
    expect(result.prompt).toContain('[Selected Workspace Context]');
    expect(result.meta.provider_cross_provider_fresh_thread).toBe(true);
  });

  it('passes selected image artifacts to Codex as provider input artifacts', () => {
    const result = buildAgentRunLaunchContext({
      agentType: 'codex',
      userPrompt: 'Use this image.',
      contextPolicy: 'continue',
      contextManifest: {
        ...EMPTY_COMPOSER_CONTEXT_MANIFEST,
        contextText: 'Artifact context',
        artifactInputs: [{
          id: 'artifact-1',
          nodeId: 'assistant-1',
          role: 'output',
          kind: 'image',
          mimeType: 'image/png',
          storage: { backend: 'remote', url: 'https://cdn.example.com/image.png' },
        }],
      },
      nodeId: 'assistant-new',
      modelCapabilities: { inputModalities: ['text', 'image'] },
    });

    const index = result.providerInternalArgs.indexOf('--input-artifacts-json');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(result.providerInternalArgs[index + 1])).toMatchObject([{
      id: 'artifact-1',
      mimeType: 'image/png',
    }]);
    expect(result.meta.provider_image_input_artifact_count).toBe(1);
  });

  it('does not pass image artifacts to text-only Codex models', () => {
    const result = buildAgentRunLaunchContext({
      agentType: 'codex',
      userPrompt: 'Use this image.',
      contextPolicy: 'continue',
      contextManifest: {
        ...EMPTY_COMPOSER_CONTEXT_MANIFEST,
        contextText: 'Artifact context',
        artifactInputs: [{
          id: 'artifact-1',
          nodeId: 'assistant-1',
          role: 'output',
          kind: 'image',
          mimeType: 'image/png',
          storage: { backend: 'remote', url: 'https://cdn.example.com/image.png' },
        }],
      },
      nodeId: 'assistant-new',
      modelCapabilities: { inputModalities: ['text'] },
    });

    expect(result.providerInternalArgs).not.toContain('--input-artifacts-json');
    expect(result.meta.provider_image_input_artifact_count).toBe(0);
  });

  it('passes capability-supported image artifacts to OpenCode', () => {
    const result = buildAgentRunLaunchContext({
      agentType: 'opencode',
      userPrompt: 'Inspect this image.',
      contextManifest: {
        ...EMPTY_COMPOSER_CONTEXT_MANIFEST,
        artifactInputs: [{
          id: 'artifact-1',
          nodeId: 'assistant-1',
          role: 'output',
          kind: 'image',
          mimeType: 'image/png',
          storage: { backend: 'local', path: '/tmp/image.png' },
        }],
      },
      modelCapabilities: { inputModalities: ['text', 'image'] },
    });

    expect(result.providerInternalArgs).toContain('--input-artifacts-json');
  });

  it('passes capability-supported file artifacts to OpenCode', () => {
    const result = buildAgentRunLaunchContext({
      agentType: 'opencode',
      userPrompt: 'Inspect this document.',
      contextManifest: {
        ...EMPTY_COMPOSER_CONTEXT_MANIFEST,
        artifactInputs: [{
          id: 'artifact-pdf',
          nodeId: 'assistant-1',
          role: 'output',
          kind: 'file',
          mimeType: 'application/pdf',
          filename: 'report.pdf',
          storage: { backend: 'local', path: '/tmp/report.pdf' },
        }],
      },
      modelCapabilities: { inputModalities: ['text', 'pdf'], attachments: true },
    });

    const index = result.providerInternalArgs.indexOf('--input-artifacts-json');
    expect(JSON.parse(result.providerInternalArgs[index + 1])).toEqual([
      expect.objectContaining({ id: 'artifact-pdf', mimeType: 'application/pdf' }),
    ]);
    expect(result.meta.provider_input_artifact_count).toBe(1);
  });

  it('strips inline data urls from provider artifact input args', () => {
    const result = buildAgentRunLaunchContext({
      agentType: 'codex',
      userPrompt: 'Use this image.',
      contextPolicy: 'continue',
      contextManifest: {
        ...EMPTY_COMPOSER_CONTEXT_MANIFEST,
        contextText: 'Artifact context',
        artifactInputs: [{
          id: 'artifact-1',
          nodeId: 'assistant-1',
          role: 'output',
          kind: 'image',
          mimeType: 'image/png',
          storage: { backend: 'local', path: '/tmp/generated.png', url: 'data:image/png;base64,large' },
          thumbnail: { url: 'data:image/png;base64,large' },
        }],
      },
      nodeId: 'assistant-new',
      modelCapabilities: { inputModalities: ['text', 'image'] },
    });

    const index = result.providerInternalArgs.indexOf('--input-artifacts-json');
    const artifact = JSON.parse(result.providerInternalArgs[index + 1])[0];
    expect(artifact.storage).toEqual({ backend: 'local', path: '/tmp/generated.png' });
    expect(artifact.thumbnail).toBeUndefined();
  });

  it('passes saved default prompt overrides into launch prompt assembly', () => {
    useDefaultPromptStore.getState().upsertUserPrompt({
      id: 'dependency_guard',
      text: 'Custom dependency guard',
    });
    useDefaultPromptStore.getState().upsertUserPrompt({
      id: 'thread_title_none',
      text: 'Do not set a thread title for this run.',
    });

    const result = buildAgentRunLaunchContext({
      agentType: 'codex',
      userPrompt: 'Review the implementation.',
      contextPolicy: 'fresh',
      threadTitleMode: 'none',
    });

    expect(result.prompt).toContain('Custom dependency guard');
    expect(result.prompt).toContain('Do not set a thread title for this run.');
    expect(result.prompt).not.toContain('Agentree provides writable runtime paths');
    expect(result.prompt).not.toContain('set thread_title to null');
  });
});
