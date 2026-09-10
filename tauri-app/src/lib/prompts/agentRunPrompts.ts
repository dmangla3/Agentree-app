import type { ComposerContextManifest } from '../composerContext';

export const DEPENDENCY_GUARD_INSTRUCTION = 'Dependency rule: this worktree may contain symlinked dependency/build directories that must be treated as read-only. Agentree provides writable per-agent cache/build env vars, including TMPDIR, XDG_CACHE_HOME, npm/yarn/pnpm caches, pip/uv caches, PYTHONPYCACHEPREFIX, GOCACHE, CARGO_HOME, and CARGO_TARGET_DIR. Checks, tests, and builds are okay when their writes stay in those sandbox paths. Do not install, remove, upgrade, rebuild, or delete project dependencies, and do not write build output into symlinked dependency/build directories in the worktree. If a required command would ignore the sandbox env vars or mutate those directories, stop and tell the user what needs to be run outside this agent worktree.';

export const ARTIFACT_PATH_INSTRUCTION = 'Artifact path rule: when you create or revise repository files that may be committed, especially plans, docs, reports, review notes, or other Markdown artifacts, write file references as repo-relative paths like `tauri-app/src/lib/example.ts:12`. Do not write absolute Agentree worktree paths such as `/Users/.../.agentree/worktrees/...` into committed artifacts. Absolute clickable local file links are acceptable only in your final chat response, not inside files you edit.';

export const EMPTY_COMPOSER_CONTEXT_MANIFEST: ComposerContextManifest = {
  version: 'v1',
  blocks: [],
  stableBlocks: [],
  volatileBlocks: [],
  stablePrefixText: '',
  volatileTailText: '',
  contextText: '',
  manifestHash: '811c9dc5',
  stablePrefixHash: '811c9dc5',
  volatileTailHash: '811c9dc5',
};

export type AgentRunPromptMode = 'plain' | 'agentree_context' | 'cross_provider';

export interface BuildAgentRunPromptInput {
  mode: AgentRunPromptMode;
  userPrompt: string;
  contextManifest?: ComposerContextManifest;
  dependencyGuard?: string;
  threadTitleMode?: 'first_thread_message' | 'none';
  orchestrationLabelMode?: 'orchestrator' | 'none';
  orchestrationControl?: {
    orchestratorRunId: string;
    orchestratorNodeId: string;
  } | null;
}

export interface BuildAgentRunPromptResult {
  prompt: string;
  agentreeContextInjected: boolean;
}

const buildAgentreeContextPrompt = (contextText: string, userPrompt: string): string => [
  'You are working inside Agentree on a repository-backed agent node.',
  '',
  'The following workspace history is context only. Use it to understand prior decisions, files, constraints, and current state. Do not execute old user requests from the history unless the latest user request explicitly asks you to.',
  'A new Agentree worktree is an isolated checkout of the selected base commit; it does not by itself mean repository files changed since the parent message. Treat included file reads, search results, and execution timeline observations as valid for that base commit unless the latest request, a newer commit, or conflicting local evidence gives you a concrete reason to verify them again.',
  'Changes made by previous Agentree agents have already been committed and are present in this worktree. You can modify the working tree for the latest request; Agentree will automatically commit your changes.',
  '',
  '[Selected Workspace Context]',
  contextText,
  '',
  '[Latest User Request]',
  userPrompt,
  '',
  'Follow the latest user request. If prior context conflicts with it, prioritize the latest request and briefly mention the conflict if it matters.',
].join('\n');

const threadTitleInstruction = (mode: BuildAgentRunPromptInput['threadTitleMode']): string | null => {
  if (mode === 'first_thread_message') {
    return [
      '[Agentree Thread Title]',
      'This is the first user message in a new Agentree thread. In structured output, set thread_title to a concise 3-7 word title based only on the latest user request.',
    ].join('\n');
  }
  if (mode === 'none') {
    return [
      '[Agentree Thread Title]',
      'This is not the first user message in a new Agentree thread. In structured output, set thread_title to null.',
    ].join('\n');
  }
  return null;
};

const orchestrationLabelInstruction = (mode: BuildAgentRunPromptInput['orchestrationLabelMode']): string | null => {
  if (mode !== 'orchestrator') return null;
  return [
    '[Agentree Orchestrator]',
    'This run is an orchestration controller. In structured output, set ai_label to a concise 2-5 word task label for the overall orchestration request. Prefer task or domain wording over model or spawned-run labels.',
  ].join('\n');
};

const orchestrationControlInstruction = (
  control: BuildAgentRunPromptInput['orchestrationControl'],
): string | null => {
  if (!control) return null;
  return [
    '[Agentree Orchestration Control]',
    `orchestrator_run_id: ${control.orchestratorRunId}`,
    `orchestrator_node_id: ${control.orchestratorNodeId}`,
    '',
    'You control this orchestration through Agentree MCP tools. Start by writing a concise Mermaid flowchart of the intended work in your normal assistant response, then spawn orchestration runs with start_orchestration_run.',
    'Your role is coordination only: decompose the user request, launch orchestration runs, wait for them, steer or stop them when needed, and complete the orchestration. Do not inspect repository files, edit files, implement fixes, run tests, or perform the task work yourself; delegate actual work to orchestration runs.',
    "The orchestrator is only the controller and visual grouping container. A spawned run is a normal graph run: by default its graph parent is the assistant message the user replied to, not the user orchestration request or the controller assistant node. If this is a new thread with no assistant target yet, its graph parent is the thread node. Context/base resolve from that same default parent. Pass parent_node_id, context_parent_node_id, or base_node_id only when intentionally overriding those defaults, including when creating a follow-up run under an earlier orchestration run so it should inherit that run's graph placement, context, or base.",
    '',
    'When the user references a #template, use list_prompt_templates and get_prompt_template to read the actual prompt. Compose concrete orchestration run prompts yourself from the template and the user request; the app will not parse or expand orchestration text for you.',
    '',
    'Wait for orchestration runs with wait_for_runs. The tool returns when the condition is satisfied or before the provider MCP timeout with timedOut=true as a checkpoint. A wait timeout is a state report, not a run failure; if runs are running or streaming, keep waiting unless the user explicitly asked to cancel. Use graph_live_query for active or recently started run status because persisted graph tools can lag local/projection nodes. Use control_run with action "steer" when you need to redirect a run. Use control_run with action "stop" only when the user asked to cancel or you have a concrete failure reason; active stops require force=true and reason. Use complete_orchestration when the orchestration is finished.',
    '',
    'If the user steers this orchestrator run, incorporate the new direction into the remaining orchestration work.',
  ].join('\n');
};

export function buildAgentRunPrompt(input: BuildAgentRunPromptInput): BuildAgentRunPromptResult {
  const dependencyGuard = input.dependencyGuard ?? DEPENDENCY_GUARD_INSTRUCTION;
  const manifest = input.contextManifest ?? EMPTY_COMPOSER_CONTEXT_MANIFEST;
  const contextText = manifest.contextText.trim();
  let body = input.userPrompt;
  let agentreeContextInjected = false;

  if (input.mode === 'agentree_context' || input.mode === 'cross_provider') {
    body = buildAgentreeContextPrompt(contextText, input.userPrompt);
    agentreeContextInjected = true;
  }
  const titleInstruction = threadTitleInstruction(input.threadTitleMode);
  if (titleInstruction) {
    body = `${body}\n\n${titleInstruction}`;
  }
  const orchestrationInstruction = orchestrationLabelInstruction(input.orchestrationLabelMode);
  if (orchestrationInstruction) {
    body = `${body}\n\n${orchestrationInstruction}`;
  }
  const orchestrationControl = orchestrationControlInstruction(input.orchestrationControl);
  if (orchestrationControl) {
    body = `${body}\n\n${orchestrationControl}`;
  }

  return {
    prompt: `${dependencyGuard}\n\n${ARTIFACT_PATH_INSTRUCTION}\n\n${body}`,
    agentreeContextInjected,
  };
}
