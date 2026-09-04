import { describe, expect, it } from 'vitest';
import { compileFlowDefinition } from './flowNodeRegistry';
import {
  appendStatementToRun,
  createDefaultFlowStatement,
  deleteStatementAtPath,
  duplicateStatementAtPath,
  flowDefinitionToCanvasModel,
  getStatementAtPath,
  insertStatementAfterPath,
  insertStatementIntoPath,
  moveStatementAtPath,
  updateStatementAtPath,
} from './flowCanvasModel';
import type { FlowDefinition } from './types';

const definition: FlowDefinition = {
  flow: { id: 'canvas', label: 'Canvas' },
  inputs: {
    input: { type: 'string' },
    count: { type: 'integer', min: 1, max: 4, default: 2 },
  },
  nodes: [
    { id: 'Worker', params: ['request'], paramTypes: { request: ['string'] }, parent: 'root', requiresFinalizedCommit: true, prompt: 'work {{ request }}' },
    { id: 'Reviewer', params: ['commit'], paramTypes: { commit: ['commit[]'] }, parent: 'root', returns: { verdict: ['pass', 'fail'] }, prompt: 'review {{ commit }}' },
  ],
  run: [
    { set: 'workers', parallel: { count: 'input.count', call: 'Worker', parent: 'root', args: { request: 'input.input' } } },
    { if: 'all(workers.commit == null)', then: { stop: 'missing_commit' } },
    {
      loop: {
        max_rounds: 2,
        steps: [
          { set: 'reviewer', call: 'Reviewer', parent: 'root', args: { commit: 'workers.commit' } },
          { if: 'reviewer.verdict == pass', then: { break: true } },
        ],
      },
    },
  ],
};

function compiledDefinitionToSource(definition: FlowDefinition): unknown {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => ({
      ...node,
      params: node.params?.length
        ? Object.fromEntries((node.params ?? []).map((param) => [
          param,
          (node.paramTypes?.[param] ?? ['scalar']).join(' | '),
        ]))
        : undefined,
      paramTypes: undefined,
    })),
  };
}

describe('flow canvas model', () => {
  it('projects compiled flow statements into selectable React Flow nodes and control edges', () => {
    const model = flowDefinitionToCanvasModel(definition);

    expect(model.nodes.map((node) => [node.id, node.data.kind, node.data.label])).toEqual([
      ['start', 'start', 'Start'],
      ['statement:0', 'parallel', 'Worker'],
      ['statement:1', 'if', 'all(workers.commit == null)'],
      ['statement:1.0', 'stop', 'stop: missing_commit'],
      ['statement:2', 'loop', 'loop max 2'],
      ['statement:2.0', 'call', 'Reviewer'],
      ['statement:2.1', 'if', 'reviewer.verdict == pass'],
      ['statement:2.1.0', 'break', 'break'],
      ['done', 'done', 'Done'],
    ]);
    expect(model.edges.map((edge) => [edge.source, edge.target, edge.label])).toContainEqual([
      'statement:1',
      'statement:1.0',
      'true',
    ]);
    expect(model.edges.map((edge) => [edge.source, edge.target, edge.label])).toContainEqual([
      'statement:2.0',
      'statement:2.1',
      undefined,
    ]);
  });

  it('projects an overview graph that hides plumbing and keeps context/data on primary nodes', () => {
    const model = flowDefinitionToCanvasModel(definition, { mode: 'overview' });

    expect(model.nodes.map((node) => [node.id, node.data.kind, node.data.label])).toEqual([
      ['start', 'start', 'Start'],
      ['statement:0', 'group', 'Parallel'],
      ['statement:0:call', 'call', 'Worker'],
      ['statement:1', 'if', 'all(workers.commit == null)'],
      ['statement:2', 'group', 'Loop'],
      ['statement:2.0', 'call', 'Reviewer'],
      ['statement:2.1', 'if', 'reviewer.verdict == pass'],
      ['done', 'done', 'Done'],
    ]);
    expect(model.nodes.some((node) => node.data.kind === 'set')).toBe(false);
    expect(model.nodes.some((node) => node.data.kind === 'break')).toBe(false);
    expect(model.nodes.some((node) => node.data.kind === 'stop')).toBe(false);
    expect(model.nodes.find((node) => node.id === 'statement:0')?.data.outputs).toContainEqual({
      label: 'node[]',
      expression: 'workers',
      kind: 'node',
      importance: 'secondary',
    });
    expect(model.nodes.find((node) => node.id === 'start')?.data.dataPorts).toContainEqual({
      id: 'out:request:0',
      direction: 'output',
      label: 'request',
      expression: 'input.input',
      kind: 'scalar',
    });
    expect(model.nodes.find((node) => node.id === 'statement:0:call')?.data.dataPorts).toEqual([
      {
        id: 'in:request:0',
        direction: 'input',
        label: 'request',
        expression: 'request: input.input',
        kind: 'scalar',
      },
      {
        id: 'out:commit:0',
        direction: 'output',
        label: 'commit',
        expression: 'workers.commit',
        kind: 'commit',
      },
    ]);
    expect(model.nodes.find((node) => node.id === 'statement:0')?.data.dataPorts).toContainEqual({
      id: 'out:commit-array:0',
      direction: 'output',
      label: 'commit[]',
      expression: 'workers.commit',
      kind: 'commit',
      isArray: true,
    });
    expect(model.nodes.find((node) => node.id === 'statement:2.0')?.data.dataPorts).toContainEqual({
      id: 'in:commit-array:0',
      direction: 'input',
      label: 'commit[]',
      expression: 'commit: workers.commit',
      kind: 'commit',
      isArray: true,
    });
    expect(model.edges.map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle, edge.data?.kind])).toContainEqual([
      'start',
      'out:request:0',
      'statement:0:call',
      'in:request:0',
      'data',
    ]);
    expect(model.edges.map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle, edge.data?.kind])).toContainEqual([
      'statement:0',
      'out:commit-array:0',
      'statement:2.0',
      'in:commit-array:0',
      'data',
    ]);
    expect(model.nodes.find((node) => node.id === 'statement:2.0')?.data.outputs).toContainEqual({
      label: 'verdict',
      expression: 'reviewer.verdict',
      kind: 'verdict',
      importance: 'primary',
    });
    expect(model.nodes.find((node) => node.id === 'statement:1')?.data.outcomes).toEqual(['stop: missing_commit']);
    expect(model.nodes.find((node) => node.id === 'statement:2.1')?.data.outcomes).toEqual(['break']);
    expect(model.edges.some((edge) => edge.label === 'false')).toBe(false);
  });

  it('keeps handoff literals out of overview ports while showing real runtime-node dependencies', () => {
    const handoffDefinition: FlowDefinition = {
      ...definition,
      nodes: [
        ...definition.nodes,
        {
          id: 'Handoff',
          params: ['request', 'phase', 'source_nodes', 'review', 'focus'],
          paramTypes: {
            request: ['string'],
            phase: ['string'],
            source_nodes: ['agent', 'agent[]'],
            review: ['agent', 'string'],
            focus: ['string'],
          },
          parent: 'root',
          prompt: 'handoff {{ request }}',
        },
      ],
      run: [
        ...definition.run,
        { set: 'handoff', call: 'Handoff', parent: 'root', args: {
          request: 'input.input',
          phase: 'implementation handoff',
          source_nodes: 'reviewer',
          review: 'reviewer',
          focus: 'Summarize the final implementation in simple words.',
        } },
      ],
    };

    const model = flowDefinitionToCanvasModel(handoffDefinition, { mode: 'overview' });
    const handoff = model.nodes.find((node) => node.id === 'statement:3');
    const reviewer = model.nodes.find((node) => node.id === 'statement:2.0');

    expect(handoff?.data.dataPorts?.filter((port) => port.direction === 'input')).toEqual([
      {
        id: 'in:request:0',
        direction: 'input',
        label: 'request',
        expression: 'request: input.input',
        kind: 'scalar',
      },
      {
        id: 'in:agent:1',
        direction: 'input',
        label: 'agent',
        expression: 'source_nodes: reviewer; review: reviewer',
        kind: 'node',
        count: 2,
      },
    ]);
    expect(handoff?.data.dataPorts?.some((port) => port.label === 'phase' || port.label === 'focus')).toBe(false);
    expect(reviewer?.data.dataPorts).toContainEqual({
      id: 'out:agent:1',
      direction: 'output',
      label: 'agent',
      expression: 'reviewer',
      kind: 'node',
    });
    expect(model.edges.map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle, edge.data?.kind])).toContainEqual([
      'statement:2.0',
      'out:agent:1',
      'statement:3',
      'in:agent:1',
      'data',
    ]);
  });

  it('resolves commit fields through set aliases without falling back to the parent agent result', () => {
    const aliasDefinition: FlowDefinition = {
      flow: { id: 'alias', label: 'Alias' },
      inputs: { input: { type: 'string' } },
      nodes: [
        { id: 'Implementer', params: ['request'], paramTypes: { request: ['string'] }, parent: 'root', requiresFinalizedCommit: true, prompt: 'implement {{ request }}' },
        { id: 'Reviewer', params: ['commit'], paramTypes: { commit: ['commit'] }, parent: 'root', returns: { verdict: ['pass', 'fail'] }, prompt: 'review {{ commit }}' },
      ],
      run: [
        { set: 'impl', call: 'Implementer', parent: 'root', args: { request: 'input.input' } },
        { set: 'implementation', value: 'impl' },
        { set: 'current_commit', value: 'implementation.commit' },
        { set: 'reviewer', call: 'Reviewer', parent: 'root', args: { commit: 'current_commit' } },
      ],
    };

    const model = flowDefinitionToCanvasModel(aliasDefinition, { mode: 'overview' });
    const reviewer = model.nodes.find((node) => node.id === 'statement:3');

    expect(reviewer?.data.dataPorts).toContainEqual({
      id: 'in:commit:0',
      direction: 'input',
      label: 'commit',
      expression: 'commit: current_commit',
      kind: 'commit',
    });
    expect(reviewer?.data.dataPorts?.some((port) => port.kind === 'node' && port.label === 'commit')).toBe(false);
    expect(model.edges.map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle, edge.data?.kind])).toContainEqual([
      'statement:0',
      'out:commit:0',
      'statement:3',
      'in:commit:0',
      'data',
    ]);
  });

  it('projects a tidy context tree from root through resolved parent nodes', () => {
    const contextDefinition: FlowDefinition = {
      ...definition,
      nodes: [
        ...definition.nodes,
        { id: 'Fixer', params: ['review'], paramTypes: { review: ['agent'] }, parent: 'root', prompt: 'fix {{ review }}' },
        { id: 'Handoff', params: ['source'], paramTypes: { source: ['agent'] }, parent: 'root', prompt: 'handoff {{ source }}' },
      ],
      run: [
        ...definition.run,
        { set: 'fixer_parent', value: 'reviewer' },
        { set: 'fixer', call: 'Fixer', parent: 'fixer_parent', args: { review: 'reviewer' } },
        { set: 'handoff', call: 'Handoff', parent: 'fixer', args: { source: 'fixer' } },
      ],
    };

    const model = flowDefinitionToCanvasModel(contextDefinition, { mode: 'context' });

    expect(model.nodes.map((node) => [node.id, node.data.kind, node.data.label])).toEqual([
      ['context:root', 'start', 'Root'],
      ['statement:0', 'parallel', 'Worker'],
      ['statement:2.0', 'call', 'Reviewer'],
      ['statement:4', 'call', 'Fixer'],
      ['statement:5', 'call', 'Handoff'],
    ]);
    expect(model.edges.map((edge) => [edge.source, edge.target, edge.data?.kind])).toEqual([
      ['context:root', 'statement:0', 'context'],
      ['context:root', 'statement:2.0', 'context'],
      ['statement:2.0', 'statement:4', 'context'],
      ['statement:4', 'statement:5', 'context'],
    ]);
    const worker = model.nodes.find((node) => node.id === 'statement:0');
    const reviewer = model.nodes.find((node) => node.id === 'statement:2.0');
    const fixer = model.nodes.find((node) => node.id === 'statement:4');
    const handoff = model.nodes.find((node) => node.id === 'statement:5');

    expect(worker?.position.y).toBe(reviewer?.position.y);
    expect(fixer?.position.y).toBeGreaterThan(reviewer?.position.y ?? 0);
    expect(handoff?.position.y).toBeGreaterThan(fixer?.position.y ?? 0);
    expect(model.nodes.some((node) => node.data.kind === 'set')).toBe(false);
    expect(model.nodes.some((node) => node.data.kind === 'if')).toBe(false);
  });

  it('updates, inserts, duplicates, moves, and deletes statements while preserving a valid AST', () => {
    const updated = updateStatementAtPath(definition, [0], {
      set: 'workers',
      parallel: { count: 3, call: 'Worker', parent: 'root', args: { request: 'input.input' } },
    });
    expect(getStatementAtPath(updated, [0])).toEqual({
      set: 'workers',
      parallel: { count: 3, call: 'Worker', parent: 'root', args: { request: 'input.input' } },
    });

    const inserted = insertStatementAfterPath(updated, [0], { set: 'commit', value: 'workers.commit' });
    expect(getStatementAtPath(inserted, [1])).toEqual({ set: 'commit', value: 'workers.commit' });

    const nested = insertStatementIntoPath(inserted, [3], { set: 'review_commit', value: 'reviewer.commit' });
    expect(getStatementAtPath(nested, [3, 2])).toEqual({ set: 'review_commit', value: 'reviewer.commit' });

    const duplicated = duplicateStatementAtPath(nested, [1]);
    expect(getStatementAtPath(duplicated, [2])).toEqual({ set: 'commit', value: 'workers.commit' });

    const moved = moveStatementAtPath(duplicated, [2], -1);
    expect(getStatementAtPath(moved, [1])).toEqual({ set: 'commit', value: 'workers.commit' });

    const deleted = deleteStatementAtPath(moved, [1]);
    expect(getStatementAtPath(deleted, [1])).toEqual({ set: 'commit', value: 'workers.commit' });
    expect(compileFlowDefinition(compiledDefinitionToSource(deleted)).issues).toEqual([]);
  });

  it('appends default statements that can be edited and validated by the existing compiler', () => {
    const withCall = appendStatementToRun(definition, createDefaultFlowStatement('call', definition));
    const appended = getStatementAtPath(withCall, [definition.run.length]);

    expect(appended).toEqual({ set: 'worker', call: 'Worker', parent: 'root' });
    expect(compileFlowDefinition(compiledDefinitionToSource(withCall)).issues).toEqual([]);
  });

  it('reads nested single-statement if branches without mutating the source definition', () => {
    const originalThen = definition.run[1] && 'if' in definition.run[1] ? definition.run[1].then : null;
    expect(getStatementAtPath(definition, [1, 0])).toEqual({ stop: 'missing_commit' });
    expect(definition.run[1] && 'if' in definition.run[1] ? definition.run[1].then : null).toBe(originalThen);
  });
});
