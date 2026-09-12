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
});
