import React, { useMemo } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '../../@/components/ui/alert';
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
  
  // Initialize workspace if not already open
  React.useEffect(() => {
    if (!session && selectedWorkspaceId && repoPath) {
      const { openMergeSession } = useIntegrationStore.getState();
      openMergeSession(selectedWorkspaceId, repoPath);
    }
  }, [session, selectedWorkspaceId, repoPath]);

  if (!selectedWorkspaceId) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Select a workspace to start merging commits.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!repoPath) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            This workspace does not have a git repository configured.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <EmbeddedIntegrationWorkspace onClose={onClose} />;
}

export default MergePanel;
