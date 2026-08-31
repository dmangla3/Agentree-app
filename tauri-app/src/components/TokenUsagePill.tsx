import { Sigma, Sparkles, Zap } from 'lucide-react';

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
    <div className="inline-flex min-w-0 max-w-full flex-wrap items-center overflow-hidden rounded-lg border border-border/50 bg-muted/30 dark:bg-slate-800/50">
      {formatTokenValue(promptTokens) ? (
        <span
          className="inline-flex items-center gap-1 border-r border-border/30 px-2 py-0.5 text-[10px] font-medium text-emerald-600 last:border-r-0 dark:text-emerald-400"
          title={typeof promptTokens === 'number' ? `${promptTokens.toLocaleString()} input tokens sent as context for this response.` : undefined}
        >
          <Zap size={9} strokeWidth={2.5} className="text-emerald-500 dark:text-emerald-400" />
          {formatTokenValue(promptTokens)}
        </span>
      ) : null}
      {formatTokenValue(completionTokens) ? (
        <span
          className="inline-flex items-center gap-1 border-r border-border/30 px-2 py-0.5 text-[10px] font-medium text-blue-600 last:border-r-0 dark:text-blue-400"
          title={typeof completionTokens === 'number' ? `${completionTokens.toLocaleString()} output tokens generated in this response.` : undefined}
        >
          <Zap size={9} strokeWidth={2.5} className="text-blue-500 dark:text-blue-400" />
          {formatTokenValue(completionTokens)}
        </span>
      ) : null}
      {formatTokenValue(cachedInputTokens) ? (
        <span
          className="inline-flex items-center gap-1 border-r border-border/30 px-2 py-0.5 text-[10px] font-medium text-cyan-600 last:border-r-0 dark:text-cyan-400"
          title={typeof cachedInputTokens === 'number' ? `${cachedInputTokens.toLocaleString()} cached input tokens reused from prior context.` : undefined}
        >
          <Sigma size={9} strokeWidth={2.5} className="text-cyan-500 dark:text-cyan-400" />
          {formatTokenValue(cachedInputTokens)}
        </span>
      ) : null}
      {formatTokenValue(reasoningTokens) ? (
        <span
          className="inline-flex items-center gap-1 border-r border-border/30 px-2 py-0.5 text-[10px] font-medium text-violet-600 last:border-r-0 dark:text-violet-400"
          title={typeof reasoningTokens === 'number' ? `${reasoningTokens.toLocaleString()} internal reasoning tokens used by the model.` : undefined}
        >
          <Sparkles size={9} strokeWidth={2.5} className="text-violet-500 dark:text-violet-400" />
          {formatTokenValue(reasoningTokens)}
        </span>
      ) : null}
      {formatTokenValue(totalTokens) ? (
        <span
          className="inline-flex items-center gap-1 bg-amber-50/50 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:bg-amber-950/20 dark:text-amber-400"
          title={typeof totalTokens === 'number' ? `${totalTokens.toLocaleString()} total input, output, cached, and reasoning tokens reported for this response.` : undefined}
        >
          <Sigma size={9} strokeWidth={2.5} className="text-amber-500 dark:text-amber-400" />
          {formatTokenValue(totalTokens)}
        </span>
      ) : null}
    </div>
  );
}
