import { memo, useState } from 'react';
import type { MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GitBranch, Loader2 } from 'lucide-react';
import { agentClient } from '../lib/agentClient';
import { gitRefSnapshotKeys } from '../hooks/useGitRefSnapshot';
import { cn } from '../lib/utils';
import { useToast } from './Toast';

interface CommitCheckoutButtonProps {
  repoPath?: string | null;
  commitSha?: string | null;
  className?: string;
  iconClassName?: string;
}

export const CommitCheckoutButton = memo(({
  repoPath,
  commitSha,
  className,
  iconClassName,
}: CommitCheckoutButtonProps) => {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [isCheckingOut, setIsCheckingOut] = useState(false);

  const normalizedCommit = commitSha?.trim() || null;
  const canCheckout = Boolean(repoPath && normalizedCommit);

  const handleCheckout = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!repoPath || !normalizedCommit || isCheckingOut) return;

    setIsCheckingOut(true);
    try {
      const checkedOutCommit = await agentClient.checkoutCommitDetached(repoPath, normalizedCommit);
      queryClient.invalidateQueries({ queryKey: gitRefSnapshotKeys.all });
      addToast({
        title: 'Checkout Complete',
        description: `Detached HEAD at ${checkedOutCommit.slice(0, 7)}.`,
        variant: 'success',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not checkout this commit.';
      addToast({
        title: message.toLowerCase().includes('uncommitted changes') ? 'Checkout Skipped' : 'Checkout Failed',
        description: message,
        variant: message.toLowerCase().includes('uncommitted changes') ? 'warning' : 'error',
        duration: 9000,
      });
    } finally {
      setIsCheckingOut(false);
    }
  };

  if (!canCheckout) return null;

  return (
    <button
      type="button"
      onClick={handleCheckout}
      disabled={isCheckingOut}
      title={`Checkout ${normalizedCommit}`}
      aria-label={`Checkout commit ${normalizedCommit}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-sky-200/70 bg-white/70 px-2 py-1 text-[10px] font-medium text-sky-700 transition-colors hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-sky-800/70 dark:bg-slate-950/30 dark:text-sky-300 dark:hover:bg-sky-950/30',
        className
      )}
    >
      {isCheckingOut ? (
        <Loader2 size={12} className={cn('animate-spin', iconClassName)} />
      ) : (
        <GitBranch size={12} className={iconClassName} />
      )}
      Checkout
    </button>
  );
});

CommitCheckoutButton.displayName = 'CommitCheckoutButton';
