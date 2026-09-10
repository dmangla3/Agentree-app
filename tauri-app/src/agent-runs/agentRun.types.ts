import type { AgentStatus } from '@shared/agentStatus';
import type { Message } from '../stores/workspaceStore';

export type AgentRunMessage = Partial<Message> & Record<string, any>;

export type AgentRunStatus = AgentStatus;

export type AgentRunPhase =
  | 'idle'
  | 'optimistic'
  | 'setup'
  | 'running'
  | 'streaming'
  | 'finalizing'
  | 'terminal'
  | 'cleanup';

export interface AgentRunFinalizeAck {
  status: AgentRunStatus;
  outputCommitSha: string | null;
  commitCreated: boolean | null;
  gitBranchName: string | null;
  persisted: boolean | null;
  serverAckAt: string | null;
}

export interface AgentRunSnapshot {
  nodeId: string;
  workspaceId: string | null;
  parentId: string | null;
  role: string | null;
  agentId: string | null;
  message: AgentRunMessage | null;
  runId: string | null;
  phase: AgentRunPhase;
  status: AgentRunStatus | null;
  progress: string | null;
  content: string;
  lastSeq: number | null;
  lastStreamSeq: number | null;
  timeline: any[];
  executionData: Record<string, any>;
  usage: Record<string, any> | null;
  terminalStatus: AgentRunStatus | null;
  terminalReason: string | null;
  finalizeAck: AgentRunFinalizeAck | null;
  terminalHoldUntil: number | null;
  cleanupAt: number | null;
  updatedAt: string;
}

export interface AgentRunInput {
  nodeId: string;
  workspaceId?: string | null;
  parentId?: string | null;
  role?: string | null;
  agentId?: string | null;
  message?: AgentRunMessage | null;
  runId?: string | null;
  status?: AgentRunStatus | null;
  progress?: string | null;
  content?: string | null;
  executionData?: Record<string, any> | null;
}

export type AgentRunEvent =
  | { type: 'seed'; message: Message; runId?: string | null }
  | { type: 'replace_node'; optimisticNodeId: string; realNode: Message }
  | { type: 'setup_progress'; progress: string; status?: AgentRunStatus | null }
  | { type: 'status'; status: AgentRunStatus; progress?: string | null }
  | { type: 'native_event'; event: Record<string, any> }
  // `content` updates the assistant card answer; `providerItemId` scopes the
  // corresponding timeline message row in the work log.
  | { type: 'content'; content: string; appendedText?: string | null; providerItemId?: string | null; streamSeq?: number | null; timestamp?: number | null }
  | { type: 'content_final'; content: string; providerItemId?: string | null; streamSeq?: number | null; timestamp?: number | null }
  | { type: 'timeline_event'; event: any }
  | { type: 'execution_data'; patch: Record<string, any> }
  | { type: 'usage'; usage: Record<string, any> }
  | { type: 'finalize_progress'; progress: string; phase?: string | null }
  | {
      type: 'finalize_ack';
      status?: AgentRunStatus | null;
      outputCommitSha?: string | null;
      commitCreated?: boolean | null;
      gitBranchName?: string | null;
      persisted?: boolean | null;
      serverAckAt?: string | null;
      meta?: Record<string, any>;
    }
  | { type: 'terminal'; status: AgentRunStatus; content?: string | null; reason?: string | null; holdMs?: number }
  | { type: 'cancel'; reason?: string | null }
  | { type: 'cleanup' }
  | { type: 'remove' };
