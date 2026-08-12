import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Loader2,
  GitMerge,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  SquareTerminal,
  Play,
  Check,
  X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useIntegrationStore } from '../../stores/integrationStore';
import { useWorkspaceStore, type Message } from '../../stores/workspaceStore';
import { useAgents, findDefaultCodexAgentId } from '../../hooks/useAgents';
import { useMessages } from '../../hooks/useMessages';
import { Popover, PopoverContent, PopoverTrigger } from '../../../@/components/ui/popover';
import { UnifiedAgentModelSelector } from '../UnifiedAgentModelSelector';
import { cn } from '../../lib/utils';
import { Button } from '../../../@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../@/components/ui/card';
import { ScrollArea } from '../../../@/components/ui/scroll-area';
import { Badge } from '../../../@/components/ui/badge';
import { Label } from '../../../@/components/ui/label';
import { agentClient, ConflictResolution, MergeReviewTimelineEvent } from '../../lib/agentClient';
import { api } from '../../lib/api';
import { scheduleMessagesRefreshWhenGraphIdle } from '../../lib/graphInteractionGate';
import { getMessageOutputCommitSha } from '../../lib/graph/commitAccessors';
import { persistMergeCommitGraph } from '../../lib/mergeCommitGraph';
import { getMergeReviewTerminalReconciliation } from './mergeReviewReconcile';
import { persistMergeResultNodeLocally } from './mergeResultNode';

const autoStartedMergeReviewKeys = new Set<string>();

const getAutoStartKey = (session: NonNullable<ReturnType<typeof useIntegrationStore.getState>['session']>) => [
  session.id,
  session.target?.commitSha ?? '',
  session.sources.map((source) => source.commitSha).join(','),
  session.preview?.base_commit ?? '',
].join('|');

const parseCliArgs = (cliArgs: string | null | undefined) => {
  const tokens = String(cliArgs || '').split(/\s+/).filter(Boolean);
  let model: string | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === '--model' && tokens[i + 1]) {
      model = tokens[i + 1];
      i += 1;
    }
  }
  return { model };
};

const resolveMergeEndpointNodeId = (
  endpoint: { nodeId?: string; id: string; commitSha: string },
  messages: Message[],
  messageById: Map<string, Message>,
): string | null => {
  if (endpoint.nodeId && messageById.has(endpoint.nodeId)) return endpoint.nodeId;
  if (endpoint.id && messageById.has(endpoint.id)) return endpoint.id;

  return messages
    .filter((message) => getMessageOutputCommitSha(message) === endpoint.commitSha)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0]?.id ?? null;
};

export function SmartResolutionStage() {
  const {
    session,
    moveToStage,
    beginReviewRun,
    setReviewStatus,
    setReviewIssueSelection,
    appendReviewTimeline,
    completeReviewRun,
    setApplyState,
    setResult,
    applySynthesisResult,
  } = useIntegrationStore();
  const { selectedAgentId, setSelectedAgentId } = useWorkspaceStore();
  const { data: agents = [] } = useAgents();
  const { data: messages = [] } = useMessages(session?.workspaceId ?? null);
  const queryClient = useQueryClient();

  const [isAgentPopoverOpen, setIsAgentPopoverOpen] = useState(false);
  const [isApplyingMerge, setIsApplyingMerge] = useState(false);
  const [applyRunId, setApplyRunId] = useState<string | null>(null);
  const [agentPhase, setAgentPhase] = useState<'idle' | 'reviewing' | 'synthesizing' | 'applying' | 'completed' | 'failed'>('idle');
  const [agentTimeline, setAgentTimeline] = useState<MergeReviewTimelineEvent[]>([]);
  const reviewUnsubRef = useRef<null | (() => void)>(null);

  if (!session) return null;

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) || null;
  const parsedCliArgs = parseCliArgs(selectedAgent?.cliArgs);
  const effectiveAgentType = selectedAgent?.type || 'codex';
  const effectiveModelId = (selectedAgent as any)?.model_config?.model || parsedCliArgs.model || null;
  const displayName = selectedAgent ? selectedAgent.name : 'Codex';
  const applyState = session.applyState || { status: 'not-run' as const };

  const conflictedFiles = useMemo(
    () => session.fileDecisions.filter((decision) => session.preview?.conflicted_files.includes(decision.path)),
    [session.fileDecisions, session.preview?.conflicted_files]
  );
  const autoMergeableFiles = useMemo(
    () => session.fileDecisions.filter((decision) => session.preview?.auto_mergeable_files.includes(decision.path)),
    [session.fileDecisions, session.preview?.auto_mergeable_files]
  );
  const reviewIssues = session.reviewIssues;
  const reviewComplete = Boolean(
    session.reviewSummary &&
    reviewIssues.every((issue) => Boolean(session.issueSelections[issue.id]))
  );
  const isRunning = session.reviewRun.status === 'running';
  const canBypass = session.reviewRun.canBypass;
  const resolvedDecisions = useMemo(
    () => session.reviewIssues
      .map((issue) => ({
        issue,
        option: issue.options.find((option) => option.id === session.issueSelections[issue.id]) || null,
      }))
      .filter((entry) => entry.option),
    [session.issueSelections, session.reviewIssues]
  );

  const appendAgentActivity = (level: MergeReviewTimelineEvent['level'], message: string) => {
    setAgentTimeline((current) => [
      ...current,
      {
        timestamp: Date.now(),
        level,
        message,
      },
    ].slice(-200));
  };

  useEffect(() => {
    if (agents.length === 0) return;
    if (selectedAgentId && agents.some((agent) => agent.id === selectedAgentId)) return;

    const defaultAgentId = findDefaultCodexAgentId(agents);
    if (defaultAgentId) {
      setSelectedAgentId(defaultAgentId);
    }
  }, [agents, selectedAgentId, setSelectedAgentId]);

  useEffect(() => {
    setAgentTimeline([]);
    setApplyRunId(null);
    setAgentPhase(session.reviewRun.status === 'running' ? 'reviewing' : 'idle');
  }, [session.id, session.target?.commitSha, session.sources.length, session.preview?.base_commit]);

  useEffect(() => {
    let mounted = true;
    agentClient.onMergeReviewEvent((event) => {
      if (!mounted) return;

      const isReviewEvent = session.reviewRun.runId && event.runId === session.reviewRun.runId;
      const isApplyEvent = applyRunId && event.runId === applyRunId;
      if (!isReviewEvent && !isApplyEvent) return;

      if (event.type === 'timeline' && event.event) {
        if (isReviewEvent) appendReviewTimeline(event.event);
        if (isApplyEvent) setAgentTimeline((current) => [...current, event.event!].slice(-200));
        return;
      }

      if (event.type === 'result' && event.result && isReviewEvent) {
        completeReviewRun(event.result);
        setAgentPhase('completed');
        return;
      }

      if (event.type === 'status' && event.status) {
        if (isReviewEvent) {
          if (event.message) {
            appendReviewTimeline({
              timestamp: Date.now(),
              level: event.status === 'failed' ? 'error' : 'info',
              message: event.message,
            });
          }
          if (event.status === 'completed') {
            setReviewStatus('completed');
            setAgentPhase('completed');
          } else if (event.status === 'failed') {
            setReviewStatus('failed', {
              error: event.message || 'Merge review failed',
              canBypass: true,
            });
            setAgentPhase('failed');
          } else if (event.status === 'cancelled') {
            setReviewStatus('cancelled', {
              error: event.message || 'Merge review cancelled',
              canBypass: true,
            });
            setAgentPhase('failed');
          } else {
            setAgentPhase('reviewing');
          }
          return;
        }

        if (isApplyEvent) {
          if (event.phase === 'starting') setAgentPhase('synthesizing');
          if (event.status === 'completed') setAgentPhase('completed');
          if (event.status === 'failed') setAgentPhase('failed');
          if (event.message) {
            appendAgentActivity(event.status === 'failed' ? 'error' : 'info', event.message);
          }
        }
        return;
      }

      if (event.type === 'error') {
        if (isReviewEvent) {
          setReviewStatus('failed', {
            error: event.error || event.message || 'Merge review failed',
            canBypass: true,
          });
        }
        if (isApplyEvent) {
          setAgentPhase('failed');
          appendAgentActivity('error', event.error || event.message || 'Agent synthesis failed.');
        }
      }
    }).then((unlisten) => {
      reviewUnsubRef.current = unlisten;
    });

    return () => {
      mounted = false;
      if (reviewUnsubRef.current) {
        reviewUnsubRef.current();
        reviewUnsubRef.current = null;
      }
    };
  }, [appendReviewTimeline, applyRunId, completeReviewRun, session.reviewRun.runId, setReviewStatus]);

  useEffect(() => {
    if (session.reviewRun.status !== 'running' || !session.reviewRun.runId) return;

    let cancelled = false;
    const runId = session.reviewRun.runId;
    agentClient.isMergeReviewRunning(runId)
      .then(async (isRunning) => {
        if (cancelled || isRunning) return;
        const snapshot = await agentClient.getSessionSnapshot(runId).catch(() => null);
        if (cancelled) return;
        const terminal = getMergeReviewTerminalReconciliation(snapshot);
        if (!terminal) return;
        appendReviewTimeline({
          timestamp: Date.now(),
          level: terminal.status === 'completed' ? 'info' : 'warning',
          message: terminal.message,
        });
        if (terminal.status === 'completed' && terminal.result) {
          completeReviewRun(terminal.result);
          setAgentPhase('completed');
          return;
        }
        setReviewStatus(terminal.status, {
          error: terminal.status === 'completed' ? null : terminal.message,
          canBypass: terminal.status !== 'completed',
        });
        setAgentPhase(terminal.status === 'completed' ? 'completed' : 'failed');
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [appendReviewTimeline, completeReviewRun, session.reviewRun.runId, session.reviewRun.status, setReviewStatus]);

  const handleAnalyze = async () => {
    if (!session.target) return;

    setAgentPhase('reviewing');
    try {
      const response = await agentClient.startMergeReview({
        repoPath: session.repoPath,
        targetCommit: session.target.commitSha,
        sourceCommits: session.sources.map((source) => source.commitSha),
        files: session.fileDecisions.map((decision) => ({
          path: decision.path,
          group: session.preview?.conflicted_files.includes(decision.path) ? 'conflicted' : 'auto-apply',
        })),
        sourceLabels: Object.fromEntries(session.sources.map((source) => [source.commitSha, source.label])),
        agentType: effectiveAgentType,
        agentName: selectedAgent?.name || null,
        cliArgs: selectedAgent?.cliArgs || null,
        promptFlag: selectedAgent?.promptFlag || null,
        selectedModelId: effectiveModelId,
      });

      beginReviewRun({
        runId: response.runId,
        selectedAgentType: effectiveAgentType,
        selectedAgentName: selectedAgent?.name || displayName,
        selectedAgentCliArgs: selectedAgent?.cliArgs || null,
        selectedAgentPromptFlag: selectedAgent?.promptFlag || null,
        selectedModelId: effectiveModelId,
      });
      appendReviewTimeline({
        timestamp: Date.now(),
        level: 'info',
        message: `Started merge review with ${displayName}.`,
      });
    } catch (error) {
      setReviewStatus('failed', {
        error: error instanceof Error ? error.message : 'Failed to start merge review',
        canBypass: true,
      });
      setAgentPhase('failed');
      throw error;
    }
  };

  useEffect(() => {
    const shouldAutoStart =
      session.stage === 'smart-resolution' &&
      !!session.preview &&
      !!session.target &&
      session.reviewRun.status === 'idle' &&
      !session.reviewSummary &&
      !autoStartedMergeReviewKeys.has(getAutoStartKey(session));

    if (!shouldAutoStart) return;

    const autoStartKey = getAutoStartKey(session);
    autoStartedMergeReviewKeys.add(autoStartKey);
    handleAnalyze().catch(() => {
      autoStartedMergeReviewKeys.delete(autoStartKey);
    });
  }, [
    displayName,
    effectiveAgentType,
    effectiveModelId,
    selectedAgent?.cliArgs,
    selectedAgent?.name,
    selectedAgent?.promptFlag,
    session.preview,
    session.reviewRun.status,
    session.reviewSummary,
    session.stage,
    session.target,
  ]);

  const handleCancel = async () => {
    if (!session.reviewRun.runId) return;
    try {
      await agentClient.stopMergeReview(session.reviewRun.runId);
    } finally {
      setReviewStatus('cancelled', {
        error: 'Merge review cancelled',
        canBypass: true,
      });
      setAgentPhase('failed');
    }
  };

  const handleOptionSelect = (issueId: string, optionId: string) => {
    setReviewIssueSelection(issueId, optionId);
  };

  const handleApply = async () => {
    if (!session.target) return;

    setIsApplyingMerge(true);
    setAgentTimeline([]);
    setApplyRunId(null);
    setAgentPhase(session.reviewSummary ? 'synthesizing' : 'applying');
    setApplyState({ status: 'running', log: 'Starting merge application...\n' });

    try {
      const resultNodeId = crypto.randomUUID();
      let resolutions: ConflictResolution[];

      if (session.reviewSummary) {
        const runId = crypto.randomUUID();
        setApplyRunId(runId);
        setAgentTimeline([
          {
            timestamp: Date.now(),
            level: 'info',
            message: `Preparing ${session.reviewRun.selectedAgentName || displayName} synthesis workspace...`,
          },
        ]);
        setApplyState({
          status: 'running',
          log: 'Starting merge application...\nSynthesizing semantic decisions into concrete file resolutions...',
        });

        const synthesisResult = await agentClient.synthesizeMergeResolutions({
          runId,
          repoPath: session.repoPath,
          targetCommit: session.target.commitSha,
          sourceCommits: session.sources.map((source) => source.commitSha),
          files: session.fileDecisions.map((decision) => ({
            path: decision.path,
            group: session.preview?.conflicted_files.includes(decision.path) ? 'conflicted' : 'auto-apply',
          })),
          sourceLabels: Object.fromEntries(session.sources.map((source) => [source.commitSha, source.label])),
          issues: session.reviewIssues,
          selections: Object.entries(session.issueSelections).map(([issueId, optionId]) => ({ issueId, optionId })),
          agentType: session.reviewRun.selectedAgentType || 'codex',
          agentName: session.reviewRun.selectedAgentName,
          cliArgs: session.reviewRun.selectedAgentCliArgs,
          promptFlag: session.reviewRun.selectedAgentPromptFlag,
          selectedModelId: session.reviewRun.selectedModelId,
        });

        applySynthesisResult(synthesisResult);
        resolutions = synthesisResult.resolutions;
        setAgentPhase('applying');
        appendAgentActivity('info', 'Semantic synthesis complete. Applying the resolved merge plan through git.');
      } else {
        resolutions = session.fileDecisions.map((decision) => ({
          path: decision.path,
          action: (
            decision.action === 'take-source' ? 'source' :
            decision.action === 'keep-target' ? 'target' :
            decision.action === 'use-base' ? 'base' : 'manual'
          ) as 'source' | 'target' | 'base' | 'manual',
          content: decision.appliedContent,
        }));
        setAgentTimeline([
          {
            timestamp: Date.now(),
            level: 'info',
            message: 'No semantic synthesis was required. Applying git merge directly.',
          },
        ]);
      }

      const messageById = new Map((messages as Message[]).map((message) => [message.id, message]));
      const sourceShas = session.sources.map((source) => source.commitSha);
      const resolvedTargetNodeId = resolveMergeEndpointNodeId(session.target, messages as Message[], messageById);
      const resolvedSourceNodeIds = session.sources
        .map((source) => resolveMergeEndpointNodeId(source, messages as Message[], messageById))
        .filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0);
      const visualParentNodeIds = Array.from(new Set([
        resolvedTargetNodeId,
        ...resolvedSourceNodeIds,
      ].filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0)));
      const newestParentNodeId = visualParentNodeIds
        .map((nodeId) => messageById.get(nodeId))
        .filter((message): message is Message => Boolean(message))
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0]?.id
        ?? visualParentNodeIds[visualParentNodeIds.length - 1]
        ?? resolvedTargetNodeId
        ?? null;
      const commitMessage = `Merge ${session.sources.map((source) => source.label).join(', ')} into ${session.target.label}`;

      setApplyState({
        status: 'running',
        log: `Starting merge application...\n${session.reviewSummary ? 'Semantic decisions synthesized.\n' : ''}Resolving ${resolutions.length} files...\nApplying changes via git worktree...`,
      });

      const result = await agentClient.mergeApply(
        session.repoPath,
        sourceShas,
        session.target.commitSha,
        resultNodeId,
        commitMessage,
        resolutions
      );

      if (result.status === 'noop') {
        setAgentPhase('completed');
        appendAgentActivity('warning', result.message || 'Git reported nothing new to merge into the target.');
        setApplyState({
          status: 'noop',
          log: `Starting merge application...\nResolving conflicts for ${resolutions.length} files...\n${result.message || 'Nothing to merge. The target already contains the resolved merge result.'}`,
        });
        return;
      }

      if (!result.commit_sha) {
        throw new Error('Merge failed: no commit SHA returned');
      }

      appendAgentActivity('info', `Git merge applied successfully. Created commit ${result.commit_sha.slice(0, 7)}.`);
      setApplyState({
        status: 'running',
        log: `Starting merge application...\nResolving conflicts for ${resolutions.length} files...\nApplying changes via git worktree...\nChanges successfully applied. Commit SHA: ${result.commit_sha}\nUpdating project graph...`,
      });

      await api.post(`/workspaces/${session.workspaceId}/messages`, {
        id: resultNodeId,
        role: 'assistant',
        content: commitMessage,
        parentId: newestParentNodeId,
        skipAssistant: true,
      });

      const aiLabel = `Merge: ${session.sources.map((source) => source.label).join(', ')}`;
      const executionData = {
        meta: {
          merge_target_commit: session.target.commitSha,
          merge_source_commits: sourceShas,
        },
        merge_metadata: {
          sources: session.sources,
          target: session.target,
          visual_parent_node_ids: visualParentNodeIds,
          policy: session.policy,
          lineage: {
            mode: 'latest-parent-layout',
            primary_parent_node_id: newestParentNodeId,
            promoted_source_node_id: null,
            source_node_ids: resolvedSourceNodeIds,
          },
          decisions: session.reviewIssues.length,
          verified: true,
          review: {
            status: session.reviewRun.status,
            selected_agent_type: session.reviewRun.selectedAgentType,
            selected_model_id: session.reviewRun.selectedModelId,
            summary: session.reviewSummary,
            issue_count: session.reviewIssues.length,
            selected_issue_count: Object.keys(session.issueSelections).length,
          },
        },
      };

      await api.patch(`/messages/${resultNodeId}`, {
        output_commit_sha: result.commit_sha,
        git_branch_name: null,
        ai_label: aiLabel,
        execution_data: executionData,
      });

      await persistMergeResultNodeLocally({
        queryClient,
        workspaceId: session.workspaceId,
        resultNodeId,
        parentId: newestParentNodeId,
        content: commitMessage,
        commitSha: result.commit_sha,
        aiLabel,
        executionData,
      });

      await persistMergeCommitGraph({
        workspaceId: session.workspaceId,
        repoPath: session.repoPath,
        commitSha: result.commit_sha,
        resultNodeId,
        fallbackParents: [session.target.commitSha, ...sourceShas],
        fallbackSubject: commitMessage,
      });

      void scheduleMessagesRefreshWhenGraphIdle(queryClient, session.workspaceId, {
        refetchActive: true,
        reason: 'smart-resolution-apply',
      });

      setApplyState({
        status: 'passed',
        log: `Starting merge application...\n${session.reviewSummary ? 'Semantic decisions synthesized.\n' : ''}Resolving ${resolutions.length} files...\nApplying changes via git worktree...\nChanges successfully applied. Commit SHA: ${result.commit_sha}\nUpdating project graph...\nMerge completed successfully.`,
      });
      setAgentPhase('completed');
      setResult(resultNodeId, result.commit_sha);
    } catch (error: any) {
      setAgentPhase('failed');
      appendAgentActivity('error', error.message || 'Merge apply failed.');
      setApplyState({
        status: 'failed',
        log: `Error applying merge: ${error.message || 'Unknown error'}`,
        error: error.message,
      });
    } finally {
      setIsApplyingMerge(false);
    }
  };

  const statusConfig = {
    'not-run': { label: 'Ready to Apply', icon: Play, color: 'text-muted-foreground', bg: 'bg-muted' },
    'running': { label: 'Applying Merge...', icon: Loader2, color: 'text-primary', bg: 'bg-primary/10' },
    'passed': { label: 'Merge Applied', icon: Check, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
    'noop': { label: 'Nothing to Merge', icon: Check, color: 'text-amber-600', bg: 'bg-amber-500/10' },
    'failed': { label: 'Apply Failed', icon: X, color: 'text-destructive', bg: 'bg-destructive/10' },
  } as const;

  const phaseLabel = agentPhase === 'reviewing'
    ? 'Reviewing'
    : agentPhase === 'synthesizing'
      ? 'Synthesizing'
      : agentPhase === 'applying'
        ? 'Applying'
        : agentPhase === 'completed'
          ? 'Completed'
          : agentPhase === 'failed'
            ? 'Failed'
            : 'Idle';

  const config = statusConfig[applyState.status];
  const Icon = config.icon;
  const canApply = (!reviewIssues.length || reviewComplete || canBypass) && !isRunning;

  return (
    <div className="flex flex-col h-full space-y-0 relative">
      <div className="flex-1 overflow-y-auto space-y-6 pb-20 pr-2">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            AI Resolve
          </h3>
          <p className="text-sm text-muted-foreground">
            Review the merge with AI, make any semantic decisions, then apply the merge from this page.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Badge variant="outline" className="h-7 px-3 gap-1.5 font-medium">
            <GitMerge className="h-3 w-3" />
            {session.fileDecisions.length} Changed Files
          </Badge>
          <Badge variant="destructive" className="h-7 px-3 gap-1.5 font-medium">
            <AlertTriangle className="h-3 w-3" />
            {conflictedFiles.length} Text Conflicts
          </Badge>
          <Badge variant="secondary" className="h-7 px-3 gap-1.5 font-medium bg-amber-500/10 text-amber-700 border-amber-500/20">
            <AlertTriangle className="h-3 w-3" />
            {reviewIssues.length} Semantic Issues
          </Badge>
          <Badge variant="secondary" className="h-7 px-3 gap-1.5 font-medium bg-emerald-500/10 text-emerald-600 border-emerald-500/20">
            <CheckCircle2 className="h-3 w-3" />
            {autoMergeableFiles.length} Safe Files
          </Badge>
        </div>

        <Card className="bg-muted/30 border-dashed">
          <CardContent className="p-4 flex flex-col sm:flex-row items-end sm:items-center gap-4">
            <div className="flex-1 space-y-1.5 w-full">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resolution Agent</Label>
              <Popover open={isAgentPopoverOpen} onOpenChange={setIsAgentPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-between h-10 bg-background shadow-sm">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <Bot className="h-4 w-4 text-primary shrink-0" />
                      <span className="truncate font-medium">{displayName}</span>
                    </div>
                    <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[500px] h-[400px] p-0" align="start" sideOffset={8}>
                  <UnifiedAgentModelSelector
                    onSelectAgent={(id) => { setSelectedAgentId(id); setIsAgentPopoverOpen(false); }}
                    selectedAgentId={selectedAgentId}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex gap-2 shrink-0">
              {isRunning && (
                <Button variant="ghost" size="sm" className="h-10 text-destructive hover:text-destructive hover:bg-destructive/10 gap-2" onClick={handleCancel}>
                  <XCircle className="h-4 w-4" />
                  Cancel
                </Button>
              )}
              <Button
                className="h-10 px-6 gap-2 shadow-sm min-w-[140px]"
                onClick={handleAnalyze}
                disabled={isRunning || isApplyingMerge || applyState.status === 'running'}
              >
                {isRunning ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Reviewing...
                  </>
                ) : (
                  <>
                    <Bot className="h-4 w-4" />
                    {reviewComplete ? 'Re-run AI Review' : 'Run AI Review'}
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {session.reviewRun.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{session.reviewRun.error}</span>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2 flex flex-col">
            <div className="flex items-center gap-2 px-1">
              <SquareTerminal className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Review Progress</span>
            </div>
            <div className="flex-1 rounded-lg border bg-black/95 text-green-400 font-mono text-[11px] p-0 overflow-hidden shadow-inner flex flex-col min-h-[220px]">
              <ScrollArea className="h-[220px]">
                <div className="p-3 space-y-1">
                  {session.reviewTimeline.length === 0 ? (
                    <p className="text-green-400/40 italic">Waiting for analysis to start...</p>
                  ) : session.reviewTimeline.map((event, index) => (
                    <div key={`${event.timestamp}-${index}`} className="flex gap-3 leading-relaxed">
                      <span className="text-green-400/30 shrink-0 select-none">
                        [{new Date(event.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]
                      </span>
                      <span className={cn(
                        event.level === 'error' && 'text-red-400',
                        event.level === 'warning' && 'text-amber-400'
                      )}>
                        {event.message}
                      </span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>

          <div className="space-y-2 flex flex-col">
            <div className="flex items-center gap-2 px-1">
              <GitMerge className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Merge Intelligence</span>
            </div>
            <Card className="flex-1 flex flex-col bg-card/50 min-h-[220px]">
              <CardContent className="p-0 flex-1 overflow-hidden">
                {session.reviewSummary ? (
                  <ScrollArea className="h-[220px]">
                    <div className="p-4 space-y-4">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={session.reviewSummary.riskLevel === 'high' ? 'destructive' : 'secondary'}
                          className="rounded-sm px-1.5 py-0 text-[10px] uppercase font-bold"
                        >
                          {session.reviewSummary.riskLevel} risk
                        </Badge>
                        <Badge variant="outline" className="rounded-sm px-1.5 py-0 text-[10px] uppercase font-bold border-primary/20 text-primary">
                          {session.reviewSummary.overallVerdict}
                        </Badge>
                      </div>
                      <p className="text-sm leading-relaxed text-foreground/90 font-medium whitespace-pre-wrap break-words">
                        {session.reviewSummary.summaryText}
                      </p>
                      <div className="grid grid-cols-2 gap-3 pt-1">
                        <div className="rounded-md border bg-background/50 p-2 text-center">
                          <div className="text-xl font-bold">{session.reviewSummary.changedFilesCount}</div>
                          <p className="text-[10px] font-semibold uppercase text-muted-foreground">Files Scanned</p>
                        </div>
                        <div className="rounded-md border bg-background/50 p-2 text-center">
                          <div className={cn('text-xl font-bold', session.reviewSummary.riskyFilesCount > 0 && 'text-amber-600')}>
                            {session.reviewSummary.riskyFilesCount}
                          </div>
                          <p className="text-[10px] font-semibold uppercase text-muted-foreground">Flagged</p>
                        </div>
                      </div>
                    </div>
                  </ScrollArea>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center space-y-3 px-4 py-4">
                    <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                      <Bot className="h-5 w-5 text-muted-foreground/40" />
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      AI is analyzing the merge matrix to identify semantic conflicts and architectural mismatches.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {session.reviewSummary && reviewIssues.length === 0 && (
          <Card className="border-emerald-500/20 bg-emerald-500/5">
            <CardContent className="p-4 flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">No semantic issues require user input.</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  The agent can resolve this merge automatically. Apply when ready.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {reviewIssues.length > 0 && (
          <div className="space-y-4 pt-2">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Semantic Decisions</span>
              <span className="text-[10px] text-muted-foreground italic">Only unresolved product or behavior choices are shown</span>
            </div>

            <div className="space-y-4">
              {reviewIssues.map((issue) => {
                const selectedOptionId = session.issueSelections[issue.id] || null;
                return (
                  <Card key={issue.id} className="overflow-hidden border-muted-foreground/20">
                    <div className={cn(
                      'h-1 w-full',
                      issue.riskLevel === 'high' ? 'bg-destructive' : 'bg-amber-500'
                    )} />
                    <CardHeader className="py-2.5 px-4 bg-muted/30 border-b flex flex-row items-center justify-between space-y-0">
                      <CardTitle className="text-sm font-semibold truncate max-w-[70%]">{issue.title}</CardTitle>
                      <Badge variant={issue.riskLevel === 'high' ? 'destructive' : 'outline'} className="text-[9px] h-5 uppercase font-bold bg-background">
                        {issue.riskLevel} risk
                      </Badge>
                    </CardHeader>
                    <CardContent className="p-4 space-y-4">
                      <div className="space-y-2">
                        <p className="text-sm font-medium leading-snug">{issue.summary}</p>
                        <div className="bg-muted/30 rounded p-2.5 border border-muted-foreground/10">
                          <p className="text-[11px] text-muted-foreground leading-relaxed italic">
                            <span className="font-bold uppercase text-[9px] mr-2 not-italic">AI Rationale:</span>
                            {issue.rationale}
                          </p>
                        </div>
                        <div className="rounded-md border bg-background/50 p-2.5">
                          <p className="text-[10px] font-semibold uppercase text-muted-foreground">
                            Affects {issue.affectedFiles.length} file{issue.affectedFiles.length === 1 ? '' : 's'}
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed break-words">
                            {issue.affectedFiles.join(', ')}
                          </p>
                        </div>
                      </div>

                      <div className="grid gap-2 pt-1 sm:grid-cols-2">
                        {issue.options.map((option) => (
                          <Button
                            key={option.id}
                            size="sm"
                            variant={selectedOptionId === option.id ? 'default' : 'outline'}
                            className="h-auto min-h-10 justify-start whitespace-normal px-3 py-2 text-left"
                            onClick={() => handleOptionSelect(issue.id, option.id)}
                          >
                            <span className="block text-[11px] font-medium">{option.label}</span>
                            {option.description ? (
                              <span className="mt-1 block text-[10px] text-muted-foreground">{option.description}</span>
                            ) : null}
                          </Button>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        <Card className="shrink-0">
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className={cn('flex h-12 w-12 items-center justify-center rounded-full', config.bg)}>
                <Icon className={cn('h-6 w-6', config.color, applyState.status === 'running' && 'animate-spin')} />
              </div>
              <div>
                <p className={cn('text-lg font-semibold', config.color)}>{config.label}</p>
                <p className="text-xs text-muted-foreground">
                  {applyState.status === 'not-run' && 'Apply the merge directly from this page once review is complete.'}
                  {applyState.status === 'running' && (session.reviewSummary
                    ? `${session.reviewRun.selectedAgentName || displayName} is synthesizing semantic decisions and applying the merge.`
                    : 'Applying merge changes...')}
                  {applyState.status === 'passed' && 'Changes have been committed to the graph.'}
                  {applyState.status === 'noop' && 'No merge commit was created because there is nothing new to merge into the target.'}
                  {applyState.status === 'failed' && 'An error occurred during application.'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2 flex flex-col">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Agent Activity</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full border bg-background px-2 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">
                  {session.reviewRun.selectedAgentName || displayName}
                </span>
                <span className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase',
                  agentPhase === 'failed'
                    ? 'border-destructive/20 bg-destructive/10 text-destructive'
                    : agentPhase === 'completed'
                      ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600'
                      : 'border-primary/20 bg-primary/10 text-primary'
                )}>
                  {phaseLabel}
                </span>
              </div>
            </div>
            <div className="flex-1 rounded-lg border bg-black/95 text-cyan-100 font-mono text-[11px] shadow-inner overflow-hidden min-h-[300px]">
              <ScrollArea className="h-[300px]">
                <div className="p-3 space-y-1.5">
                  {agentTimeline.length === 0 ? (
                    <p className="text-cyan-100/40 italic">
                      {session.reviewSummary
                        ? 'Agent activity will appear here during semantic synthesis and apply.'
                        : 'No apply activity yet.'}
                    </p>
                  ) : agentTimeline.map((event, index) => (
                    <div key={`${event.timestamp}-${index}`} className="flex gap-3 leading-relaxed">
                      <span className="text-cyan-100/30 shrink-0 select-none">
                        [{new Date(event.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]
                      </span>
                      <span className={cn(
                        event.level === 'error' && 'text-red-400',
                        event.level === 'warning' && 'text-amber-400',
                        event.level === 'info' && 'text-cyan-100'
                      )}>
                        {event.message}
                      </span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>

          <div className="space-y-2 flex flex-col">
            <div className="flex items-center gap-2 px-1">
              <SquareTerminal className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Git Execution Log</span>
            </div>
            <Card className="flex flex-col min-h-[300px]">
              <CardContent className="flex-1 overflow-hidden p-0 relative">
                <ScrollArea className="h-[300px] w-full bg-black/95 p-4 font-mono text-[11px] rounded-lg shadow-inner">
                  {applyState.log ? (
                    <pre className={cn(
                      'whitespace-pre-wrap leading-relaxed',
                      applyState.status === 'failed'
                        ? 'text-red-400'
                        : applyState.status === 'noop'
                          ? 'text-amber-300'
                          : 'text-green-400'
                    )}>
                      {applyState.log}
                    </pre>
                  ) : (
                    <div className="text-green-400/20 h-full flex items-center justify-center italic">
                      Terminal ready. Waiting for apply...
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </div>

        {(session.synthesizedSummaryText || resolvedDecisions.length > 0) && (
          <Card className="shrink-0 bg-muted/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                <Bot className="h-4 w-4" />
                Agent Apply Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {session.synthesizedSummaryText ? (
                <p className="leading-relaxed text-muted-foreground">{session.synthesizedSummaryText}</p>
              ) : null}
              {resolvedDecisions.length > 0 ? (
                <div className="space-y-2">
                  {resolvedDecisions.map(({ issue, option }) => (
                    <div key={issue.id} className="rounded-md border bg-background/70 p-3">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">{issue.title}</p>
                      <p className="mt-1 text-sm font-medium">{option?.label}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between border-t bg-background/95 backdrop-blur pt-4 pb-2 pr-4 z-10">
        <Button
          variant="outline"
          onClick={() => moveToStage('setup')}
          disabled={isRunning || isApplyingMerge || applyState.status === 'running'}
          className="gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>

        <div className="flex items-center gap-3">
          {canBypass && !reviewComplete && (
            <Button
              variant="outline"
              onClick={handleApply}
              disabled={isApplyingMerge || applyState.status === 'running'}
              className="gap-2"
            >
              <Play className="h-4 w-4" />
              Bypass and Apply
            </Button>
          )}
          <Button
            onClick={handleApply}
            disabled={!canApply || isApplyingMerge || applyState.status === 'running' || applyState.status === 'passed' || applyState.status === 'noop'}
            className="gap-2 px-8"
          >
            {isApplyingMerge || applyState.status === 'running' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Applying Changes...
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Apply Merge
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default SmartResolutionStage;
