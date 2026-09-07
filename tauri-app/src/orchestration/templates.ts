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
    prompt: 'Create a concrete implementation plan for {{request}}. Include validation steps and key risks.',
  },
  {
    id: '#synthesizer',
    kind: 'node',
    label: '#synthesizer',
    prompt: 'Synthesize the relevant prior node outputs into one clear recommendation for {{request}}.',
  },
  {
    id: '#reviewer',
    kind: 'node',
    label: '#reviewer',
    prompt: 'Review the current result for correctness, regressions, missing tests, and unclear assumptions.',
  },
  {
    id: '#fixer',
    kind: 'node',
    label: '#fixer',
    prompt: 'Apply focused fixes for the reviewed issues while preserving the requested behavior.',
    requiresCommit: true,
  },
  {
    id: '#security_reviewer',
    kind: 'node',
    label: '#security_reviewer',
    prompt: 'Review the change for plausible security issues, privilege boundaries, and unsafe data handling.',
  },
  {
    id: '#ui_polish_reviewer',
    kind: 'node',
    label: '#ui_polish_reviewer',
    prompt: 'Review the UI for layout, responsiveness, visual clarity, and interaction polish.',
  },
];

export const DEFAULT_ORCHESTRATION_PROMPT_TEMPLATES: OrchestrationPromptTemplate[] = [
  {
    id: '#parallel_planners',
    kind: 'orchestration',
    label: '#parallel_planners',
    prompt: 'Create three parallel #planner for {{request}}. Create a #synthesizer sibling to combine the plans.',
    source: 'built_in',
  },
  {
    id: '#review_fix_chain',
    kind: 'orchestration',
    label: '#review_fix_chain',
    prompt: 'Create a #reviewer for {{request}}. Create a #fixer as child of reviewer to apply focused fixes.',
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
