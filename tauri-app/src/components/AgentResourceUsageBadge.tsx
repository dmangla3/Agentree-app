import { Activity } from 'lucide-react';
import { useAgentResourceUsage } from '../hooks/useAgentResourceUsage';

export const formatResourceMemory = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mebibytes = bytes / (1024 * 1024);
  if (mebibytes < 1024) return `${Math.round(mebibytes)} MB`;
  return `${(mebibytes / 1024).toFixed(mebibytes < 10 * 1024 ? 1 : 0)} GB`;
};

export function AgentResourceUsageBadge({
  assistantNodeId,
  enabled,
}: {
  assistantNodeId: string;
  enabled: boolean;
}) {
  const usage = useAgentResourceUsage(assistantNodeId, enabled);
  if (!enabled || !usage || usage.processCount === 0) return null;

  const cpu = usage.cpuPercent > 0 && usage.cpuPercent < 1
    ? '<1%'
    : `${Math.round(usage.cpuPercent)}%`;
  const processes = `${usage.processCount} ${usage.processCount === 1 ? 'process' : 'processes'}`;

  return (
    <div
      className="mb-2 flex w-fit items-center gap-1.5 rounded-md border border-[hsl(var(--app-border)/0.64)] bg-[hsl(var(--app-bg-muted)/0.56)] px-2.5 py-1 text-[11px] font-medium tabular-nums text-muted-foreground"
      title="Current CPU and memory used by this agent's full process tree. Informational only; Agentree does not throttle it."
      data-agent-resource-usage={assistantNodeId}
    >
      <Activity className="h-3 w-3" aria-hidden="true" />
      <span>CPU {cpu}</span>
      <span aria-hidden="true">·</span>
      <span>{formatResourceMemory(usage.memoryBytes)}</span>
      <span aria-hidden="true">·</span>
      <span>{processes}</span>
    </div>
  );
}
