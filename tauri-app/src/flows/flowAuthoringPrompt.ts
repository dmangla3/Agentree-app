import { FLOW_NODE_REGISTRY, type FlowNodeRegistry } from './flowNodeRegistry';
import { PREDEFINED_FLOW_SOURCES } from './predefinedFlows';

export function buildFlowAuthoringPrompt(request: string, registry: FlowNodeRegistry = FLOW_NODE_REGISTRY): string {
  const knownPatterns = PREDEFINED_FLOW_SOURCES.map((source) => source.source).join('\n---\n');
  return [
    'You author Agentree FlowSource YAML from a user request.',
    '',
    'Rules:',
    '- Return only YAML. Do not include prose or Markdown fences.',
    '- YAML/AST is canonical; Mermaid is derived later.',
    '- Prefer nodes that use the registry with "use:" and "as:".',
    '- Only use reusable node ids that appear in Registry capabilities unless you define that exact id under top-level "registry:" in the same YAML.',
    '- When a missing node role is generic and likely reusable in future flows, add it under top-level "registry:" and use it from this flow.',
    '- Inline custom nodes are allowed only when the behavior is specific to this one flow.',
    '- Registry additions and the flow are reviewed and approved together as one bundle.',
    '- Set requiresFinalizedCommit: true only for implementation/fixer/synthesizer nodes that must produce a git commit before downstream steps can use their output.',
    '- Leave requiresFinalizedCommit false or omit it for planning, review, analysis, summarization, routing, handoff, or prose-only nodes.',
    '- Prefer core.handoff@1 as the final step for planning, implementation, review, and synthesis flows unless the user explicitly asks for a machine-only flow.',
    '- Use Handoff to reduce user mental load: summarize only what matters, ask clarifying questions only when actually required, and give concrete next steps or focused test checks.',
    '- Prefer core.synthesizer@1 for combining candidate commits across implementation, planning, documentation, tests, and analysis. Do not create domain-specific synthesizer nodes unless the output contract or behavior is genuinely different.',
    '- Use typed params object form for every new registry or inline node. Do not generate old params arrays.',
    '- Supported param types are string, integer, boolean, commit, commit[], agent, agent[], verdict, and scalar. Use unions like "agent | agent[]" when needed.',
    '- Wire args by type: commit -> commit, commit[] -> commit[], agent -> agent/agent[], verdict -> verdict. Do not pass an agent node where a commit is required, or commit[] where commit is required.',
    '- If the request is a variant of a known working pattern, preserve that pattern\'s run structure and change only the node roles/prompts/args that the request actually changes.',
    '- The flow label must match the run structure: if the label/request says "synthesis", include a synthesizer call after candidate generation; if it says "review", include a reviewer call; if it says "fix" or "until satisfied", include a bounded loop and fixer.',
    '- For any downstream node that consumes candidate outputs, first set a named value such as candidate_commits: candidates.commit or candidate_nodes: candidates, then pass that value explicitly.',
    '- Flow node fields are singular: id, label, status, message, commit, and declared returns. Array projection also uses singular fields, for example planners.commit, never planners.commits.',
    '- Every registry addition must be used by at least one node entry with "use:". Do not define a registry node and then duplicate the same role as an inline node.',
    '- When a fixer produces a new commit, update the current commit variable used by later reviewers and update the fixer parent to the fixer node, matching the known working review loop.',
    '- Add guards before commit-consuming review/fix steps, for example stop when synthesized.commit == null.',
    '- Prefer commit refs for implementation and plan-file synthesis; prefer node refs/messages only for prose review, routing, or summaries that do not need git state.',
    '- Do not use tools or inspect the filesystem; answer directly from this prompt.',
    '- Do not inspect previous graph nodes for flow behavior.',
    '- Keep parallel counts and loop max_rounds between 1 and 8.',
    '',
    'DSL contract:',
`registry:
  - id: core.generic_worker@1
    label: Generic Worker
    params:
      request: string
    parent: root
    requiresFinalizedCommit: false
    prompt: "Work on {{ request }}"

flow:
  id: snake_case_id
  label: Human Label
inputs:
  input:
    type: string
nodes:
  - use: core.implementer@1
    as: Implementer
  - use: core.handoff@1
    as: Handoff
  - id: InlineWorker
    params:
      request: string
    parent: root
    prompt: "Work on {{ request }}"
run:
  - set: worker
    call: Implementer
    parent: root
    args:
      request: input.input
  - set: workers
    parallel:
      count: 3
      call: Implementer
      parent: root
      args:
        request: input.input
  - if: worker.commit == null
    then:
      stop: missing_commit
  - loop:
      max_rounds: 2
      steps:
        - set: reviewer
          call: Reviewer
        - break: true
  - set: handoff
    call: Handoff
    parent: worker
    args:
      request: input.input
      phase: implementation handoff
      source_nodes: worker
      review: "no review context"
      focus: "Summarize the implementation and list only the key things the user should test."`,
    '',
    'Known working flow patterns to adapt instead of inventing from scratch:',
    knownPatterns,
    '',
    'Registry capabilities:',
    JSON.stringify(registry, null, 2),
    '',
    'User request:',
    request,
  ].join('\n');
}

export function buildFlowAuthoringRepairPrompt(input: {
  request: string;
  previousYaml: string;
  issues: string[];
}): string {
  return [
    'Repair this Agentree flow YAML. Return only YAML.',
    '',
    'Original user request:',
    input.request,
    '',
    'Validation issues:',
    ...input.issues.map((issue) => `- ${issue}`),
    '',
    'Previous YAML:',
    input.previousYaml,
  ].join('\n');
}
