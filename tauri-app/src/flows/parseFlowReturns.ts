import { parse } from 'yaml';
import type { FlowNodeValue, FlowReturnDefinition, FlowRuntimeValue, FlowValidationIssue } from './types';

export interface ParseFlowReturnsInput {
  message: string;
  returns?: Record<string, FlowReturnDefinition>;
  selectableNodes?: FlowNodeValue[];
}

export interface ParseFlowReturnsResult {
  values: Record<string, FlowRuntimeValue>;
  issues: FlowValidationIssue[];
}

export function parseFlowReturns(input: ParseFlowReturnsInput): ParseFlowReturnsResult {
  const declaredReturns = input.returns ?? {};
  const keys = Object.keys(declaredReturns);
  if (keys.length === 0) {
    return { values: {}, issues: [] };
  }

  const rawReturns = extractReturnObject(input.message, keys);
  const values: Record<string, FlowRuntimeValue> = {};
  const issues: FlowValidationIssue[] = [];

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(rawReturns, key)) {
      issues.push({ path: `returns.${key}`, message: `Missing declared return "${key}".` });
      continue;
    }

    const parsed = parseDeclaredReturn(key, rawReturns[key], declaredReturns[key], input.selectableNodes ?? []);
    if (parsed.issue) {
      issues.push(parsed.issue);
    } else {
      values[key] = parsed.value;
    }
  }

  return { values, issues };
}

function extractReturnObject(message: string, keys: string[]): Record<string, unknown> {
  const fenced = extractLastMatchingFence(message, keys);
  if (fenced) {
    return fenced;
  }
  return extractFinalKeyValueLines(message);
}

function extractLastMatchingFence(message: string, keys: string[]): Record<string, unknown> | null {
  const fencePattern = /```(?:ya?ml)?\s*\n([\s\S]*?)```/gi;
  const blocks: Record<string, unknown>[] = [];
  let match = fencePattern.exec(message);
  while (match) {
    try {
      const parsed = parse(match[1]);
      if (isRecord(parsed) && keys.some((key) => Object.prototype.hasOwnProperty.call(parsed, key))) {
        blocks.push(parsed);
      }
    } catch {
      // Ignore non-YAML fences; normal prose can contain code blocks.
    }
    match = fencePattern.exec(message);
  }

  return blocks.length > 0 ? blocks[blocks.length - 1] : null;
}

function extractFinalKeyValueLines(message: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = message.trimEnd().split(/\r?\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.length === 0) {
      if (Object.keys(values).length > 0) {
        break;
      }
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/.exec(line);
    if (!match) {
      if (Object.keys(values).length > 0) {
        break;
      }
      continue;
    }
    values[match[1]] = match[2].trim();
  }

  return values;
}

function parseDeclaredReturn(
  key: string,
  value: unknown,
  definition: FlowReturnDefinition,
  selectableNodes: FlowNodeValue[]
): { value: FlowRuntimeValue; issue?: never } | { value?: never; issue: FlowValidationIssue } {
  if (Array.isArray(definition)) {
    const normalized = normalizeScalar(value);
    if (!definition.includes(normalized)) {
      return {
        issue: {
          path: `returns.${key}`,
          message: `Return "${key}" must be one of: ${definition.join(', ')}.`,
        },
      };
    }
    return { value: normalized };
  }

  if (definition === 'node') {
    const normalized = normalizeScalar(value);
    const resolved = resolveNodeReturn(normalized, selectableNodes);
    if (!resolved.ok) {
      return { issue: { path: `returns.${key}`, message: resolved.issue } };
    }
    return { value: resolved.node };
  }

  if (definition === 'integer') {
    const numberValue = typeof value === 'number' ? value : Number.parseInt(normalizeScalar(value), 10);
    if (!Number.isInteger(numberValue)) {
      return { issue: { path: `returns.${key}`, message: `Return "${key}" must be an integer.` } };
    }
    return { value: numberValue };
  }

  return { value: normalizeScalar(value) };
}

function resolveNodeReturn(
  selected: string,
  selectableNodes: FlowNodeValue[]
): { ok: true; node: FlowNodeValue } | { ok: false; issue: string } {
  const byId = selectableNodes.find((node) => node.id === selected);
  if (byId) {
    return { ok: true, node: byId };
  }

  const byLabel = selectableNodes.filter((node) => node.label === selected);
  if (byLabel.length === 1) {
    return { ok: true, node: byLabel[0] };
  }
  if (byLabel.length > 1) {
    return { ok: false, issue: `Node return "${selected}" matches multiple selectable nodes.` };
  }

  return { ok: false, issue: `Node return "${selected}" does not match a selectable node.` };
}

function normalizeScalar(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim().replace(/^['"]|['"]$/g, '');
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
