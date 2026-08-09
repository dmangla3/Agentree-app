export type ComposerAgentRunCounts = Record<string, number>;

export type ComposerAgentOption = {
  id: string;
  name?: string | null;
};

export type ComposerAgentRun = {
  agentId: string;
  agentName: string;
  ordinal: number;
  totalForAgent: number;
};

export type ComposerAgentTurnTopology<T extends ComposerAgentRun = ComposerAgentRun> = T & {
  turnIndex: number;
  userParentId: string | null;
};

const clampCount = (count: number) => {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(12, Math.trunc(count)));
};

export const normalizeComposerAgentRunCounts = (
  agents: ComposerAgentOption[],
  selectedAgentId: string | null,
  counts: ComposerAgentRunCounts
): ComposerAgentRunCounts => {
  const availableIds = new Set(agents.map((agent) => agent.id));
  const normalized: ComposerAgentRunCounts = {};

  for (const [agentId, rawCount] of Object.entries(counts)) {
    if (!availableIds.has(agentId)) continue;
    const count = clampCount(rawCount);
    if (count > 0) {
      normalized[agentId] = count;
    }
  }

  if (Object.keys(normalized).length === 0 && selectedAgentId && availableIds.has(selectedAgentId)) {
    normalized[selectedAgentId] = 1;
  }

  return normalized;
};

export const updateComposerAgentRunCount = (
  current: ComposerAgentRunCounts,
  agentId: string,
  nextCount: number
): ComposerAgentRunCounts => {
  const normalizedNextCount = clampCount(nextCount);
  const next = { ...current };

  if (normalizedNextCount > 0) {
    next[agentId] = normalizedNextCount;
    return next;
  }

  const selectedRunCount = Object.values(current).filter((count) => clampCount(count) > 0).length;
  if (selectedRunCount <= 1 && clampCount(current[agentId] ?? 0) > 0) {
    return current;
  }

  delete next[agentId];
  return next;
};

export const buildComposerAgentRuns = (
  agents: ComposerAgentOption[],
  counts: ComposerAgentRunCounts
): ComposerAgentRun[] => {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const runs: ComposerAgentRun[] = [];

  for (const agent of agents) {
    const count = clampCount(counts[agent.id] ?? 0);
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      runs.push({
        agentId: agent.id,
        agentName: agentById.get(agent.id)?.name || agent.id,
        ordinal,
        totalForAgent: count,
      });
    }
  }

  return runs;
};

export const buildComposerAgentTurnTopology = <T extends ComposerAgentRun>(
  runs: T[],
  parentId: string | null
): ComposerAgentTurnTopology<T>[] => (
  runs.map((run, turnIndex) => ({
    ...run,
    turnIndex,
    userParentId: parentId,
  }))
);
