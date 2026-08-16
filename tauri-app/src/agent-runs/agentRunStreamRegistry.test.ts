import { describe, expect, it, vi } from 'vitest';
import { createAgentRunStreamRegistry } from './agentRunStreamRegistry';

describe('agent run stream registry', () => {
  it('routes background events to background handler', () => {
    const background = vi.fn(() => ({ terminalHydration: false }));
    const registry = createAgentRunStreamRegistry({ background });

    registry.registerBackground({
      nodeId: 'assistant-1',
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
    });
    registry.receive('assistant-1', { type: 'message_delta', seq: 1 });

    expect(background).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'assistant-1', workspaceId: 'workspace-1' }),
      { type: 'message_delta', seq: 1 },
    );
  });

  it('buffers live events during promotion and flushes after replay finishes', () => {
    const full = vi.fn();
    const registry = createAgentRunStreamRegistry({ background: vi.fn(() => ({ terminalHydration: false })) });

    registry.beginPromotion({
      nodeId: 'assistant-1',
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
      fullHandler: full,
    });
    registry.receive('assistant-1', { type: 'message_delta', seq: 3 });
    registry.deliverReplayEvent('assistant-1', { type: 'message_delta', seq: 1 });
    registry.deliverReplayEvent('assistant-1', { type: 'message_delta', seq: 2 });

    expect(full).toHaveBeenCalledTimes(2);
    expect(full).toHaveBeenNthCalledWith(1, { type: 'message_delta', seq: 1 });
    expect(full).toHaveBeenNthCalledWith(2, { type: 'message_delta', seq: 2 });

    registry.finishPromotion('assistant-1');

    expect(full).toHaveBeenCalledTimes(3);
    expect(full).toHaveBeenNthCalledWith(3, { type: 'message_delta', seq: 3 });
    expect(registry.mode('assistant-1')).toBe('full');
  });

  it('does not downgrade a promoting stream', () => {
    const registry = createAgentRunStreamRegistry({ background: vi.fn(() => ({ terminalHydration: false })) });

    registry.beginPromotion({
      nodeId: 'assistant-1',
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
      fullHandler: vi.fn(),
    });
    registry.registerBackground({
      nodeId: 'assistant-1',
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
    });

    expect(registry.mode('assistant-1')).toBe('promoting');
  });
});
