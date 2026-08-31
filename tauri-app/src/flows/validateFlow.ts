import type {
  FlowDefinition,
  FlowInputDefinition,
  FlowNodeTemplate,
  FlowParamType,
  FlowStatement,
  FlowValidationIssue,
} from './types';
import { parseFlowParamTypes } from './flowParamTypes';

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
const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FLOW_NODE_FIELDS = new Set(['kind', 'id', 'label', 'status', 'message', 'commit']);

type StaticValueShape =
  | { kind: 'input'; fields: Map<string, StaticValueShape> }
  | { kind: 'node'; template: FlowNodeTemplate }
  | { kind: 'array'; item: StaticValueShape }
  | { kind: 'object'; fields: Map<string, StaticValueShape> }
  | { kind: 'string' }
  | { kind: 'integer' }
  | { kind: 'boolean' }
  | { kind: 'commit' }
  | { kind: 'verdict' }
  | { kind: 'null' }
  | { kind: 'scalar' }
  | { kind: 'unknown' };

interface ValidatedParams {
  params: string[];
  paramTypes: Record<string, FlowParamType[]>;
}

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

    const validatedParams = validateParams(value.params, `${path}.params`, issues);
    const returns = validateReturns(value.returns, `${path}.returns`, issues);
    const template: FlowNodeTemplate = {
      id,
      ...(typeof value.registryId === 'string' ? { registryId: value.registryId } : {}),
      ...(typeof value.label === 'string' ? { label: value.label } : {}),
      ...(validatedParams ? { params: validatedParams.params, paramTypes: validatedParams.paramTypes } : {}),
      parent: isNonEmptyString(parent) ? parent : '',
      ...(returns ? { returns } : {}),
      prompt: isNonEmptyString(prompt) ? prompt : '',
      ...(typeof value.requiresFinalizedCommit === 'boolean'
        ? { requiresFinalizedCommit: value.requiresFinalizedCommit }
        : {}),
    };

    templates.push(template);
    if (!byId.has(id)) {
      byId.set(id, template);
    }
  });

  return { templates, byId };
}

function validateParams(input: unknown, path: string, issues: FlowValidationIssue[]): ValidatedParams | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    issues.push({ path, message: 'Node params must be an object of typed params.' });
    return undefined;
  }

  const seen = new Set<string>();
  const params: string[] = [];
  const paramTypes: Record<string, FlowParamType[]> = {};

  for (const [param, rawType] of Object.entries(input)) {
    if (!isNonEmptyString(param)) {
      issues.push({ path, message: 'Node param name must be a non-empty string.' });
      continue;
    }
    if (seen.has(param)) {
      issues.push({ path: `${path}.${param}`, message: `Node param "${param}" is already used.` });
    }
    const types = parseFlowParamTypes(rawType);
    if (!types) {
      issues.push({ path: `${path}.${param}`, message: 'Node param type must be a supported type or union.' });
      continue;
    }
    seen.add(param);
    params.push(param);
    paramTypes[param] = types;
  }
  return { params, paramTypes };
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
  const scope = createInitialStaticScope(inputs);
  const statements: FlowStatement[] = [];
  input.forEach((statementInput, index) => {
    const path = `run.${index}`;
    const statement = validateStatement(statementInput, path, templatesById, inputs, issues);
    if (!statement) return;
    validateStatementExpressions(statement, path, scope, templatesById, inputs, issues);
    applyStatementStaticEffects(statement, scope, templatesById);
    statements.push(statement);
  });
  return statements;
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
      if (input.parent !== undefined && !isNonEmptyString(input.parent)) {
        issues.push({ path: `${path}.parent`, message: 'Call parent must be a non-empty string.' });
      }
      return {
        set: typeof input.set === 'string' ? input.set : '',
        call: typeof input.call === 'string' ? input.call : '',
        ...(typeof input.parent === 'string' ? { parent: input.parent } : {}),
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

function createInitialStaticScope(inputs: Record<string, FlowInputDefinition> | undefined): Map<string, StaticValueShape> {
  const scope = new Map<string, StaticValueShape>();
  scope.set('input', inputs
    ? {
      kind: 'input',
      fields: new Map(Object.entries(inputs).map(([key, value]) => [
        key,
        value.type === 'integer' ? { kind: 'integer' } : { kind: 'string' },
      ])),
    }
    : { kind: 'unknown' });
  return scope;
}

function validateStatementExpressions(
  statement: FlowStatement,
  path: string,
  scope: Map<string, StaticValueShape>,
  nodeTemplates: Map<string, FlowNodeTemplate>,
  inputs: Record<string, FlowInputDefinition> | undefined,
  issues: FlowValidationIssue[]
): void {
  if ('call' in statement) {
    validateParentExpression(statement.parent, `${path}.parent`, scope, issues);
    validateArgExpressions(
      statement.args,
      `${path}.args`,
      scope,
      issues,
      nodeTemplates.get(statement.call)
    );
    return;
  }

  if ('parallel' in statement) {
    validateParentExpression(statement.parallel.parent, `${path}.parallel.parent`, scope, issues);
    validateArgExpressions(
      statement.parallel.args,
      `${path}.parallel.args`,
      scope,
      issues,
      nodeTemplates.get(statement.parallel.call)
    );
    return;
  }

  if ('value' in statement) {
    validateFlowExpressionPath(statement.value, `${path}.value`, scope, issues);
    return;
  }

  if ('if' in statement) {
    validateConditionExpression(statement.if, `${path}.if`, scope, issues);
    const thenStatements = Array.isArray(statement.then) ? statement.then : [statement.then];
    const branchScope = cloneStaticScope(scope);
    thenStatements.forEach((thenStatement, index) => {
      const thenPath = Array.isArray(statement.then) ? `${path}.then.${index}` : `${path}.then`;
      validateStatementExpressions(thenStatement, thenPath, branchScope, nodeTemplates, inputs, issues);
      applyStatementStaticEffects(thenStatement, branchScope, nodeTemplates);
    });
    return;
  }

  if ('loop' in statement) {
    const loopScope = cloneStaticScope(scope);
    statement.loop.steps.forEach((step, index) => {
      const stepPath = `${path}.loop.steps.${index}`;
      validateStatementExpressions(step, stepPath, loopScope, nodeTemplates, inputs, issues);
      applyStatementStaticEffects(step, loopScope, nodeTemplates);
    });
  }
}

function validateArgExpressions(
  args: Record<string, string> | undefined,
  path: string,
  scope: Map<string, StaticValueShape>,
  issues: FlowValidationIssue[],
  template?: FlowNodeTemplate
): void {
  if (!args) return;
  for (const [key, expression] of Object.entries(args)) {
    const shape = validateFlowExpressionPath(expression, `${path}.${key}`, scope, issues);
    const expectedTypes = template?.paramTypes?.[key];
    if (!expectedTypes) continue;
    validateParamTypeCompatibility({
      expression,
      path: `${path}.${key}`,
      paramName: key,
      templateId: template?.id,
      actual: shape,
      expectedTypes,
      issues,
    });
  }
}

function validateParentExpression(
  expression: string | undefined,
  path: string,
  scope: Map<string, StaticValueShape>,
  issues: FlowValidationIssue[]
): void {
  if (!expression || expression === 'root') return;
  validateFlowExpressionPath(expression, path, scope, issues);
}

function validateConditionExpression(
  condition: string,
  path: string,
  scope: Map<string, StaticValueShape>,
  issues: FlowValidationIssue[]
): void {
  const parts = condition.split(/\s+==\s+/);
  if (parts.length !== 2) return;
  validateFlowExpressionPath(parts[0], path, scope, issues);
}

function validateFlowExpressionPath(
  expression: string | number | boolean | null,
  path: string,
  scope: Map<string, StaticValueShape>,
  issues: FlowValidationIssue[]
): StaticValueShape {
  if (expression === null) {
    return { kind: 'null' };
  }
  if (typeof expression === 'number') {
    return Number.isInteger(expression) ? { kind: 'integer' } : { kind: 'scalar' };
  }
  if (typeof expression === 'boolean') {
    return { kind: 'boolean' };
  }
  if (typeof expression !== 'string') {
    return { kind: 'scalar' };
  }
  const trimmed = expression.trim();
  if (trimmed === 'root') {
    return { kind: 'scalar' };
  }
  if (!PATH_PATTERN.test(trimmed)) {
    return { kind: 'string' };
  }

  const result = resolveStaticPath(trimmed, scope);
  if (!result.ok) {
    issues.push({ path, message: result.issue });
    return { kind: 'unknown' };
  }
  return result.shape;
}

function resolveStaticPath(
  expression: string,
  scope: Map<string, StaticValueShape>
): { ok: true; shape: StaticValueShape } | { ok: false; issue: string } {
  const segments = expression.split('.');
  let shape = scope.get(segments[0]);
  if (!shape) {
    return { ok: false, issue: `Expression "${expression}" references unknown flow value "${segments[0]}".` };
  }

  let prefix = segments[0];
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = readStaticSegment(shape, segment);
    if (!next) {
      return {
        ok: false,
        issue: missingStaticSegmentMessage(expression, prefix, segment, shape),
      };
    }
    shape = next;
    prefix = `${prefix}.${segment}`;
  }
  return { ok: true, shape };
}

function readStaticSegment(shape: StaticValueShape, segment: string): StaticValueShape | null {
  if (shape.kind === 'input') {
    return shape.fields.get(segment) ?? null;
  }
  if (shape.kind === 'node') {
    if (segment === 'commit') {
      return { kind: 'commit' };
    }
    if (FLOW_NODE_FIELDS.has(segment)) {
      return { kind: 'scalar' };
    }
    const returnDefinition = shape.template.returns?.[segment];
    return returnDefinition ? staticShapeFromReturn(segment, returnDefinition) : null;
  }
  if (shape.kind === 'array') {
    const item = readStaticSegment(shape.item, segment);
    return item ? { kind: 'array', item } : null;
  }
  if (shape.kind === 'object') {
    return shape.fields.get(segment) ?? null;
  }
  if (shape.kind === 'unknown') {
    return { kind: 'unknown' };
  }
  return null;
}

function missingStaticSegmentMessage(
  expression: string,
  prefix: string,
  segment: string,
  shape: StaticValueShape
): string {
  const singular = segment.endsWith('s') ? segment.slice(0, -1) : '';
  const singularExists = singular ? Boolean(readStaticSegment(shape, singular)) : false;
  const suggestion = singularExists ? ` Did you mean "${prefix}.${singular}"?` : '';
  return `Expression "${expression}" references unknown field "${segment}" on "${prefix}".${suggestion}`;
}

function staticShapeFromReturn(key: string, definition: NonNullable<FlowNodeTemplate['returns']>[string]): StaticValueShape {
  if (definition === 'integer') return { kind: 'integer' };
  if (definition === 'string') return { kind: 'string' };
  if (definition === 'node') return { kind: 'node', template: {
    id: key,
    parent: 'root',
    prompt: '',
  } };
  if (Array.isArray(definition) && key === 'verdict' && definition.includes('pass') && definition.includes('fail')) {
    return { kind: 'verdict' };
  }
  return { kind: 'scalar' };
}

function validateParamTypeCompatibility(input: {
  expression: string;
  path: string;
  paramName: string;
  templateId?: string;
  actual: StaticValueShape;
  expectedTypes: FlowParamType[];
  issues: FlowValidationIssue[];
}): void {
  if (input.actual.kind === 'unknown' || input.actual.kind === 'null') return;
  if (input.expectedTypes.includes('scalar')) return;
  const actualType = staticShapeToParamType(input.actual);
  if (!actualType) return;
  if (input.expectedTypes.includes(actualType)) return;

  input.issues.push({
    path: input.path,
    message: [
      input.templateId ? `${input.templateId}.${input.paramName}` : `Argument "${input.paramName}"`,
      `expected ${input.expectedTypes.join(' | ')}`,
      `but expression "${input.expression}" resolves to ${actualType}.`,
    ].join(' '),
  });
}

function staticShapeToParamType(shape: StaticValueShape): FlowParamType | null {
  if (shape.kind === 'array') {
    const itemType = staticShapeToParamType(shape.item);
    if (itemType === 'commit') return 'commit[]';
    if (itemType === 'agent') return 'agent[]';
    return null;
  }
  if (shape.kind === 'node') return 'agent';
  if (shape.kind === 'commit') return 'commit';
  if (shape.kind === 'verdict') return 'verdict';
  if (shape.kind === 'string') return 'string';
  if (shape.kind === 'integer') return 'integer';
  if (shape.kind === 'boolean') return 'boolean';
  return null;
}

function applyStatementStaticEffects(
  statement: FlowStatement,
  scope: Map<string, StaticValueShape>,
  nodeTemplates: Map<string, FlowNodeTemplate>
): void {
  if ('call' in statement) {
    const template = nodeTemplates.get(statement.call);
    scope.set(statement.set, template ? { kind: 'node', template } : { kind: 'unknown' });
    return;
  }
  if ('parallel' in statement) {
    const template = nodeTemplates.get(statement.parallel.call);
    scope.set(statement.set, template ? { kind: 'array', item: { kind: 'node', template } } : { kind: 'unknown' });
    return;
  }
  if ('value' in statement) {
    const shape = validateFlowExpressionPath(statement.value, `run.${statement.set}.value`, scope, []);
    scope.set(statement.set, shape);
  }
}

function cloneStaticScope(scope: Map<string, StaticValueShape>): Map<string, StaticValueShape> {
  return new Map(scope);
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
    case 'args,call,parent,set':
    case 'call,parent,set':
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
