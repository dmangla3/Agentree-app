import { useState } from 'react';
import { AlertTriangle, ChevronDown, RefreshCw, WifiOff } from 'lucide-react';
import { cn } from '../lib/utils';
import { presentTimelineError } from '../lib/errorPresentation';

export function TimelineErrorNotice({
  error,
  compact = false,
  showIcon = true,
}: {
  error: unknown;
  compact?: boolean;
  showIcon?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const presentation = presentTimelineError(error);
  const hasDetails = Boolean(presentation.technicalDetails);
  const Icon = presentation.isRetrying ? WifiOff : AlertTriangle;

  return (
    <div
      role={presentation.isRetrying ? 'status' : 'alert'}
      className={cn(
        'min-w-0 max-w-full overflow-hidden border shadow-[0_10px_24px_-22px_hsl(var(--foreground)/0.5)]',
        presentation.isRetrying
          ? 'border-amber-200/80 bg-amber-50/75 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/25 dark:text-amber-100'
          : 'border-red-200/80 bg-red-50/70 text-red-950 dark:border-red-900/70 dark:bg-red-950/25 dark:text-red-100',
        compact ? 'rounded-lg' : 'rounded-xl',
      )}
    >
      <div className={cn('flex min-w-0 items-start gap-2.5', compact ? 'px-2.5 py-2' : 'px-3 py-2.5')}>
        {showIcon ? (
          <div
            className={cn(
              'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg',
              presentation.isRetrying
                ? 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
                : 'bg-red-500/12 text-red-700 dark:text-red-300',
            )}
          >
            <Icon size={13} />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold">{presentation.title}</span>
            {presentation.isRetrying ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.04em] text-amber-800 tabular-nums dark:text-amber-200">
                <RefreshCw size={9} className="animate-spin" />
                {presentation.retryAttempt !== null && presentation.retryLimit !== null
                  ? `Retrying ${presentation.retryAttempt} of ${presentation.retryLimit}`
                  : 'Retrying'}
              </span>
            ) : null}
            {presentation.httpStatus !== null ? (
              <span className="rounded-full bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[9px] font-medium tabular-nums">
                HTTP {presentation.httpStatus}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed opacity-80 [text-wrap:pretty]">
            {presentation.message}
          </p>
        </div>
      </div>

      {hasDetails ? (
        <div className="border-t border-black/10 dark:border-white/10">
          <button
            type="button"
            className="flex min-h-10 w-full items-center justify-between gap-3 px-3 text-left text-[10px] font-medium opacity-[0.65] transition-[background-color,opacity] duration-150 hover:bg-foreground/[0.04] hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              setShowDetails((current) => !current);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            aria-expanded={showDetails}
          >
            <span>Technical details</span>
            <ChevronDown
              size={12}
              className={cn('transition-transform duration-150', showDetails && 'rotate-180')}
            />
          </button>
          {showDetails ? (
            <div className="px-3 pb-3">
              {presentation.errorCode ? (
                <div className="mb-2 flex min-w-0 items-baseline gap-2 text-[10px]">
                  <span className="shrink-0 font-medium opacity-[0.55]">Code</span>
                  <code className="min-w-0 break-all opacity-75">{presentation.errorCode}</code>
                </div>
              ) : null}
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/[0.06] p-2 font-mono text-[9px] leading-relaxed opacity-70 dark:bg-white/[0.06]">
                {presentation.technicalDetails}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
