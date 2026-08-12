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

export const buildMergeAgentUserContent = ({ target, sources }: MergeAgentPromptInput): string => {
  const sourceLabel = sources.length === 1
    ? sources[0]?.label ?? 'selected source'
    : `${sources.length} selected sources`;

  return `Merge ${sourceLabel} into ${target.label} using AI.`;
};

const DEPENDENCY_GUARD_INSTRUCTION = 'Dependency rule: some dependency and build directories in this worktree are symlinked and must be treated as read-only. Do not install, remove, upgrade, rebuild, or delete project dependencies or write build output into those symlinked directories. It is okay to run read-only checks, tests, and builds when their caches and build output are redirected outside those symlinked directories. If you need to build, test, or install dependencies in a way that would write there, avoid doing it yourself and explicitly tell the user what needs to be run so they can do it outside the agent worktree.';

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

export const buildMergeAgentArgs = (
  cliArgs: string | null | undefined,
  promptFlag: string | null | undefined,
  prompt: string,
): string[] => {
  const args = String(cliArgs || '').split(/\s+/).filter(Boolean);
  return promptFlag ? [...args, promptFlag, prompt] : [...args, prompt];
};
