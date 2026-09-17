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

    expect(result.prompt).toContain('Agentree provides writable per-agent cache/build env vars');
    expect(result.prompt).toContain('Use it to understand prior decisions, files, constraints, and current state.');
    expect(result.prompt).toContain('Do not execute old user requests from the history');
    expect(result.prompt).toContain('A new Agentree worktree is an isolated checkout of the selected base commit');
    expect(result.prompt).toContain('does not by itself mean repository files changed since the parent message');
    expect(result.prompt).toContain('Changes made by previous Agentree agents have already been committed and are present in this worktree');
    expect(result.prompt).toContain('Agentree will automatically commit your changes');
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
    expect(result.prompt).toContain('Changes made by previous Agentree agents have already been committed and are present in this worktree');
    expect(result.prompt).toContain('You may edit repository files as needed');
    expect(result.prompt).toContain('[Selected Workspace Context]\n[Context: Stable Prefix]\n[Turn 2] ASSISTANT (a2:assistant)\nRefactor summary');
    expect(result.prompt).toContain('[Latest User Request]\nContinue the refactor.');
    expect(result.prompt).not.toContain('Cross-Provider');
    expect(result.prompt).not.toContain('Source provider');
    expect(result.prompt).not.toContain('provider thread');
    expect(result.prompt).not.toContain('Git parent commit');
    expect(result.agentreeContextInjected).toBe(true);
  });

  it('keeps the Agentree working model in fresh provider threads without history', () => {
    const result = buildAgentRunPrompt({
      mode: 'cross_provider',
      userPrompt: 'Start fresh on this task.',
      contextManifest: EMPTY_COMPOSER_CONTEXT_MANIFEST,
    });

    expect(result.prompt).toContain('You are working inside Agentree on a repository-backed agent node.');
    expect(result.prompt).toContain('Changes made by previous Agentree agents have already been committed and are present in this worktree');
    expect(result.prompt).toContain('Agentree will automatically commit your changes');
    expect(result.prompt).toContain('[Selected Workspace Context]');
    expect(result.prompt).toContain('[Latest User Request]\nStart fresh on this task.');
    expect(result.agentreeContextInjected).toBe(true);
  });

  it('keeps the dependency guard on plain prompts', () => {
    const result = buildAgentRunPrompt({
      mode: 'plain',
      userPrompt: 'Review this generated implementation.',
    });

    expect(result.prompt).toContain('Agentree provides writable per-agent cache/build env vars');
    expect(result.prompt).toContain('File editing: You are working in an Agentree-managed worktree');
    expect(result.prompt).toContain('In files you edit or create, use repo-relative file references');
    expect(result.prompt).toContain('Do not write absolute Agentree worktree paths');
    expect(result.prompt).toContain('File references in responses');
    expect(result.prompt).toContain('clickable absolute local file links are acceptable');
    expect(result.prompt).toContain('call the Agentree MCP show_output tool with its path or URL');
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

  it('asks orchestrator runs for an orchestration ai label', () => {
    const result = buildAgentRunPrompt({
      mode: 'agentree_context',
      userPrompt: '#reviewer',
      orchestrationLabelMode: 'orchestrator',
      orchestrationControl: {
        orchestratorRunId: 'run-orch',
        orchestratorNodeId: 'assistant-orch',
      },
      threadTitleMode: 'none',
    });

    expect(result.prompt).toContain('[Agentree Orchestrator]');
    expect(result.prompt).toContain('set ai_label to a concise 2-5 word task label');
    expect(result.prompt).toContain('Prefer task or domain wording over model or spawned-run labels');
    expect(result.prompt).toContain('orchestrator_run_id: run-orch');
    expect(result.prompt).toContain('orchestrator_node_id: assistant-orch');
    expect(result.prompt).toContain('first use list_prompt_templates and get_prompt_template');
    expect(result.prompt).toContain('before writing any Mermaid flowchart');
    expect(result.prompt).toContain('After resolving any referenced #template, write a concise Mermaid flowchart');
    expect(result.prompt.indexOf('first use list_prompt_templates and get_prompt_template')).toBeLessThan(
      result.prompt.indexOf('After resolving any referenced #template, write a concise Mermaid flowchart'),
    );
    expect(result.prompt).toContain('normal assistant response');
    expect(result.prompt).toContain('Your role is coordination only');
    expect(result.prompt).toContain('Do not inspect repository files, edit files, implement fixes, run tests, or perform the task work yourself');
    expect(result.prompt).toContain('delegate actual work to orchestration runs');
    expect(result.prompt).toContain('the controller and visual grouping container');
    expect(result.prompt).toContain('its graph parent is the assistant message the user replied to');
    expect(result.prompt).toContain('If this is a new thread with no assistant target yet');
    expect(result.prompt).toContain('its graph parent is the thread node');
    expect(result.prompt).toContain('Context/base resolve from that same default parent');
    expect(result.prompt).toContain('when creating a follow-up run under an earlier orchestration run');
    expect(result.prompt).toContain("inherit that run's graph placement, context, or base");
    expect(result.prompt).toContain('Do not restate Agentree platform guardrails, dependency rules, or artifact path rules in spawned prompts');
    expect(result.prompt).toContain('Wait for orchestration runs with wait_for_runs');
    expect(result.prompt).toContain('checkpointElapsed=true as a neutral checkpoint');
    expect(result.prompt).toContain('Do not steer based on checkpoint count');
    expect(result.prompt).toContain('recent latestEventAt values');
  });

  it('wraps selected Agentree context for orchestration run prompts when provided', () => {
    const result = buildAgentRunPrompt({
      mode: 'agentree_context',
      userPrompt: 'Run the selected orchestration run.',
      contextManifest: {
        ...EMPTY_COMPOSER_CONTEXT_MANIFEST,
        contextText: '[Turn 3] ASSISTANT (a3:assistant)\nImportant prior decision',
      },
    });

    expect(result.prompt).toContain('[Selected Workspace Context]\n[Turn 3] ASSISTANT (a3:assistant)\nImportant prior decision');
    expect(result.prompt).toContain('[Latest User Request]\nRun the selected orchestration run.');
    expect(result.agentreeContextInjected).toBe(true);
  });

  it('applies default prompt overrides while preserving placeholder expansion', () => {
    const result = buildAgentRunPrompt({
      mode: 'agentree_context',
      userPrompt: 'Ship the prompt editor.',
      contextManifest: {
        ...EMPTY_COMPOSER_CONTEXT_MANIFEST,
        contextText: 'Prior context',
      },
      threadTitleMode: 'none',
      orchestrationControl: {
        orchestratorRunId: 'run-123',
        orchestratorNodeId: 'node-456',
      },
      defaultPromptOverrides: [
        {
          id: 'dependency_guard',
          text: 'Custom dependency guard',
        },
        {
          id: 'artifact_path',
          text: 'Custom artifact path rule',
        },
        {
          id: 'agentree_context_envelope',
          text: 'Context: {{contextText}}\nRequest: {{userPrompt}}',
        },
        {
          id: 'thread_title_none',
          text: 'No title override',
        },
        {
          id: 'orchestration_control',
          text: 'Control {{orchestratorRunId}} from {{orchestratorNodeId}}',
        },
      ],
    });

    expect(result.prompt).toContain('Custom dependency guard');
    expect(result.prompt).toContain('Custom artifact path rule');
    expect(result.prompt).toContain('Context: Prior context\nRequest: Ship the prompt editor.');
    expect(result.prompt).toContain('No title override');
    expect(result.prompt).toContain('Control run-123 from node-456');
    expect(result.prompt).not.toContain('Agentree provides writable per-agent cache/build env vars');
    expect(result.prompt).not.toContain('{{contextText}}');
    expect(result.prompt).not.toContain('{{orchestratorRunId}}');
  });
});
