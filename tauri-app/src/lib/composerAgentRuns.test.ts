import { describe, expect, it } from 'vitest';
import {
  buildComposerAgentTurnTopology,
  buildComposerAgentRuns,
  normalizeComposerAgentRunCounts,
  updateComposerAgentRunCount,
} from './composerAgentRuns';

const agent = (id: string, name = id) => ({ id, name });

describe('composer agent run counts', () => {
  it('keeps the selected agent as a single fallback when no counts exist', () => {
    expect(normalizeComposerAgentRunCounts([agent('codex-medium')], 'codex-medium', {})).toEqual({
      'codex-medium': 1,
    });
  });

  it('does not select the first available model before the composer default is known', () => {
    expect(normalizeComposerAgentRunCounts([agent('gpt-5.5-low')], null, {})).toEqual({});
  });

  it('drops unavailable agents and keeps at least one selected model', () => {
    expect(
      normalizeComposerAgentRunCounts(
        [agent('codex-medium'), agent('claude-high')],
        'claude-high',
        { 'missing-agent': 4, 'codex-medium': 2 }
      )
    ).toEqual({
      'codex-medium': 2,
    });
  });

  it('updates counts without allowing the last selected run to be removed', () => {
    const current = { 'codex-medium': 1 };
    expect(updateComposerAgentRunCount(current, 'codex-medium', 0)).toEqual(current);
    expect(updateComposerAgentRunCount(current, 'claude-high', 2)).toEqual({
      'codex-medium': 1,
      'claude-high': 2,
    });
  });

  it('expands counts into ordered runs with stable labels', () => {
    expect(
      buildComposerAgentRuns(
        [agent('codex-medium', 'Codex Medium'), agent('claude-high', 'Claude High')],
        { 'codex-medium': 2, 'claude-high': 1 }
      )
    ).toEqual([
      { agentId: 'codex-medium', agentName: 'Codex Medium', ordinal: 1, totalForAgent: 2 },
      { agentId: 'codex-medium', agentName: 'Codex Medium', ordinal: 2, totalForAgent: 2 },
      { agentId: 'claude-high', agentName: 'Claude High', ordinal: 1, totalForAgent: 1 },
    ]);
  });

  it('plans one sibling user turn per selected agent run', () => {
    const runs = buildComposerAgentRuns(
      [agent('codex-medium', 'Codex Medium'), agent('claude-high', 'Claude High')],
      { 'codex-medium': 1, 'claude-high': 1 }
    );

    expect(buildComposerAgentTurnTopology(runs, 'parent-node')).toEqual([
      expect.objectContaining({
        agentId: 'codex-medium',
        turnIndex: 0,
        userParentId: 'parent-node',
      }),
      expect.objectContaining({
        agentId: 'claude-high',
        turnIndex: 1,
        userParentId: 'parent-node',
      }),
    ]);
  });
});
