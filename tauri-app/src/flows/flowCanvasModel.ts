import type { Edge, Node } from '@xyflow/react';
import type { FlowDefinition, FlowStatement } from './types';

export type FlowCanvasNodeKind =
  | 'start'
  | 'done'
  | 'group'
  | 'call'
  | 'parallel'
  | 'set'
  | 'if'
  | 'loop'
  | 'stop'
  | 'break';

export type FlowStatementKind = Exclude<FlowCanvasNodeKind, 'start' | 'done' | 'group'>;
export type FlowCanvasMode = 'overview' | 'context' | 'debug';

export interface FlowCanvasOutput {
  label: string;
  expression: string;
  kind: 'commit' | 'verdict' | 'node' | 'message' | 'scalar';
  importance: 'primary' | 'secondary' | 'debug';
}

export interface FlowCanvasDataBinding {
  target: string;
  expression: string;
}

export type FlowCanvasDataPortKind = 'commit' | 'verdict' | 'node' | 'message' | 'scalar';
export type FlowCanvasDataPortDirection = 'input' | 'output';

export interface FlowCanvasDataPort {
  id: string;
  direction: FlowCanvasDataPortDirection;
  label: string;
  expression: string;
  kind: FlowCanvasDataPortKind;
  isArray?: boolean;
  count?: number;
}

export interface FlowCanvasNodeData extends Record<string, unknown> {
  kind: FlowCanvasNodeKind;
  label: string;
  statementPath?: number[];
  statement?: FlowStatement;
  depth: number;
  meta?: string;
  contextLabel?: string;
  outputs?: FlowCanvasOutput[];
  dataPorts?: FlowCanvasDataPort[];
  dataBindings?: FlowCanvasDataBinding[];
  outcomes?: string[];
  groupLabel?: string;
  groupKind?: 'parallel' | 'loop' | 'context';
  groupPath?: number[];
}

export interface FlowCanvasModel {
  nodes: Node<FlowCanvasNodeData>[];
  edges: Edge[];
}

interface EdgeTail {
  id: string;
  label?: string;
}

interface BuildContext {
  nodes: Node<FlowCanvasNodeData>[];
  edges: Edge[];
  row: number;
}

const NODE_X_GAP = 360;
const NODE_Y_GAP = 176;

export function flowDefinitionToCanvasModel(
  definition: FlowDefinition,
  options: { mode?: FlowCanvasMode } = {}
): FlowCanvasModel {
  if (options.mode === 'overview') {
    return flowDefinitionToOverviewCanvasModel(definition);
  }
  if (options.mode === 'context') {
    return flowDefinitionToContextCanvasModel(definition);
  }
  return flowDefinitionToDebugCanvasModel(definition);
}

function flowDefinitionToDebugCanvasModel(definition: FlowDefinition): FlowCanvasModel {
  const context: BuildContext = {
    nodes: [{
      id: 'start',
      type: 'flowCanvasNode',
      position: { x: 0, y: 0 },
      data: { kind: 'start', label: 'Start', depth: 0 },
      selectable: false,
      draggable: false,
    }],
    edges: [],
    row: 1,
  };

  const tails = appendDebugStatements(definition, definition.run, [], [{ id: 'start' }], 0, context);
  const terminalTails = [...tails.next, ...tails.breaks];
  const doneId = 'done';
  context.nodes.push({
    id: doneId,
    type: 'flowCanvasNode',
    position: { x: 0, y: Math.max(context.row, 1) * NODE_Y_GAP },
    data: { kind: 'done', label: 'Done', depth: 0 },
    selectable: false,
    draggable: false,
  });
  for (const tail of terminalTails.length ? terminalTails : [{ id: 'start' }]) {
    connect(context, tail, doneId);
  }

  return context;
}

function flowDefinitionToOverviewCanvasModel(
  definition: FlowDefinition
): FlowCanvasModel {
  const context: OverviewBuildContext = {
    nodes: [{
      id: 'start',
      type: 'flowCanvasNode',
      position: { x: 0, y: 0 },
      data: { kind: 'start', label: 'Start', depth: 0 },
      selectable: false,
      draggable: false,
    }],
    edges: [],
    row: 1,
    producers: new Map(),
    definition,
  };

  const tails = appendOverviewStatements(definition.run, [], [{ id: 'start' }], 0, context);
  const terminalTails = [...tails.next, ...tails.breaks];
  context.nodes.push({
    id: 'done',
    type: 'flowCanvasNode',
    position: { x: 0, y: Math.max(context.row, 1) * NODE_Y_GAP },
    data: { kind: 'done', label: 'Done', depth: 0 },
    selectable: false,
    draggable: false,
  });
  for (const tail of terminalTails.length ? terminalTails : [{ id: 'start' }]) {
    connect(context, tail, 'done');
  }
  pruneUnusedNodeResultPorts(context);
  return { nodes: context.nodes, edges: context.edges };
}

interface ContextCanvasItem {
  id: string;
  statement: Extract<FlowStatement, { call: string }> | Extract<FlowStatement, { parallel: unknown }>;
  statementPath: number[];
  label: string;
  set: string;
  parentExpression: string;
  parentKey: string;
  parentProducerId: string | null;
  loopLabel?: string;
  annotations: Pick<FlowCanvasNodeData, 'contextLabel' | 'outputs' | 'dataBindings' | 'outcomes' | 'groupLabel'>;
}

interface ContextParentGroup {
  key: string;
  label: string;
  meta: string;
  producerId: string | null;
  depth: number;
  items: ContextCanvasItem[];
}

interface ContextCollection {
  items: ContextCanvasItem[];
  producerByVariable: Map<string, string>;
  labelByProducerId: Map<string, string>;
}

const CONTEXT_GROUP_WIDTH = 336;
const CONTEXT_GROUP_HEADER = 74;
const CONTEXT_NODE_HEIGHT = 116;
const CONTEXT_NODE_GAP = 18;
const CONTEXT_GROUP_X_GAP = 410;
const CONTEXT_GROUP_Y_GAP = 96;
const CONTEXT_GROUP_PADDING_X = 26;
const CONTEXT_GROUP_PADDING_BOTTOM = 26;

function flowDefinitionToContextCanvasModel(definition: FlowDefinition): FlowCanvasModel {
  const collection: ContextCollection = {
    items: [],
    producerByVariable: new Map(),
    labelByProducerId: new Map(),
  };
  collectContextItems(definition, definition.run, [], [], collection);

  const groups = buildContextParentGroups(collection.items, collection.labelByProducerId);
  const nodes: Node<FlowCanvasNodeData>[] = [];
  const groupsByDepth = new Map<number, ContextParentGroup[]>();
  for (const group of groups) {
    const current = groupsByDepth.get(group.depth) ?? [];
    current.push(group);
    groupsByDepth.set(group.depth, current);
  }

  for (const group of groups) {
    const peers = groupsByDepth.get(group.depth) ?? [];
    const peerIndex = peers.findIndex((candidate) => candidate.key === group.key);
    const height = CONTEXT_GROUP_HEADER
      + Math.max(1, group.items.length) * CONTEXT_NODE_HEIGHT
      + Math.max(0, group.items.length - 1) * CONTEXT_NODE_GAP
      + CONTEXT_GROUP_PADDING_BOTTOM;
    const position = {
      x: group.depth * CONTEXT_GROUP_X_GAP,
      y: peerIndex * (height + CONTEXT_GROUP_Y_GAP),
    };
    nodes.push({
      id: contextGroupNodeId(group.key),
      type: 'flowCanvasNode',
      position,
      data: {
        kind: 'group',
        groupKind: 'context',
        label: group.label,
        depth: group.depth,
        meta: group.meta,
      },
      style: { width: CONTEXT_GROUP_WIDTH, height },
      selectable: false,
      draggable: false,
    });
  }

  for (const group of groups) {
    group.items.forEach((item, itemIndex) => {
      const nodeKind = 'parallel' in item.statement ? 'parallel' : 'call';
      nodes.push({
        id: item.id,
        type: 'flowCanvasNode',
        position: {
          x: CONTEXT_GROUP_PADDING_X,
          y: CONTEXT_GROUP_HEADER + itemIndex * (CONTEXT_NODE_HEIGHT + CONTEXT_NODE_GAP),
        },
        parentId: contextGroupNodeId(group.key),
        extent: 'parent',
        data: {
          kind: nodeKind,
          label: item.label,
          statementPath: item.statementPath,
          statement: item.statement,
          depth: group.depth + 1,
          meta: [
            `sets ${item.set}`,
            item.loopLabel,
          ].filter(Boolean).join(' · '),
          contextLabel: item.parentExpression,
          ...item.annotations,
        },
        style: { width: CONTEXT_GROUP_WIDTH - CONTEXT_GROUP_PADDING_X * 2 },
        draggable: false,
      });
    });
  }

  return { nodes, edges: [] };
}

function collectContextItems(
  definition: FlowDefinition,
  statements: FlowStatement[],
  pathPrefix: number[],
  loopStack: string[],
  collection: ContextCollection
): void {
  statements.forEach((statement, index) => {
    const statementPath = [...pathPrefix, index];
    if ('value' in statement) {
      recordContextSetProducer(statement.set, statement.value, collection);
      return;
    }
    if ('call' in statement || 'parallel' in statement) {
      const id = statementNodeId(statementPath);
      const set = statement.set;
      const parentExpression = getContextParentExpression(definition, statement);
      const parentProducerId = resolveContextParentProducer(parentExpression, collection);
      const label = 'parallel' in statement ? statement.parallel.call : statement.call;
      const item: ContextCanvasItem = {
        id,
        statement,
        statementPath,
        label,
        set,
        parentExpression,
        parentProducerId,
        parentKey: parentProducerId ? `producer:${parentProducerId}` : `expr:${parentExpression}`,
        loopLabel: loopStack[loopStack.length - 1],
        annotations: getStatementAnnotations(definition, statement),
      };
      collection.items.push(item);
      collection.producerByVariable.set(set, id);
      collection.labelByProducerId.set(id, label);
      return;
    }
    if ('if' in statement) {
      const thenStatements = Array.isArray(statement.then) ? statement.then : [statement.then];
      collectContextItems(definition, thenStatements, statementPath, loopStack, collection);
      return;
    }
    if ('loop' in statement) {
      collectContextItems(
        definition,
        statement.loop.steps,
        statementPath,
        [...loopStack, `loop max ${statement.loop.max_rounds}`],
        collection
      );
    }
  });
}

function buildContextParentGroups(
  items: ContextCanvasItem[],
  labelByProducerId: Map<string, string>
): ContextParentGroup[] {
  const groupMap = new Map<string, ContextParentGroup>();
  const ensureGroup = (item: ContextCanvasItem): ContextParentGroup => {
    const existing = groupMap.get(item.parentKey);
    if (existing) return existing;
    const depth = getContextParentDepth(item.parentProducerId, items);
    const label = item.parentProducerId
      ? `${labelByProducerId.get(item.parentProducerId) ?? 'Agent'} context`
      : item.parentExpression;
    const meta = item.parentProducerId
      ? `parent ${item.parentExpression}`
      : item.parentExpression === 'root'
        ? 'root context'
        : `external parent ${item.parentExpression}`;
    const group: ContextParentGroup = {
      key: item.parentKey,
      label,
      meta,
      producerId: item.parentProducerId,
      depth,
      items: [],
    };
    groupMap.set(item.parentKey, group);
    return group;
  };

  for (const item of items) {
    ensureGroup(item).items.push(item);
  }

  return Array.from(groupMap.values()).sort((a, b) => (
    a.depth - b.depth || firstContextItemIndex(a, items) - firstContextItemIndex(b, items)
  ));
}

function firstContextItemIndex(group: ContextParentGroup, items: ContextCanvasItem[]): number {
  const firstId = group.items[0]?.id;
  return Math.max(0, items.findIndex((item) => item.id === firstId));
}

function getContextParentDepth(parentProducerId: string | null, items: ContextCanvasItem[]): number {
  if (!parentProducerId) return 0;
  const parentItem = items.find((item) => item.id === parentProducerId);
  if (!parentItem) return 1;
  return 1 + getContextParentDepth(parentItem.parentProducerId, items);
}

function getContextParentExpression(
  definition: FlowDefinition,
  statement: Extract<FlowStatement, { call: string }> | Extract<FlowStatement, { parallel: unknown }>
): string {
  if ('call' in statement) {
    const template = definition.nodes.find((node) => node.id === statement.call);
    return statement.parent ?? template?.parent ?? 'root';
  }
  const template = definition.nodes.find((node) => node.id === statement.parallel.call);
  return statement.parallel.parent ?? template?.parent ?? 'root';
}

function resolveContextParentProducer(parentExpression: string, collection: ContextCollection): string | null {
  if (parentExpression === 'root') return null;
  return collection.producerByVariable.get(rootToken(parentExpression)) ?? null;
}

function recordContextSetProducer(target: string, value: unknown, collection: ContextCollection): void {
  const source = typeof value === 'string' ? rootToken(value) : null;
  if (!source) return;
  const producer = collection.producerByVariable.get(source);
  if (producer) {
    collection.producerByVariable.set(target, producer);
  }
}

function contextGroupNodeId(key: string): string {
  return `context:${key.replace(/[^a-zA-Z0-9:.-]+/g, '_')}`;
}

function appendDebugStatements(
  definition: FlowDefinition,
  statements: FlowStatement[],
  pathPrefix: number[],
  incoming: EdgeTail[],
  depth: number,
  context: BuildContext
): { next: EdgeTail[]; breaks: EdgeTail[] } {
  let tails = incoming;
  const breaks: EdgeTail[] = [];
  statements.forEach((statement, index) => {
    if (tails.length === 0) return;
    const result = appendDebugStatement(definition, statement, [...pathPrefix, index], tails, depth, context);
    tails = result.next;
    breaks.push(...result.breaks);
  });
  return { next: tails, breaks };
}

function appendDebugStatement(
  definition: FlowDefinition,
  statement: FlowStatement,
  statementPath: number[],
  incoming: EdgeTail[],
  depth: number,
  context: BuildContext
): { next: EdgeTail[]; breaks: EdgeTail[] } {
  const id = statementNodeId(statementPath);
  context.nodes.push({
    id,
    type: 'flowCanvasNode',
    position: { x: depth * NODE_X_GAP, y: context.row * NODE_Y_GAP },
    data: {
      kind: getStatementKind(statement),
      label: getStatementLabel(statement),
      statementPath,
      statement,
      depth,
      meta: getStatementMeta(statement),
      ...getStatementAnnotations(definition, statement),
    },
    draggable: false,
  });
  context.row += 1;
  incoming.forEach((tail) => connect(context, tail, id));

  if ('if' in statement) {
    const thenStatements = Array.isArray(statement.then) ? statement.then : [statement.then];
    const thenTails = appendDebugStatements(definition, thenStatements, statementPath, [{ id, label: 'true' }], depth + 1, context);
    return {
      next: [...thenTails.next, { id, label: 'false' }],
      breaks: thenTails.breaks,
    };
  }

  if ('loop' in statement) {
    const loopTails = appendDebugStatements(definition, statement.loop.steps, statementPath, [{ id, label: 'round' }], depth + 1, context);
    loopTails.next.forEach((tail) => connect(context, tail, id, tail.label ?? 'next'));
    return {
      next: [{ id, label: 'done' }, ...loopTails.breaks],
      breaks: [],
    };
  }

  if ('stop' in statement) {
    return { next: [], breaks: [] };
  }

  if ('break' in statement) {
    return { next: [], breaks: [{ id, label: 'break' }] };
  }

  return { next: [{ id }], breaks: [] };
}

interface DataProducer {
  nodeId: string;
  portId: string;
  label: string;
  expression: string;
  kind: FlowCanvasDataPortKind;
  isArray: boolean;
}

interface OverviewInputPortBinding {
  port: FlowCanvasDataPort;
  sources: DataProducer[];
}

interface OverviewBuildContext extends BuildContext {
  producers: Map<string, DataProducer>;
  definition: FlowDefinition;
}

function appendOverviewStatements(
  statements: FlowStatement[],
  pathPrefix: number[],
  incoming: EdgeTail[],
  depth: number,
  context: OverviewBuildContext
): { next: EdgeTail[]; breaks: EdgeTail[] } {
  let tails = incoming;
  const breaks: EdgeTail[] = [];
  statements.forEach((statement, index) => {
    if (tails.length === 0 && !('value' in statement)) return;
    const result = appendOverviewStatement(statement, [...pathPrefix, index], tails, depth, context);
    tails = result.next;
    breaks.push(...result.breaks);
  });
  return { next: tails, breaks };
}

function appendOverviewStatement(
  statement: FlowStatement,
  statementPath: number[],
  incoming: EdgeTail[],
  depth: number,
  context: OverviewBuildContext
): { next: EdgeTail[]; breaks: EdgeTail[] } {
  if ('value' in statement) {
    recordSetProducer(statement.set, statement.value, context);
    incoming.forEach((tail) => addDataBinding(context, tail.id, { target: statement.set, expression: formatScalar(statement.value) }));
    return { next: incoming, breaks: [] };
  }

  if ('stop' in statement) {
    incoming.forEach((tail) => addOutcome(context, tail.id, `stop: ${statement.stop}`));
    return { next: [], breaks: [] };
  }

  if ('break' in statement) {
    incoming.forEach((tail) => addOutcome(context, tail.id, 'break'));
    return { next: [], breaks: incoming.map((tail) => ({ id: tail.id, label: 'break' })) };
  }

  if ('parallel' in statement) {
    return appendOverviewParallel(statement, statementPath, incoming, depth, context);
  }

  if ('loop' in statement) {
    return appendOverviewLoop(statement, statementPath, incoming, depth, context);
  }

  const id = statementNodeId(statementPath);
  const annotations = getStatementAnnotations(context.definition, statement);
  const inputBindings = 'call' in statement ? buildOverviewInputPorts(statement.args, context) : [];
  const outputPorts = 'call' in statement
    ? getTemplateDataPorts(statement.set, context.definition.nodes.find((node) => node.id === statement.call), false)
    : [];
  const position = { x: depth * NODE_X_GAP, y: context.row * NODE_Y_GAP };
  context.nodes.push({
    id,
    type: 'flowCanvasNode',
    position,
    data: {
      kind: getStatementKind(statement),
      label: getStatementLabel(statement),
      statementPath,
      statement,
      depth,
      meta: getOverviewStatementMeta(statement),
      dataPorts: [...inputBindings.map((binding) => binding.port), ...outputPorts],
      ...annotations,
    },
    draggable: false,
  });
  context.row += 1;
  incoming.forEach((tail) => connect(context, tail, id));
  inputBindings.forEach((binding) => connectDataInputs(context, binding, id));
  if ('call' in statement) {
    registerOutputProducers(statement.set, id, outputPorts, context);
    return { next: [{ id }], breaks: [] };
  }

  if ('if' in statement) {
    const thenStatements = Array.isArray(statement.then) ? statement.then : [statement.then];
    const thenTails = appendOverviewStatements(thenStatements, statementPath, [{ id, label: 'true' }], depth + 1, context);
    return {
      next: [...thenTails.next, { id }],
      breaks: thenTails.breaks,
    };
  }

  return { next: [{ id }], breaks: [] };
}

function appendOverviewParallel(
  statement: Extract<FlowStatement, { parallel: unknown }>,
  statementPath: number[],
  incoming: EdgeTail[],
  depth: number,
  context: OverviewBuildContext
): { next: EdgeTail[]; breaks: EdgeTail[] } {
  const groupId = statementNodeId(statementPath);
  const childId = `${groupId}:call`;
  const template = context.definition.nodes.find((node) => node.id === statement.parallel.call);
  const annotations = getStatementAnnotations(context.definition, statement);
  const inputBindings = buildOverviewInputPorts(statement.parallel.args, context);
  const childOutputPorts = getTemplateDataPorts(statement.set, template, false);
  const aggregateOutputPorts = getTemplateDataPorts(statement.set, template, true);
  const groupPosition = { x: depth * NODE_X_GAP, y: context.row * NODE_Y_GAP };
  context.nodes.push({
    id: groupId,
    type: 'flowCanvasNode',
    position: groupPosition,
    data: {
      kind: 'group',
      groupKind: 'parallel',
      label: 'Parallel',
      statementPath,
      statement,
      depth,
      meta: `${String(statement.parallel.count)} branches`,
      dataPorts: aggregateOutputPorts,
      ...annotations,
    },
    style: { width: 340, height: 254 },
    draggable: false,
  });
  context.nodes.push({
    id: childId,
    type: 'flowCanvasNode',
    position: { x: 48, y: 78 },
    parentId: groupId,
    extent: 'parent',
    data: {
      kind: 'call',
      label: statement.parallel.call,
      statementPath,
      statement,
      depth: depth + 1,
      meta: `sets ${statement.set}`,
      groupPath: statementPath,
      dataPorts: [...inputBindings.map((binding) => binding.port), ...childOutputPorts],
    },
    draggable: false,
  });
  incoming.forEach((tail) => connect(context, tail, groupId));
  inputBindings.forEach((binding) => connectDataInputs(context, binding, childId));
  registerOutputProducers(statement.set, groupId, aggregateOutputPorts, context);
  context.row += 2;
  return { next: [{ id: childId }], breaks: [] };
}

function appendOverviewLoop(
  statement: Extract<FlowStatement, { loop: unknown }>,
  statementPath: number[],
  incoming: EdgeTail[],
  depth: number,
  context: OverviewBuildContext
): { next: EdgeTail[]; breaks: EdgeTail[] } {
  const groupId = statementNodeId(statementPath);
  const startRow = context.row;
  const groupNode: Node<FlowCanvasNodeData> = {
    id: groupId,
    type: 'flowCanvasNode',
    position: { x: depth * NODE_X_GAP, y: startRow * NODE_Y_GAP },
    data: {
      kind: 'group',
      groupKind: 'loop',
      label: 'Loop',
      statementPath,
      statement,
      depth,
      meta: `max ${statement.loop.max_rounds} · ${statement.loop.steps.length} steps`,
      groupLabel: 'Loop group',
    },
    draggable: false,
  };
  context.nodes.push(groupNode);
  context.row += 1;
  incoming.forEach((tail) => connect(context, tail, groupId));

  const loopTails = appendOverviewStatements(statement.loop.steps, statementPath, [{ id: groupId, label: 'round' }], depth + 1, context);
  loopTails.next.forEach((tail) => connect(context, tail, groupId, tail.label ?? 'next'));
  const childNodes = context.nodes.filter((node) => (
    node.data.statementPath &&
    node.data.statementPath.length > statementPath.length &&
    statementPath.every((part, index) => node.data.statementPath?.[index] === part)
  ));
  const bounds = getBounds(childNodes);
  if (bounds) {
    const paddingX = 34;
    const paddingTop = 60;
    const paddingBottom = 34;
    groupNode.position = {
      x: Math.min(groupNode.position.x, bounds.minX - paddingX),
      y: Math.min(groupNode.position.y, bounds.minY - paddingTop),
    };
    groupNode.style = {
      width: Math.max(300, bounds.maxX - groupNode.position.x + paddingX),
      height: Math.max(170, bounds.maxY - groupNode.position.y + paddingBottom),
    };
  } else {
    groupNode.style = { width: 300, height: 170 };
  }
  return {
    next: [{ id: groupId, label: 'done' }, ...loopTails.breaks],
    breaks: [],
  };
}

function connect(context: BuildContext, from: EdgeTail, to: string, overrideLabel?: string): void {
  const label = overrideLabel ?? from.label;
  context.edges.push({
    id: `${from.id}->${to}${label ? `:${label}` : ''}`,
    source: from.id,
    target: to,
    type: 'smoothstep',
    animated: label === 'round',
    label,
    data: { kind: 'execution' },
  });
}

function connectDataInputs(context: OverviewBuildContext, binding: OverviewInputPortBinding, targetNodeId: string): void {
  for (const source of binding.sources) {
    context.edges.push({
      id: `${source.nodeId}:${source.portId}->${targetNodeId}:${binding.port.id}`,
      source: source.nodeId,
      sourceHandle: source.portId,
      target: targetNodeId,
      targetHandle: binding.port.id,
      type: 'smoothstep',
      data: { kind: 'data' },
      className: 'agentree-flow-data-edge',
    });
  }
}

function buildOverviewInputPorts(
  args: Record<string, string> | undefined,
  context: OverviewBuildContext
): OverviewInputPortBinding[] {
  const bindingsByKey = new Map<string, OverviewInputPortBinding>();
  for (const [target, expression] of Object.entries(args ?? {})) {
    const source = resolveDataProducer(expression, target, context);
    if (!source && !isUnresolvedDataDependency(target, expression)) {
      continue;
    }
    const inferred = inferDataPort(target, expression, source);
    const key = `${inferred.kind}:${inferred.isArray ? 'array' : 'one'}:${inferred.label}`;
    const existing = bindingsByKey.get(key);
    if (existing) {
      existing.port.expression = mergePortExpression(existing.port.expression, `${target}: ${expression}`);
      if (source && !existing.sources.some((candidate) => candidate.nodeId === source.nodeId && candidate.portId === source.portId)) {
        existing.sources.push(source);
      }
      existing.port.count = (existing.port.count ?? 1) + 1;
      continue;
    }
    bindingsByKey.set(key, {
      port: {
        id: createDataPortId('input', inferred.label, bindingsByKey.size),
        direction: 'input',
        label: inferred.label,
        expression: `${target}: ${expression}`,
        kind: inferred.kind,
        ...(inferred.isArray ? { isArray: true } : {}),
      },
      sources: source ? [source] : [],
    });
  }
  return Array.from(bindingsByKey.values());
}

function inferDataPort(
  target: string,
  expression: string,
  source: DataProducer | null
): Pick<FlowCanvasDataPort, 'label' | 'kind' | 'isArray'> {
  if (source) {
    return {
      label: source.label,
      kind: source.kind,
      ...(source.isArray ? { isArray: true } : {}),
    };
  }

  const token = `${target} ${expression}`.toLowerCase();
  const isArray = /\[\]|commits|candidates|implementations|nodes/.test(token);
  if (/(^|[_.\s])commit(s)?($|[_.\s])/.test(token)) {
    return { label: isArray ? 'commit[]' : 'commit', kind: 'commit', ...(isArray ? { isArray: true } : {}) };
  }
  if (/(^|[_.\s])verdict($|[_.\s])/.test(token)) {
    return { label: 'verdict', kind: 'verdict' };
  }
  if (/(^|[_.\s])node(s)?($|[_.\s])/.test(token)) {
    return { label: agentPortLabel(isArray), kind: 'node', ...(isArray ? { isArray: true } : {}) };
  }
  return { label: target, kind: 'scalar' };
}

function isUnresolvedDataDependency(target: string, expression: string): boolean {
  const token = `${target} ${expression}`.toLowerCase();
  if (/(^|[_.\s])commit(s)?($|[_.\s])/.test(token)) return true;
  if (/(^|[_.\s])verdict($|[_.\s])/.test(token)) return true;
  if (/(^|[_.\s])node(s)?($|[_.\s])/.test(token)) return true;
  return /^[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)+$/.test(expression.trim());
}

function resolveDataProducer(
  expression: string,
  inputLabel: string,
  context: OverviewBuildContext
): DataProducer | null {
  const trimmed = expression.trim();
  const exact = context.producers.get(trimmed);
  if (exact) return exact;

  if (trimmed.startsWith('input.')) {
    return getOrCreateStartInputProducer(trimmed, inputLabel, context);
  }

  const root = rootToken(trimmed);
  return context.producers.get(root) ?? null;
}

function getOrCreateStartInputProducer(
  expression: string,
  inputLabel: string,
  context: OverviewBuildContext
): DataProducer {
  const existing = context.producers.get(expression);
  if (existing) return existing;

  const startNode = context.nodes.find((node) => node.id === 'start');
  const label = inputLabel || expression.replace(/^input\./, '');
  const port: FlowCanvasDataPort = {
    id: createDataPortId('output', label, startNode?.data.dataPorts?.length ?? 0),
    direction: 'output',
    label,
    expression,
    kind: 'scalar',
  };
  if (startNode) {
    startNode.data.dataPorts = [...(startNode.data.dataPorts ?? []), port];
  }
  const producer = dataProducerFromPort('start', port);
  context.producers.set(expression, producer);
  return producer;
}

function getTemplateDataPorts(
  variableName: string,
  template: FlowDefinition['nodes'][number] | undefined,
  isArray: boolean
): FlowCanvasDataPort[] {
  const outputs = getTemplateOutputs(variableName, template, isArray);
  return outputs.map((output, index) => ({
    id: createDataPortId('output', dataPortOutputLabel(output), index),
    direction: 'output',
    label: dataPortOutputLabel(output),
    expression: output.expression,
    kind: output.kind,
    ...(isArrayOutputLabel(output.label) ? { isArray: true } : {}),
  }));
}

function dataPortOutputLabel(output: FlowCanvasOutput): string {
  if (output.kind === 'node') {
    return agentPortLabel(output.label.endsWith('[]'));
  }
  return output.label;
}

function isArrayOutputLabel(label: string): boolean {
  return label.endsWith('[]');
}

function registerOutputProducers(
  variableName: string,
  nodeId: string,
  ports: FlowCanvasDataPort[],
  context: OverviewBuildContext
): void {
  for (const port of ports) {
    const producer = dataProducerFromPort(nodeId, port);
    context.producers.set(port.expression, producer);
    if (port.kind === 'node' && port.expression === variableName) {
      context.producers.set(variableName, producer);
    }
  }
}

function dataProducerFromPort(nodeId: string, port: FlowCanvasDataPort): DataProducer {
  return {
    nodeId,
    portId: port.id,
    label: port.label,
    expression: port.expression,
    kind: port.kind,
    isArray: Boolean(port.isArray),
  };
}

function createDataPortId(direction: FlowCanvasDataPortDirection, label: string, index: number): string {
  const prefix = direction === 'input' ? 'in' : 'out';
  return `${prefix}:${slugifyDataPortLabel(label)}:${index}`;
}

function slugifyDataPortLabel(label: string): string {
  return label
    .replace(/\[\]/g, '-array')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'data';
}

function mergePortExpression(current: string, next: string): string {
  if (current.includes(next)) return current;
  return `${current}; ${next}`;
}

function pruneUnusedNodeResultPorts(context: OverviewBuildContext): void {
  const usedOutputHandles = new Set(
    context.edges
      .filter((edge) => edge.data?.kind === 'data' && typeof edge.sourceHandle === 'string')
      .map((edge) => `${edge.source}:${edge.sourceHandle}`)
  );
  for (const node of context.nodes) {
    const ports = node.data.dataPorts;
    if (!ports?.length) continue;
    node.data.dataPorts = ports.filter((port) => (
      port.direction !== 'output'
      || port.kind !== 'node'
      || usedOutputHandles.has(`${node.id}:${port.id}`)
    ));
  }
}

function agentPortLabel(isArray: boolean): string {
  return isArray ? 'agent[]' : 'agent';
}

export function statementNodeId(path: number[]): string {
  return `statement:${path.join('.')}`;
}

export function getStatementKind(statement: FlowStatement): FlowStatementKind {
  if ('call' in statement) return 'call';
  if ('parallel' in statement) return 'parallel';
  if ('value' in statement) return 'set';
  if ('if' in statement) return 'if';
  if ('loop' in statement) return 'loop';
  if ('stop' in statement) return 'stop';
  return 'break';
}

function getBounds(nodes: Node<FlowCanvasNodeData>[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (nodes.length === 0) return null;
  return nodes.reduce((bounds, node) => {
    const width = typeof node.style?.width === 'number' ? node.style.width : 240;
    const height = typeof node.style?.height === 'number' ? node.style.height : 128;
    return {
      minX: Math.min(bounds.minX, node.position.x),
      minY: Math.min(bounds.minY, node.position.y),
      maxX: Math.max(bounds.maxX, node.position.x + width),
      maxY: Math.max(bounds.maxY, node.position.y + height),
    };
  }, {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  });
}

export function getStatementLabel(statement: FlowStatement): string {
  if ('call' in statement) return statement.call;
  if ('parallel' in statement) return statement.parallel.call;
  if ('value' in statement) return `set ${statement.set}`;
  if ('if' in statement) return statement.if;
  if ('loop' in statement) return `loop max ${statement.loop.max_rounds}`;
  if ('stop' in statement) return `stop: ${statement.stop}`;
  return 'break';
}

function getStatementMeta(statement: FlowStatement): string | undefined {
  if ('call' in statement) return `set ${statement.set}${statement.parent ? ` · parent ${statement.parent}` : ''}`;
  if ('parallel' in statement) {
    return `set ${statement.set} · ${String(statement.parallel.count)} branches${statement.parallel.parent ? ` · parent ${statement.parallel.parent}` : ''}`;
  }
  if ('value' in statement) return formatScalar(statement.value);
  if ('if' in statement) return 'conditional branch';
  if ('loop' in statement) return `${statement.loop.steps.length} steps`;
  return undefined;
}

function getOverviewStatementMeta(statement: FlowStatement): string | undefined {
  if ('parallel' in statement) return `${String(statement.parallel.count)} branches`;
  if ('loop' in statement) return `${statement.loop.steps.length} steps · max ${statement.loop.max_rounds}`;
  if ('if' in statement) return 'decision';
  if ('call' in statement) return `sets ${statement.set}`;
  return getStatementMeta(statement);
}

function formatScalar(value: unknown): string {
  if (value === null) return 'null';
  return String(value);
}

function getStatementAnnotations(
  definition: FlowDefinition,
  statement: FlowStatement
): Pick<FlowCanvasNodeData, 'contextLabel' | 'outputs' | 'dataBindings' | 'outcomes' | 'groupLabel'> {
  if ('call' in statement) {
    const template = definition.nodes.find((node) => node.id === statement.call);
    return {
      contextLabel: statement.parent ?? template?.parent ?? 'root',
      outputs: getTemplateOutputs(statement.set, template, false),
      dataBindings: argsToDataBindings(statement.args),
    };
  }
  if ('parallel' in statement) {
    const template = definition.nodes.find((node) => node.id === statement.parallel.call);
    return {
      contextLabel: statement.parallel.parent ?? template?.parent ?? 'root',
      outputs: getTemplateOutputs(statement.set, template, true),
      dataBindings: argsToDataBindings(statement.parallel.args),
    };
  }
  if ('loop' in statement) {
    return { groupLabel: 'Loop group' };
  }
  return {};
}

function getTemplateOutputs(
  variableName: string,
  template: FlowDefinition['nodes'][number] | undefined,
  isArray: boolean
): FlowCanvasOutput[] {
  const outputs: FlowCanvasOutput[] = [];
  const suffix = isArray ? '[]' : '';
  if (template?.requiresFinalizedCommit) {
    outputs.push({
      label: `commit${suffix}`,
      expression: `${variableName}.commit`,
      kind: 'commit',
      importance: 'primary',
    });
  }
  for (const [key, definition] of Object.entries(template?.returns ?? {})) {
    outputs.push({
      label: `${key}${suffix}`,
      expression: `${variableName}.${key}`,
      kind: key === 'verdict' || (Array.isArray(definition) && definition.includes('pass') && definition.includes('fail'))
        ? 'verdict'
        : 'scalar',
      importance: key === 'verdict' ? 'primary' : 'secondary',
    });
  }
  outputs.push({
    label: `node${suffix}`,
    expression: variableName,
    kind: 'node',
    importance: 'secondary',
  });
  return outputs;
}

function argsToDataBindings(args: Record<string, string> | undefined): FlowCanvasDataBinding[] | undefined {
  const bindings = Object.entries(args ?? {}).map(([target, expression]) => ({ target, expression }));
  return bindings.length ? bindings : undefined;
}

function addDataBinding(context: BuildContext, nodeId: string, binding: FlowCanvasDataBinding): void {
  const node = context.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  node.data.dataBindings = [...(node.data.dataBindings ?? []), binding];
}

function addOutcome(context: BuildContext, nodeId: string, outcome: string): void {
  const node = context.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  node.data.outcomes = [...(node.data.outcomes ?? []), outcome];
}

function recordSetProducer(target: string, value: unknown, context: OverviewBuildContext): void {
  if (typeof value !== 'string') return;
  const expression = value.trim();
  const producer = context.producers.get(expression)
    ?? (expression.includes('.') ? null : context.producers.get(rootToken(expression)));
  if (producer) {
    context.producers.set(target, producer);
    if (!expression.includes('.')) {
      aliasProducerFields(target, expression, context);
    }
  }
}

function aliasProducerFields(target: string, sourceExpression: string, context: OverviewBuildContext): void {
  const sourcePrefix = `${sourceExpression}.`;
  for (const [key, producer] of Array.from(context.producers.entries())) {
    if (key.startsWith(sourcePrefix)) {
      context.producers.set(`${target}.${key.slice(sourcePrefix.length)}`, producer);
    }
  }
}

function rootToken(expression: string): string {
  return expression.trim().split('.')[0] ?? expression.trim();
}

export function getStatementAtPath(definition: FlowDefinition, path: number[]): FlowStatement | null {
  if (path.length === 0) return null;
  let statements = definition.run;
  for (let depth = 0; depth < path.length; depth += 1) {
    const statement = statements[path[depth]];
    if (!statement) return null;
    if (depth === path.length - 1) return statement;
    if ('if' in statement) {
      statements = Array.isArray(statement.then) ? statement.then : [statement.then];
    } else if ('loop' in statement) {
      statements = statement.loop.steps;
    } else {
      return null;
    }
  }
  return null;
}

export function updateStatementAtPath(
  definition: FlowDefinition,
  path: number[],
  nextStatement: FlowStatement
): FlowDefinition {
  return mutateDefinitionStatements(definition, path, (statements, index) => {
    statements[index] = nextStatement;
  });
}

export function insertStatementAfterPath(
  definition: FlowDefinition,
  path: number[],
  statement: FlowStatement
): FlowDefinition {
  return mutateDefinitionStatements(definition, path, (statements, index) => {
    statements.splice(index + 1, 0, statement);
  });
}

export function insertStatementIntoPath(
  definition: FlowDefinition,
  path: number[],
  statement: FlowStatement
): FlowDefinition {
  const next = cloneDefinition(definition);
  const target = getStatementAtPath(next, path);
  if (!target) return next;
  if ('if' in target) {
    const thenStatements = Array.isArray(target.then) ? [...target.then] : [target.then];
    target.then = [...thenStatements, statement];
  } else if ('loop' in target) {
    target.loop.steps = [...target.loop.steps, statement];
  }
  return next;
}

export function appendStatementToRun(definition: FlowDefinition, statement: FlowStatement): FlowDefinition {
  const next = cloneDefinition(definition);
  next.run = [...next.run, statement];
  return next;
}

export function deleteStatementAtPath(definition: FlowDefinition, path: number[]): FlowDefinition {
  return mutateDefinitionStatements(definition, path, (statements, index) => {
    statements.splice(index, 1);
  });
}

export function moveStatementAtPath(
  definition: FlowDefinition,
  path: number[],
  direction: -1 | 1
): FlowDefinition {
  return mutateDefinitionStatements(definition, path, (statements, index) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= statements.length) return;
    const [statement] = statements.splice(index, 1);
    statements.splice(nextIndex, 0, statement);
  });
}

export function duplicateStatementAtPath(definition: FlowDefinition, path: number[]): FlowDefinition {
  const statement = getStatementAtPath(definition, path);
  if (!statement) return definition;
  return insertStatementAfterPath(definition, path, cloneStatement(statement));
}

export function createDefaultFlowStatement(kind: FlowStatementKind, definition: FlowDefinition): FlowStatement {
  const firstTemplateId = definition.nodes[0]?.id ?? 'Worker';
  switch (kind) {
    case 'call':
      return { set: toSetName(firstTemplateId), call: firstTemplateId, parent: 'root' };
    case 'parallel':
      return { set: `${toSetName(firstTemplateId)}s`, parallel: { count: defaultParallelCount(definition), call: firstTemplateId, parent: 'root' } };
    case 'set':
      return { set: 'value', value: 'root' };
    case 'if':
      return { if: 'value == null', then: { stop: 'condition_matched' } };
    case 'loop':
      return { loop: { max_rounds: 2, steps: [{ set: toSetName(firstTemplateId), call: firstTemplateId, parent: 'root' }] } };
    case 'stop':
      return { stop: 'stopped' };
    case 'break':
      return { break: true };
  }
}

function getStatementLocation(
  definition: FlowDefinition,
  path: number[]
): { statements: FlowStatement[]; index: number } | null {
  if (path.length === 0) return null;
  let statements = definition.run;
  for (let depth = 0; depth < path.length - 1; depth += 1) {
    const statement = statements[path[depth]];
    if (!statement) return null;
    if ('if' in statement) {
      const thenStatements = Array.isArray(statement.then) ? statement.then : [statement.then];
      statement.then = thenStatements;
      statements = thenStatements;
    } else if ('loop' in statement) {
      statements = statement.loop.steps;
    } else {
      return null;
    }
  }
  return { statements, index: path[path.length - 1] };
}

function mutateDefinitionStatements(
  definition: FlowDefinition,
  path: number[],
  mutate: (statements: FlowStatement[], index: number) => void
): FlowDefinition {
  const next = cloneDefinition(definition);
  const location = getStatementLocation(next, path);
  if (!location) return next;
  mutate(location.statements, location.index);
  return next;
}

function cloneDefinition(definition: FlowDefinition): FlowDefinition {
  return {
    flow: { ...definition.flow },
    ...(definition.inputs ? { inputs: structuredClone(definition.inputs) } : {}),
    nodes: structuredClone(definition.nodes),
    run: structuredClone(definition.run),
  };
}

function cloneStatement(statement: FlowStatement): FlowStatement {
  return structuredClone(statement);
}

function defaultParallelCount(definition: FlowDefinition): string | number {
  const integerInput = Object.entries(definition.inputs ?? {}).find(([, input]) => (
    input.type === 'integer' &&
    (input.min ?? 1) >= 1 &&
    (input.max ?? 8) <= 8
  ));
  return integerInput ? `input.${integerInput[0]}` : 2;
}

function toSetName(templateId: string): string {
  const normalized = templateId.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const lower = normalized ? normalized[0].toLowerCase() + normalized.slice(1) : 'node';
  return /^[A-Za-z_]/.test(lower) ? lower : `node_${lower}`;
}
