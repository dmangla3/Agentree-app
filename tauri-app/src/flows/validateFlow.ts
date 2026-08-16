import type {
  FlowDefinition,
  FlowInputDefinition,
  FlowNodeTemplate,
  FlowStatement,
  FlowValidationIssue,
} from './types';

export interface FlowValidationResult {
  definition: FlowDefinition | null;
  issues: FlowValidationIssue[];
}

type MutableFlowDefinition = {
  flow?: unknown;
  inputs?: unknown;
  nodes?: unknown;
  run?: unknown;
};

const MAX_STATIC_ROUNDS = 8;

export function validateFlowDefinition(input: unknown): FlowValidationResult {
  const issues: FlowValidationIssue[] = [];

  if (!isRecord(input)) {
    return {
      definition: null,
      issues: [{ path: '', message: 'Flow definition must be an object.' }],
    };
  }

  const candidate = input as MutableFlowDefinition;
  const flow = validateFlow(candidate.flow, issues);
  const inputs = validateInputs(candidate.inputs, issues);
  const nodes = validateNodes(candidate.nodes, issues);
  const run = validateRun(candidate.run, nodes.templates, inputs, issues);

  if (!flow) {
    issues.push({ path: 'flow', message: 'Flow definition requires flow metadata.' });
  }
  if (!Array.isArray(candidate.nodes)) {
    issues.push({ path: 'nodes', message: 'Flow definition requires a nodes array.' });
  }
  if (!Array.isArray(candidate.run)) {
    issues.push({ path: 'run', message: 'Flow definition requires a run array.' });
  }

  if (!flow || !Array.isArray(candidate.nodes) || !Array.isArray(candidate.run)) {
    return { definition: null, issues };
  }

  return {
    definition: {
      flow,
      inputs,
      nodes: nodes.templates,
      run,
    },
    issues,
  };
}

function validateFlow(input: unknown, issues: FlowValidationIssue[]): FlowDefinition['flow'] | null {
  if (!isRecord(input)) {
    return null;
  }

  const id = input.id;
  if (!isNonEmptyString(id)) {
    issues.push({ path: 'flow.id', message: 'Flow id must be a non-empty string.' });
    return null;
  }

  const label = input.label;
  if (label !== undefined && typeof label !== 'string') {
    issues.push({ path: 'flow.label', message: 'Flow label must be a string when provided.' });
  }

  return typeof label === 'string' ? { id, label } : { id };
}

function validateInputs(input: unknown, issues: FlowValidationIssue[]): Record<string, FlowInputDefinition> | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    issues.push({ path: 'inputs', message: 'Inputs must be an object when provided.' });
    return undefined;
  }

  const result: Record<string, FlowInputDefinition> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isRecord(value)) {
      issues.push({ path: `inputs.${key}`, message: 'Input definition must be an object.' });
      continue;
    }

    const type = value.type;
    if (type !== 'string' && type !== 'integer') {
      issues.push({ path: `inputs.${key}.type`, message: 'Input type must be "string" or "integer".' });
      continue;
    }

    const definition: FlowInputDefinition = { type };
    if (typeof value.default === 'string' || typeof value.default === 'number') {
      definition.default = value.default;
    } else if (value.default !== undefined) {
      issues.push({ path: `inputs.${key}.default`, message: 'Input default must be a string or number.' });
    }

    if (value.min !== undefined) {
      if (typeof value.min === 'number') {
        definition.min = value.min;
      } else {
        issues.push({ path: `inputs.${key}.min`, message: 'Input min must be a number.' });
      }
    }
    if (value.max !== undefined) {
      if (typeof value.max === 'number') {
        definition.max = value.max;
      } else {
        issues.push({ path: `inputs.${key}.max`, message: 'Input max must be a number.' });
      }
    }
    result[key] = definition;
  }

  return result;
}

function validateNodes(
  input: unknown,
  issues: FlowValidationIssue[]
): { templates: FlowNodeTemplate[]; byId: Map<string, FlowNodeTemplate> } {
  const templates: FlowNodeTemplate[] = [];
  const byId = new Map<string, FlowNodeTemplate>();
  if (!Array.isArray(input)) {
    return { templates, byId };
  }

  input.forEach((value, index) => {
    const path = `nodes.${index}`;
    if (!isRecord(value)) {
      issues.push({ path, message: 'Node template must be an object.' });
      return;
    }

    const id = value.id;
    if (!isNonEmptyString(id)) {
      issues.push({ path: `${path}.id`, message: 'Node id must be a non-empty string.' });
      return;
    }
    if (byId.has(id)) {
      issues.push({ path: `${path}.id`, message: `Node id "${id}" is already used.` });
    }

    const parent = value.parent;
    if (!isNonEmptyString(parent)) {
      issues.push({ path: `${path}.parent`, message: 'Node parent must be a non-empty string.' });
    }

    const prompt = value.prompt;
    if (!isNonEmptyString(prompt)) {
      issues.push({ path: `${path}.prompt`, message: 'Node prompt must be a non-empty string.' });
    }

    const params = validateParams(value.params, `${path}.params`, issues);
    const returns = validateReturns(value.returns, `${path}.returns`, issues);
    const template: FlowNodeTemplate = {
      id,
      ...(params ? { params } : {}),
      parent: isNonEmptyString(parent) ? parent : '',
      ...(returns ? { returns } : {}),
      prompt: isNonEmptyString(prompt) ? prompt : '',
    };

    templates.push(template);
    if (!byId.has(id)) {
      byId.set(id, template);
    }
  });

  return { templates, byId };
}

function validateParams(input: unknown, path: string, issues: FlowValidationIssue[]): string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    issues.push({ path, message: 'Node params must be an array of strings.' });
    return undefined;
  }

  const seen = new Set<string>();
  const params: string[] = [];
  input.forEach((param, index) => {
    if (!isNonEmptyString(param)) {
      issues.push({ path: `${path}.${index}`, message: 'Node param must be a non-empty string.' });
      return;
    }
    if (seen.has(param)) {
      issues.push({ path: `${path}.${index}`, message: `Node param "${param}" is already used.` });
    }
    seen.add(param);
    params.push(param);
  });
  return params;
}

function validateReturns(
  input: unknown,
  path: string,
  issues: FlowValidationIssue[]
): FlowNodeTemplate['returns'] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    issues.push({ path, message: 'Node returns must be an object.' });
    return undefined;
  }

  const result: NonNullable<FlowNodeTemplate['returns']> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === 'string' || value === 'integer' || value === 'node') {
      result[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => isNonEmptyString(entry))) {
      result[key] = value;
      continue;
    }
    issues.push({ path: `${path}.${key}`, message: 'Return definition must be a scalar type or enum string array.' });
  }
  return result;
}

function validateRun(
  input: unknown,
  nodeTemplates: FlowNodeTemplate[],
  inputs: Record<string, FlowInputDefinition> | undefined,
  issues: FlowValidationIssue[]
): FlowStatement[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const templatesById = new Map(nodeTemplates.map((node) => [node.id, node]));
  return input
    .map((statement, index) => validateStatement(statement, `run.${index}`, templatesById, inputs, issues))
    .filter((statement): statement is FlowStatement => statement !== null);
}

function validateStatement(
  input: unknown,
  path: string,
  nodeTemplates: Map<string, FlowNodeTemplate>,
  inputs: Record<string, FlowInputDefinition> | undefined,
  issues: FlowValidationIssue[]
): FlowStatement | null {
  if (!isRecord(input)) {
    issues.push({ path, message: 'Statement must be an object.' });
    return null;
  }

  const shape = detectStatementShape(input);
  if (!shape) {
    issues.push({ path, message: 'Statement must match exactly one supported shape.' });
    return null;
  }

  switch (shape) {
    case 'call':
      validateSetKey(input.set, `${path}.set`, issues);
      validateCall(input.call, input.args, path, nodeTemplates, issues);
      return {
        set: typeof input.set === 'string' ? input.set : '',
        call: typeof input.call === 'string' ? input.call : '',
        ...(isRecord(input.args) ? { args: stringifyRecord(input.args) } : {}),
      };
    case 'parallel':
      validateSetKey(input.set, `${path}.set`, issues);
      return validateParallelStatement(input, path, nodeTemplates, inputs, issues);
    case 'set':
      validateSetKey(input.set, `${path}.set`, issues);
      return {
        set: typeof input.set === 'string' ? input.set : '',
        value: input.value as string | number | boolean | null,
      };
    case 'if':
      return validateIfStatement(input, path, nodeTemplates, inputs, issues);
    case 'loop':
      return validateLoopStatement(input, path, nodeTemplates, inputs, issues);
    case 'stop':
      if (!isNonEmptyString(input.stop)) {
        issues.push({ path: `${path}.stop`, message: 'Stop reason must be a non-empty string.' });
      }
      return { stop: typeof input.stop === 'string' ? input.stop : '' };
    case 'break':
      if (input.break !== true) {
        issues.push({ path: `${path}.break`, message: 'Break statement must be true.' });
      }
      return { break: true };
  }
}

function validateParallelStatement(
  input: Record<string, unknown>,
  path: string,
  nodeTemplates: Map<string, FlowNodeTemplate>,
  inputs: Record<string, FlowInputDefinition> | undefined,
  issues: FlowValidationIssue[]
): FlowStatement | null {
  if (!isRecord(input.parallel)) {
    issues.push({ path: `${path}.parallel`, message: 'Parallel statement must be an object.' });
    return null;
  }

  const parallel = input.parallel;
  validateCall(parallel.call, parallel.args, `${path}.parallel`, nodeTemplates, issues);
  validateParallelCount(parallel.count, `${path}.parallel.count`, inputs, issues);
  if (parallel.parent !== undefined && !isNonEmptyString(parallel.parent)) {
    issues.push({ path: `${path}.parallel.parent`, message: 'Parallel parent must be a non-empty string.' });
  }

  return {
    set: typeof input.set === 'string' ? input.set : '',
    parallel: {
      count: typeof parallel.count === 'number' || typeof parallel.count === 'string' ? parallel.count : 0,
      call: typeof parallel.call === 'string' ? parallel.call : '',
      ...(isRecord(parallel.args) ? { args: stringifyRecord(parallel.args) } : {}),
      ...(typeof parallel.parent === 'string' ? { parent: parallel.parent } : {}),
    },
  };
}

function validateIfStatement(
  input: Record<string, unknown>,
  path: string,
  nodeTemplates: Map<string, FlowNodeTemplate>,
  inputs: Record<string, FlowInputDefinition> | undefined,
  issues: FlowValidationIssue[]
): FlowStatement | null {
  if (!isNonEmptyString(input.if)) {
    issues.push({ path: `${path}.if`, message: 'If condition must be a non-empty string.' });
  }

  const thenInput = input.then;
  if (Array.isArray(thenInput)) {
    return {
      if: typeof input.if === 'string' ? input.if : '',
      then: thenInput
        .map((statement, index) => validateStatement(statement, `${path}.then.${index}`, nodeTemplates, inputs, issues))
        .filter((statement): statement is FlowStatement => statement !== null),
    };
  }
  const thenStatement = validateStatement(thenInput, `${path}.then`, nodeTemplates, inputs, issues);
  return {
    if: typeof input.if === 'string' ? input.if : '',
    then: thenStatement ?? [],
  };
}

function validateLoopStatement(
  input: Record<string, unknown>,
  path: string,
  nodeTemplates: Map<string, FlowNodeTemplate>,
  inputs: Record<string, FlowInputDefinition> | undefined,
  issues: FlowValidationIssue[]
): FlowStatement | null {
  if (!isRecord(input.loop)) {
    issues.push({ path: `${path}.loop`, message: 'Loop statement must be an object.' });
    return null;
  }

  const maxRounds = input.loop.max_rounds;
  if (!Number.isInteger(maxRounds) || Number(maxRounds) < 1 || Number(maxRounds) > MAX_STATIC_ROUNDS) {
    issues.push({ path: `${path}.loop.max_rounds`, message: 'Loop max_rounds must be an integer from 1 to 8.' });
  }

  const stepsInput = input.loop.steps;
  if (!Array.isArray(stepsInput)) {
    issues.push({ path: `${path}.loop.steps`, message: 'Loop steps must be an array.' });
  }

  return {
    loop: {
      max_rounds: typeof maxRounds === 'number' ? maxRounds : 0,
      steps: Array.isArray(stepsInput)
        ? stepsInput
            .map((statement, index) =>
              validateStatement(statement, `${path}.loop.steps.${index}`, nodeTemplates, inputs, issues)
            )
            .filter((statement): statement is FlowStatement => statement !== null)
        : [],
    },
  };
}

function validateCall(
  call: unknown,
  args: unknown,
  path: string,
  nodeTemplates: Map<string, FlowNodeTemplate>,
  issues: FlowValidationIssue[]
): void {
  if (!isNonEmptyString(call)) {
    issues.push({ path: `${path}.call`, message: 'Call must reference a node template id.' });
    return;
  }

  const template = nodeTemplates.get(call);
  if (!template) {
    issues.push({ path: `${path}.call`, message: `Call references unknown node template "${call}".` });
    return;
  }

  if (args === undefined) {
    return;
  }
  if (!isRecord(args)) {
    issues.push({ path: `${path}.args`, message: 'Args must be an object when provided.' });
    return;
  }

  const params = new Set(template.params ?? []);
  for (const [key, value] of Object.entries(args)) {
    if (!params.has(key)) {
      issues.push({
        path: `${path}.args.${key}`,
        message: `Argument "${key}" is not declared in params for node template "${template.id}".`,
      });
    }
    if (typeof value !== 'string') {
      issues.push({ path: `${path}.args.${key}`, message: `Argument "${key}" must be an expression string.` });
    }
  }
}

function validateParallelCount(
  count: unknown,
  path: string,
  inputs: Record<string, FlowInputDefinition> | undefined,
  issues: FlowValidationIssue[]
): void {
  if (Number.isInteger(count)) {
    if (Number(count) < 1 || Number(count) > MAX_STATIC_ROUNDS) {
      issues.push({ path, message: 'Parallel count must be an integer from 1 to 8.' });
    }
    return;
  }

  if (typeof count !== 'string') {
    issues.push({ path, message: 'Parallel count must be an integer or input path.' });
    return;
  }

  const match = /^input\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(count);
  if (!match) {
    issues.push({ path, message: 'Input-backed parallel count must reference input.<name>.' });
    return;
  }

  const input = inputs?.[match[1]];
  if (!input) {
    issues.push({ path, message: `Input-backed parallel count references unknown input "${match[1]}".` });
    return;
  }
  if (input.type !== 'integer') {
    issues.push({ path, message: 'Input-backed parallel count must reference an integer input.' });
    return;
  }
  if (input.min === undefined || input.max === undefined || input.min < 1 || input.max > MAX_STATIC_ROUNDS) {
    issues.push({ path, message: 'Input-backed parallel count must have min >= 1 and max <= 8.' });
  }
}

function validateSetKey(value: unknown, path: string, issues: FlowValidationIssue[]): void {
  if (!isNonEmptyString(value)) {
    issues.push({ path, message: 'Set target must be a non-empty string.' });
  }
}

function detectStatementShape(input: Record<string, unknown>):
  | 'call'
  | 'parallel'
  | 'set'
  | 'if'
  | 'loop'
  | 'stop'
  | 'break'
  | null {
  const keys = Object.keys(input).sort();
  const key = keys.join(',');
  switch (key) {
    case 'args,call,set':
    case 'call,set':
      return 'call';
    case 'parallel,set':
      return 'parallel';
    case 'set,value':
      return 'set';
    case 'if,then':
      return 'if';
    case 'loop':
      return 'loop';
    case 'stop':
      return 'stop';
    case 'break':
      return 'break';
    default:
      return null;
  }
}

function stringifyRecord(input: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
