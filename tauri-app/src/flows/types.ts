export type FlowScope = 'global' | 'workspace';
export type UserFlowScope = FlowScope;
export type FlowScalarType = 'string' | 'integer' | 'node';
export type FlowParamType =
  | 'string'
  | 'integer'
  | 'boolean'
  | 'commit'
  | 'commit[]'
  | 'agent'
  | 'agent[]'
  | 'verdict'
  | 'scalar';
export type FlowNodeStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface FlowSource {
  id: string;
  label: string;
  scope: FlowScope;
  source: string;
}

export interface UserFlowSource extends FlowSource {
  scope: UserFlowScope;
  version: number;
  enabled: boolean;
  workspaceId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FlowDefinition {
  flow: { id: string; label?: string };
  inputs?: Record<string, FlowInputDefinition>;
  nodes: FlowNodeTemplate[];
  run: FlowStatement[];
}

export interface FlowInputDefinition {
  type: 'string' | 'integer';
  default?: string | number;
  min?: number;
  max?: number;
}

export interface FlowNodeTemplate {
  id: string;
  registryId?: string;
  label?: string;
  params?: string[];
  paramTypes?: Record<string, FlowParamType[]>;
  parent: string;
  returns?: Record<string, FlowReturnDefinition>;
  prompt: string;
  requiresFinalizedCommit?: boolean;
}

export type FlowReturnDefinition = FlowScalarType | string[];

export type FlowStatement =
  | FlowCallStatement
  | FlowParallelStatement
  | FlowSetStatement
  | FlowIfStatement
  | FlowLoopStatement
  | FlowStopStatement
  | FlowBreakStatement;

export interface FlowCallStatement {
  set: string;
  call: string;
  parent?: string;
  args?: Record<string, string>;
}

export interface FlowParallelStatement {
  set: string;
  parallel: {
    count: string | number;
    call: string;
    args?: Record<string, string>;
    parent?: string;
  };
}

export interface FlowSetStatement {
  set: string;
  value: string | number | boolean | null;
}

export interface FlowIfStatement {
  if: string;
  then: FlowStatement | FlowStatement[];
}

export interface FlowLoopStatement {
  loop: {
    max_rounds: number;
    steps: FlowStatement[];
  };
}

export interface FlowStopStatement {
  stop: string;
}

export interface FlowBreakStatement {
  break: true;
}

export interface FlowNodeValue {
  kind: 'node';
  id: string;
  label?: string;
  status: FlowNodeStatus;
  message?: string;
  commit?: string | null;
  returns?: Record<string, FlowRuntimeValue>;
}

export type FlowRuntimeValue =
  | string
  | number
  | boolean
  | null
  | FlowNodeValue
  | { [key: string]: FlowRuntimeValue }
  | FlowRuntimeValue[];

export interface FlowValidationIssue {
  path: string;
  message: string;
}
