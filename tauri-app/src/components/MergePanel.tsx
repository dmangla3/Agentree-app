import React, { useMemo } from 'react';
import { GitMerge, Loader2, AlertCircle } from 'lucide-react';
import { useIntegrationStore } from '../stores/integrationStore';
import { EmbeddedIntegrationWorkspace } from './integration/IntegrationWorkspace';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useWorkspaces } from '../hooks/useWorkspaces';

interface MergePanelProps {
  onClose?: () => void;
}

export function MergePanel({ onClose }: MergePanelProps) {
  const { session } = useIntegrationStore();
  const { selectedWorkspaceId } = useWorkspaceStore();
  const { data: workspacesData } = useWorkspaces();
  
  const selectedWorkspace = useMemo(() => {
    if (!workspacesData || !selectedWorkspaceId) return null;
    return workspacesData.find((c) => c.id === selectedWorkspaceId);
  }, [workspacesData, selectedWorkspaceId]);

  const repoPath = selectedWorkspace?.git_repo_path || selectedWorkspace?.folderPath;

  const panelNotice = (message: string) => (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex w-full max-w-md items-start gap-3 rounded-xl border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel)/0.82)] p-4 shadow-[0_16px_36px_-30px_hsl(var(--foreground)/0.42),inset_0_1px_0_hsl(var(--foreground)/0.04)]">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--app-warning)/0.12)] text-[hsl(var(--app-warning))]">
          <AlertCircle className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">Merge panel unavailable</p>
          <p className="text-xs leading-5 text-muted-foreground">{message}</p>
        </div>
      </div>
    </div>
  );
  
  // Initialize workspace if not already open
  React.useEffect(() => {
    if (
      selectedWorkspaceId &&
      repoPath &&
      (!session || session.workspaceId !== selectedWorkspaceId || session.repoPath !== repoPath)
    ) {
      const { ensureMergeSession } = useIntegrationStore.getState();
      ensureMergeSession(selectedWorkspaceId, repoPath);
    }
  }, [session, selectedWorkspaceId, repoPath]);

  if (!selectedWorkspaceId) {
    return panelNotice('Select a workspace to start merging commits.');
  }

  if (!repoPath) {
    return panelNotice('This workspace does not have a git repository configured.');
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex items-center gap-3 rounded-xl border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel)/0.78)] px-4 py-3 text-sm text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]">
          <GitMerge className="h-4 w-4 text-[hsl(var(--app-graph-commit))]" />
          <Loader2 className="h-4 w-4 animate-spin" />
          Preparing merge workspace
        </div>
      </div>
    );
  }

  return <EmbeddedIntegrationWorkspace onClose={onClose} />;
}

export default MergePanel;
