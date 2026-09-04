import { evaluateFlowCondition, evaluateFlowExpression } from './flowExpressions';
import { interpolateFlowPrompt } from './interpolateFlowPrompt';
import { parseFlowReturns } from './parseFlowReturns';
import type {
  FlowDefinition,
  FlowNodeTemplate,
  FlowNodeValue,
  FlowParamType,
  FlowRuntimeValue,
  FlowStatement,
} from './types';

export interface FlowNodeRunInput {
  templateId: string;
  registryId?: string;
  parent: FlowRuntimeValue;
  prompt: string;
  args: Record<string, FlowRuntimeValue>;
  requiresFinalizedCommit?: boolean;
  signal?: AbortSignal;
  onNodeLaunched?: (node: FlowNodeLaunchEvent) => void;
}

export interface FlowNodeRunner {
  runNode(input: FlowNodeRunInput): Promise<FlowNodeValue>;
}

export type FlowExecutionStatus = 'completed' | 'stopped' | 'failed' | 'cancelled';

export interface FlowNodeLaunchEvent {
  templateId: string;
  userNodeId: string;
  assistantNodeId: string;
}

export interface FlowExecutionEvent {
  type: 'node_started' | 'node_launched' | 'node_completed' | 'flow_stopped' | 'flow_completed' | 'flow_cancelled';
  templateId?: string;
  nodeId?: string;
  userNodeId?: string;
  message: string;
}

export interface FlowExecutionResult {
  status: FlowExecutionStatus;
  reason?: string;
  scope: Record<string, FlowRuntimeValue>;
  events: FlowExecutionEvent[];
}

export async function executeFlow(input: {
  definition: FlowDefinition;
  inputs: Record<string, FlowRuntimeValue>;
  runner: FlowNodeRunner;
  signal?: AbortSignal;
  onEvent?: (event: FlowExecutionEvent) => void;
}): Promise<FlowExecutionResult> {
  const templates = new Map(input.definition.nodes.map((template) => [template.id, template]));
  const events: FlowExecutionEvent[] = [];
  const scope: Record<string, FlowRuntimeValue> = {
    input: input.inputs,
  };
  const context: ExecutionContext = {
    templates,
    runner: input.runner,
    signal: input.signal,
    emit: (event) => {
      events.push(event);
      input.onEvent?.(event);
    },
  };

  try {
    throwIfFlowCancelled(context.signal);
    const signal = await executeStatements(input.definition.run, scope, context);
    if (signal.type === 'stopped') {
      context.emit({ type: 'flow_stopped', message: signal.reason });
      return { status: 'stopped', reason: signal.reason, scope, events };
    }
    if (signal.type === 'cancelled') {
      context.emit({ type: 'flow_cancelled', message: signal.reason });
      return { status: 'cancelled', reason: signal.reason, scope, events };
    }
    context.emit({ type: 'flow_completed', message: 'Flow completed.' });
    return { status: 'completed', scope, events };
  } catch (error) {
    if (isFlowExecutionCancelledError(error)) {
      context.emit({ type: 'flow_cancelled', message: error.message });
      return { status: 'cancelled', reason: error.message, scope, events };
    }
    const reason = error instanceof Error ? error.message : 'Flow execution failed.';
    context.emit({ type: 'flow_stopped', message: reason });
    return { status: 'failed', reason, scope, events };
  }
}

interface ExecutionContext {
  templates: Map<string, FlowNodeTemplate>;
  runner: FlowNodeRunner;
  signal?: AbortSignal;
  emit: (event: FlowExecutionEvent) => void;
}

type ExecutionSignal =
  | { type: 'continue' }
  | { type: 'break' }
  | { type: 'stopped'; reason: string }
  | { type: 'cancelled'; reason: string };

async function executeStatements(
  statements: FlowStatement[],
  scope: Record<string, FlowRuntimeValue>,
  context: ExecutionContext
): Promise<ExecutionSignal> {
  for (const statement of statements) {
    throwIfFlowCancelled(context.signal);
    const signal = await executeStatement(statement, scope, context);
    if (signal.type !== 'continue') {
      return signal;
    }
  }
  return { type: 'continue' };
}

async function executeStatement(
  statement: FlowStatement,
  scope: Record<string, FlowRuntimeValue>,
  context: ExecutionContext
): Promise<ExecutionSignal> {
  throwIfFlowCancelled(context.signal);

  if ('call' in statement) {
    const result = await executeCall(statement.call, statement.args ?? {}, statement.parent, scope, context);
    if (result.signal) {
      return result.signal;
    }
    scope[statement.set] = result.node;
    return { type: 'continue' };
  }

  if ('parallel' in statement) {
    const parallel = statement.parallel;
    if ('branches' in parallel) {
      const calls = parallel.branches.map((branch) =>
        executeCall(branch.call, branch.args ?? {}, branch.parent, scope, context)
      );
      const results = await Promise.all(calls);
      const stopped = results.find((result) => result.signal);
      if (stopped?.signal) {
        return stopped.signal;
      }
      scope[statement.set] = results.map((result) => result.node);
      return { type: 'continue' };
    }

    const countResult = evaluateFlowExpression(parallel.count, scope);
    if (countResult.issues.length > 0) {
      return stopFromIssues(countResult.issues.map((issue) => issue.message));
    }
    if (!Number.isInteger(countResult.value) || typeof countResult.value !== 'number' || countResult.value < 1) {
      return { type: 'stopped', reason: 'Parallel count must resolve to a positive integer.' };
    }

    const calls = Array.from({ length: countResult.value }, () =>
      executeCall(parallel.call, parallel.args ?? {}, parallel.parent, scope, context)
    );
    const results = await Promise.all(calls);
    const stopped = results.find((result) => result.signal);
    if (stopped?.signal) {
      return stopped.signal;
    }
    scope[statement.set] = results.map((result) => result.node);
    return { type: 'continue' };
  }

  if ('value' in statement) {
    const result = evaluateFlowExpression(statement.value, scope);
    if (result.issues.length > 0) {
      return stopFromIssues(result.issues.map((issue) => issue.message));
    }
    scope[statement.set] = result.value;
    return { type: 'continue' };
  }

  if ('if' in statement) {
    const result = evaluateFlowCondition(statement.if, scope);
    if (result.issues.length > 0) {
      return stopFromIssues(result.issues.map((issue) => issue.message));
    }
    if (!result.value) {
      return { type: 'continue' };
    }
    const thenStatements = Array.isArray(statement.then) ? statement.then : [statement.then];
    return executeStatements(thenStatements, scope, context);
  }

  if ('loop' in statement) {
    for (let round = 0; round < statement.loop.max_rounds; round += 1) {
      throwIfFlowCancelled(context.signal);
      const signal = await executeStatements(statement.loop.steps, scope, context);
      if (signal.type === 'break') {
        return { type: 'continue' };
      }
      if (signal.type === 'stopped' || signal.type === 'cancelled') {
        return signal;
      }
    }
    return { type: 'stopped', reason: 'max_rounds_exhausted' };
  }

  if ('break' in statement) {
    return { type: 'break' };
  }

  if ('stop' in statement) {
    return { type: 'stopped', reason: statement.stop };
  }

  return { type: 'stopped', reason: 'Unsupported flow statement.' };
}

async function executeCall(
  templateId: string,
  argExpressions: Record<string, string>,
  parentOverride: string | undefined,
  scope: Record<string, FlowRuntimeValue>,
  context: ExecutionContext
): Promise<{ node: FlowNodeValue; signal?: ExecutionSignal }> {
  throwIfFlowCancelled(context.signal);

  const template = context.templates.get(templateId);
  if (!template) {
    return { node: emptyNode(templateId), signal: { type: 'stopped', reason: `Unknown node template "${templateId}".` } };
  }

  const argsResult = evaluateArgs(argExpressions, scope);
  if (argsResult.issues.length > 0) {
    return { node: emptyNode(templateId), signal: stopFromIssues(argsResult.issues) };
  }
  const typeIssues = validateRuntimeArgs(template, argsResult.args);
  if (typeIssues.length > 0) {
    return { node: emptyNode(templateId), signal: stopFromIssues(typeIssues) };
  }

  let prompt: string;
  let parent: FlowRuntimeValue;
  try {
    prompt = interpolateFlowPrompt(template.prompt, argsResult.args);
    parent = parentOverride
      ? resolveCallParent(parentOverride, scope)
      : resolveTemplateParent(template.parent, argsResult.args);
  } catch (error) {
    return {
      node: emptyNode(templateId),
      signal: {
        type: 'stopped',
        reason: error instanceof Error ? error.message : 'Failed to resolve node prompt or parent.',
      },
    };
  }

  context.emit({ type: 'node_started', templateId, message: `Started ${templateId}.` });
  throwIfFlowCancelled(context.signal);
  const rawNode = await context.runner.runNode({
    templateId,
    ...(template.registryId ? { registryId: template.registryId } : {}),
    parent,
    prompt,
    args: argsResult.args,
    requiresFinalizedCommit: template.requiresFinalizedCommit ?? false,
    signal: context.signal,
    onNodeLaunched: (node) => {
      context.emit({
        type: 'node_launched',
        templateId: node.templateId,
        userNodeId: node.userNodeId,
        nodeId: node.assistantNodeId,
        message: `Launched ${node.templateId}.`,
      });
    },
  });
  throwIfFlowCancelled(context.signal);
  if (rawNode.status === 'cancelled') {
    return {
      node: rawNode,
      signal: { type: 'cancelled', reason: `Node "${rawNode.id}" ended with status "cancelled".` },
    };
  }
  if (rawNode.status === 'failed') {
    return {
      node: rawNode,
      signal: { type: 'stopped', reason: `Node "${rawNode.id}" ended with status "${rawNode.status}".` },
    };
  }

  const nodeWithReturns = attachDeclaredReturns(rawNode, template, scope);
  if (nodeWithReturns.signal) {
    return nodeWithReturns;
  }

  context.emit({
    type: 'node_completed',
    templateId,
    nodeId: nodeWithReturns.node.id,
    message: `Completed ${templateId}.`,
  });
  return { node: nodeWithReturns.node };
}

function evaluateArgs(
  argExpressions: Record<string, string>,
  scope: Record<string, FlowRuntimeValue>
): { args: Record<string, FlowRuntimeValue>; issues: string[] } {
  const args: Record<string, FlowRuntimeValue> = {};
  const issues: string[] = [];
  for (const [key, expression] of Object.entries(argExpressions)) {
    if (expression === 'root') {
      args[key] = 'root';
      continue;
    }
    const result = evaluateFlowExpression(expression, scope);
    if (result.issues.length > 0) {
      issues.push(...result.issues.map((issue) => issue.message));
    } else {
      args[key] = result.value;
    }
  }
  return { args, issues };
}

function validateRuntimeArgs(template: FlowNodeTemplate, args: Record<string, FlowRuntimeValue>): string[] {
  const issues: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const expected = template.paramTypes?.[key];
    if (!expected) continue;
    if (expected.includes('scalar')) continue;
    const actual = runtimeValueType(value);
    if (!actual || isRuntimeTypeCompatible(actual, expected)) continue;
    issues.push(`${template.id}.${key} expected ${expected.join(' | ')}, got ${actual}.`);
  }
  return issues;
}

function isRuntimeTypeCompatible(actual: FlowParamType, expected: FlowParamType[]): boolean {
  if (expected.includes(actual)) return true;
  if (actual === 'string' && (expected.includes('commit') || expected.includes('verdict'))) return true;
  if (actual === 'commit[]' && expected.includes('commit[]')) return true;
  return false;
}

function runtimeValueType(value: FlowRuntimeValue): FlowParamType | null {
  if (value === null) return null;
  if (Array.isArray(value)) {
    const firstType = value.length > 0 ? runtimeValueType(value[0]) : null;
    if (firstType === 'commit' || firstType === 'string') return 'commit[]';
    if (firstType === 'agent') return 'agent[]';
    return null;
  }
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'scalar';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object' && value.kind === 'node') return 'agent';
  return null;
}

function resolveCallParent(parentExpression: string, scope: Record<string, FlowRuntimeValue>): FlowRuntimeValue {
  if (parentExpression === 'root') {
    return 'root';
  }
  const result = evaluateFlowExpression(parentExpression, scope);
  if (result.issues.length > 0) {
    throw new Error(result.issues.map((issue) => issue.message).join(' '));
  }
  return result.value;
}

function resolveTemplateParent(parentExpression: string, args: Record<string, FlowRuntimeValue>): FlowRuntimeValue {
  const tokenMatch = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(parentExpression);
  if (!tokenMatch) {
    return parentExpression;
  }
  const result = evaluateFlowExpression(tokenMatch[1].trim(), args);
  if (result.issues.length > 0) {
    throw new Error(result.issues.map((issue) => issue.message).join(' '));
  }
  return result.value;
}

function attachDeclaredReturns(
  node: FlowNodeValue,
  template: FlowNodeTemplate,
  scope: Record<string, FlowRuntimeValue>
): { node: FlowNodeValue; signal?: ExecutionSignal } {
  if (!template.returns) {
    return { node };
  }

  const parsed = parseFlowReturns({
    message: node.message ?? '',
    returns: template.returns,
    selectableNodes: collectNodeValues(scope),
  });
  if (parsed.issues.length > 0) {
    return {
      node,
      signal: stopFromIssues(parsed.issues.map((issue) => issue.message)),
    };
  }

  return {
    node: {
      ...node,
      returns: {
        ...(node.returns ?? {}),
        ...parsed.values,
      },
    },
  };
}

function collectNodeValues(scope: Record<string, FlowRuntimeValue>): FlowNodeValue[] {
  const nodes: FlowNodeValue[] = [];
  for (const value of Object.values(scope)) {
    collectNodeValuesFromValue(value, nodes);
  }
  return nodes;
}

function collectNodeValuesFromValue(value: FlowRuntimeValue, nodes: FlowNodeValue[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectNodeValuesFromValue(entry, nodes));
    return;
  }
  if (isFlowNodeValue(value)) {
    nodes.push(value);
  }
}

function stopFromIssues(issues: string[]): ExecutionSignal {
  return { type: 'stopped', reason: issues.join(' ') };
}

export class FlowExecutionCancelledError extends Error {
  constructor(reason = 'Flow cancelled.') {
    super(reason);
    this.name = 'FlowExecutionCancelledError';
  }
}

export function isFlowExecutionCancelledError(error: unknown): error is FlowExecutionCancelledError {
  return error instanceof FlowExecutionCancelledError ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'FlowExecutionCancelledError');
}

export function throwIfFlowCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = typeof signal.reason === 'string' && signal.reason.trim()
    ? signal.reason.trim()
    : 'Flow cancelled.';
  throw new FlowExecutionCancelledError(reason);
}

function emptyNode(id: string): FlowNodeValue {
  return {
    kind: 'node',
    id,
    status: 'failed',
  };
}

function isFlowNodeValue(value: FlowRuntimeValue): value is FlowNodeValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && value.kind === 'node';
}
