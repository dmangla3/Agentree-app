import { useState } from 'react';
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
}

const getShareTitle = (share: WorkspacePublicShare) => (
  share.rootNode?.aiLabel || share.rootNode?.contentPreview || `Node ${share.rootNodeId.slice(0, 8)}`
);

export function WorkspaceShareDialog({ workspaceId, workspaceName }: WorkspaceShareDialogProps) {
  const [open, setOpen] = useState(false);
  const [copiedPublicId, setCopiedPublicId] = useState<string | null>(null);
  const toast = useToastHelpers();
  const sharesQuery = useWorkspacePublicShares(open ? workspaceId : null);
  const revokeShare = useRevokePublicShare();

  const shares = sharesQuery.data?.shares ?? [];

  const handleCopy = async (share: WorkspacePublicShare) => {
    try {
      await writeClipboardText(getPublicShareUrl(share.publicId));
      setCopiedPublicId(share.publicId);
      window.setTimeout(() => setCopiedPublicId(null), 1600);
      toast.success('Copied link');
    } catch (error) {
      console.error('[WorkspaceShareDialog] Failed to copy share URL:', error);
      toast.error('Copy failed', 'The link could not be copied to the clipboard.');
    }
  };

  const handleRevoke = async (share: WorkspacePublicShare) => {
    if (!workspaceId) return;
    try {
      await revokeShare.mutateAsync({ workspaceId, shareId: share.id });
      toast.success('Public link revoked');
    } catch (error) {
      console.error('[WorkspaceShareDialog] Failed to revoke share:', error);
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
        <span className="hidden sm:inline text-xs">Shared Nodes</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe2 className="h-4 w-4" />
              Shared Node Links
            </DialogTitle>
            <DialogDescription>
              Manage unlisted read-only node subgraph links for {workspaceName || 'this workspace'}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 overflow-hidden">
            <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-sm leading-5 text-muted-foreground">
              A node share exposes the selected root node and every descendant below it. Full node content, attachments, and raw execution data are not included in the public payload.
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium uppercase text-muted-foreground">
                  Active links
                </label>
                <span className="text-xs text-muted-foreground">{shares.length}</span>
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto overflow-x-hidden pr-1">
                {sharesQuery.isLoading ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">Loading shared nodes...</div>
                ) : shares.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">No active public node links.</div>
                ) : (
                  shares.map((share) => (
                    <div key={share.id} className="flex max-w-full flex-col gap-2 rounded-lg border border-border/70 bg-background/80 p-3 shadow-sm sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <div className="truncate text-sm font-medium leading-5" title={getShareTitle(share)}>{getShareTitle(share)}</div>
                        <div className="mt-1 max-w-full truncate rounded-md bg-muted/45 px-2 py-1 font-mono text-[11px] leading-4 text-muted-foreground" title={getPublicShareUrl(share.publicId)}>
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
                        <Button type="button" variant="outline" size="sm" onClick={() => handleRevoke(share)} disabled={revokeShare.isPending} className="h-8 w-8 p-0 text-destructive hover:text-destructive" title="Revoke link">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
