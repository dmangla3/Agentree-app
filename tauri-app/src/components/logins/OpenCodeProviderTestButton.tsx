import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../../../@/components/ui/button';
import { Checkbox } from '../../../@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '../../../@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../@/components/ui/tooltip';
import {
  getOpenCodeProviderCapabilities,
  type LoginProfileSummary,
  type OpenCodeProviderCapability,
} from '../../lib/loginProfiles';
import { cn } from '../../lib/utils';

const successClassName = 'bg-emerald-600/[0.08] text-emerald-700 dark:text-emerald-400';
const warningClassName = 'bg-amber-600/[0.08] text-amber-700 dark:text-amber-400';
const dangerClassName = 'bg-destructive/[0.07] text-destructive';

const getAccessPresentation = (capability: OpenCodeProviderCapability) => {
  if (capability.access === 'full') {
    return {
      label: 'Paid models available',
      description: `${capability.name} accepted the credentials and reports that paid model access is available.`,
      className: successClassName,
    };
  }
  if (capability.access === 'free_only') {
    const freeModels = capability.freeModelCount === 1 ? '1 free model remains' : `${capability.freeModelCount} free models remain`;
    return {
      label: 'Free models only',
      description: `${capability.name} accepted the credentials, but paid model access is unavailable. ${freeModels} available.`,
      className: warningClassName,
    };
  }
  if (capability.access === 'unavailable') {
    return {
      label: 'No usable models',
      description: `${capability.name} accepted the credentials, but paid model access is unavailable and no free models are available.`,
      className: dangerClassName,
    };
  }
  if (capability.access === 'invalid') {
    return {
      label: 'Credentials rejected',
      description: `${capability.name} rejected these credentials. Reconnect the provider, then test it again.`,
      className: dangerClassName,
    };
  }
  if (capability.authStatus === 'valid') {
    return {
      label: 'Paid access unverified',
      description: `${capability.name} accepted the credentials, but the test could not confirm paid model access. Try again.`,
      className: warningClassName,
    };
  }
  return {
    label: 'Test inconclusive',
    description: `The test could not confirm whether ${capability.name} credentials or models work. Try again; if this repeats, reconnect the provider.`,
    className: 'bg-muted/65 text-muted-foreground',
  };
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
          className={cn('h-10 rounded-lg', buttonVariants[variant], className)}
          disabled={disabled || isTesting}
        >
          {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {isTesting ? 'Testing' : 'Test providers'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-80 p-0" disableAnimation>
        <div className="border-b border-[hsl(var(--app-border)/0.62)] px-4 py-3">
          <div className="text-[13px] font-semibold text-foreground">Test providers</div>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
            Check credentials and model access for each selected provider.
          </p>
        </div>
        {capabilities.length === 0 ? (
          <div className="px-4 py-4">
            <p className="text-[12px] leading-5 text-muted-foreground">
              No provider data yet. Test all connected providers to probe them.
            </p>
          </div>
        ) : (
          <div className="max-h-64 divide-y divide-border/55 overflow-auto">
            <div className="flex min-h-10 items-center gap-2 bg-muted/25 px-4 py-2">
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
              const presentation = getAccessPresentation(capability);
              return (
                <div
                  key={capability.id}
                  className="flex min-h-10 items-center gap-2 px-4 py-2 transition-[background-color] duration-150 ease-out hover:bg-muted/40"
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch">
                    <Checkbox
                      indicatorMode="check"
                      aria-label={capability.name}
                      checked={selected.has(capability.id)}
                      onCheckedChange={() => toggleProvider(capability.id)}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                      {capability.name}
                    </span>
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={0}
                        className="flex min-h-10 shrink-0 cursor-help items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                        aria-label={`${capability.name}: ${presentation.label}`}
                      >
                        <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold', presentation.className)}>
                          {presentation.label}
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="end" className="max-w-72 text-pretty leading-5">
                      {presentation.description}
                    </TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-[hsl(var(--app-border)/0.62)] px-4 py-3">
          <Button
            type="button"
            size="sm"
            className="h-10 rounded-lg"
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
