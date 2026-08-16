import { describe, expect, it } from 'vitest';
import { resolveWorkspaceRouteState } from './workspaceRouteState';

const workspace = (id: string) => ({ id }) as any;

describe('resolveWorkspaceRouteState', () => {
  it('waits for workspace loading before rejecting a deep-linked workspace', () => {
    expect(resolveWorkspaceRouteState({
      workspaceIdParam: 'missing-workspace',
      selectedWorkspaceId: null,
      workspaces: [],
      isLoadingWorkspaces: true,
    })).toEqual({ type: 'wait' });
  });

  it('selects a deep-linked workspace only when it exists in the workspace list', () => {
    expect(resolveWorkspaceRouteState({
      workspaceIdParam: 'workspace-1',
      selectedWorkspaceId: null,
      workspaces: [workspace('workspace-1')],
      isLoadingWorkspaces: false,
    })).toEqual({ type: 'select', workspaceId: 'workspace-1' });
  });

  it('redirects an unknown deep-linked workspace instead of opening orphan local nodes', () => {
    expect(resolveWorkspaceRouteState({
      workspaceIdParam: 'missing-workspace',
      selectedWorkspaceId: null,
      workspaces: [workspace('workspace-1')],
      isLoadingWorkspaces: false,
    })).toEqual({ type: 'redirect', workspaceId: 'workspace-1' });
  });

  it('clears selection when no workspace exists locally or remotely', () => {
    expect(resolveWorkspaceRouteState({
      workspaceIdParam: 'missing-workspace',
      selectedWorkspaceId: 'missing-workspace',
      workspaces: [],
      isLoadingWorkspaces: false,
    })).toEqual({ type: 'clear' });
  });
});
