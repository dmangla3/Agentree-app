import { useMemo, useState, type ReactNode } from 'react';
import { Loader2, Minus, Play, Plus } from 'lucide-react';
import type { FlowExecutionEvent } from '../../flows/flowExecutor';
import { cn } from '../../lib/utils';

export interface ComposerFlowOption {
  id: string;
  label: string;
}

export interface ComposerFlowTabProps {
  flows: ComposerFlowOption[];
  selectedFlowId: string;
  onSelectFlow: (flowId: string) => void;
  prompt: string;
  workspaceId: string | null;
  selectedAgentId: string | null;
  isRunning: boolean;
  events: FlowExecutionEvent[];
  modelSelector?: ReactNode;
  onRunFlow: (input: { input: string; count: number }) => void | Promise<void>;
}

const MIN_COUNT = 1;
const MAX_COUNT = 5;

export function ComposerFlowTab({
  flows,
  selectedFlowId,
  onSelectFlow,
  prompt,
  workspaceId,
  selectedAgentId,
  isRunning,
  events,
  modelSelector,
  onRunFlow,
}: ComposerFlowTabProps) {
  const [count, setCount] = useState(3);
  const selectedFlow = useMemo(
    () => flows.find((flow) => flow.id === selectedFlowId) ?? flows[0] ?? null,
    [flows, selectedFlowId]
  );
  const trimmedPrompt = prompt.trim();
  const disabledReason = !trimmedPrompt
    ? 'Add a prompt before running a flow.'
    : !workspaceId
      ? 'Select a workspace before running a flow.'
      : !selectedAgentId
        ? 'Select a model before running a flow.'
        : null;
  const canRun = !disabledReason && !isRunning && Boolean(selectedFlow);
  const latestEvent = events[events.length - 1] ?? null;

  const updateCount = (nextCount: number) => {
    setCount(clampCount(nextCount));
  };

  return (
    <div className="flex flex-col gap-2 border-t border-[hsl(var(--app-border)/0.45)] bg-background/35 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-[min(100%,17rem)] flex-1 flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Flow</span>
          <select
            value={selectedFlowId}
            onChange={(event) => onSelectFlow(event.target.value)}
            className="h-8 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel-strong))] px-2 text-xs font-semibold text-foreground shadow-[0_1px_2px_rgba(22,26,32,0.05)] outline-none transition-[border-color,box-shadow] duration-150 focus:border-[hsl(var(--app-border-strong))] focus:ring-2 focus:ring-[hsl(var(--app-focus)/0.18)]"
          >
            {flows.map((flow) => (
              <option key={flow.id} value={flow.id}>
                {flow.label}
              </option>
            ))}
          </select>
        </label>

        {modelSelector ? (
          <div className="flex min-w-[min(100%,12rem)] flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Model</span>
            {modelSelector}
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <label htmlFor="flow-parallel-count" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Parallel count
          </label>
          <div className="flex h-8 items-center rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel-strong))] shadow-[0_1px_2px_rgba(22,26,32,0.05)]">
            <button
              type="button"
              aria-label="Decrease flow count"
              onClick={() => updateCount(count - 1)}
              className="flex h-8 w-8 items-center justify-center text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40"
              disabled={count <= MIN_COUNT || isRunning}
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <input
              id="flow-parallel-count"
              aria-label="Parallel count"
              type="number"
              min={MIN_COUNT}
              max={MAX_COUNT}
              value={count}
              disabled={isRunning}
              onChange={(event) => updateCount(Number(event.target.value))}
              className="h-8 w-10 border-x border-[hsl(var(--app-border)/0.7)] bg-transparent text-center text-xs font-semibold tabular-nums text-foreground outline-none disabled:opacity-50"
            />
            <button
              type="button"
              aria-label="Increase flow count"
              onClick={() => updateCount(count + 1)}
              className="flex h-8 w-8 items-center justify-center text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40"
              disabled={count >= MAX_COUNT || isRunning}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <button
          type="button"
          className={cn(
            "mt-auto flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-[background-color,box-shadow,filter,transform,opacity] duration-150 active:scale-[0.96]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-1",
            canRun
              ? "bg-[hsl(var(--app-accent))] text-white shadow-[0_14px_30px_-20px_hsl(var(--app-accent)/0.75)] hover:brightness-105"
              : "bg-muted text-muted-foreground opacity-60"
          )}
          disabled={!canRun}
          onClick={() => {
            if (canRun) {
              void onRunFlow({ input: trimmedPrompt, count });
            }
          }}
        >
          {isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run Flow
        </button>
      </div>

      <div className="flex min-h-5 items-center justify-between gap-3 text-[11px] leading-5 text-muted-foreground">
        <span className="truncate">
          {selectedFlow?.label ? `${selectedFlow.label} runs implementation variants, selects one, then reviews until pass.` : 'No flow selected.'}
        </span>
        <span className="shrink-0 tabular-nums">
          {isRunning ? 'Running' : disabledReason ?? latestEvent?.message ?? 'Ready'}
        </span>
      </div>

      {events.length > 0 ? (
        <div className="max-h-20 overflow-y-auto border-t border-[hsl(var(--app-border)/0.45)] pt-1 text-[11px] leading-5 text-muted-foreground">
          {events.slice(-4).map((event, index) => (
            <div key={`${event.type}-${event.nodeId ?? event.templateId ?? index}-${index}`} className="flex min-w-0 items-center gap-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--app-accent)/0.75)]" />
              <span className="truncate">{event.message}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function clampCount(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_COUNT;
  }
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.trunc(value)));
}
