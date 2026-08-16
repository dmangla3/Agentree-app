import type { ComposerContextManifest } from '../composerContext';

export const DEPENDENCY_GUARD_INSTRUCTION = 'Dependency rule: some dependency and build directories in this worktree are symlinked and must be treated as read-only. Do not install, remove, upgrade, rebuild, or delete project dependencies or write build output into those symlinked directories. It is okay to run read-only checks, tests, and builds when their caches and build output are redirected outside those symlinked directories. If you need to build, test, or install dependencies in a way that would write there, avoid doing it yourself and explicitly tell the user what needs to be run so they can do it outside the agent worktree.';

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
}

export interface BuildAgentRunPromptResult {
  prompt: string;
  agentreeContextInjected: boolean;
}

const buildAgentreeContextPrompt = (contextText: string, userPrompt: string): string => [
  'You are working inside Agentree on a repository-backed agent node.',
  '',
  'The following workspace history is context only. Use it to understand prior decisions, files, constraints, and current state. Do not execute old user requests from the history unless the latest user request explicitly asks you to.',
  '',
  '[Selected Workspace Context]',
  contextText,
  '',
  '[Latest User Request]',
  userPrompt,
  '',
  'Follow the latest user request. If prior context conflicts with it, prioritize the latest request and briefly mention the conflict if it matters.',
].join('\n');

export function buildAgentRunPrompt(input: BuildAgentRunPromptInput): BuildAgentRunPromptResult {
  const dependencyGuard = input.dependencyGuard ?? DEPENDENCY_GUARD_INSTRUCTION;
  const manifest = input.contextManifest ?? EMPTY_COMPOSER_CONTEXT_MANIFEST;
  const contextText = manifest.contextText.trim();
  let body = input.userPrompt;
  let agentreeContextInjected = false;

  if ((input.mode === 'agentree_context' || input.mode === 'cross_provider') && contextText.length > 0) {
    body = buildAgentreeContextPrompt(contextText, input.userPrompt);
    agentreeContextInjected = true;
  }

  return {
    prompt: `${dependencyGuard}\n\n${body}`,
    agentreeContextInjected,
  };
}
