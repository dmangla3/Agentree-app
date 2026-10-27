import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../hooks/useAgents';
import type { LoginProfileSummary } from '../lib/loginProfiles';
import {
  createAgentRunSpec,
  launchAgentRunBatch,
  prepareAgentRuns,
} from './agentRunBatch';

const profile = (id: string, provider: string): LoginProfileSummary => ({
  id,
  provider,
  displayName: id,
  authType: `${provider}_auth`,
  status: 'ready',
  isDefault: true,
});

const agent = (id: string, provider: string, model: string, reasoningEffort: string): Agent => ({
  id,
  name: id,
  type: provider,
  model_config: { model, reasoningEffort },
  cliArgs: `--model ${model}`,
});

const selection = (value: Agent) => ({
  agentId: value.id,
  agentName: value.name,
  ordinal: 1,
  totalForAgent: 1,
  agent: value,
});

describe('agent run batch orchestration', () => {
  it('keeps each selected model and profile in its own immutable run', async () => {
    const codexProfile = profile('codex-profile', 'codex');
    const claudeProfile = profile('claude-profile', 'claude');

    const prepared = await prepareAgentRuns({
      runs: [
        selection(agent('codex-medium', 'codex', 'gpt-5.6', 'medium')),
        selection(agent('claude-high', 'claude', 'claude-opus-4-6', 'high')),
      ],
      profiles: [codexProfile, claudeProfile],
    });
    const specs = prepared.map((run) => createAgentRunSpec(run, {
      prompt: 'Compare these approaches',
      base: { commitSha: 'abc123', selectedFromNodeId: 'parent' },
      context: { parentMessageId: 'parent' },
    }));

    expect(specs.map((run) => ({
      provider: run.provider,
      model: run.model,
      effort: run.reasoningEffort,
      profile: run.loginProfileId,
    }))).toEqual([
      { provider: 'codex', model: 'gpt-5.6', effort: 'medium', profile: 'codex-profile' },
      { provider: 'claude', model: 'claude-opus-4-6', effort: 'high', profile: 'claude-profile' },
    ]);
    expect(Object.isFrozen(specs[0])).toBe(true);
    expect(Object.isFrozen(specs[0].agent)).toBe(true);
  });

  it('uses cached profile readiness without rechecking providers while retaining every run', async () => {
    const codexProfile = profile('codex-profile', 'codex');

    const prepared = await prepareAgentRuns({
      runs: [
        selection(agent('codex-medium', 'codex', 'gpt-5.6', 'medium')),
        { ...selection(agent('codex-low', 'codex', 'gpt-5.6', 'low')), ordinal: 2, totalForAgent: 2 },
      ],
      profiles: [codexProfile],
    });

    expect(prepared).toHaveLength(2);
    expect(prepared.every((run) => run.loginProfileId === codexProfile.id)).toBe(true);
  });

  it('reports the exact provider whose cached profile is not ready', async () => {
    let caught: unknown;
    try {
      prepareAgentRuns({
        runs: [selection(agent('claude-high', 'claude', 'claude-opus-4-6', 'high'))],
        profiles: [],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      failures: [expect.objectContaining({ provider: 'claude', profileId: null })],
    });
  });

  it('launches runs concurrently and keeps failures associated with their specs', async () => {
    const codexProfile = profile('codex-profile', 'codex');
    const prepared = await prepareAgentRuns({
      runs: [
        selection(agent('codex-medium', 'codex', 'gpt-5.6', 'medium')),
        { ...selection(agent('codex-low', 'codex', 'gpt-5.6', 'low')), ordinal: 2, totalForAgent: 2 },
      ],
      profiles: [codexProfile],
    });
    const specs = prepared.map((run) => createAgentRunSpec(run, {
      prompt: 'Run',
      base: { commitSha: 'abc123', selectedFromNodeId: null },
      context: {},
    }));
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const batchPromise = launchAgentRunBatch(specs, async (spec) => {
      started.push(spec.runKey);
      if (spec.ordinal === 1) await firstBlocked;
      else throw new Error('second failed');
      return spec.agentId;
    });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    releaseFirst();
    const results = await batchPromise;

    expect(results[0].result).toMatchObject({ status: 'fulfilled', value: 'codex-medium' });
    expect(results[1].result).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
    expect(results[1].spec.agentId).toBe('codex-low');
  });
});
