import { useEffect } from 'react';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { ensureAgentRunHydrated } from '../agent-runs/agentRunHydration';

export function useAgentRunHoverHydration(nodeId: string | null | undefined, enabled = true) {
  useEffect(() => {
    if (!nodeId || !enabled) return;
    agentRunManager.watch(nodeId, 'hover');
    void ensureAgentRunHydrated(nodeId, 'hover');
    return () => {
      agentRunManager.unwatch(nodeId, 'hover');
    };
  }, [enabled, nodeId]);
}
