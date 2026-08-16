import { resolveFlowPath } from './flowExpressions';
import type { FlowNodeValue, FlowRuntimeValue } from './types';

const TOKEN_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;
const MESSAGE_EXCERPT_LENGTH = 800;

export function interpolateFlowPrompt(template: string, scope: Record<string, FlowRuntimeValue>): string {
  return template.replace(TOKEN_PATTERN, (_token, rawExpression: string) => {
    const expression = rawExpression.trim();
    const result = resolveFlowPath(expression, scope);
    if (result.issues.length > 0) {
      throw new Error(result.issues.map((issue) => issue.message).join(' '));
    }
    return renderFlowValue(result.value);
  });
}

export function renderFlowValue(value: FlowRuntimeValue): string {
  if (value === null) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => `${index + 1}. ${indentAfterFirstLine(renderFlowValue(entry), '   ')}`).join('\n\n');
  }
  if (isFlowNodeValue(value)) {
    return renderNodeValue(value);
  }
  return JSON.stringify(value);
}

function renderNodeValue(node: FlowNodeValue): string {
  const lines = [
    '[Agentree node]',
    `id: ${node.id}`,
  ];
  if (node.label) {
    lines.push(`label: ${node.label}`);
  }
  lines.push(
    `status: ${node.status}`,
    `commit: ${node.commit || 'none'}`,
    'message:',
    excerpt(node.message || '')
  );
  return lines.join('\n');
}

function indentAfterFirstLine(value: string, indent: string): string {
  const lines = value.split('\n');
  return lines.map((line, index) => (index === 0 ? line : `${indent}${line}`)).join('\n');
}

function excerpt(value: string): string {
  if (value.length <= MESSAGE_EXCERPT_LENGTH) {
    return value;
  }
  return `${value.slice(0, MESSAGE_EXCERPT_LENGTH).trimEnd()}...`;
}

function isFlowNodeValue(value: FlowRuntimeValue): value is FlowNodeValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && value.kind === 'node';
}
