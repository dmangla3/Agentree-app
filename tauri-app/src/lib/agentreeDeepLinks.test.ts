// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAgentreeLink,
  buildAgentreePath,
  isAgentreeTargetAvailable,
  navigateToAgentreeDeepLink,
  parseAgentreeDeepLink,
} from './agentreeDeepLinks';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }));
vi.mock('@tauri-apps/plugin-deep-link', () => ({ getCurrent: vi.fn(), onOpenUrl: vi.fn() }));

describe('Agentree deep links', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('builds canonical workspace, thread, and node links', () => {
    expect(buildAgentreeLink({ workspaceId: 'workspace 1' })).toBe('agentree://workspaces/workspace%201');
    expect(buildAgentreeLink({ workspaceId: 'workspace-1', threadId: 'thread/root' }))
      .toBe('agentree://workspaces/workspace-1?threadId=thread%2Froot');
    expect(buildAgentreePath({ workspaceId: 'workspace-1', nodeId: 'node-1' }))
      .toBe('/workspaces/workspace-1?nodeId=node-1');
  });

  it('parses internal and external links', () => {
    expect(parseAgentreeDeepLink('/workspaces/workspace-1?nodeId=node-1')).toEqual({
      workspaceId: 'workspace-1',
      nodeId: 'node-1',
      threadId: null,
    });
    expect(parseAgentreeDeepLink('agentree://workspaces/workspace-1?threadId=thread-1')).toEqual({
      workspaceId: 'workspace-1',
      nodeId: null,
      threadId: 'thread-1',
    });
  });

  it('keeps messageId links compatible and gives node targets precedence', () => {
    expect(parseAgentreeDeepLink('/workspaces/workspace-1?messageId=old-node')).toMatchObject({ nodeId: 'old-node' });
    expect(parseAgentreeDeepLink('/workspaces/workspace-1?nodeId=node-1&threadId=thread-1')).toEqual({
      workspaceId: 'workspace-1',
      nodeId: 'node-1',
      threadId: null,
    });
  });

  it('rejects unrelated schemes and malformed workspace routes', () => {
    expect(parseAgentreeDeepLink('https://example.com/workspaces/workspace-1')).toBeNull();
    expect(parseAgentreeDeepLink('agentree://settings/profile')).toBeNull();
    expect(parseAgentreeDeepLink('/workspaces/one/extra')).toBeNull();
    expect(parseAgentreeDeepLink('agentree://user@workspaces/workspace-1')).toBeNull();
  });

  it('checks loaded node and thread targets before navigation', () => {
    const available = {
      messageIds: new Set(['node-1']),
      threadIds: new Set(['thread-1']),
    };
    expect(isAgentreeTargetAvailable({ nodeId: 'node-1' }, available)).toBe(true);
    expect(isAgentreeTargetAvailable({ nodeId: 'missing-node' }, available)).toBe(false);
    expect(isAgentreeTargetAvailable({ threadId: 'thread-1' }, available)).toBe(true);
    expect(isAgentreeTargetAvailable({ threadId: 'missing-thread' }, available)).toBe(false);
  });

  it('updates browser routing for a valid external link', () => {
    const popstate = vi.fn();
    window.addEventListener('popstate', popstate, { once: true });

    expect(navigateToAgentreeDeepLink('agentree://workspaces/workspace-1?nodeId=node-1')).toBe(true);
    expect(`${window.location.pathname}${window.location.search}`)
      .toBe('/workspaces/workspace-1?nodeId=node-1');
    expect(popstate).toHaveBeenCalledOnce();
  });
});
