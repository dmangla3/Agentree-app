import { describe, expect, it } from 'vitest';
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from '@shared/agentStatus';
import {
  isActiveAgentRunStatus,
  isSteerableAssistantNode,
} from './agentRunSteering';

describe('agent run steering helpers', () => {
  it.each(ACTIVE_STATUSES)(
    'treats %s as active',
    (status) => {
      expect(isActiveAgentRunStatus(status)).toBe(true);
    }
  );

  it.each([...TERMINAL_STATUSES, null, undefined, ''])(
    'does not treat %s as active',
    (status) => {
      expect(isActiveAgentRunStatus(status)).toBe(false);
    }
  );

  it('allows steering active assistant nodes', () => {
    expect(isSteerableAssistantNode({
      nodeId: 'assistant-1',
      role: 'assistant',
      status: 'completed',
      runStatus: 'running',
    })).toBe(true);
  });

  it('rejects active non-assistant nodes', () => {
    expect(isSteerableAssistantNode({
      nodeId: 'user-1',
      role: 'user',
      status: 'running',
      runStatus: 'running',
    })).toBe(false);
  });
});
