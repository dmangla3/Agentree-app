import { stringify } from 'yaml';
import { buildFlowAuthoringPrompt, buildFlowAuthoringRepairPrompt } from './flowAuthoringPrompt';
import { compileFlowDefinition } from './flowNodeRegistry';
import { parseFlowYaml } from './parseFlowYaml';
import type { FlowDefinition, FlowValidationIssue, UserFlowSource } from './types';

export interface FlowAuthoringAgent {
  complete(prompt: string): Promise<string>;
}

export interface AuthorFlowFromNaturalLanguageInput {
  request: string;
  agent: FlowAuthoringAgent;
  workspaceId?: string | null;
  maxRepairAttempts?: number;
  now?: string;
}

export interface FlowAuthoringReview {
  status: 'ready';
  source: UserFlowSource;
  definition: FlowDefinition;
  registryNodeIds: string[];
  inlineNodeIds: string[];
  attempts: number;
}

export interface FlowAuthoringFailure {
  status: 'failed';
  source: UserFlowSource;
  issues: FlowValidationIssue[];
  attempts: number;
}

export type FlowAuthoringResult = FlowAuthoringReview | FlowAuthoringFailure;

export async function authorFlowFromNaturalLanguage(input: AuthorFlowFromNaturalLanguageInput): Promise<FlowAuthoringResult> {
  const maxRepairAttempts = input.maxRepairAttempts ?? 2;
  const now = input.now ?? new Date().toISOString();
  let attempts = 0;
  let yaml = extractYaml(await input.agent.complete(buildFlowAuthoringPrompt(input.request)));
  attempts += 1;
  let validation = validateDraftYaml(yaml);

  while (validation.issues.length > 0 && attempts <= maxRepairAttempts) {
    yaml = extractYaml(await input.agent.complete(buildFlowAuthoringRepairPrompt({
      request: input.request,
      previousYaml: yaml,
      issues: validation.issues.map((issue) => formatIssue(issue)),
    })));
    attempts += 1;
    validation = validateDraftYaml(yaml);
  }

  const source = toUserFlowSource({
    yaml,
    request: input.request,
    workspaceId: input.workspaceId ?? null,
    now,
    definition: validation.definition,
  });

  if (!validation.definition || validation.issues.length > 0) {
    return {
      status: 'failed',
      source: { ...source, enabled: false },
      issues: validation.issues,
      attempts,
    };
  }

  return {
    status: 'ready',
    source,
    definition: validation.definition,
    registryNodeIds: validation.definition.nodes.flatMap((node) => node.registryId ? [node.registryId] : []),
    inlineNodeIds: validation.definition.nodes.flatMap((node) => node.registryId ? [] : [node.id]),
    attempts,
  };
}

export function createRuleBasedFlowDraft(request: string): string {
  const label = titleCase(request).slice(0, 64) || 'Custom Flow';
  const id = slugifyFlowId(label);
  return stringify({
    flow: { id, label },
    inputs: {
      input: { type: 'string' },
    },
    nodes: [
      { use: 'core.implementer@1', as: 'Implementer' },
    ],
    run: [
      {
        set: 'implementation',
        call: 'Implementer',
        parent: 'root',
        args: { request: 'input.input' },
      },
    ],
  }).trim();
}

function validateDraftYaml(source: string): { definition: FlowDefinition | null; issues: FlowValidationIssue[] } {
  try {
    return compileFlowDefinition(parseFlowYaml(source));
  } catch (error) {
    return {
      definition: null,
      issues: [{
        path: '',
        message: error instanceof Error ? error.message : 'Flow YAML could not be parsed.',
      }],
    };
  }
}

function toUserFlowSource(input: {
  yaml: string;
  request: string;
  workspaceId: string | null;
  now: string;
  definition: FlowDefinition | null;
}): UserFlowSource {
  const id = input.definition?.flow.id ?? slugifyFlowId(input.request);
  const label = input.definition?.flow.label ?? (titleCase(input.request).slice(0, 64) || id);
  return {
    id,
    label,
    scope: input.workspaceId ? 'workspace' : 'global',
    workspaceId: input.workspaceId,
    source: input.yaml,
    version: 1,
    enabled: true,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function extractYaml(response: string): string {
  const fenced = response.match(/```(?:ya?ml)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? response).trim();
}

function formatIssue(issue: FlowValidationIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

function slugifyFlowId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug || 'custom_flow';
}

function titleCase(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
