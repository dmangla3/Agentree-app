import type { FlowExecutionEvent, FlowExecutionResult } from './flowExecutor';
import type { FlowRuntimeValue } from './types';

export type FlowRunStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'cancelled';

export interface FlowRunSnapshot {
  flowRunId: string;
  flowId: string;
  status: FlowRunStatus;
  activeNodeIds: string[];
  launchedNodeIds: string[];
  currentTemplateId: string | null;
  scope: Record<string, FlowRuntimeValue>;
  events: FlowExecutionEvent[];
  reason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface FlowRunInput {
  flowRunId: string;
  flowId: string;
  status?: FlowRunStatus;
  scope?: Record<string, FlowRuntimeValue>;
}

export type FlowRunEvent =
  | { type: 'start'; startedAt?: string | null }
  | { type: 'execution_event'; event: FlowExecutionEvent }
  | { type: 'result'; result: FlowExecutionResult }
  | { type: 'fail'; reason: string }
  | { type: 'cancel'; reason?: string | null }
  | { type: 'cleanup' };
