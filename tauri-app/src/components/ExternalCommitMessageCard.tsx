import { useMemo, useState } from 'react';
import type { Message } from '../stores/workspaceStore';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useCurrentHead } from '../hooks/useCurrentHead';
import { agentClient } from '../lib/agentClient';
import { Badge } from '../../@/components/ui/badge';
import { Button } from '../../@/components/ui/button';
import { GitCommitHorizontal, GitBranch, User, Clock3, Files, ChevronDown, ChevronRight } from 'lucide-react';
import { getGitParentShas } from '../lib/graph/turnUtils';
import { CopyCommitShaButton } from './CopyCommitShaButton';
import { getMessageOutputCommitSha } from '../lib/graph/commitAccessors';

interface ExternalCommitMessageCardProps {
  message: Message;
  workspaceId: string;
}

export function ExternalCommitMessageCard({ message, workspaceId }: ExternalCommitMessageCardProps) {
  const meta = ((message.execution_data as any)?.meta || {}) as Record<string, any>;
  const commitSha = getMessageOutputCommitSha(message);
  const subject = message.aiLabel || message.content || `Commit ${(commitSha || message.id).slice(0, 8)}`;
  const parents = getGitParentShas(message);
  const importedFromRef = typeof meta.imported_from_ref === 'string' ? meta.imported_from_ref : null;
  const authoredAt = typeof meta.git_authored_at === 'string' ? meta.git_authored_at : message.createdAt;
  const authorName = typeof meta.git_author_name === 'string' ? meta.git_author_name : null;


  const { data: workspacesData } = useWorkspaces();
  const repoPath = useMemo(() => {
    const workspaces = workspacesData ?? [];
    const workspace = workspaces.find((conv) => conv.id === workspaceId);
    return workspace?.git_repo_path ?? workspace?.folderPath ?? null;
  }, [workspacesData, workspaceId]);

  const { data: currentHeadSha } = useCurrentHead(repoPath);

  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);

  const toggleFiles = async () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || files || !repoPath || !commitSha || parents.length === 0) return;

    try {
      setLoading(true);
      const diff = await agentClient.diffCommits(repoPath, parents[0], commitSha, false);
      setFiles(diff.files.map((file) => `${file.status.toUpperCase()} ${file.path}`));
    } catch (_error) {
      setFiles(['Unable to load file changes for this commit.']);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-50/30 dark:bg-emerald-950/20">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <GitCommitHorizontal size={14} className="text-emerald-600" />
        <div className="text-xs font-semibold">External Commit</div>
        {currentHeadSha && commitSha === currentHeadSha && (
          <div className="bg-emerald-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-sm shadow-sm" title="Checked Out Commit">
            HEAD
          </div>
        )}
        {commitSha ? (
          <Badge variant="secondary" className="ml-auto inline-flex items-center gap-1 font-mono text-[10px]">
            {commitSha.slice(0, 8)}
            <CopyCommitShaButton commitSha={commitSha} className="h-3.5 w-3.5" />
          </Badge>
        ) : null}
      </div>

      <div className="space-y-2 px-3 py-2 text-xs">
        <div className="font-medium text-foreground">{subject}</div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          {authorName ? (
            <span className="inline-flex items-center gap-1">
              <User size={11} />
              {authorName}
            </span>
          ) : null}
          {authoredAt ? (
            <span className="inline-flex items-center gap-1">
              <Clock3 size={11} />
              {new Date(authoredAt).toLocaleString()}
            </span>
          ) : null}
          {importedFromRef ? (
            <span className="inline-flex items-center gap-1">
              <GitBranch size={11} />
              {importedFromRef.replace('refs/heads/', '')}
            </span>
          ) : null}
        </div>

        {parents.length > 0 ? (
          <div className="text-[11px] text-muted-foreground">
            Parents: <span className="font-mono">{parents.map((parent) => parent.slice(0, 8)).join(', ')}</span>
          </div>
        ) : null}

        <div>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={toggleFiles}>
            {expanded ? <ChevronDown size={12} className="mr-1" /> : <ChevronRight size={12} className="mr-1" />}
            <Files size={12} className="mr-1" />
            File changes
          </Button>
          {expanded ? (
            <div className="mt-1 rounded-md border border-border/50 bg-background/70 p-2">
              {loading ? (
                <div className="text-[11px] text-muted-foreground">Loading file changes...</div>
              ) : (
                <ul className="space-y-0.5 text-[11px]">
                  {(files ?? []).length > 0 ? (files ?? []).map((file) => (
                    <li key={file} className="font-mono truncate">{file}</li>
                  )) : (
                    <li className="text-muted-foreground">No file changes metadata.</li>
                  )}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
