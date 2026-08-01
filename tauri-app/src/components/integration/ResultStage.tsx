import { useEffect, useMemo, useState } from 'react';
import { Check, GitBranch, ArrowRight, Copy, GitCommit, GitMerge, Loader2 } from 'lucide-react';
import { useIntegrationStore } from '../../stores/integrationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { agentClient } from '../../lib/agentClient';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { cn } from '../../lib/utils';
import { Button } from '../../../@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../@/components/ui/card';
import { Badge } from '../../../@/components/ui/badge';
import { Label } from '../../../@/components/ui/label';
import { useQuery } from '@tanstack/react-query';

// ═══════════════════════════════════════════════════════════════════════════
// BRANCH POINTER SELECTOR
// ═══════════════════════════════════════════════════════════════════════════

function BranchPointerSelector() {
  const { session, setPromotionTarget } = useIntegrationStore();
  const { data: workspacesData } = useWorkspaces();
  
  const selectedWorkspace = useMemo(() => {
    if (!workspacesData || !session) return null;
    return workspacesData.find((c) => c.id === session.workspaceId);
  }, [workspacesData, session?.workspaceId]);

  const repoPath = selectedWorkspace?.git_repo_path || selectedWorkspace?.folderPath;

  const { data: pointers = [] } = useQuery({
    queryKey: ['branch-pointers', repoPath],
    enabled: !!repoPath,
    queryFn: async () => {
      if (!repoPath) return [];
      return agentClient.listBranchPointers(repoPath);
    },
  });

  const targetBranch = session?.target?.branchName && !session.target.branchName.startsWith('agentree/')
    ? {
        name: session.target.branchName,
        gitRef: `refs/heads/${session.target.branchName}`,
        kind: 'branch' as const,
      }
    : null;

  const promotionTargets = [
    ...(targetBranch ? [targetBranch] : []),
    ...pointers
      .filter((pointer) => !targetBranch || pointer.git_ref !== targetBranch.gitRef)
      .map((pointer) => ({
        name: pointer.name,
        gitRef: pointer.git_ref,
        kind: 'pointer' as const,
      })),
  ];

  useEffect(() => {
    if (session && !session.promotionTarget && targetBranch) {
      setPromotionTarget(targetBranch);
    }
  }, [session, setPromotionTarget, targetBranch]);

  if (!session) return null;

  if (promotionTargets.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No branch or pointer targets available for promotion.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {promotionTargets.map((target) => {
        const isSelected = session.promotionTarget?.gitRef === target.gitRef;
        return (
          <button
            key={target.gitRef}
            onClick={() => setPromotionTarget(isSelected ? null : target)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-all',
              isSelected 
                ? 'border-primary bg-primary/5' 
                : 'border-border hover:border-primary/50'
            )}
          >
            <GitBranch className={cn(
              'h-4 w-4',
              isSelected ? 'text-primary' : 'text-muted-foreground'
            )} />
            <span className="flex-1 font-medium">{target.name}</span>
            <Badge variant="outline" className="text-[10px] h-5 uppercase">
              {target.kind}
            </Badge>
            <span className="text-[10px] text-muted-foreground font-mono">
              {target.kind === 'branch'
                ? session.target?.commitSha.slice(0, 7)
                : pointers.find((pointer) => pointer.git_ref === target.gitRef)?.commit_sha.slice(0, 7)}
            </span>
            {isSelected && (
              <Badge variant="secondary" className="text-[10px] h-5 bg-primary/10 text-primary border-primary/20">Selected</Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN RESULT STAGE
// ═══════════════════════════════════════════════════════════════════════════

export function ResultStage() {
  const { session, closeMergeSession } = useIntegrationStore();
  const { dispatchFocus } = useWorkspaceStore();
  const [isPromoting, setIsPromoting] = useState(false);
  const [promotionDone, setPromotionDone] = useState(false);

  if (!session || !session.resultNodeId) return null;

  const { data: workspacesData } = useWorkspaces();
  const selectedWorkspace = useMemo(() => {
    if (!workspacesData || !session) return null;
    return workspacesData.find((c) => c.id === session.workspaceId);
  }, [workspacesData, session.workspaceId]);

  const repoPath = selectedWorkspace?.git_repo_path || selectedWorkspace?.folderPath;

  const handlePromote = async () => {
    if (!session.promotionTarget || !repoPath) return;
    
    setIsPromoting(true);
    try {
      await agentClient.updateGitRef(
        repoPath,
        session.promotionTarget.gitRef,
        session.resultCommitSha!
      );
      setPromotionDone(true);
    } catch (error) {
      console.error('Failed to promote:', error);
    } finally {
      setIsPromoting(false);
    }
  };

  const handleGoToResult = () => {
    dispatchFocus({ messageId: session.resultNodeId, source: 'system', metadata: { reason: 'integration-result' } });
    closeMergeSession();
  };

  const handleCopySha = () => {
    if (session.resultCommitSha) {
      navigator.clipboard.writeText(session.resultCommitSha);
    }
  };

  const resolvedDecisions = session.reviewIssues
    .map((issue) => ({
      issue,
      option: issue.options.find((option) => option.id === session.issueSelections[issue.id]) || null,
    }))
    .filter((entry) => entry.option);

  return (
    <div className="flex flex-col h-full space-y-0 relative">
      <div className="flex-1 overflow-y-auto space-y-6 pb-20 pr-2">
        {/* Success Header */}
        <div className="flex flex-col items-center justify-center space-y-3 py-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 border border-emerald-500/20 shadow-sm">
            <Check className="h-8 w-8 text-emerald-500" />
          </div>
          <div>
            <h3 className="text-xl font-bold text-foreground">Merge Complete!</h3>
            <p className="text-sm text-muted-foreground max-w-xs">
              The integration has been successfully finalized and added to the graph.
            </p>
          </div>
        </div>

        {/* Result Card */}
        <Card className="shadow-sm">
          <CardHeader className="pb-3 border-b bg-muted/30">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <GitMerge className="h-3.5 w-3.5" />
              Merge Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 pt-4">
            {/* Commit SHA */}
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase text-muted-foreground">Generated Commit</Label>
              <div className="flex items-center justify-between rounded-md bg-muted/50 border p-2.5">
                <div className="flex items-center gap-2">
                  <GitCommit className="h-4 w-4 text-primary" />
                  <span className="text-xs font-mono font-semibold tracking-tight">
                    {session.resultCommitSha}
                  </span>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-background shadow-sm" onClick={handleCopySha}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-2 rounded-lg bg-background border shadow-sm">
                <p className="text-xl font-bold">{session.sources.length}</p>
                <p className="text-[9px] font-bold uppercase text-muted-foreground">Sources</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-background border shadow-sm">
                <p className="text-xl font-bold">{session.fileDecisions.length}</p>
                <p className="text-[9px] font-bold uppercase text-muted-foreground">Files</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-background border shadow-sm">
                <p className="text-xl font-bold">{session.reviewIssues.length}</p>
                <p className="text-[9px] font-bold uppercase text-muted-foreground">Issues</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {(session.reviewSummary || session.synthesizedSummaryText || resolvedDecisions.length > 0) && (
          <Card className="shadow-sm border-primary/10">
            <CardHeader className="pb-3 border-b bg-primary/5">
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-primary flex items-center gap-2">
                <GitMerge className="h-3.5 w-3.5" />
                Agent Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              {session.reviewSummary ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline" className="text-[10px] uppercase">{session.reviewSummary.overallVerdict}</Badge>
                    <Badge
                      variant={session.reviewSummary.riskLevel === 'high' ? 'destructive' : 'secondary'}
                      className="text-[10px] uppercase"
                    >
                      {session.reviewSummary.riskLevel} risk
                    </Badge>
                  </div>
                  <p className="text-sm leading-relaxed font-medium">{session.reviewSummary.summaryText}</p>
                </div>
              ) : null}

              {session.synthesizedSummaryText ? (
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-[10px] font-bold uppercase text-muted-foreground">What The Agent Applied</p>
                  <p className="mt-2 text-sm leading-relaxed">{session.synthesizedSummaryText}</p>
                </div>
              ) : null}

              {resolvedDecisions.length > 0 ? (
                <div className="space-y-2">
                  <Label className="text-[10px] font-bold uppercase text-muted-foreground">Resolved Semantic Decisions</Label>
                  {resolvedDecisions.map(({ issue, option }) => (
                    <div key={issue.id} className="rounded-md border bg-background p-3 shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold">{issue.title}</p>
                          <p className="text-xs text-muted-foreground leading-relaxed">{issue.summary}</p>
                        </div>
                        <Badge variant="outline" className="text-[10px] uppercase shrink-0">
                          {issue.affectedFiles.length} file{issue.affectedFiles.length === 1 ? '' : 's'}
                        </Badge>
                      </div>
                      <div className="mt-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
                        <p className="text-[10px] font-bold uppercase text-primary">Chosen Resolution</p>
                        <p className="mt-1 text-sm font-medium">{option?.label}</p>
                        {option?.description ? (
                          <p className="mt-1 text-xs text-muted-foreground">{option.description}</p>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : session.reviewSummary ? (
                <div className="rounded-md border bg-emerald-500/5 p-3">
                  <p className="text-sm font-medium">No semantic issues required user intervention.</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    The agent was able to preserve the requested behavior without surfacing extra decisions.
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        )}

        {/* Promotion */}
        <Card className="shadow-sm border-primary/20">
          <CardHeader className="pb-3 border-b bg-primary/5">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-primary flex items-center gap-2">
              <GitBranch className="h-3.5 w-3.5" />
              Promote Result
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <p className="text-xs text-muted-foreground leading-relaxed font-medium">
              Select a branch or Agentree pointer to update its reference to this new merge commit:
            </p>
            
            <BranchPointerSelector />
            
            {session.promotionTarget && !promotionDone && (
              <Button 
                onClick={handlePromote} 
                disabled={isPromoting}
                className="w-full gap-2 h-10 shadow-sm"
              >
                {isPromoting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Updating {session.promotionTarget.name}...
                  </>
                ) : (
                  <>
                    <GitBranch className="h-4 w-4" />
                    Update {session.promotionTarget.name}
                  </>
                )}
              </Button>
            )}
            
            {promotionDone && (
              <div className="flex items-center justify-center gap-2 rounded-md bg-emerald-500/10 border border-emerald-500/20 p-3 text-xs font-bold text-emerald-600 uppercase shadow-sm">
                <Check className="h-4 w-4" />
                <span>{session.promotionTarget?.name} updated successfully</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Footer Actions */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between border-t bg-background/95 backdrop-blur pt-4 pb-2 pr-4 z-10">
        <Button
          variant="outline"
          onClick={closeMergeSession}
          className="h-10 px-6"
        >
          Close
        </Button>

        <Button
          onClick={handleGoToResult}
          className="gap-2 h-10 px-6 shadow-sm"
        >
          View in Graph
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export default ResultStage;
