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
    <div data-design-scope="panels" className="flex h-full items-center justify-center p-6 antialiased">
      <div className="flex w-full max-w-sm items-start gap-3 px-3 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--app-warning)/0.1)] text-[hsl(var(--app-warning))]">
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
      <div data-design-scope="panels" className="flex h-full items-center justify-center p-6 antialiased">
        <div className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-foreground">
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
