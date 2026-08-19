import type { FlowNodeValue, FlowRuntimeValue, FlowValidationIssue } from './types';

export interface FlowExpressionResult {
  value: FlowRuntimeValue;
  issues: FlowValidationIssue[];
}

export interface FlowConditionResult {
  value: boolean;
  issues: FlowValidationIssue[];
}

const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function evaluateFlowExpression(
  expression: string | number | boolean | null,
  scope: Record<string, FlowRuntimeValue>
): FlowExpressionResult {
  if (typeof expression !== 'string') {
    return { value: expression, issues: [] };
  }

  const trimmed = expression.trim();
  if (!PATH_PATTERN.test(trimmed)) {
    return { value: expression, issues: [] };
  }

  return resolveFlowPath(trimmed, scope);
}

export function evaluateFlowCondition(condition: string, scope: Record<string, FlowRuntimeValue>): FlowConditionResult {
  const parts = condition.split(/\s+==\s+/);
  if (parts.length !== 2 || condition.includes('!=') || condition.includes('>=') || condition.includes('<=')) {
    return {
      value: false,
      issues: [{ path: condition, message: 'Only equality conditions are supported.' }],
    };
  }

  const [leftExpression, expectedLiteral] = parts;
  if (!PATH_PATTERN.test(leftExpression) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(expectedLiteral)) {
    return {
      value: false,
      issues: [{ path: condition, message: 'Only variable-path equality against bare literals is supported.' }],
    };
  }

  const result = resolveFlowPath(leftExpression, scope);
  if (result.issues.length > 0) {
    return { value: false, issues: result.issues };
  }

  return {
    value: result.value === parseConditionLiteral(expectedLiteral),
    issues: [],
  };
}

export function resolveFlowPath(path: string, scope: Record<string, FlowRuntimeValue>): FlowExpressionResult {
  const segments = path.split('.');
  let current: FlowRuntimeValue | undefined = scope[segments[0]];
  if (current === undefined) {
    return missingPath(path, segments[0]);
  }

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    current = readSegment(current, segment);
    if (current === undefined) {
      return missingPath(path, segments.slice(0, index + 1).join('.'));
    }
  }

  return { value: current, issues: [] };
}

function readSegment(value: FlowRuntimeValue, segment: string): FlowRuntimeValue | undefined {
  if (Array.isArray(value)) {
    const projected = value.map((entry) => readSegment(entry, segment));
    if (projected.some((entry) => entry === undefined)) {
      return undefined;
    }
    return projected as FlowRuntimeValue[];
  }

  if (isFlowNodeValue(value)) {
    if (segment in value) {
      return value[segment as keyof FlowNodeValue] as FlowRuntimeValue | undefined;
    }
    return value.returns?.[segment];
  }

  if (isPlainFlowObject(value)) {
    return value[segment];
  }

  return undefined;
}

function missingPath(path: string, missing: string): FlowExpressionResult {
  return {
    value: null,
    issues: [{ path, message: `Missing flow value at "${missing}".` }],
  };
}

function parseConditionLiteral(value: string): FlowRuntimeValue {
  if (value === 'null') {
    return null;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return value;
}

function isFlowNodeValue(value: FlowRuntimeValue): value is FlowNodeValue {
  return isPlainFlowObject(value) && value.kind === 'node' && typeof value.id === 'string';
}

function isPlainFlowObject(value: FlowRuntimeValue): value is { [key: string]: FlowRuntimeValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
