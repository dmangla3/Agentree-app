import type { FlowValidationIssue } from './types';
import type { FlowNodeDefinition, FlowNodeRegistry } from './flowNodeRegistry';
import { normalizeFlowNodeDefinition } from './userFlowNodeRegistryStore';

export function extractFlowRegistryAdditions(
  parsed: unknown,
  baseRegistry: FlowNodeRegistry
): { registryAdditions: FlowNodeDefinition[]; issues: FlowValidationIssue[] } {
  if (!isRecord(parsed) || parsed.registry === undefined) {
    return { registryAdditions: [], issues: [] };
  }
  if (!Array.isArray(parsed.registry)) {
    return {
      registryAdditions: [],
      issues: [{ path: 'registry', message: 'Registry additions must be an array.' }],
    };
  }

  const issues: FlowValidationIssue[] = [];
  const registryAdditions: FlowNodeDefinition[] = [];
  const seen = new Set<string>();
  parsed.registry.forEach((entry, index) => {
    const definition = normalizeFlowNodeDefinition(entry);
    if (!definition) {
      issues.push({ path: `registry.${index}`, message: 'Registry node definition is invalid.' });
      return;
    }
    if (baseRegistry[definition.id]) {
      issues.push({ path: `registry.${index}.id`, message: `Reusable node "${definition.id}" already exists.` });
      return;
    }
    if (seen.has(definition.id)) {
      issues.push({ path: `registry.${index}.id`, message: `Reusable node "${definition.id}" is duplicated.` });
      return;
    }
    seen.add(definition.id);
    registryAdditions.push(definition);
  });

  return { registryAdditions, issues };
}

export function mergeFlowRegistryAdditions(
  baseRegistry: FlowNodeRegistry,
  registryAdditions: FlowNodeDefinition[]
): FlowNodeRegistry {
  return {
    ...baseRegistry,
    ...Object.fromEntries(registryAdditions.map((definition) => [definition.id, definition])),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
