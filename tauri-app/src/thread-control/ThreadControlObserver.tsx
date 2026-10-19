import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { workspaceApplication } from '../application/workspaces';
import { localNodeKeys } from '../hooks/useLocalNodes';
import { threadSessionKeys } from '../hooks/useThreadSessions';

type ThreadControlChanged = {
  workspaceId?: string | null;
  threadId?: string | null;
};

/**
 * Render-only observer for native thread mutations. Thread control remains fully
 * operational when this component (or the entire webview) is not mounted.
 */
export function ThreadControlObserver() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workspaceApplication.isDesktop()) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<ThreadControlChanged>('thread-control:changed', ({ payload }) => {
      const workspaceId = payload?.workspaceId?.trim();
      if (!workspaceId) return;
      void queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: threadSessionKeys.workspace(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: ['messages', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['graph-snapshot', workspaceId] });
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);

  return null;
}
