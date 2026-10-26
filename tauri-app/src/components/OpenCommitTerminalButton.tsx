import { SquareTerminal } from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import { dispatchOpenCommitTerminal } from '../lib/commitTerminalEvents';
import { cn } from '../lib/utils';

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
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!enabled}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!repoPath || !commitSha) return;
        dispatchOpenCommitTerminal({ repoPath, commitSha, label });
      }}
      className={cn(
        compact ? 'h-6 gap-1 px-2 text-[10px]' : 'h-7 gap-1.5 px-2.5 text-xs',
        'transition-[background-color,border-color,color,scale] duration-150 active:scale-[0.96]',
        className,
      )}
      title={enabled ? 'Open a docked terminal at this commit' : 'Commit terminal unavailable'}
      aria-label="Open terminal at commit"
    >
      <SquareTerminal className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      {!compact ? 'Terminal' : null}
    </Button>
  );
}
