import { useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { Check, Copy, ExternalLink, Globe2, Share2, Trash2 } from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../@/components/ui/dialog';
import {
  getPublicShareUrl,
  useRevokePublicShare,
  useWorkspacePublicShares,
  type WorkspacePublicShare,
} from '../hooks/useWorkspacePublicShare';
import { writeClipboardText } from '../lib/clipboard';
import { useToastHelpers } from './Toast';

interface WorkspaceShareDialogProps {
  workspaceId: string | null;
  workspaceName: string | null;
  cloudSyncEnabled: boolean;
}

const getShareTitle = (share: WorkspacePublicShare) => (
  share.rootNode?.aiLabel || share.rootNode?.contentPreview || `Node ${share.rootNodeId.slice(0, 8)}`
);

export function WorkspaceShareDialog({
  workspaceId,
  workspaceName,
  cloudSyncEnabled,
}: WorkspaceShareDialogProps) {
  const [open, setOpen] = useState(false);
  const [copiedPublicId, setCopiedPublicId] = useState<string | null>(null);
  const toast = useToastHelpers();
  const sharesQuery = useWorkspacePublicShares(open && cloudSyncEnabled ? workspaceId : null);
  const revokeShare = useRevokePublicShare();
  const shares = sharesQuery.data?.shares ?? [];

  const handleCopy = async (share: WorkspacePublicShare) => {
    try {
      await writeClipboardText(getPublicShareUrl(share.publicId));
      setCopiedPublicId(share.publicId);
      window.setTimeout(() => setCopiedPublicId(null), 1600);
      toast.success('Copied link');
    } catch {
      toast.error('Copy failed', 'The link could not be copied to the clipboard.');
    }
  };

  const handleRevoke = async (share: WorkspacePublicShare) => {
    if (!workspaceId) return;
    try {
      await revokeShare.mutateAsync({ workspaceId, shareId: share.id });
      toast.success('Public link revoked');
    } catch {
      toast.error('Unable to revoke link', 'The public node link is still active.');
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        title="View shared node links"
        disabled={!workspaceId}
        onClick={() => setOpen(true)}
        className="h-8 gap-2"
      >
        <Share2 className="h-3.5 w-3.5" />
        <span className="hidden text-xs sm:inline">Shared Nodes</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe2 className="h-4 w-4" />
              Shared Node Links
            </DialogTitle>
            <DialogDescription>
              Manage unlisted read-only graph links for {workspaceName || 'this workspace'}.
            </DialogDescription>
          </DialogHeader>

          {!cloudSyncEnabled ? (
            <div className="rounded-md border border-border/70 bg-muted/30 p-4 text-sm leading-5 text-muted-foreground">
              Nothing from this workspace is stored on Agentree Cloud. Share a node from its menu to review and enable cloud sync.
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase text-muted-foreground">Active links</span>
                <span className="text-xs text-muted-foreground">{shares.length}</span>
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto overflow-x-hidden pr-1">
                {sharesQuery.isError ? (
                  <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-destructive">
                        {shares.length > 0 ? 'Unable to refresh shared node links.' : 'Unable to load shared node links.'}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {shares.length > 0 ? 'Showing previously loaded links.' : 'Active public links may still exist.'}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={sharesQuery.isFetching}
                      onClick={() => void sharesQuery.refetch()}
                      className="shrink-0"
                    >
                      {sharesQuery.isFetching ? 'Trying again...' : 'Try again'}
                    </Button>
                  </div>
                ) : null}
                {sharesQuery.isLoading ? (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Loading shared nodes...</div>
                ) : shares.length === 0 && !sharesQuery.isError ? (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No active public node links.</div>
                ) : shares.map((share) => {
                  const created = new Date(share.createdAt);
                  const createdLabel = Number.isNaN(created.getTime())
                    ? null
                    : `Created ${formatDistanceToNowStrict(created, { addSuffix: true })}`;
                  return (
                    <div key={share.id} className="flex max-w-full flex-col gap-2 rounded-lg border bg-background/80 p-3 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <div className="truncate text-sm font-medium" title={getShareTitle(share)}>{getShareTitle(share)}</div>
                        {createdLabel ? <div className="mt-0.5 text-xs text-muted-foreground">{createdLabel}</div> : null}
                        <div className="mt-1 truncate rounded-md bg-muted/45 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                          {getPublicShareUrl(share.publicId)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-auto">
                        <Button type="button" variant="outline" size="sm" onClick={() => handleCopy(share)} className="h-8 w-8 p-0" title="Copy link">
                          {copiedPublicId === share.publicId ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => window.open(getPublicShareUrl(share.publicId), '_blank', 'noopener,noreferrer')} className="h-8 w-8 p-0" title="Open link">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => handleRevoke(share)} disabled={revokeShare.isPending} className="h-8 w-8 p-0 text-destructive" title="Revoke link">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
