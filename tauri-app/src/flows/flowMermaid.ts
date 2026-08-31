import type { FlowDefinition, FlowStatement } from './types';

export interface FlowMermaidOptions {
  debugSetStatements?: boolean;
}

interface EdgeTail {
  id: string;
  label?: string;
}

interface FlowTails {
  next: EdgeTail[];
  breaks: EdgeTail[];
}

interface MermaidBuildContext {
  lines: string[];
  edges: string[];
  counter: number;
  options: FlowMermaidOptions;
}

export function buildFlowRunMermaid(definition: FlowDefinition, options: FlowMermaidOptions = {}): string {
  const context: MermaidBuildContext = {
    lines: [
      'flowchart LR',
      '  start(("Start"))',
      '  done(("Done"))',
    ],
    edges: [],
    counter: 0,
    options,
  };

  const tails = appendStatements(definition, [{ id: 'start' }], definition.run, context);
  const terminalTails = [...tails.next, ...tails.breaks];
  for (const tail of terminalTails.length > 0 ? terminalTails : [{ id: 'start' }]) {
    connect(context, tail, 'done');
  }

  return [
    ...context.lines,
    ...context.edges,
    '  classDef terminalStep fill:#f8fafc,stroke:#94a3b8,color:#0f172a,stroke-width:1px;',
    '  classDef agentStep fill:#ecfdf5,stroke:#10b981,color:#064e3b,stroke-width:1px;',
    '  classDef decisionStep fill:#fff7ed,stroke:#f97316,color:#7c2d12,stroke-width:1px;',
    '  classDef controlStep fill:#eef2ff,stroke:#6366f1,color:#312e81,stroke-width:1px;',
    '  class start,done terminalStep;',
  ].join('\n');
}

function appendStatements(
  definition: FlowDefinition,
  incoming: EdgeTail[],
  statements: FlowStatement[],
  context: MermaidBuildContext
): FlowTails {
  let tails = incoming;
  const breaks: EdgeTail[] = [];
  for (const statement of statements) {
    const result = appendStatement(definition, tails, statement, context);
    breaks.push(...result.breaks);
    tails = result.next;
    if (tails.length === 0) break;
  }
  return { next: tails, breaks };
}

function appendStatement(
  definition: FlowDefinition,
  incoming: EdgeTail[],
  statement: FlowStatement,
  context: MermaidBuildContext
): FlowTails {
  if ('call' in statement) {
    const id = addNode(context, statement.call, 'agentStep');
    incoming.forEach((tail) => connect(context, tail, id));
    return { next: [{ id }], breaks: [] };
  }

  if ('parallel' in statement) {
    return { next: appendParallel(definition, incoming, statement, context), breaks: [] };
  }

  if ('if' in statement) {
    const id = addNode(context, statement.if, 'decisionStep', 'decision');
    incoming.forEach((tail) => connect(context, tail, id));
    const thenSteps = Array.isArray(statement.then) ? statement.then : [statement.then];
    const thenTails = appendStatements(definition, [{ id, label: 'true' }], thenSteps, context);
    return {
      next: [...thenTails.next, { id, label: 'false' }],
      breaks: thenTails.breaks,
    };
  }

  if ('loop' in statement) {
    const id = addNode(context, `loop max ${statement.loop.max_rounds}`, 'controlStep', 'decision');
    incoming.forEach((tail) => connect(context, tail, id));
    const loopTails = appendStatements(definition, [{ id, label: 'round' }], statement.loop.steps, context);
    loopTails.next.forEach((tail) => connect(context, tail, id, tail.label ?? 'next'));
    return {
      next: [{ id, label: 'done' }, ...loopTails.breaks],
      breaks: [],
    };
  }

  if ('stop' in statement) {
    const id = addNode(context, `stop: ${statement.stop}`, 'terminalStep', 'terminal');
    incoming.forEach((tail) => connect(context, tail, id));
    return { next: [], breaks: [] };
  }

  if ('break' in statement) {
    const id = addNode(context, 'break', 'controlStep', 'terminal');
    incoming.forEach((tail) => connect(context, tail, id));
    return { next: [], breaks: [{ id, label: 'break' }] };
  }

  if ('value' in statement && context.options.debugSetStatements) {
    const id = addNode(context, `set ${statement.set}`, 'controlStep');
    incoming.forEach((tail) => connect(context, tail, id));
    return { next: [{ id }], breaks: [] };
  }

  return { next: incoming, breaks: [] };
}

function appendParallel(
  definition: FlowDefinition,
  incoming: EdgeTail[],
  statement: Extract<FlowStatement, { parallel: unknown }>,
  context: MermaidBuildContext
): EdgeTail[] {
  const branchCount = resolveParallelBranchCount(definition, statement.parallel.count);
  const subgraphId = `parallel_${nextId(context)}`;
  context.lines.push(`  subgraph ${subgraphId}["parallel"]`);
  context.lines.push('    direction TB');
  const branchIds = Array.from({ length: branchCount }, (_, index) => {
    const branchId = `${subgraphId}_branch_${index + 1}`;
    context.lines.push(`    ${branchId}["${escapeMermaidLabel(`${statement.parallel.call} ${index + 1}`)}"]`);
    context.lines.push(`    class ${branchId} agentStep;`);
    return branchId;
  });
  context.lines.push('  end');
  for (const tail of incoming) {
    branchIds.forEach((branchId) => connect(context, tail, branchId));
  }
  return branchIds.map((id) => ({ id }));
}

function addNode(
  context: MermaidBuildContext,
  label: string,
  className: 'agentStep' | 'decisionStep' | 'controlStep' | 'terminalStep',
  shape: 'action' | 'decision' | 'terminal' = 'action'
): string {
  const id = `step_${nextId(context)}`;
  const escaped = escapeMermaidLabel(label);
  if (shape === 'decision') {
    context.lines.push(`  ${id}{"${escaped}"}`);
  } else if (shape === 'terminal') {
    context.lines.push(`  ${id}(("${escaped}"))`);
  } else {
    context.lines.push(`  ${id}["${escaped}"]`);
  }
  context.lines.push(`  class ${id} ${className};`);
  return id;
}

function connect(context: MermaidBuildContext, from: EdgeTail, to: string, overrideLabel?: string): void {
  const label = overrideLabel ?? from.label;
  context.edges.push(label
    ? `  ${from.id} -->|${escapeMermaidLabel(label)}| ${to}`
    : `  ${from.id} --> ${to}`);
}

function nextId(context: MermaidBuildContext): number {
  context.counter += 1;
  return context.counter;
}

function escapeMermaidLabel(label: string): string {
  return label.replace(/"/g, "'").replace(/\n/g, ' ');
}

function resolveParallelBranchCount(definition: FlowDefinition, count: string | number): number {
  if (typeof count === 'number') {
    return clampParallelBranchCount(count);
  }

  const inputName = count.match(/^input\.([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  const inputDefault = inputName ? definition.inputs?.[inputName]?.default : undefined;
  if (typeof inputDefault === 'number') {
    return clampParallelBranchCount(inputDefault);
  }

  const parsed = Number.parseInt(count, 10);
  return Number.isFinite(parsed) ? clampParallelBranchCount(parsed) : 3;
}

function clampParallelBranchCount(count: number): number {
  return Math.max(1, Math.min(5, Math.trunc(count)));
}
