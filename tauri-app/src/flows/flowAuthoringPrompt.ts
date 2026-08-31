import { FLOW_NODE_REGISTRY } from './flowNodeRegistry';

export function buildFlowAuthoringPrompt(request: string): string {
  return [
    'You author Agentree FlowSource YAML from a user request.',
    '',
    'Rules:',
    '- Return only YAML. Do not include prose or Markdown fences.',
    '- YAML/AST is canonical; Mermaid is derived later.',
    '- Prefer nodes that use the registry with "use:" and "as:".',
    '- Inline custom nodes are allowed only when no registry node fits.',
    '- Do not inspect previous graph nodes for flow behavior.',
    '- Keep parallel counts and loop max_rounds between 1 and 8.',
    '',
    'DSL contract:',
    `flow:
  id: snake_case_id
  label: Human Label
inputs:
  input:
    type: string
nodes:
  - use: core.implementer@1
    as: Implementer
  - id: InlineWorker
    params: [request]
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
        - break: true`,
    '',
    'Registry capabilities:',
    JSON.stringify(FLOW_NODE_REGISTRY, null, 2),
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
