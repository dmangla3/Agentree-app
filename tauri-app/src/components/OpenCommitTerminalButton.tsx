import { SquareTerminal } from 'lucide-react';
import { dispatchOpenCommitTerminal } from '../lib/commitTerminalEvents';
import { CommitActionButton, commitActionIconClassName } from './CommitActionButton';

interface OpenCommitTerminalButtonProps {
  repoPath: string | null | undefined;
  commitSha: string | null | undefined;
  label?: string | null;
  compact?: boolean;
  className?: string;
}

export function OpenCommitTerminalButton({
  repoPath,
  commitSha,
  label,
  compact = false,
  className,
}: OpenCommitTerminalButtonProps) {
  const enabled = Boolean(repoPath?.trim() && commitSha?.trim());

  return (
    <CommitActionButton
      type="button"
      compact={compact}
      disabled={!enabled}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!repoPath || !commitSha) return;
        dispatchOpenCommitTerminal({ repoPath, commitSha, label });
      }}
      className={className}
      title={enabled ? 'Open a docked terminal at this commit' : 'Commit terminal unavailable'}
      aria-label="Open terminal at commit"
    >
      <SquareTerminal className={commitActionIconClassName(compact)} />
      {!compact ? 'Terminal' : null}
    </CommitActionButton>
  );
}
