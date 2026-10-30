import { ArrowDownToLine, ArrowUpFromLine, BrainCircuit, Database, Sigma } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../@/components/ui/tooltip';

export const formatTokenValue = (value: number | null | undefined): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toLocaleString();
};

export interface TokenUsagePillProps {
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
}

export function TokenUsagePill({
  promptTokens,
  completionTokens,
  cachedInputTokens,
  reasoningTokens,
  totalTokens,
}: TokenUsagePillProps) {
  if (
    !formatTokenValue(promptTokens)
    && !formatTokenValue(completionTokens)
    && !formatTokenValue(cachedInputTokens)
    && !formatTokenValue(reasoningTokens)
    && !formatTokenValue(totalTokens)
  ) {
    return null;
  }

  return (
    <div
      data-design-part="token-usage"
      aria-label="Token usage"
      className="inline-flex min-w-0 max-w-full flex-nowrap items-center overflow-x-auto rounded-md border border-[hsl(var(--app-border)/0.44)] bg-[hsl(var(--app-bg-muted)/0.68)] p-0.5 text-muted-foreground/72 tabular-nums [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {formatTokenValue(promptTokens) ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              aria-label={`${promptTokens?.toLocaleString()} input tokens`}
              className="inline-flex h-4 items-center gap-1 rounded-sm border-r border-[hsl(var(--app-border)/0.34)] px-1.5 text-[10px] font-normal outline-none last:border-r-0 focus-visible:bg-[hsl(var(--app-focus)/0.12)] focus-visible:text-foreground"
            >
              <ArrowDownToLine size={9} strokeWidth={1.8} className="text-muted-foreground/58" />
              {formatTokenValue(promptTokens)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">Input tokens: {promptTokens?.toLocaleString()} sent as context for this response.</TooltipContent>
        </Tooltip>
      ) : null}
      {formatTokenValue(completionTokens) ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              aria-label={`${completionTokens?.toLocaleString()} output tokens`}
              className="inline-flex h-4 items-center gap-1 rounded-sm border-r border-[hsl(var(--app-border)/0.34)] px-1.5 text-[10px] font-normal outline-none last:border-r-0 focus-visible:bg-[hsl(var(--app-focus)/0.12)] focus-visible:text-foreground"
            >
              <ArrowUpFromLine size={9} strokeWidth={1.8} className="text-muted-foreground/58" />
              {formatTokenValue(completionTokens)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">Output tokens: {completionTokens?.toLocaleString()} generated in this response.</TooltipContent>
        </Tooltip>
      ) : null}
      {formatTokenValue(cachedInputTokens) ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              aria-label={`${cachedInputTokens?.toLocaleString()} cached input tokens`}
              className="inline-flex h-4 items-center gap-1 rounded-sm border-r border-[hsl(var(--app-border)/0.34)] px-1.5 text-[10px] font-normal outline-none last:border-r-0 focus-visible:bg-[hsl(var(--app-focus)/0.12)] focus-visible:text-foreground"
            >
              <Database size={9} strokeWidth={1.8} className="text-muted-foreground/58" />
              {formatTokenValue(cachedInputTokens)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">Cached input: {cachedInputTokens?.toLocaleString()} tokens reused from prior context.</TooltipContent>
        </Tooltip>
      ) : null}
      {formatTokenValue(reasoningTokens) ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              aria-label={`${reasoningTokens?.toLocaleString()} reasoning tokens`}
              className="inline-flex h-4 items-center gap-1 rounded-sm border-r border-[hsl(var(--app-border)/0.34)] px-1.5 text-[10px] font-normal outline-none last:border-r-0 focus-visible:bg-[hsl(var(--app-focus)/0.12)] focus-visible:text-foreground"
            >
              <BrainCircuit size={9} strokeWidth={1.8} className="text-muted-foreground/58" />
              {formatTokenValue(reasoningTokens)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">Reasoning tokens: {reasoningTokens?.toLocaleString()} used internally by the model.</TooltipContent>
        </Tooltip>
      ) : null}
      {formatTokenValue(totalTokens) ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              aria-label={`${totalTokens?.toLocaleString()} total tokens`}
              className="inline-flex h-4 items-center gap-1 rounded-sm bg-[hsl(var(--foreground)/0.055)] px-1.5 text-[10px] font-medium text-foreground/72 outline-none focus-visible:bg-[hsl(var(--app-focus)/0.16)] focus-visible:text-foreground"
            >
              <Sigma size={9} strokeWidth={1.8} className="text-muted-foreground/66" />
              {formatTokenValue(totalTokens)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">Total usage: {totalTokens?.toLocaleString()} tokens reported for this response.</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
