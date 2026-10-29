import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../../../@/components/ui/button';
import { Checkbox } from '../../../@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '../../../@/components/ui/popover';
import {
  getOpenCodeProviderCapabilities,
  type LoginProfileSummary,
  type OpenCodeProviderAccess,
} from '../../lib/loginProfiles';
import { cn } from '../../lib/utils';

const accessMeta: Record<OpenCodeProviderAccess, { label: string; className: string }> = {
  full: { label: 'Full access', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/35 dark:text-emerald-300' },
  free_only: { label: 'Free only', className: 'bg-amber-50 text-amber-800 dark:bg-amber-950/35 dark:text-amber-300' },
  unavailable: { label: 'Unavailable', className: 'bg-red-50 text-red-700 dark:bg-red-950/35 dark:text-red-300' },
  invalid: { label: 'Invalid', className: 'bg-red-50 text-red-700 dark:bg-red-950/35 dark:text-red-300' },
  unconfirmed: { label: 'Not confirmed', className: 'bg-muted text-muted-foreground' },
};

const buttonVariants = {
  outline: 'bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
  muted: 'border-0 bg-muted text-foreground shadow-none hover:bg-muted/80 dark:bg-input/30',
};

interface OpenCodeProviderTestButtonProps {
  profile: LoginProfileSummary;
  disabled?: boolean;
  isTesting?: boolean;
  onTest: (providers: string[] | null) => void;
  variant?: keyof typeof buttonVariants;
  className?: string;
}

export function OpenCodeProviderTestButton({
  profile,
  disabled = false,
  isTesting = false,
  onTest,
  variant = 'outline',
  className,
}: OpenCodeProviderTestButtonProps) {
  const capabilities = getOpenCodeProviderCapabilities(profile);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setSelected(new Set(capabilities.map((capability) => capability.id)));
    }
    setOpen(next);
  };

  const toggleProvider = (providerId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((current) => (
      current.size === capabilities.length
        ? new Set()
        : new Set(capabilities.map((capability) => capability.id))
    ));
  };

  const runTest = (providers: string[] | null) => {
    setOpen(false);
    onTest(providers);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(buttonVariants[variant], className)}
          disabled={disabled || isTesting}
        >
          {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {isTesting ? 'Testing' : 'Test providers'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-80 p-0" disableAnimation>
        <div className="border-b border-[hsl(var(--app-border)/0.62)] px-4 py-3">
          <div className="text-[13px] font-semibold text-foreground">Test providers</div>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
            Run a live model call on each selected provider to confirm it works.
          </p>
        </div>
        {capabilities.length === 0 ? (
          <div className="px-4 py-4">
            <p className="text-[12px] leading-5 text-muted-foreground">
              No provider data yet. Test all connected providers to probe them.
            </p>
          </div>
        ) : (
          <div className="max-h-64 overflow-auto py-1">
            <div className="flex items-center gap-2 px-4 py-2">
              <Checkbox
                id="opencode-test-providers-all"
                indicatorMode="check"
                aria-label="Select all providers"
                checked={selected.size === capabilities.length}
                onCheckedChange={toggleAll}
              />
              <label htmlFor="opencode-test-providers-all" className="text-[12px] font-semibold text-foreground">
                Select all
              </label>
            </div>
            {capabilities.map((capability) => {
              const meta = accessMeta[capability.access] ?? accessMeta.unconfirmed;
              return (
                <label
                  key={capability.id}
                  className="flex cursor-pointer items-center gap-2 px-4 py-2 hover:bg-muted/40"
                >
                  <Checkbox
                    indicatorMode="check"
                    aria-label={capability.name}
                    checked={selected.has(capability.id)}
                    onCheckedChange={() => toggleProvider(capability.id)}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                    {capability.name}
                  </span>
                  <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold', meta.className)}>
                    {meta.label}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-[hsl(var(--app-border)/0.62)] px-4 py-3">
          <Button
            type="button"
            size="sm"
            disabled={capabilities.length > 0 && selected.size === 0}
            onClick={() => runTest(selected.size === 0 ? null : Array.from(selected))}
          >
            {capabilities.length === 0 || selected.size === 0
              ? 'Test all'
              : selected.size === capabilities.length
                ? `Test all (${capabilities.length})`
                : `Test selected (${selected.size})`}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
