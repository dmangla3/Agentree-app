import { evaluateFlowCondition, evaluateFlowExpression } from './flowExpressions';
import { interpolateFlowPrompt } from './interpolateFlowPrompt';
import { parseFlowReturns } from './parseFlowReturns';
import type {
  FlowDefinition,
  FlowNodeTemplate,
  FlowNodeValue,
  FlowRuntimeValue,
  FlowStatement,
} from './types';

export interface FlowNodeRunInput {
  templateId: string;
  parent: FlowRuntimeValue;
  prompt: string;
  args: Record<string, FlowRuntimeValue>;
}

export interface FlowNodeRunner {
  runNode(input: FlowNodeRunInput): Promise<FlowNodeValue>;
}

export type FlowExecutionStatus = 'completed' | 'stopped' | 'failed' | 'cancelled';

export interface FlowExecutionEvent {
  type: 'node_started' | 'node_completed' | 'flow_stopped' | 'flow_completed';
  templateId?: string;
  nodeId?: string;
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
    emit: (event) => {
      events.push(event);
      input.onEvent?.(event);
    },
  };

  try {
    const signal = await executeStatements(input.definition.run, scope, context);
    if (signal.type === 'stopped') {
      context.emit({ type: 'flow_stopped', message: signal.reason });
      return { status: 'stopped', reason: signal.reason, scope, events };
    }
    context.emit({ type: 'flow_completed', message: 'Flow completed.' });
    return { status: 'completed', scope, events };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Flow execution failed.';
    context.emit({ type: 'flow_stopped', message: reason });
    return { status: 'failed', reason, scope, events };
  }
}

interface ExecutionContext {
  templates: Map<string, FlowNodeTemplate>;
  runner: FlowNodeRunner;
  emit: (event: FlowExecutionEvent) => void;
}

type ExecutionSignal = { type: 'continue' } | { type: 'break' } | { type: 'stopped'; reason: string };

async function executeStatements(
  statements: FlowStatement[],
  scope: Record<string, FlowRuntimeValue>,
  context: ExecutionContext
): Promise<ExecutionSignal> {
  for (const statement of statements) {
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
  if ('call' in statement) {
    const result = await executeCall(statement.call, statement.args ?? {}, undefined, scope, context);
    if (result.signal) {
      return result.signal;
    }
    scope[statement.set] = result.node;
    return { type: 'continue' };
  }

  if ('parallel' in statement) {
    const countResult = evaluateFlowExpression(statement.parallel.count, scope);
    if (countResult.issues.length > 0) {
      return stopFromIssues(countResult.issues.map((issue) => issue.message));
    }
    if (!Number.isInteger(countResult.value) || typeof countResult.value !== 'number' || countResult.value < 1) {
      return { type: 'stopped', reason: 'Parallel count must resolve to a positive integer.' };
    }

    const calls = Array.from({ length: countResult.value }, () =>
      executeCall(statement.parallel.call, statement.parallel.args ?? {}, statement.parallel.parent, scope, context)
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
      const signal = await executeStatements(statement.loop.steps, scope, context);
      if (signal.type === 'break') {
        return { type: 'continue' };
      }
      if (signal.type === 'stopped') {
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
  const template = context.templates.get(templateId);
  if (!template) {
    return { node: emptyNode(templateId), signal: { type: 'stopped', reason: `Unknown node template "${templateId}".` } };
  }

  const argsResult = evaluateArgs(argExpressions, scope);
  if (argsResult.issues.length > 0) {
    return { node: emptyNode(templateId), signal: stopFromIssues(argsResult.issues) };
  }

  let prompt: string;
  let parent: FlowRuntimeValue;
  try {
    prompt = interpolateFlowPrompt(template.prompt, argsResult.args);
    parent = resolveParent(parentOverride ?? template.parent, argsResult.args);
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
  const rawNode = await context.runner.runNode({
    templateId,
    parent,
    prompt,
    args: argsResult.args,
  });
  if (rawNode.status === 'failed' || rawNode.status === 'cancelled') {
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

function resolveParent(parentExpression: string, args: Record<string, FlowRuntimeValue>): FlowRuntimeValue {
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
