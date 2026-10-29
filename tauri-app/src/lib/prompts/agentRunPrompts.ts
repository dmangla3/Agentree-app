import type { ComposerContextManifest } from '../composerContext';
import {
  getDefaultPromptDefinition,
  getEffectiveDefaultPromptText,
  type DefaultPromptOverride,
} from './defaultPrompts';

export const DEPENDENCY_GUARD_INSTRUCTION = getDefaultPromptDefinition('dependency_guard').defaultText;

export const ARTIFACT_PATH_INSTRUCTION = getDefaultPromptDefinition('artifact_path').defaultText;

export const EMPTY_COMPOSER_CONTEXT_MANIFEST: ComposerContextManifest = {
  version: 'v1',
  blocks: [],
  stableBlocks: [],
  volatileBlocks: [],
  stablePrefixText: '',
  volatileTailText: '',
  contextText: '',
  artifactInputs: [],
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
  defaultPromptOverrides?: DefaultPromptOverride[];
  threadTitleMode?: 'first_thread_message' | 'none';
}

export interface BuildAgentRunPromptResult {
  prompt: string;
  agentreeContextInjected: boolean;
}

const buildAgentreeContextPrompt = (
  contextText: string,
  userPrompt: string,
  overrides: DefaultPromptOverride[] | undefined,
): string => (
  getEffectiveDefaultPromptText('agentree_context_envelope', overrides, { contextText, userPrompt })
);

const threadTitleInstruction = (
  mode: BuildAgentRunPromptInput['threadTitleMode'],
  overrides: DefaultPromptOverride[] | undefined,
): string | null => {
  if (mode === 'first_thread_message') {
    return getEffectiveDefaultPromptText('thread_title_first', overrides);
  }
  if (mode === 'none') {
    return getEffectiveDefaultPromptText('thread_title_none', overrides);
  }
  return null;
};

export function buildAgentRunPrompt(input: BuildAgentRunPromptInput): BuildAgentRunPromptResult {
  const defaultPromptOverrides = input.defaultPromptOverrides;
  const dependencyGuard = input.dependencyGuard
    ?? getEffectiveDefaultPromptText('dependency_guard', defaultPromptOverrides);
  const manifest = input.contextManifest ?? EMPTY_COMPOSER_CONTEXT_MANIFEST;
  const contextText = manifest.contextText.trim();
  let body = input.userPrompt;
  let agentreeContextInjected = false;

  if (input.mode === 'agentree_context' || input.mode === 'cross_provider') {
    body = buildAgentreeContextPrompt(contextText, input.userPrompt, defaultPromptOverrides);
    agentreeContextInjected = true;
  }
  const titleInstruction = threadTitleInstruction(input.threadTitleMode, defaultPromptOverrides);
  if (titleInstruction) {
    body = `${body}\n\n${titleInstruction}`;
  }
  body = `${body}\n\n${getEffectiveDefaultPromptText('delegation_control', defaultPromptOverrides)}`;
  body = `${body}\n\n${getEffectiveDefaultPromptText('rlm_loop', defaultPromptOverrides)}`;

  return {
    prompt: `${dependencyGuard}\n\n${getEffectiveDefaultPromptText('artifact_path', defaultPromptOverrides)}\n\n${body}`,
    agentreeContextInjected,
  };
}
