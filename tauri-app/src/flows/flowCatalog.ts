import { compileFlowDefinition, FLOW_NODE_REGISTRY, type FlowNodeRegistry } from './flowNodeRegistry';
import { extractFlowRegistryAdditions, mergeFlowRegistryAdditions } from './flowRegistryAdditions';
import { parseFlowYaml } from './parseFlowYaml';
import { PREDEFINED_FLOW_SOURCES } from './predefinedFlows';
import type { FlowDefinition, FlowSource, FlowValidationIssue, UserFlowSource } from './types';

export type FlowCatalogSourceKind = 'predefined' | 'user';

export interface FlowCatalogItem {
  id: string;
  label: string;
  sourceId: string;
  sourceVersion: number;
  kind: FlowCatalogSourceKind;
  source: FlowSource | UserFlowSource;
  definition: FlowDefinition | null;
  enabled: boolean;
  runnable: boolean;
  issues: FlowValidationIssue[];
}

export interface RunnableFlowDescriptor {
  id: string;
  label: string;
  sourceId: string;
  sourceVersion: number;
  kind: FlowCatalogSourceKind;
  definition: FlowDefinition;
}

export function buildFlowCatalog(input?: {
  predefinedSources?: FlowSource[];
  userSources?: UserFlowSource[];
  registry?: FlowNodeRegistry;
}): FlowCatalogItem[] {
  const predefinedSources = input?.predefinedSources ?? PREDEFINED_FLOW_SOURCES;
  const userSources = input?.userSources ?? [];
  const registry = input?.registry;
  return [
    ...predefinedSources.map((source) => compileCatalogSource(source, 'predefined', registry)),
    ...userSources.map((source) => compileCatalogSource(source, 'user', registry)),
  ].sort(compareCatalogItems);
}

export function getRunnableFlowDescriptors(catalog: FlowCatalogItem[]): RunnableFlowDescriptor[] {
  return catalog
    .filter((flow): flow is FlowCatalogItem & { definition: FlowDefinition } => flow.runnable && Boolean(flow.definition))
    .map((flow) => ({
      id: flow.id,
      label: flow.label,
      sourceId: flow.sourceId,
      sourceVersion: flow.sourceVersion,
      kind: flow.kind,
      definition: flow.definition,
    }));
}

export function compileCatalogSource(
  source: FlowSource | UserFlowSource,
  kind: FlowCatalogSourceKind,
  registry?: FlowNodeRegistry
): FlowCatalogItem {
  const enabled = kind === 'predefined' || !('enabled' in source) || source.enabled;
  const sourceVersion = 'version' in source ? source.version : 1;
  try {
    const parsed = parseFlowYaml(source.source);
    const baseRegistry = registry ?? FLOW_NODE_REGISTRY;
    const extracted = extractFlowRegistryAdditions(parsed, baseRegistry);
    const result = compileFlowDefinition(parsed, mergeFlowRegistryAdditions(baseRegistry, extracted.registryAdditions));
    const issues = [...extracted.issues, ...result.issues];
    const definition = issues.length === 0 ? result.definition ?? null : null;
    const label = definition?.flow.label ?? source.label;
    return {
      id: source.id,
      label,
      sourceId: source.id,
      sourceVersion,
      kind,
      source,
      definition,
      enabled,
      runnable: enabled && Boolean(definition) && issues.length === 0,
      issues,
    };
  } catch (error) {
    return {
      id: source.id,
      label: source.label,
      sourceId: source.id,
      sourceVersion,
      kind,
      source,
      definition: null,
      enabled,
      runnable: false,
      issues: [{
        path: '',
        message: error instanceof Error ? error.message : 'Flow source could not be parsed.',
      }],
    };
  }
}

function compareCatalogItems(left: FlowCatalogItem, right: FlowCatalogItem): number {
  if (left.kind !== right.kind) return left.kind === 'predefined' ? -1 : 1;
  if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
  const labelCompare = left.label.localeCompare(right.label);
  if (labelCompare !== 0) return labelCompare;
  return left.id.localeCompare(right.id);
}
