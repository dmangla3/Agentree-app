import type { FlowDefinition, FlowNodeTemplate, FlowValidationIssue } from './types';
import { validateFlowDefinition, type FlowValidationResult } from './validateFlow';

export interface FlowNodeDefinition {
  id: string;
  label: string;
  params: Record<string, string>;
  parent: string;
  returns?: FlowNodeTemplate['returns'];
  prompt: string;
  requiresFinalizedCommit?: boolean;
}

export type FlowNodeRegistry = Record<string, FlowNodeDefinition>;

type MutableFlowDefinition = {
  nodes?: unknown;
  [key: string]: unknown;
};

type ReusableFlowNodeReference = {
  use: string;
  as: string;
  parent?: string;
};

export const FLOW_NODE_REGISTRY: FlowNodeRegistry = {
  'core.implementer@1': {
    id: 'core.implementer@1',
    label: 'Implementer',
    params: { request: 'string' },
    parent: 'root',
    requiresFinalizedCommit: true,
    prompt: `Please implement:
{{ request }}`,
  },
  'core.synthesizer@1': {
    id: 'core.synthesizer@1',
    label: 'Synthesizer',
    params: { request: 'string', candidate_commits: 'commit[]' },
    parent: 'root',
    requiresFinalizedCommit: true,
    prompt: `Compare these candidate commits for the request.
Create or update the file-backed artifact that best satisfies the request. The candidate commits may represent implementation work, plans, documentation, tests, analysis, or another requested artifact. Infer the intended artifact from the original request and preserve that intent.
Do not convert a planning, documentation, testing, or analysis task into implementation work unless the request explicitly asks for implementation.
You may use one candidate unchanged when it is already the best answer, or create a synthesized result that keeps the strongest candidate's strengths and applies useful ideas, fixes, risks, sequencing, validation details, or tradeoffs from the other candidate commits when they improve the result.
Do not copy weaker, duplicated, vague, or conflicting changes just because they are present.

Request:
{{ request }}

Candidate commits:
{{ candidate_commits }}

Finish by making the artifact changes in files. Agentree will record the finalized commit automatically. Do not end with structured flow returns.`,
  },
  'core.reviewer@1': {
    id: 'core.reviewer@1',
    label: 'Reviewer',
    params: { request: 'string', commit: 'commit', latest_fix_commit: 'commit', criteria: 'string' },
    parent: 'root',
    returns: {
      verdict: ['pass', 'fail'],
    },
    prompt: `Review this committed artifact against the original request.
The artifact may be implementation work, a plan, documentation, tests, analysis, or another requested output. Infer the intended artifact from the request and review criteria.
Do not convert a planning, documentation, testing, or analysis task into implementation expectations unless the request explicitly asks for implementation.

Original request:
{{ request }}

Artifact commit:
{{ commit }}

Latest fix commit, if any:
{{ latest_fix_commit }}

Review criteria:
{{ criteria }}

Provide feedback normally.
End with:

verdict: pass | fail`,
  },
  // Later, if handoff needs to drive automated flow branching, add declared returns
  // such as needs_input: ['yes', 'no'] and recommended_action: ['implement', 'test', 'accept', 'revise'].
  // Keep v1 prose-only so it stays useful as a low-friction user checkpoint in any flow phase.
  'core.handoff@1': {
    id: 'core.handoff@1',
    label: 'Handoff',
    params: {
      request: 'string',
      phase: 'string',
      source_nodes: 'agent | agent[]',
      review: 'agent | string',
      focus: 'string',
    },
    parent: 'root',
    requiresFinalizedCommit: false,
    prompt: `You are an Agentree handoff checkpoint.
This is a prose-only node: do not modify files, run commands, create commits, or continue implementation work.

Your job is to reduce the user's mental load at a flow transition.
Be brief, concrete, and selective. Do not ask broad approval questions.
Ask the user for clarification only when the answer is required to avoid a wrong implementation, unsafe change, failed acceptance, or materially different product direction.

Original request:
{{ request }}

Flow phase:
{{ phase }}

Relevant completed work:
{{ source_nodes }}

Review or validation context, if any:
{{ review }}

Handoff focus:
{{ focus }}

Write the response with exactly these sections:

## What Matters
- 2 to 4 bullets covering the key decision, plan, or implementation outcome in simple words.

## User Attention Needed
- Only blockers, risky assumptions, or required clarifications.
- If there are none, write: None.

## Suggested Next Step
One concrete sentence.

## Quick Checks
- For planning, list only clarifications that truly affect implementation.
- For implementation, list the smallest useful things the user should test before accepting or requesting changes.
- If there is nothing useful to check, write: None.`,
  },
  'core.fixer@1': {
    id: 'core.fixer@1',
    label: 'Fixer',
    params: { review: 'agent' },
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

export function compileFlowDefinition(input: unknown, registry: FlowNodeRegistry = FLOW_NODE_REGISTRY): FlowValidationResult {
  const resolved = resolveFlowNodeReferences(input, registry);
  if (resolved.issues.length > 0) {
    return { definition: null, issues: resolved.issues };
  }
  return validateFlowDefinition(resolved.definition);
}

export function resolveFlowNodeReferences(
  input: unknown,
  registry: FlowNodeRegistry = FLOW_NODE_REGISTRY
): { definition: unknown; issues: FlowValidationIssue[] } {
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

    const definition = registry[node.use];
    if (!definition) {
      issues.push({
        path: `nodes.${index}.use`,
        message: `Reusable node "${node.use}" is not registered. Use a known registry id or define "${node.use}" under top-level registry in this YAML. Known registry ids: ${formatKnownRegistryIds(registry)}.`,
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

function formatKnownRegistryIds(registry: FlowNodeRegistry): string {
  const ids = Object.keys(registry).sort();
  return ids.length ? ids.join(', ') : 'none';
}

function toFlowNodeTemplate(
  reference: ReusableFlowNodeReference,
  definition: FlowNodeDefinition
): Record<string, unknown> {
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
