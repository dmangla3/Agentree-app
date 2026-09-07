import { describe, expect, it } from 'vitest';
import type { AgentRunJournalEvent } from '../lib/agentClient';
import type { Message } from '../stores/workspaceStore';
import {
  getControlledByNodeId,
  findExistingOrchestrationChildLaunch,
  getNodeKind,
  getOrchestrationDecisionKey,
  getSatisfiedActiveWaitGroup,
  isOrchestrationWaitGroupSatisfied,
  parseOrchestrationJournalEvent,
  planOrchestrationRecoveryAction,
  recoverOrchestrationProjection,
  replayOrchestrationEvents,
} from './domain';

const journalEvent = (
  seq: number,
  eventType: string,
  payload: Record<string, unknown>,
): AgentRunJournalEvent => ({
  runId: 'run-orchestrator',
  assistantNodeId: 'assistant-orchestrator',
  seq,
  eventType,
  payload: JSON.stringify(payload),
  timestamp: 1_800_000_000 + seq,
});

const message = (input: Partial<Message> & { id: string; role: Message['role'] }): Message => ({
  content: '',
  parentId: null,
  workspaceId: 'workspace-1',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...input,
} as Message);

describe('orchestration domain helpers', () => {
  it('normalizes node kind and controlled_by aliases without flow metadata', () => {
    const node = {
      controlled_by_node_id: ' assistant-orchestrator ',
      execution_data: {
        meta: {
          node_kind: 'orchestrator',
        },
      },
    };

    expect(getControlledByNodeId(node as any)).toBe('assistant-orchestrator');
    expect(getNodeKind(node as any)).toBe('orchestrator');
    expect(getOrchestrationDecisionKey('run-1', 'planner-1')).toBe('run-1:planner-1');
  });

  it('finds an existing controlled child by orchestrator and decision id for replay-safe child starts', () => {
    const existing = findExistingOrchestrationChildLaunch([
      message({
        id: 'user-child',
        role: 'user',
        parentId: 'assistant-orchestrator',
        content: 'Run planner',
      }),
      message({
        id: 'assistant-child',
        role: 'assistant',
        parentId: 'user-child',
        status: 'running' as any,
        controlled_by_node_id: 'assistant-orchestrator',
        execution_data: {
          current_run_id: 'run-child',
          meta: {
            orchestration_decision_id: 'planner-1',
          },
        },
      }),
    ], 'assistant-orchestrator', 'planner-1');

    expect(existing).toEqual({
      userNodeId: 'user-child',
      assistantNodeId: 'assistant-child',
      runId: 'run-child',
      status: 'running',
    });
  });

  it('replays diagram, child, wait, and completion events', () => {
    const parsed = [
      journalEvent(1, 'orchestration:flow_diagram_created', {
        mermaid: 'flowchart LR\n  A-->B',
      }),
      journalEvent(2, 'orchestration:child_requested', {
        decisionId: 'planner-1',
        childAssistantNodeId: 'assistant-planner',
      }),
      journalEvent(3, 'orchestration:child_started', {
        decisionId: 'planner-1',
        childAssistantNodeId: 'assistant-planner',
      }),
      journalEvent(4, 'orchestration:wait_started', {
        waitGroupId: 'wait-planners',
        decisionIds: ['planner-1'],
        condition: 'all',
      }),
      journalEvent(5, 'orchestration:wait_completed', { waitGroupId: 'wait-planners' }),
      journalEvent(6, 'orchestration:completed', {}),
    ].map((event) => parseOrchestrationJournalEvent(event)!);

    const projection = replayOrchestrationEvents(parsed);

    expect(projection.status).toBe('completed');
    expect(projection.requestedDecisionIds.has('planner-1')).toBe(true);
    expect(projection.childAssistantNodeIdByDecisionId.get('planner-1')).toBe('assistant-planner');
    expect(projection.activeWaitGroup).toBeNull();
  });

  it('detects satisfied wait groups from controlled child statuses', () => {
    const waitGroup = {
      waitGroupId: 'wait-planners',
      decisionIds: ['planner-1', 'planner-2'],
      condition: 'all',
    };
    const children = [
      { assistantNodeId: 'assistant-1', decisionId: 'planner-1', status: 'completed' as const, active: false, terminal: true, outputCommitSha: null },
      { assistantNodeId: 'assistant-2', decisionId: 'planner-2', status: 'completed' as const, active: false, terminal: true, outputCommitSha: null },
    ];

    expect(isOrchestrationWaitGroupSatisfied(waitGroup, children)).toBe(true);
    expect(getSatisfiedActiveWaitGroup({
      status: 'running',
      requestedDecisionIds: new Set(),
      childAssistantNodeIdByDecisionId: new Map(),
      supersededChildIds: new Set(),
      activeWaitGroup: waitGroup,
      needsUserActionReason: null,
      lastSeq: 1,
      controlledChildren: children,
      activeControlledAssistantNodeIds: [],
      terminalChildren: children,
      missingDecisionIds: [],
    })).toEqual(waitGroup);
  });

  it('plans cancellation recovery without resuming host-built previews', () => {
    const projection = recoverOrchestrationProjection({
      orchestratorNodeId: 'assistant-orchestrator',
      events: [
        parseOrchestrationJournalEvent(journalEvent(1, 'orchestration:cancel_requested', {
          reason: 'user_cancelled',
        }))!,
      ],
      messages: [
        message({
          id: 'assistant-child',
          role: 'assistant',
          status: 'running' as any,
          controlled_by_node_id: 'assistant-orchestrator',
          execution_data: { meta: { orchestration_decision_id: 'planner-1' } },
        }),
      ],
    });

    expect(planOrchestrationRecoveryAction(projection)).toEqual({
      type: 'stop_active_children',
      assistantNodeIds: ['assistant-child'],
      reason: 'cancel_recovery',
    });
  });

  it('marks missing requested children as needing user action instead of replaying a preview', () => {
    const projection = recoverOrchestrationProjection({
      orchestratorNodeId: 'assistant-orchestrator',
      events: [
        parseOrchestrationJournalEvent(journalEvent(1, 'orchestration:child_requested', {
          decisionId: 'planner-1',
        }))!,
      ],
      messages: [],
    });

    expect(projection.status).toBe('needs_user_action');
    expect(planOrchestrationRecoveryAction(projection)).toEqual({
      type: 'needs_user_action',
      reason: 'Requested child run is missing for decision planner-1.',
    });
  });
});
