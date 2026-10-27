export interface AgentRunAutoCheckoutInput {
  nodeId: string;
  workspaceId: string | null;
  repoPath: string | null;
  terminalStatus: string | null;
  outputCommitSha: string | null;
  executionData: Record<string, unknown> | null | undefined;
}

export type AgentRunAutoCheckoutOutcome =
  | { kind: 'ignored'; reason: 'not-requested' | 'duplicate' }
  | { kind: 'skipped'; reason: 'run-not-completed' | 'no-commit' | 'missing-repo'; message: string }
  | { kind: 'checked-out'; commitSha: string }
  | { kind: 'failed'; error: unknown };

export interface AgentRunAutoCheckoutDependencies {
  checkoutCommit: (repoPath: string, commitSha: string) => Promise<string>;
  onCheckedOut?: (input: AgentRunAutoCheckoutInput, checkedOutCommit: string) => void;
  onSkipped?: (input: AgentRunAutoCheckoutInput, outcome: Extract<AgentRunAutoCheckoutOutcome, { kind: 'skipped' }>) => void;
  onFailed?: (input: AgentRunAutoCheckoutInput, error: unknown) => void;
}

const cleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const MAX_HANDLED_AUTO_CHECKOUT_RUNS = 512;

export const isAgentRunAutoCheckoutRequested = (
  executionData: Record<string, unknown> | null | undefined,
): boolean => {
  if (!executionData) return false;
  if (executionData.auto_checkout_requested === true) return true;
  const meta = executionData.meta;
  return Boolean(meta && typeof meta === 'object' && (meta as Record<string, unknown>).auto_checkout_requested === true);
};

/**
 * Owns post-finalize auto-checkout independently of whichever composer launched
 * the run. Git mutations are serialized so concurrently finishing agents never
 * run checkout commands at the same time.
 */
export const createAgentRunAutoCheckoutCoordinator = (
  dependencies: AgentRunAutoCheckoutDependencies,
) => {
  const handledNodeIds = new Set<string>();
  const handledNodeOrder: string[] = [];
  let checkoutTail: Promise<void> = Promise.resolve();

  const markHandled = (nodeId: string) => {
    handledNodeIds.add(nodeId);
    handledNodeOrder.push(nodeId);
    while (handledNodeOrder.length > MAX_HANDLED_AUTO_CHECKOUT_RUNS) {
      const oldestNodeId = handledNodeOrder.shift();
      if (oldestNodeId) handledNodeIds.delete(oldestNodeId);
    }
  };

  const handleFinalizedRun = async (
    input: AgentRunAutoCheckoutInput,
  ): Promise<AgentRunAutoCheckoutOutcome> => {
    if (!isAgentRunAutoCheckoutRequested(input.executionData)) {
      return { kind: 'ignored', reason: 'not-requested' };
    }
    if (handledNodeIds.has(input.nodeId)) {
      return { kind: 'ignored', reason: 'duplicate' };
    }
    markHandled(input.nodeId);

    const terminalStatus = cleanString(input.terminalStatus);
    if (terminalStatus !== 'completed') {
      const outcome = {
        kind: 'skipped' as const,
        reason: 'run-not-completed' as const,
        message: `The agent ended with status "${terminalStatus ?? 'unknown'}", so there was no completed commit to check out.`,
      };
      dependencies.onSkipped?.(input, outcome);
      return outcome;
    }

    const outputCommitSha = cleanString(input.outputCommitSha);
    if (!outputCommitSha) {
      const outcome = {
        kind: 'skipped' as const,
        reason: 'no-commit' as const,
        message: 'The agent finished without creating a commit to check out.',
      };
      dependencies.onSkipped?.(input, outcome);
      return outcome;
    }
    const repoPath = cleanString(input.repoPath);
    if (!repoPath) {
      const outcome = {
        kind: 'skipped' as const,
        reason: 'missing-repo' as const,
        message: 'The workspace repository is unavailable, so Agentree could not check out the generated commit.',
      };
      dependencies.onSkipped?.(input, outcome);
      return outcome;
    }

    const checkout = checkoutTail.then(async () => {
      try {
        const checkedOutCommit = await dependencies.checkoutCommit(repoPath, outputCommitSha);
        dependencies.onCheckedOut?.(input, checkedOutCommit);
        return { kind: 'checked-out' as const, commitSha: checkedOutCommit };
      } catch (error) {
        dependencies.onFailed?.(input, error);
        return { kind: 'failed' as const, error };
      }
    });
    checkoutTail = checkout.then(() => undefined, () => undefined);
    return checkout;
  };

  return {
    handleFinalizedRun,
    clearHandledRuns: () => {
      handledNodeIds.clear();
      handledNodeOrder.length = 0;
    },
  };
};
