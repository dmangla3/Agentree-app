export type OrchestrationTemplateKind = 'node' | 'orchestration';

export interface OrchestrationPromptTemplate {
  id: string;
  kind: OrchestrationTemplateKind;
  label: string;
  prompt: string;
  requiresCommit?: boolean;
  defaultAgentId?: string | null;
  defaultModel?: string | null;
  source?: 'built_in' | 'user';
  updatedAt?: string | null;
}

export const normalizeTemplateId = (value: string): string => {
  const trimmed = value.trim().replace(/^[@#]+/, '');
  return trimmed ? `@${trimmed.toLowerCase().replace(/[^a-z0-9_-]+/g, '_')}` : '';
};

export const DEFAULT_ORCHESTRATION_NODE_TEMPLATES: OrchestrationPromptTemplate[] = [
  {
    id: '#planner',
    kind: 'node',
    label: '#planner',
    prompt: 'Understand the current codebase around the request, then write an implementation plan.\n\nPrefer integrating with the existing domain model over inventing new names, helpers, or parallel abstractions. Fix the current concept unless the bug reveals a truly missing concept, new functionality, or business logic that requires it.',
    requiresCommit: true,
  },
  {
    id: '#synthesizer',
    kind: 'node',
    label: '#synthesizer',
    prompt: 'Look at the shared commits. They may contain implementations, plans, or other outputs.\n\nCompare them and select the commit that best matches the requirement.\n\nIf other implementations contain better ideas, include those ideas and write the final changes.\n\nThe final synthesized output should combine the best ideas and feel coherent and seamless.',
    requiresCommit: true,
  },
  {
    id: '#reviewer',
    kind: 'node',
    label: '#reviewer',
    prompt: 'Review the commit for correctness and regressions.\n\nAlso assess the result at a high level: identify major missed opportunities or significantly better, simpler, cleaner, or more elegant alternative solutions.',
  },
  {
    id: '#fixer',
    kind: 'node',
    label: '#fixer',
    prompt: 'Review the reviewer suggestions.\n\nFor each suggestion, implement it if you agree. If you disagree, explain why.',
    requiresCommit: true,
  },
  {
    id: '#implementer',
    kind: 'node',
    label: '#implementer',
    prompt: "Implement the plan thoroughly and correctly.\n\nYou may adjust small implementation details as you learn the codebase, but keep the functionality aligned with the user's requirement.",
    requiresCommit: true,
  },
  {
    id: '#handoff',
    kind: 'node',
    label: '#handoff',
    prompt: "Your job is to reduce the user's mental load because the user may not want to read full plans or test full implementations.\n\nBe brief, concrete, and selective. Do not ask broad approval questions. Ask the user for clarification only when the answer is required to avoid a wrong implementation, unsafe change, failed acceptance, or materially different product direction.\n\nWrite the response with exactly these sections:\n\n## What Matters\n- 2 to 4 bullets covering the key decision, plan, or implementation outcome in simple words.\n\n## User Attention Needed\n- Only blockers, risky assumptions, or required clarifications.\n- If there are none, write: None.\n\n## Suggested Next Step\nOne concrete sentence.\n\n## Quick Checks\n- For planning, list only clarifications that truly affect implementation.\n- For implementation, list the smallest useful things the user should test before accepting or requesting changes.",
  },
];

export const DEFAULT_ORCHESTRATION_PROMPT_TEMPLATES: OrchestrationPromptTemplate[] = [
  {
    id: '#parallel_planners',
    kind: 'orchestration',
    label: '#parallel_planners',
    prompt: "Create three parallel #planner runs named A, B, and C.\nCreate a #synthesizer sibling D to combine the plans.\nCreate a #handoff E as a child of D.\n\nShare the handoff's output with the user after finishing.",
    source: 'built_in',
  },
  {
    id: '#parallel_implementer',
    kind: 'orchestration',
    label: '#parallel_implementer',
    prompt: "Create three parallel #implementer runs named A, B, and C.\nCreate a #synthesizer sibling D to combine the plans.\n\nLoop up to 3 times:\n- Create a #reviewer sibling to review the latest synthesized plan.\n- Create a #fixer child of D for the first pass, then a child of the previous fixer for later passes.\n\nRun a #handoff as a child of the final fixer.\n\nShare the handoff's output with the user after finishing.",
    source: 'built_in',
  },
];

export const DEFAULT_ORCHESTRATION_TEMPLATES: OrchestrationPromptTemplate[] = [
  ...DEFAULT_ORCHESTRATION_NODE_TEMPLATES,
  ...DEFAULT_ORCHESTRATION_PROMPT_TEMPLATES,
];

export const buildTemplateRegistry = (
  templates: OrchestrationPromptTemplate[] = DEFAULT_ORCHESTRATION_TEMPLATES,
): Map<string, OrchestrationPromptTemplate> => {
  const registry = new Map<string, OrchestrationPromptTemplate>();
  for (const template of templates) {
    const id = normalizeTemplateId(template.id);
    if (!id) continue;
    registry.set(id, {
      ...template,
      id,
      label: template.label ? template.label.replace(/^@/, '#') : `#${id.replace(/^@/, '')}`,
    });
  }
  return registry;
};

export const getTemplatesByKind = (
  templates: OrchestrationPromptTemplate[],
  kind: OrchestrationTemplateKind,
): OrchestrationPromptTemplate[] => templates.filter((template) => template.kind === kind);

export const renderTemplatePrompt = (
  template: OrchestrationPromptTemplate,
  request: string,
): string => template.prompt.replace(/\{\{\s*request\s*\}\}/g, request.trim());

export const resolveOrchestrationPromptTemplate = (
  rawPrompt: string,
  templates: OrchestrationPromptTemplate[] = DEFAULT_ORCHESTRATION_TEMPLATES,
): string => {
  const prompt = rawPrompt.trim();
  const match = prompt.match(/^#([a-zA-Z0-9_-]+)(?:\s+(.*))?$/);
  if (!match) return prompt;

  const templateId = normalizeTemplateId(match[1]);
  const template = buildTemplateRegistry(getTemplatesByKind(templates, 'orchestration')).get(templateId);
  if (!template) return prompt;
  return renderTemplatePrompt(template, match[2]?.trim() || prompt);
};
