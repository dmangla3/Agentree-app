import type { ComponentProps } from 'react';
import { Button } from '../../@/components/ui/button';
import { cn } from '../lib/utils';

type CommitActionButtonProps = Omit<ComponentProps<typeof Button>, 'size' | 'variant'> & {
  compact?: boolean;
};

export function CommitActionButton({
  compact = false,
  className,
  ...props
}: CommitActionButtonProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        compact ? 'h-6 gap-1 px-2 text-[10px]' : 'h-7 gap-1.5 px-2.5 text-xs',
        'transition-[background-color,border-color,color,scale] duration-150 active:scale-[0.96]',
        className,
      )}
      {...props}
    />
  );
}

export const commitActionIconClassName = (compact = false) => (
  compact ? 'h-3 w-3' : 'h-3.5 w-3.5'
);
