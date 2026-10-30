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
        'relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96]',
        "after:absolute after:left-1/2 after:top-1/2 after:h-10 after:w-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
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
