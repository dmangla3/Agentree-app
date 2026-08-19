import type { FlowDefinition, FlowNodeTemplate, FlowValidationIssue } from './types';
import { validateFlowDefinition, type FlowValidationResult } from './validateFlow';

export interface FlowNodeDefinition {
  id: string;
  label: string;
  params: string[];
  parent: string;
  returns?: FlowNodeTemplate['returns'];
  prompt: string;
  requiresFinalizedCommit?: boolean;
}

type MutableFlowDefinition = {
  nodes?: unknown;
  [key: string]: unknown;
};

type ReusableFlowNodeReference = {
  use: string;
  as: string;
  parent?: string;
};

export const FLOW_NODE_REGISTRY: Record<string, FlowNodeDefinition> = {
  'core.implementer@1': {
    id: 'core.implementer@1',
    label: 'Implementer',
    params: ['request'],
    parent: 'root',
    requiresFinalizedCommit: true,
    prompt: `Please implement:
{{ request }}`,
  },
  'core.synthesizer@1': {
    id: 'core.synthesizer@1',
    label: 'Synthesizer',
    params: ['request', 'candidate_commits'],
    parent: 'root',
    requiresFinalizedCommit: true,
    prompt: `Compare these candidate implementation commits for the request.
Produce one finalized implementation commit. You may use one candidate unchanged when it is already the best answer, or create a synthesized implementation that keeps the strongest candidate's strengths and applies useful ideas, fixes, or tradeoffs from the other candidate commits when they improve the result.
Do not copy weaker or conflicting changes just because they are present.

Request:
{{ request }}

Candidate commits:
{{ candidate_commits }}

Finish by producing a commit. Do not end with structured flow returns.`,
  },
  'core.reviewer@1': {
    id: 'core.reviewer@1',
    label: 'Reviewer',
    params: ['request', 'commit', 'latest_fix_commit', 'criteria'],
    parent: 'root',
    returns: {
      verdict: ['pass', 'fail'],
    },
    prompt: `Review this implementation against the original request.

Original request:
{{ request }}

Implementation commit:
{{ commit }}

Latest fix commit, if any:
{{ latest_fix_commit }}

Review criteria:
{{ criteria }}

Provide feedback normally.
End with:

verdict: pass | fail`,
  },
  'core.fixer@1': {
    id: 'core.fixer@1',
    label: 'Fixer',
    params: ['review'],
    parent: 'root',
    requiresFinalizedCommit: true,
    prompt: `Please check this feedback on your implementation.
You inherit implementation context from your parent.

Feedback:
{{ review }}

If you disagree with any feedback, explain why.
Otherwise implement the fix.`,
  },
};

export function compileFlowDefinition(input: unknown): FlowValidationResult {
  const resolved = resolveFlowNodeReferences(input);
  if (resolved.issues.length > 0) {
    return { definition: null, issues: resolved.issues };
  }
  return validateFlowDefinition(resolved.definition);
}

export function resolveFlowNodeReferences(input: unknown): { definition: unknown; issues: FlowValidationIssue[] } {
  if (!isRecord(input)) {
    return { definition: input, issues: [] };
  }

  const candidate = input as MutableFlowDefinition;
  if (!Array.isArray(candidate.nodes)) {
    return { definition: input, issues: [] };
  }

  const issues: FlowValidationIssue[] = [];
  const nodes = candidate.nodes.map((node, index) => {
    if (!isReusableNodeReference(node)) {
      return node;
    }

    const definition = FLOW_NODE_REGISTRY[node.use];
    if (!definition) {
      issues.push({
        path: `nodes.${index}.use`,
        message: `Reusable node "${node.use}" is not registered.`,
      });
      return node;
    }

    return toFlowNodeTemplate(node, definition);
  });

  if (issues.length > 0) {
    return { definition: null, issues };
  }

  return {
    definition: {
      ...candidate,
      nodes,
    } satisfies FlowDefinition | MutableFlowDefinition,
    issues,
  };
}

function toFlowNodeTemplate(
  reference: ReusableFlowNodeReference,
  definition: FlowNodeDefinition
): FlowNodeTemplate {
  return {
    id: reference.as,
    registryId: definition.id,
    label: definition.label,
    params: definition.params,
    parent: reference.parent ?? definition.parent,
    ...(definition.returns ? { returns: definition.returns } : {}),
    prompt: definition.prompt,
    requiresFinalizedCommit: definition.requiresFinalizedCommit ?? false,
  };
}

function isReusableNodeReference(value: unknown): value is ReusableFlowNodeReference {
  return isRecord(value) &&
    typeof value.use === 'string' &&
    typeof value.as === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
