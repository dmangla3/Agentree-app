import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunManager } from './agentRunManager';
import { deriveStreamingAppendText, dispatchProviderStreamEvent, resolveProviderAssistantOutput } from './agentRunStreamDispatch';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import { useRunStatusStore } from '../stores/runStatusStore';

const message = (overrides: Record<string, any> = {}) => ({
  id: 'assistant-1',
  workspaceId: 'workspace-1',
  parentId: 'user-1',
  role: 'assistant',
  content: '',
  status: 'running',
  createdAt: '2026-05-06T00:00:00.000Z',
  updatedAt: '2026-05-06T00:00:00.000Z',
  execution_data: {},
  ...overrides,
}) as any;

const dispatchContext = {
  nodeId: 'assistant-1',
  parentId: 'user-1',
  workspaceId: 'workspace-1',
  agentId: 'codex',
  currentOutput: '',
  getProjection: (nodeId: string) => useAgentRunProjectionStore.getState().projectionsById[nodeId] ?? null,
  getAgents: () => [],
  setSetupProgress: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  agentRunManager.clearAll();
  useAgentRunProjectionStore.getState().clearAllProjections();
  useRunStatusStore.getState().clearAllRunStatus();
});

afterEach(() => {
  agentRunManager.clearAll();
  useAgentRunProjectionStore.getState().clearAllProjections();
  useRunStatusStore.getState().clearAllRunStatus();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('resolveProviderAssistantOutput', () => {
  it('keeps later Codex assistant item text cumulative until final content arrives', () => {
    const result = resolveProviderAssistantOutput('I will inspect first.', 'I inspected and fixed it.', {
      kind: 'snapshot',
      currentProviderItemId: 'msg-initial',
      nextProviderItemId: 'msg-final',
    });

    expect(result.output).toBe('I will inspect first.I inspected and fixed it.');
    expect(result.providerItemId).toBe('msg-final');
  });

  it('treats provider stop final content as authoritative', () => {
    const result = resolveProviderAssistantOutput(
      'I will inspect first.I inspected and fixed it.',
      'I inspected and fixed it.',
      { kind: 'final', currentProviderItemId: 'msg-final', nextProviderItemId: null },
    );

    expect(result.output).toBe('I inspected and fixed it.');
    expect(result.providerItemId).toBe('msg-final');
  });

  it('treats empty provider stop final content as authoritative', () => {
    const result = resolveProviderAssistantOutput(
      'partial text',
      '',
      { kind: 'final', currentProviderItemId: 'msg-final', nextProviderItemId: null },
    );

    expect(result.output).toBe('');
    expect(result.providerItemId).toBe('msg-final');
  });

  it('does not clear output for empty non-final provider item snapshots', () => {
    const result = resolveProviderAssistantOutput(
      'partial text',
      '',
      { kind: 'snapshot', currentProviderItemId: 'msg-1', nextProviderItemId: 'msg-2' },
    );

    expect(result.output).toBe('partial text');
    expect(result.providerItemId).toBe('msg-2');
  });

  it('keeps same-item deltas append-only even when text repeats', () => {
    const result = resolveProviderAssistantOutput('the', 'the', {
      kind: 'delta',
      currentProviderItemId: 'msg-1',
      nextProviderItemId: 'msg-1',
    });

    expect(result.output).toBe('thethe');
    expect(result.providerItemId).toBe('msg-1');
  });

  it('derives timeline append text from actor content when projection is throttled', () => {
    const appended = deriveStreamingAppendText(
      'I’ll inspect',
      '',
      'I’ll inspect the relevant UI',
    );

    expect(appended).toBe(' the relevant UI');
  });

  it('falls back to projected content before an actor exists', () => {
    const appended = deriveStreamingAppendText(
      null,
      'I’ll inspect',
      'I’ll inspect the relevant UI',
    );

    expect(appended).toBe(' the relevant UI');
  });

  it('dispatches thinking and steering provider events into the actor timeline', () => {
    dispatchProviderStreamEvent({
      type: 'thinking',
      content: 'Inspecting the current runtime.',
    }, dispatchContext);
    dispatchProviderStreamEvent({
      type: 'user_steer_requested',
      content: 'Use the cached result.',
      idempotency_key: 'steer-1',
      timestamp: 123,
    }, dispatchContext);

    expect(agentRunManager.snapshot('assistant-1')?.timeline).toEqual([
      expect.objectContaining({
        type: 'thinking',
        content: 'Inspecting the current runtime.',
      }),
      expect.objectContaining({
        type: 'user_steer_requested',
        content: 'Use the cached result.',
        idempotencyKey: 'steer-1',
      }),
    ]);
  });

  it('preserves valid structured provider metadata and unrelated provider metadata', () => {
    agentRunManager.seed(message(), 'run-1');

    dispatchProviderStreamEvent({
      type: 'provider_meta',
      meta: {
        ai_label: '  Fix Runtime Validation  ',
        commit_subject: '  Add provider metadata validation  ',
        commit_body: '  Validate generated provider metadata before merge.  ',
        thread_title: '  Runtime Validation  ',
        provider: 'custom',
        provider_limits: {
          credits: { balance: '10', hasCredits: true, unlimited: false },
          primary: { usedPercent: 0.25, windowDurationMins: 300, resetsAt: 123 },
        },
        unknown_diagnostic: { retained: true },
      },
    }, dispatchContext);

    const meta = agentRunManager.snapshot('assistant-1')?.executionData.meta;
    expect(meta).toMatchObject({
      ai_label: 'Fix Runtime Validation',
      commit_subject: 'Add provider metadata validation',
      commit_body: 'Validate generated provider metadata before merge.',
      thread_title: 'Runtime Validation',
      provider: 'custom',
      provider_limits: {
        credits: { balance: '10', hasCredits: true, unlimited: false },
      },
      unknown_diagnostic: { retained: true },
    });
  });

  it('strips invalid generated provider metadata without dropping unknown metadata', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    agentRunManager.seed(message(), 'run-1');

    dispatchProviderStreamEvent({
      type: 'provider_meta',
      meta: {
        ai_label: 42,
        commit_subject: 'x'.repeat(73),
        commit_body: { text: 'not a string' },
        thread_title: null,
        provider: 'custom',
        provider_limits: {
          credits: { balance: '10', hasCredits: true, unlimited: false },
        },
        unknown_diagnostic: { retained: true },
      },
    }, dispatchContext);

    const meta = agentRunManager.snapshot('assistant-1')?.executionData.meta;
    expect(meta).toMatchObject({
      provider: 'custom',
      provider_limits: {
        credits: { balance: '10', hasCredits: true, unlimited: false },
      },
      unknown_diagnostic: { retained: true },
    });
    expect(meta?.ai_label).toBeUndefined();
    expect(meta?.commit_subject).toBeUndefined();
    expect(meta?.commit_body).toBeUndefined();
    expect(meta?.thread_title).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stores registered artifacts on execution data and projects them', () => {
    agentRunManager.seed(message(), 'run-1');

    dispatchProviderStreamEvent({
      type: 'artifact_registered',
      artifact: {
        id: 'artifact-1',
        nodeId: 'assistant-1',
        role: 'output',
        kind: 'screenshot',
        mimeType: 'image/png',
        title: 'Landing preview',
        storage: {
          backend: 'local',
          path: 'screenshots/landing.png',
        },
        thumbnail: {
          url: 'data:image/png;base64,abcd',
        },
        isPrimary: true,
      },
    }, dispatchContext);
    dispatchProviderStreamEvent({
      type: 'artifact_registered',
      artifact: {
        id: 'artifact-2',
        nodeId: 'assistant-1',
        role: 'output',
        kind: 'image',
        mimeType: 'image/png',
        title: 'Detail preview',
        storage: {
          backend: 'remote',
          url: 'https://cdn.example.com/detail.png',
        },
      },
    }, dispatchContext);

    const snapshot = agentRunManager.snapshot('assistant-1');
    expect(snapshot?.executionData.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-1',
        role: 'output',
        title: 'Landing preview',
        isPrimary: true,
      }),
      expect.objectContaining({
        id: 'artifact-2',
        role: 'output',
        title: 'Detail preview',
      }),
    ]);
    expect(snapshot?.timeline).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        toolName: 'show_output',
        toolUseId: 'artifact-1',
      }),
      expect.objectContaining({
        type: 'tool_result',
        toolName: 'show_output',
        toolUseId: 'artifact-2',
      }),
    ]);
    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']?.execution_data?.artifacts).toHaveLength(2);
  });

  it('captures provider image generation tool results as output artifacts', () => {
    agentRunManager.seed(message(), 'run-1');

    dispatchProviderStreamEvent({
      type: 'tool_result',
      id: 'image-tool-1',
      toolName: 'imageGeneration',
      toolOutput: {
        type: 'imageGeneration',
        result: 'abcd',
      },
    }, dispatchContext);

    const artifacts = agentRunManager.snapshot('assistant-1')?.executionData.artifacts;
    expect(artifacts).toEqual([
      expect.objectContaining({
        id: 'assistant-1:provider-image:image-tool-1',
        role: 'output',
        kind: 'image',
        mimeType: 'image/png',
        storage: expect.objectContaining({
          backend: 'inline',
          url: 'data:image/png;base64,abcd',
        }),
        thumbnail: expect.objectContaining({
          url: 'data:image/png;base64,abcd',
        }),
        source: 'provider_image_generation',
      }),
    ]);
  });
});
