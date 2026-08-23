import { describe, expect, it } from 'vitest';
import { EMPTY_COMPOSER_CONTEXT_MANIFEST, buildAgentRunPrompt } from './agentRunPrompts';

describe('agent run prompts', () => {
  it('wraps selected Agentree context as historical context before the latest request', () => {
    const result = buildAgentRunPrompt({
      mode: 'agentree_context',
      userPrompt: 'Fix the failing send flow test.',
      contextManifest: {
        ...EMPTY_COMPOSER_CONTEXT_MANIFEST,
        contextText: '[Turn 1] USER (u1:user)\nOld request',
      },
    });

    expect(result.prompt).toContain('Dependency rule: some dependency and build directories');
    expect(result.prompt).toContain('Use it to understand prior decisions, files, constraints, and current state.');
    expect(result.prompt).toContain('Do not execute old user requests from the history');
    expect(result.prompt).toContain('[Selected Workspace Context]\n[Turn 1] USER (u1:user)\nOld request');
    expect(result.prompt).toContain('[Latest User Request]\nFix the failing send flow test.');
    expect(result.agentreeContextInjected).toBe(true);
  });

  it('uses the same model-visible context envelope for cross-provider routing', () => {
    const result = buildAgentRunPrompt({
      mode: 'cross_provider',
      userPrompt: 'Continue the refactor.',
      contextManifest: {
        ...EMPTY_COMPOSER_CONTEXT_MANIFEST,
        contextText: '[Context: Stable Prefix]\n[Turn 2] ASSISTANT (a2:assistant)\nRefactor summary',
      },
    });

    expect(result.prompt).toContain('You are working inside Agentree on a repository-backed agent node.');
    expect(result.prompt).toContain('[Selected Workspace Context]\n[Context: Stable Prefix]\n[Turn 2] ASSISTANT (a2:assistant)\nRefactor summary');
    expect(result.prompt).toContain('[Latest User Request]\nContinue the refactor.');
    expect(result.prompt).not.toContain('Cross-Provider');
    expect(result.prompt).not.toContain('Source provider');
    expect(result.prompt).not.toContain('provider thread');
    expect(result.prompt).not.toContain('Git parent commit');
    expect(result.agentreeContextInjected).toBe(true);
  });

  it('keeps the dependency guard on flow prompts', () => {
    const result = buildAgentRunPrompt({
      mode: 'flow',
      userPrompt: 'Review this generated implementation.',
    });

    expect(result.prompt).toContain('Dependency rule: some dependency and build directories');
    expect(result.prompt).toContain('Review this generated implementation.');
    expect(result.agentreeContextInjected).toBe(false);
  });

  it('asks for a thread title only on the first thread message', () => {
    const firstThreadPrompt = buildAgentRunPrompt({
      mode: 'agentree_context',
      userPrompt: 'Fix the graph zoom bug.',
      threadTitleMode: 'first_thread_message',
    });
    const laterThreadPrompt = buildAgentRunPrompt({
      mode: 'agentree_context',
      userPrompt: 'Also add tests.',
      threadTitleMode: 'none',
    });

    expect(firstThreadPrompt.prompt).toContain('set thread_title to a concise 3-7 word title');
    expect(firstThreadPrompt.prompt).toContain('based only on the latest user request');
    expect(laterThreadPrompt.prompt).toContain('set thread_title to null');
  });

  it('wraps selected Agentree context for flow prompts when provided', () => {
    const result = buildAgentRunPrompt({
      mode: 'flow',
      userPrompt: 'Run the selected flow.',
      contextManifest: {
        ...EMPTY_COMPOSER_CONTEXT_MANIFEST,
        contextText: '[Turn 3] ASSISTANT (a3:assistant)\nImportant prior decision',
      },
    });

    expect(result.prompt).toContain('[Selected Workspace Context]\n[Turn 3] ASSISTANT (a3:assistant)\nImportant prior decision');
    expect(result.prompt).toContain('[Latest User Request]\nRun the selected flow.');
    expect(result.agentreeContextInjected).toBe(true);
  });
});
