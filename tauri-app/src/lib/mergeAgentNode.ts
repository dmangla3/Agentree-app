export {
  buildMergeAgentPrompt,
  type MergeAgentPromptInput,
  type MergeAgentPromptSource,
  type MergeAgentPromptTarget,
} from './prompts';

import type { MergeAgentPromptInput } from './prompts';

export const buildMergeAgentUserContent = ({ target, sources }: MergeAgentPromptInput): string => {
  const sourceLabel = sources.length === 1
    ? sources[0]?.label ?? 'selected source'
    : `${sources.length} selected sources`;

  return `Merge ${sourceLabel} into ${target.label} using AI.`;
};

export const buildMergeAgentArgs = (
  cliArgs: string | null | undefined,
  promptFlag: string | null | undefined,
  prompt: string,
): string[] => {
  const args = String(cliArgs || '').split(/\s+/).filter(Boolean);
  return promptFlag ? [...args, promptFlag, prompt] : [...args, prompt];
};
