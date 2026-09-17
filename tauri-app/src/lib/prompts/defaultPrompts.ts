export type DefaultPromptId =
  | 'dependency_guard'
  | 'artifact_path'
  | 'agentree_context_envelope'
  | 'thread_title_first'
  | 'thread_title_none'
  | 'orchestration_label'
  | 'orchestration_control';

export interface DefaultPromptDefinition {
  id: DefaultPromptId;
  label: string;
  description: string;
  defaultText: string;
  variables?: string[];
}

export interface DefaultPromptOverride {
  id: DefaultPromptId;
  text: string;
  updatedAt?: string | null;
}

export interface EffectiveDefaultPrompt extends DefaultPromptDefinition {
  text: string;
  source: 'built_in' | 'user';
  updatedAt?: string | null;
}

const placeholderPattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export const DEFAULT_PROMPT_DEFINITIONS: DefaultPromptDefinition[] = [
  {
    id: 'dependency_guard',
    label: 'Dependency guard',
    description: 'Prepended to agent runs so dependency and build directories stay read-only.',
    defaultText: 'Dependency rule: this worktree may contain symlinked dependency/build directories that must be treated as read-only. Agentree provides writable per-agent cache/build env vars, including TMPDIR, XDG_CACHE_HOME, npm/yarn/pnpm caches, pip/uv caches, PYTHONPYCACHEPREFIX, GOCACHE, CARGO_HOME, and CARGO_TARGET_DIR. Checks, tests, and builds are okay when their writes stay in those sandbox paths. Do not install, remove, upgrade, rebuild, or delete project dependencies, and do not write build output into symlinked dependency/build directories in the worktree. If a required command would ignore the sandbox env vars or mutate those directories, stop and tell the user what needs to be run outside this agent worktree.',
  },
  {
    id: 'artifact_path',
    label: 'File and output rules',
    description: 'Clarifies file editing, file references, and preview output behavior in Agentree runs.',
    defaultText: [
      '[Agentree File And Output Rules]',
      '',
      'File editing: You are working in an Agentree-managed worktree for the latest user request. You may edit repository files as needed, and Agentree will automatically commit your changes after the run. In files you edit or create, use repo-relative file references such as `tauri-app/src/lib/example.ts:12`. Do not write absolute Agentree worktree paths such as `/Users/.../.agentree/worktrees/...` into committed files.',
      '',
      'File references in responses: in your final chat response, clickable absolute local file links are acceptable when they help the user open files directly; otherwise prefer concise repo-relative references.',
      '',
      'Preview outputs: if you create or edit something visual or previewable, such as a landing page, app screen, chart, diagram, generated image, PDF, HTML export, video, audio, or downloadable file, produce a preview artifact when practical. For visual UI work, capture a screenshot of the result when you can. If you generate visual output directly, or want to show the user a screenshot or preview file, call the Agentree MCP show_output tool with its path or URL. Do not use show_output for ordinary source files, logs, or internal notes unless they are the actual user-facing output.',
    ].join('\n'),
  },
  {
    id: 'agentree_context_envelope',
    label: 'Agentree context envelope',
    description: 'Wraps selected workspace history around the latest user request.',
    variables: ['contextText', 'userPrompt'],
    defaultText: [
      'You are working inside Agentree on a repository-backed agent node.',
      '',
      'The following workspace history is context only. Use it to understand prior decisions, files, constraints, and current state. Do not execute old user requests from the history unless the latest user request explicitly asks you to.',
      'A new Agentree worktree is an isolated checkout of the selected base commit; it does not by itself mean repository files changed since the parent message. Treat included file reads, search results, and execution timeline observations as valid for that base commit unless the latest request, a newer commit, or conflicting local evidence gives you a concrete reason to verify them again.',
      'Changes made by previous Agentree agents have already been committed and are present in this worktree.',
      '',
      '[Selected Workspace Context]',
      '{{contextText}}',
      '',
      '[Latest User Request]',
      '{{userPrompt}}',
      '',
      'Follow the latest user request. If prior context conflicts with it, prioritize the latest request and briefly mention the conflict if it matters.',
    ].join('\n'),
  },
  {
    id: 'thread_title_first',
    label: 'First thread title',
    description: 'Asks spawned agents to title newly created Agentree threads.',
    defaultText: [
      '[Agentree Thread Title]',
      'This is the first user message in a new Agentree thread. In structured output, set thread_title to a concise 3-7 word title based only on the latest user request.',
    ].join('\n'),
  },
  {
    id: 'thread_title_none',
    label: 'Existing thread title',
    description: 'Prevents spawned agents from renaming existing Agentree threads.',
    defaultText: [
      '[Agentree Thread Title]',
      'This is not the first user message in a new Agentree thread. In structured output, set thread_title to null.',
    ].join('\n'),
  },
  {
    id: 'orchestration_label',
    label: 'Orchestration label',
    description: 'Asks controller runs for a concise orchestration label.',
    defaultText: [
      '[Agentree Orchestrator]',
      'This run is an orchestration controller. In structured output, set ai_label to a concise 2-5 word task label for the overall orchestration request. Prefer task or domain wording over model or spawned-run labels.',
    ].join('\n'),
  },
  {
    id: 'orchestration_control',
    label: 'Orchestration control',
    description: 'Gives controller runs their MCP orchestration responsibilities and identifiers.',
    variables: ['orchestratorRunId', 'orchestratorNodeId'],
    defaultText: [
      '[Agentree Orchestration Control]',
      'orchestrator_run_id: {{orchestratorRunId}}',
      'orchestrator_node_id: {{orchestratorNodeId}}',
      '',
      'You control this orchestration through Agentree MCP tools.',
      'If the user references a #template, first use list_prompt_templates and get_prompt_template to read the actual prompt before writing any Mermaid flowchart or spawning orchestration runs. Compose concrete orchestration run prompts yourself from the template and the user request; the app will not parse or expand orchestration text for you. Do not restate Agentree platform guardrails, dependency rules, or artifact path rules in spawned prompts; Agentree applies those automatically to every spawned run.',
      'After resolving any referenced #template, write a concise Mermaid flowchart of the intended work in your normal assistant response, then spawn orchestration runs with start_orchestration_run.',
      'Your role is coordination only: decompose the user request, launch orchestration runs, wait for them, steer or stop them when needed, and complete the orchestration. Do not inspect repository files, edit files, implement fixes, run tests, or perform the task work yourself; delegate actual work to orchestration runs.',
      "The orchestrator is only the controller and visual grouping container. A spawned run is a normal graph run: by default its graph parent is the assistant message the user replied to, not the user orchestration request or the controller assistant node. If this is a new thread with no assistant target yet, its graph parent is the thread node. Context/base resolve from that same default parent. Pass parent_node_id, context_parent_node_id, or base_node_id only when intentionally overriding those defaults, including when creating a follow-up run under an earlier orchestration run so it should inherit that run's graph placement, context, or base.",
      '',
      'Wait for orchestration runs with wait_for_runs. The tool returns when the condition is satisfied or every few minutes with checkpointElapsed=true as a neutral checkpoint. A checkpoint is a state report, not a child-run timeout or failure; if runs are active and have recent latestEventAt values, call wait_for_runs again without narrating concern. Do not steer based on checkpoint count. Use graph_live_query for active or recently started run status because persisted graph tools can lag local/projection nodes. Use control_run with action "steer" only when you need to redirect a run because the user changed direction, the run explicitly asks for guidance, or the run explicitly reports a blocker. Use control_run with action "stop" only when the user asked to cancel or you have a concrete failure reason; active stops require force=true and reason. Use complete_orchestration when the orchestration is finished.',
      '',
      'If the user steers this orchestrator run, incorporate the new direction into the remaining orchestration work.',
    ].join('\n'),
  },
];

const defaultPromptIds = new Set(DEFAULT_PROMPT_DEFINITIONS.map((definition) => definition.id));

export const isDefaultPromptId = (value: string): value is DefaultPromptId => (
  defaultPromptIds.has(value as DefaultPromptId)
);

export const getDefaultPromptDefinition = (id: DefaultPromptId): DefaultPromptDefinition => {
  const definition = DEFAULT_PROMPT_DEFINITIONS.find((candidate) => candidate.id === id);
  if (!definition) {
    throw new Error(`Unknown default prompt id: ${id}`);
  }
  return definition;
};

export const getDefaultPromptPlaceholders = (text: string): Set<string> => {
  const placeholders = new Set<string>();
  for (const match of text.matchAll(placeholderPattern)) {
    const key = match[1];
    if (key) placeholders.add(key);
  }
  return placeholders;
};

export const getMissingDefaultPromptVariables = (
  id: DefaultPromptId,
  text: string,
): string[] => {
  const requiredVariables = getDefaultPromptDefinition(id).variables ?? [];
  if (requiredVariables.length === 0) return [];
  const placeholders = getDefaultPromptPlaceholders(text);
  return requiredVariables.filter((variable) => !placeholders.has(variable));
};

export const normalizeDefaultPromptOverrides = (
  overrides: DefaultPromptOverride[],
): DefaultPromptOverride[] => {
  const normalized = new Map<DefaultPromptId, DefaultPromptOverride>();
  for (const override of overrides) {
    if (!isDefaultPromptId(override.id)) continue;
    const text = typeof override.text === 'string' ? override.text.trim() : '';
    if (!text) continue;
    if (text === getDefaultPromptDefinition(override.id).defaultText.trim()) continue;
    if (getMissingDefaultPromptVariables(override.id, text).length > 0) continue;
    normalized.set(override.id, {
      id: override.id,
      text,
      updatedAt: override.updatedAt ?? null,
    });
  }
  return Array.from(normalized.values());
};

export const mergeDefaultPromptOverrides = (
  overrides: DefaultPromptOverride[],
): EffectiveDefaultPrompt[] => {
  const overridesById = new Map(
    normalizeDefaultPromptOverrides(overrides).map((override) => [override.id, override]),
  );

  return DEFAULT_PROMPT_DEFINITIONS.map((definition) => {
    const override = overridesById.get(definition.id);
    return {
      ...definition,
      text: override?.text ?? definition.defaultText,
      source: override ? 'user' : 'built_in',
      updatedAt: override?.updatedAt ?? null,
    };
  });
};

export const renderDefaultPromptText = (
  text: string,
  variables: Record<string, string> = {},
): string => text.replace(placeholderPattern, (_match, key: string) => (
  variables[key] ?? ''
));

export const getEffectiveDefaultPromptText = (
  id: DefaultPromptId,
  overrides: DefaultPromptOverride[] = [],
  variables: Record<string, string> = {},
): string => {
  const normalizedOverrides = normalizeDefaultPromptOverrides(overrides);
  const override = normalizedOverrides.find((candidate) => candidate.id === id);
  return renderDefaultPromptText(
    override?.text ?? getDefaultPromptDefinition(id).defaultText,
    variables,
  );
};
