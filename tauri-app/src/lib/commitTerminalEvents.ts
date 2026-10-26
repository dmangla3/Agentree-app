export const OPEN_COMMIT_TERMINAL_EVENT = 'agentree:open-commit-terminal';

export interface OpenCommitTerminalDetail {
  repoPath: string;
  commitSha: string;
  label?: string | null;
}

export function dispatchOpenCommitTerminal(detail: OpenCommitTerminalDetail) {
  const repoPath = detail.repoPath.trim();
  const commitSha = detail.commitSha.trim();
  if (!repoPath || !commitSha) return false;

  window.dispatchEvent(new CustomEvent<OpenCommitTerminalDetail>(OPEN_COMMIT_TERMINAL_EVENT, {
    detail: {
      repoPath,
      commitSha,
      label: detail.label?.trim() || null,
    },
  }));
  return true;
}
