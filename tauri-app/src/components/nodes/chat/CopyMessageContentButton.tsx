import { memo, useState, type MouseEvent } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../../lib/utils';

interface CopyMessageContentButtonProps {
  text?: string | null;
  ariaLabel: string;
  title: string;
  className?: string;
}

export const CopyMessageContentButton = memo(({
  text,
  ariaLabel,
  title,
  className,
}: CopyMessageContentButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const copyText = typeof text === 'string' ? text : '';

  if (!copyText.trim()) return null;

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      await navigator.clipboard.writeText(copyText);
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), 1200);
    } catch (_error) {
      // Keep the card interaction quiet if the platform clipboard is unavailable.
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground shadow-sm transition-colors",
        "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      aria-label={ariaLabel}
      title={isCopied ? 'Copied' : title}
    >
      {isCopied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2.2} />}
    </button>
  );
});

CopyMessageContentButton.displayName = 'CopyMessageContentButton';
