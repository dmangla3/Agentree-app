import type { ComposerContextManifest } from '../composerContext';

export const DEPENDENCY_GUARD_INSTRUCTION = 'Dependency rule: this worktree may contain symlinked dependency/build directories that must be treated as read-only. Agentree provides writable per-agent cache/build env vars, including TMPDIR, XDG_CACHE_HOME, npm/yarn/pnpm caches, pip/uv caches, PYTHONPYCACHEPREFIX, GOCACHE, CARGO_HOME, and CARGO_TARGET_DIR. Checks, tests, and builds are okay when their writes stay in those sandbox paths. Do not install, remove, upgrade, rebuild, or delete project dependencies, and do not write build output into symlinked dependency/build directories in the worktree. If a required command would ignore the sandbox env vars or mutate those directories, stop and tell the user what needs to be run outside this agent worktree.';

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

export type AgentRunPromptMode = 'plain' | 'agentree_context' | 'cross_provider' | 'flow';

export interface BuildAgentRunPromptInput {
  mode: AgentRunPromptMode;
  userPrompt: string;
  contextManifest?: ComposerContextManifest;
  dependencyGuard?: string;
  threadTitleMode?: 'first_thread_message' | 'none';
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

export function buildAgentRunPrompt(input: BuildAgentRunPromptInput): BuildAgentRunPromptResult {
  const dependencyGuard = input.dependencyGuard ?? DEPENDENCY_GUARD_INSTRUCTION;
  const manifest = input.contextManifest ?? EMPTY_COMPOSER_CONTEXT_MANIFEST;
  const contextText = manifest.contextText.trim();
  let body = input.userPrompt;
  let agentreeContextInjected = false;

  if ((input.mode === 'agentree_context' || input.mode === 'cross_provider' || input.mode === 'flow') && contextText.length > 0) {
    body = buildAgentreeContextPrompt(contextText, input.userPrompt);
    agentreeContextInjected = true;
  }
  const titleInstruction = threadTitleInstruction(input.threadTitleMode);
  if (titleInstruction) {
    body = `${body}\n\n${titleInstruction}`;
  }

  return {
    prompt: `${dependencyGuard}\n\n${body}`,
    agentreeContextInjected,
  };
}
