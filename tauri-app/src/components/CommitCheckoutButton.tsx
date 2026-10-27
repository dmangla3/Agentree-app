import { memo, useState } from 'react';
import type { MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GitBranch, Loader2 } from 'lucide-react';
import { agentClient } from '../lib/agentClient';
import { describeCheckoutFailure } from '../lib/checkoutFailure';
import { gitRefSnapshotKeys } from '../hooks/useGitRefSnapshot';
import { cn } from '../lib/utils';
import { useToast } from './Toast';
import { CommitActionButton, commitActionIconClassName } from './CommitActionButton';

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
      addToast({
        ...describeCheckoutFailure(error, 'manual'),
        duration: 9000,
      });
    } finally {
      setIsCheckingOut(false);
    }
  };

  if (!canCheckout) return null;

  return (
    <CommitActionButton
      type="button"
      onClick={handleCheckout}
      disabled={isCheckingOut}
      title={`Checkout ${normalizedCommit}`}
      aria-label={`Checkout commit ${normalizedCommit}`}
      className={className}
    >
      {isCheckingOut ? (
        <Loader2 className={cn(commitActionIconClassName(), 'animate-spin', iconClassName)} />
      ) : (
        <GitBranch className={cn(commitActionIconClassName(), iconClassName)} />
      )}
      Checkout
    </CommitActionButton>
  );
});

CommitCheckoutButton.displayName = 'CommitCheckoutButton';
