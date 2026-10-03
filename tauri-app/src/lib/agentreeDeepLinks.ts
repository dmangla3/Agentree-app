import { isTauri } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';

export interface AgentreeDeepLinkTarget {
  workspaceId: string;
  nodeId?: string | null;
  threadId?: string | null;
}

export type AgentreeTargetAvailability = 'pending' | 'available' | 'missing';

export const resolveAgentreeTargetAvailability = (
  target: Pick<AgentreeDeepLinkTarget, 'nodeId' | 'threadId'>,
  available: { messageIds: ReadonlySet<string>; threadIds: ReadonlySet<string> },
  ready: boolean,
): AgentreeTargetAvailability => {
  if (!ready) return 'pending';
  if (target.nodeId) return available.messageIds.has(target.nodeId) ? 'available' : 'missing';
  if (target.threadId) return available.threadIds.has(target.threadId) ? 'available' : 'missing';
  return 'available';
};

const WORKSPACE_ROUTE_PREFIX = '/workspaces/';

const parseWorkspaceRoute = (pathname: string, searchParams: URLSearchParams): AgentreeDeepLinkTarget | null => {
  if (!pathname.startsWith(WORKSPACE_ROUTE_PREFIX)) return null;
  const encodedWorkspaceId = pathname.slice(WORKSPACE_ROUTE_PREFIX.length);
  if (!encodedWorkspaceId || encodedWorkspaceId.includes('/')) return null;

  let workspaceId: string;
  try {
    workspaceId = decodeURIComponent(encodedWorkspaceId).trim();
  } catch {
    return null;
  }
  if (!workspaceId) return null;

  const nodeId = searchParams.get('nodeId')?.trim()
    || searchParams.get('messageId')?.trim()
    || null;
  const threadId = nodeId ? null : searchParams.get('threadId')?.trim() || null;
  return { workspaceId, nodeId, threadId };
};

export const buildAgentreePath = ({ workspaceId, nodeId, threadId }: AgentreeDeepLinkTarget): string => {
  const params = new URLSearchParams();
  if (nodeId) params.set('nodeId', nodeId);
  else if (threadId) params.set('threadId', threadId);
  const search = params.toString();
  return `/workspaces/${encodeURIComponent(workspaceId)}${search ? `?${search}` : ''}`;
};

export const buildAgentreeLink = (target: AgentreeDeepLinkTarget): string => {
  const path = buildAgentreePath(target);
  return `agentree://${path.slice(1)}`;
};

export const parseAgentreeDeepLink = (value: string): AgentreeDeepLinkTarget | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith('/')) {
      const url = new URL(trimmed, 'https://agentree.local');
      return parseWorkspaceRoute(url.pathname, url.searchParams);
    }

    const url = new URL(trimmed);
    if (url.protocol !== 'agentree:' || url.hostname !== 'workspaces' || url.username || url.password || url.port) return null;
    return parseWorkspaceRoute(`/workspaces${url.pathname}`, url.searchParams);
  } catch {
    return null;
  }
};

export const navigateToAgentreeDeepLink = (value: string, options?: { replace?: boolean }): boolean => {
  const target = parseAgentreeDeepLink(value);
  if (!target) return false;

  const path = buildAgentreePath(target);
  if (options?.replace) window.history.replaceState({}, document.title, path);
  else window.history.pushState({}, document.title, path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  return true;
};

export const copyAgentreeLink = async (target: AgentreeDeepLinkTarget): Promise<string | null> => {
  const link = buildAgentreeLink(target);
  try {
    if (isTauri()) await writeText(link);
    else await navigator.clipboard.writeText(link);
    return link;
  } catch (error) {
    console.error('[DeepLink] Failed to copy link:', error);
    return null;
  }
};

let initialized = false;

export const initAgentreeDeepLinkHandler = async (): Promise<void> => {
  if (!isTauri() || initialized) return;
  initialized = true;

  await onOpenUrl((urls) => {
    const link = urls.find((url) => parseAgentreeDeepLink(url));
    if (link) navigateToAgentreeDeepLink(link);
  });

  const current = await getCurrent();
  const initialLink = current?.find((url) => parseAgentreeDeepLink(url));
  if (initialLink) navigateToAgentreeDeepLink(initialLink, { replace: true });
};
