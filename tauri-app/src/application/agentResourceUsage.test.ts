import { beforeEach, describe, expect, it, vi } from 'vitest';

const agentClientMock = vi.hoisted(() => ({
  hasRuntime: vi.fn(),
  listAgentResourceUsage: vi.fn(),
}));

vi.mock('../lib/agentClient', () => ({ agentClient: agentClientMock }));

import { agentResourceUsageApplication } from './agentResourceUsage';

describe('agent resource usage application boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('owns runtime availability and usage reads', async () => {
    const usage = [{ assistantNodeId: 'assistant-1', cpuPercent: 12 }];
    agentClientMock.hasRuntime.mockReturnValue(true);
    agentClientMock.listAgentResourceUsage.mockResolvedValue(usage);

    expect(agentResourceUsageApplication.isAvailable()).toBe(true);
    await expect(agentResourceUsageApplication.list()).resolves.toBe(usage);
    expect(agentClientMock.hasRuntime).toHaveBeenCalledOnce();
    expect(agentClientMock.listAgentResourceUsage).toHaveBeenCalledOnce();
  });
});
