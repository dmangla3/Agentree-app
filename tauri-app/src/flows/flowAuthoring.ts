import { buildFlowAuthoringPrompt, buildFlowAuthoringRepairPrompt } from './flowAuthoringPrompt';
import { compileFlowDefinition, FLOW_NODE_REGISTRY, type FlowNodeDefinition, type FlowNodeRegistry } from './flowNodeRegistry';
import { extractFlowRegistryAdditions, mergeFlowRegistryAdditions } from './flowRegistryAdditions';
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
  registry?: FlowNodeRegistry;
}

export interface FlowAuthoringReview {
  status: 'ready';
  source: UserFlowSource;
  definition: FlowDefinition;
  registryAdditions: FlowNodeDefinition[];
  registryNodeIds: string[];
  registryAdditionIds: string[];
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
  const baseRegistry = input.registry ?? FLOW_NODE_REGISTRY;
  let attempts = 0;
  let yaml = extractYaml(await input.agent.complete(buildFlowAuthoringPrompt(input.request, baseRegistry)));
  attempts += 1;
  let validation = validateDraftYaml(yaml, baseRegistry);

  while (validation.issues.length > 0 && attempts <= maxRepairAttempts) {
    yaml = extractYaml(await input.agent.complete(buildFlowAuthoringRepairPrompt({
      request: input.request,
      previousYaml: yaml,
      issues: validation.issues.map((issue) => formatIssue(issue)),
    })));
    attempts += 1;
    validation = validateDraftYaml(yaml, baseRegistry);
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
    registryAdditions: validation.registryAdditions,
    registryNodeIds: validation.definition.nodes.flatMap((node) => node.registryId ? [node.registryId] : []),
    registryAdditionIds: validation.registryAdditions.map((definition) => definition.id),
    inlineNodeIds: validation.definition.nodes.flatMap((node) => node.registryId ? [] : [node.id]),
    attempts,
  };
}

function validateDraftYaml(
  source: string,
  baseRegistry: FlowNodeRegistry
): { definition: FlowDefinition | null; registryAdditions: FlowNodeDefinition[]; issues: FlowValidationIssue[] } {
  try {
    const parsed = parseFlowYaml(source);
    const extracted = extractFlowRegistryAdditions(parsed, baseRegistry);
    const candidateRegistry = mergeFlowRegistryAdditions(baseRegistry, extracted.registryAdditions);
    const compiled = compileFlowDefinition(parsed, candidateRegistry);
    const issues = [...extracted.issues, ...compiled.issues];
    return {
      definition: issues.length === 0 ? compiled.definition : null,
      registryAdditions: extracted.registryAdditions,
      issues,
    };
  } catch (error) {
    return {
      definition: null,
      registryAdditions: [],
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
