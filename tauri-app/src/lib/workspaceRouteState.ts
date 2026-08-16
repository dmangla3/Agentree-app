import type { Workspace } from '../stores/workspaceStore';

export type WorkspaceRouteState =
  | { type: 'wait' }
  | { type: 'select'; workspaceId: string }
  | { type: 'redirect'; workspaceId: string }
  | { type: 'clear' }
  | { type: 'none' };

export function resolveWorkspaceRouteState(input: {
  workspaceIdParam: string | null | undefined;
  selectedWorkspaceId: string | null;
  workspaces: Pick<Workspace, 'id'>[];
  isLoadingWorkspaces: boolean;
}): WorkspaceRouteState {
  const workspaceIdParam = input.workspaceIdParam?.trim() || null;
  const workspaceIds = new Set(input.workspaces.map((workspace) => workspace.id));

  if (workspaceIdParam) {
    if (workspaceIds.has(workspaceIdParam)) {
      return input.selectedWorkspaceId === workspaceIdParam
        ? { type: 'none' }
        : { type: 'select', workspaceId: workspaceIdParam };
    }

    if (input.isLoadingWorkspaces) {
      return { type: 'wait' };
    }

    const fallbackWorkspace = input.workspaces[0] ?? null;
    return fallbackWorkspace
      ? { type: 'redirect', workspaceId: fallbackWorkspace.id }
      : { type: 'clear' };
  }

  if (!input.selectedWorkspaceId) {
    return input.workspaces[0]
      ? { type: 'redirect', workspaceId: input.workspaces[0].id }
      : { type: 'none' };
  }

  if (workspaceIds.has(input.selectedWorkspaceId)) {
    return { type: 'none' };
  }

  if (input.isLoadingWorkspaces) {
    return { type: 'wait' };
  }

  const fallbackWorkspace = input.workspaces[0] ?? null;
  return fallbackWorkspace
    ? { type: 'redirect', workspaceId: fallbackWorkspace.id }
    : { type: 'clear' };
}
