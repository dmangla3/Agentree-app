import type { FlowParamType } from './types';

export const FLOW_PARAM_TYPES: readonly FlowParamType[] = [
  'string',
  'integer',
  'boolean',
  'commit',
  'commit[]',
  'agent',
  'agent[]',
  'verdict',
  'scalar',
];

const FLOW_PARAM_TYPE_SET = new Set<string>(FLOW_PARAM_TYPES);

export function parseFlowParamTypes(input: unknown): FlowParamType[] | null {
  if (typeof input === 'string') {
    const values = input.split('|').map((part) => part.trim()).filter(Boolean);
    return normalizeFlowParamTypes(values);
  }
  return null;
}

function normalizeFlowParamTypes(input: unknown[]): FlowParamType[] | null {
  const result: FlowParamType[] = [];
  for (const value of input) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!FLOW_PARAM_TYPE_SET.has(trimmed)) return null;
    if (!result.includes(trimmed as FlowParamType)) {
      result.push(trimmed as FlowParamType);
    }
  }
  return result.length > 0 ? result : null;
}

export function formatFlowParamTypes(types: FlowParamType[]): string {
  return types.join(' | ');
}
