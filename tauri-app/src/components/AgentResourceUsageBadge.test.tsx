// @vitest-environment jsdom
import '../test/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentResourceUsageBadge, formatResourceMemory } from './AgentResourceUsageBadge';

const resourceMocks = vi.hoisted(() => ({
  usage: null as null | {
    assistantNodeId: string;
    rootPid: number;
    processCount: number;
    cpuPercent: number;
    memoryBytes: number;
    sampledAt: number;
  },
}));

vi.mock('../hooks/useAgentResourceUsage', () => ({
  useAgentResourceUsage: () => resourceMocks.usage,
}));

describe('formatResourceMemory', () => {
  it('uses readable binary units without implying false precision', () => {
    expect(formatResourceMemory(0)).toBe('0 MB');
    expect(formatResourceMemory(512 * 1024 * 1024)).toBe('512 MB');
    expect(formatResourceMemory(1536 * 1024 * 1024)).toBe('1.5 GB');
    expect(formatResourceMemory(12 * 1024 * 1024 * 1024)).toBe('12 GB');
  });
});

describe('AgentResourceUsageBadge', () => {
  it('shows the aggregate process-tree sample as informational data', () => {
    resourceMocks.usage = {
      assistantNodeId: 'assistant-1',
      rootPid: 123,
      processCount: 7,
      cpuPercent: 81.4,
      memoryBytes: 1536 * 1024 * 1024,
      sampledAt: 1,
    };

    render(<AgentResourceUsageBadge assistantNodeId="assistant-1" enabled />);

    expect(screen.getByText('CPU 81%')).toBeTruthy();
    expect(screen.getByText('1.5 GB')).toBeTruthy();
    expect(screen.getByText('7 processes')).toBeTruthy();
    expect(screen.getByTitle(/does not throttle/i)).toBeTruthy();
  });

  it('hides a cached sample after the agent finishes', () => {
    resourceMocks.usage = {
      assistantNodeId: 'assistant-1',
      rootPid: 123,
      processCount: 7,
      cpuPercent: 81.4,
      memoryBytes: 1536 * 1024 * 1024,
      sampledAt: 1,
    };

    render(<AgentResourceUsageBadge assistantNodeId="assistant-1" enabled={false} />);

    expect(screen.queryByText('CPU 81%')).toBeNull();
    expect(screen.queryByText('7 processes')).toBeNull();
  });
});
