import { describe, expect, it } from 'vitest';
import {
  buildMergeAgentArgs,
  buildMergeAgentPrompt,
  buildMergeAgentUserContent,
  type MergeAgentPromptInput,
} from './mergeAgentNode';

const input: MergeAgentPromptInput = {
  target: {
    label: 'main',
    commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  sources: [
    {
      label: 'sandbox config',
      commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      branchName: 'agentree/sandbox-config',
    },
    {
      label: 'test commands',
      commitSha: 'cccccccccccccccccccccccccccccccccccccccc',
    },
  ],
};

describe('merge agent node helpers', () => {
  it('builds a short user turn for the graph node', () => {
    expect(buildMergeAgentUserContent(input)).toBe('Merge 2 selected sources into main using AI.');
    expect(buildMergeAgentUserContent({
      target: input.target,
      sources: [input.sources[0]],
    })).toBe('Merge sandbox config into main using AI.');
  });

  it('builds a merge prompt that asks the agent to inspect conflicts before applying', () => {
    const prompt = buildMergeAgentPrompt(input);

    expect(prompt).toContain('Agentree provides writable per-agent cache/build env vars');
    expect(prompt).toContain('Target: main (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)');
    expect(prompt).toContain('sandbox config (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, branch: agentree/sandbox-config)');
    expect(prompt).toContain('test commands (cccccccccccccccccccccccccccccccccccccccc)');
    expect(prompt).toContain('First inspect git merge feasibility and changed files.');
    expect(prompt).toContain('If semantic decisions require product/user judgment, stop and ask me before editing.');
    expect(prompt).toContain('If the merge is safe, perform the merge, run relevant checks, and leave the worktree with the resolved merge result.');
    expect(prompt).toContain('Agentree will create the final multi-parent merge commit');
  });

  it('uses default prompt overrides for the dependency guard', () => {
    const prompt = buildMergeAgentPrompt({
      ...input,
      defaultPromptOverrides: [{
        id: 'dependency_guard',
        text: 'Custom merge dependency guard',
      }],
    });

    expect(prompt).toContain('Custom merge dependency guard');
    expect(prompt).not.toContain('Agentree provides writable per-agent cache/build env vars');
  });

  it('appends the prompt to selected agent cli args', () => {
    expect(buildMergeAgentArgs('--model gpt-5.5 --reasoning-effort high', null, 'merge prompt')).toEqual([
      '--model',
      'gpt-5.5',
      '--reasoning-effort',
      'high',
      'merge prompt',
    ]);
  });

  it('uses a prompt flag when the selected agent requires one', () => {
    expect(buildMergeAgentArgs('--permission-mode auto', '--prompt', 'merge prompt')).toEqual([
      '--permission-mode',
      'auto',
      '--prompt',
      'merge prompt',
    ]);
  });
});
