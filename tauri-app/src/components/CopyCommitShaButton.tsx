import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../lib/utils';

interface CopyCommitShaButtonProps {
  commitSha?: string | null;
  className?: string;
  iconClassName?: string;
}

export function CopyCommitShaButton({
  commitSha,
  className,
  iconClassName,
}: CopyCommitShaButtonProps) {
  const [isCopied, setIsCopied] = useState(false);

  if (!commitSha) return null;

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        navigator.clipboard.writeText(commitSha).catch(console.error);
        setIsCopied(true);
        window.setTimeout(() => setIsCopied(false), 1500);
      }}
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-black/10 hover:text-foreground dark:hover:bg-white/10',
        className
      )}
      aria-label="Copy commit SHA"
      title={`Copy commit SHA: ${commitSha}`}
    >
      {isCopied ? (
        <Check size={10} className={cn('text-emerald-500', iconClassName)} />
      ) : (
        <Copy size={10} className={iconClassName} />
      )}
    </button>
  );
}
