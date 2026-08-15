import { DEPENDENCY_GUARD_INSTRUCTION } from './agentRunPrompts';

export interface MergeAgentPromptTarget {
  label: string;
  commitSha: string;
}

export interface MergeAgentPromptSource {
  label: string;
  commitSha: string;
  branchName?: string | null;
}

export interface MergeAgentPromptInput {
  target: MergeAgentPromptTarget;
  sources: MergeAgentPromptSource[];
}

const formatSource = (source: MergeAgentPromptSource, index: number) => {
  const branchSuffix = source.branchName ? `, branch: ${source.branchName}` : '';
  return `${index + 1}. ${source.label} (${source.commitSha}${branchSuffix})`;
};

export const buildMergeAgentPrompt = ({ target, sources }: MergeAgentPromptInput): string => {
  const sourceList = sources.map(formatSource).join('\n');

  return `${DEPENDENCY_GUARD_INSTRUCTION}

Merge the selected source commits into the selected target commit.

Target: ${target.label} (${target.commitSha})

Sources:
${sourceList}

Requirements:
1. First inspect git merge feasibility and changed files.
2. Check for both text conflicts and semantic conflicts across the changed code.
3. If semantic decisions require product/user judgment, stop and ask me before editing.
4. If the merge is safe, perform the merge, run relevant checks, and leave the worktree with the resolved merge result.
5. Do not create the final git commit yourself. Agentree will create the final multi-parent merge commit from the resolved worktree and update the target branch.
6. Summarize the merge result, decisions made, checks run, and any residual risk.`;
};
