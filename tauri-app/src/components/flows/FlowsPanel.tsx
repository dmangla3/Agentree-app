import { Bot, CheckCircle2, ChevronDown, FileCode2, ListChecks, Loader2, Network, Pencil, Plus, RotateCcw, Save, Workflow, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { stringify } from 'yaml';
import { UnifiedAgentModelSelector } from '../UnifiedAgentModelSelector';
import { Popover, PopoverContent, PopoverTrigger } from '../../../@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../@/components/ui/tooltip';
import { FlowCanvasEditor } from './FlowCanvasEditor';
import { authorFlowFromNaturalLanguage, type FlowAuthoringAgent, type FlowAuthoringResult } from '../../flows/flowAuthoring';
import { buildFlowCatalog, type FlowCatalogItem } from '../../flows/flowCatalog';
import { PREDEFINED_FLOW_SOURCES } from '../../flows/predefinedFlows';
import type { FlowNodeRegistry } from '../../flows/flowNodeRegistry';
import { buildUserFlowNodeRegistry, saveUserFlowNodeDefinitions, USER_FLOW_NODE_REGISTRY_STORE_KEY, useUserFlowNodeDefinitions, writeUserFlowNodeDefinitions } from '../../flows/userFlowNodeRegistryStore';
import { saveUserFlowSource, USER_FLOW_STORE_KEY, useUserFlowSources, writeUserFlowSources } from '../../flows/userFlowStore';
import { mergeStreamingOutput } from '../../agent-runs/agentRunStreamDispatch';
import { agentClient } from '../../lib/agentClient';
import { isLoginProfileActive } from '../../lib/loginProfiles';
import { getRuntimeModelByKey } from '../../lib/runtimeModels';
import { track } from '../../lib/analytics';
import type { FlowDefinition, FlowInputDefinition, FlowNodeTemplate, FlowSource, FlowStatement, UserFlowSource } from '../../flows/types';
import { cn } from '../../lib/utils';
import { useLoginProfilesStore } from '../../stores/loginProfilesStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { formatFlowParamTypes } from '../../flows/flowParamTypes';
import { useToastHelpers } from '../Toast';

export interface FlowsPanelProps {
  className?: string;
  workspaceId?: string | null;
  sources?: FlowSource[];
  userSources?: UserFlowSource[];
  authoringAgent?: FlowAuthoringAgent;
  authoringAgentLabel?: string | null;
}

export function FlowsPanel({
  className,
  workspaceId = null,
  sources = PREDEFINED_FLOW_SOURCES,
  userSources,
  authoringAgent,
  authoringAgentLabel,
}: FlowsPanelProps) {
  const storedUserSources = useUserFlowSources(workspaceId);
  const userNodeDefinitions = useUserFlowNodeDefinitions();
  const [hasRawUserArtifacts, setHasRawUserArtifacts] = useState(() => hasStoredUserFlowArtifacts());
  const toast = useToastHelpers();
  const effectiveUserSources = userSources ?? storedUserSources;
  const registry = useMemo(() => buildUserFlowNodeRegistry(userNodeDefinitions), [userNodeDefinitions]);
  const flows = useMemo(
    () => buildFlowCatalog({ predefinedSources: sources, userSources: effectiveUserSources, registry }),
    [effectiveUserSources, registry, sources]
  );
  const enabledCount = flows.filter((flow) => flow.enabled).length;
  const resettableUserArtifactCount = storedUserSources.length + userNodeDefinitions.length;
  const canResetUserArtifacts = resettableUserArtifactCount > 0 || hasRawUserArtifacts;
  const handleResetToDefaults = useCallback(() => {
    if (!canResetUserArtifacts) return;
    writeUserFlowSources([]);
    writeUserFlowNodeDefinitions([]);
    setHasRawUserArtifacts(false);
    toast.success('Reset to app default flows', 'User-created flows and reusable node templates were removed.');
  }, [canResetUserArtifacts, toast]);

  useEffect(() => {
    setHasRawUserArtifacts(hasStoredUserFlowArtifacts());
  }, [resettableUserArtifactCount]);

  return (
    <section
      className={cn(
        "app-panel flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[hsl(var(--app-border)/0.78)] bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.98),hsl(var(--app-panel)/0.94))]",
        className
      )}
      aria-label="Flows catalog"
    >
      <div className="relative shrink-0 overflow-hidden border-b border-[hsl(var(--app-border)/0.72)] px-5 py-4">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_16%_0%,hsl(var(--app-accent)/0.12),transparent_34%),linear-gradient(90deg,hsl(var(--app-border)/0.16)_1px,transparent_1px)] bg-[length:auto,28px_28px]" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--app-accent))]">
              <Workflow className="h-3.5 w-3.5" strokeWidth={2.1} />
              Flow registry
            </div>
            <p className="mt-2 max-w-[56ch] text-sm leading-6 text-muted-foreground">
              Validated YAML-backed flows. User-defined sources compile before review and only valid enabled flows can run.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleResetToDefaults}
                  disabled={!canResetUserArtifacts}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[hsl(var(--app-border)/0.7)] bg-background/65 px-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
                  aria-label="Reset to app default flows"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end" className="max-w-72 leading-5">
                Removes user-created flows and reusable node templates from local storage. Built-in app default flows stay available.
              </TooltipContent>
            </Tooltip>
            <span className="rounded-md border border-[hsl(var(--app-border)/0.7)] bg-background/65 px-2.5 py-1 text-xs font-semibold text-foreground shadow-[0_10px_24px_-22px_hsl(var(--app-accent)/0.55)]">
              YAML-backed
            </span>
            <span className="rounded-md border border-[hsl(var(--app-border)/0.7)] bg-background/65 px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
              {enabledCount} enabled
            </span>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="space-y-4 px-5 py-5">
          <div className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">Existing flows</h2>
                <p className="mt-1 max-w-[62ch] text-xs leading-5 text-muted-foreground">
                  Browse flow summaries first. Expand a card only when you need inputs, node prompts, canvas, or YAML.
                </p>
              </div>
              <span className="rounded-full border border-[hsl(var(--app-border)/0.62)] bg-background/62 px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
                {flows.length} total
              </span>
            </div>
            {flows.length === 0 ? (
              <div className="flex min-h-36 items-center justify-center rounded-2xl border border-dashed border-[hsl(var(--app-border)/0.68)] bg-background/36 p-8 text-sm text-muted-foreground">
                No flows are registered.
              </div>
            ) : (
              <div className="space-y-3">
                {flows.map((flow) => (
                  <FlowCatalogEntry
                    key={flow.source.id}
                    flow={flow}
                    registry={registry}
                    workspaceId={workspaceId}
                    authoringAgent={authoringAgent}
                    authoringAgentLabel={authoringAgentLabel}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-[hsl(var(--app-border)/0.68)] bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.78),hsl(var(--app-panel)/0.54))] p-4 shadow-[0_22px_60px_-48px_hsl(var(--app-accent)/0.75)]">
            <FlowAuthoringReviewPanel
              workspaceId={workspaceId}
              authoringAgent={authoringAgent}
              authoringAgentLabel={authoringAgentLabel}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function FlowAuthoringReviewPanel({
  workspaceId,
  authoringAgent,
  authoringAgentLabel,
}: {
  workspaceId: string | null;
  authoringAgent?: FlowAuthoringAgent;
  authoringAgentLabel?: string | null;
}) {
  const userNodeDefinitions = useUserFlowNodeDefinitions();
  const registry = useMemo(() => buildUserFlowNodeRegistry(userNodeDefinitions), [userNodeDefinitions]);
  const selectedAgentId = useWorkspaceStore((state) => state.selectedAgentId);
  const setSelectedAgentId = useWorkspaceStore((state) => state.setSelectedAgentId);
  const { profiles, startSync } = useLoginProfilesStore();
  const toast = useToastHelpers();
  const [request, setRequest] = useState('');
  const [status, setStatus] = useState<'idle' | 'drafting' | 'ready' | 'failed'>('idle');
  const [result, setResult] = useState<FlowAuthoringResult | null>(null);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [streamOutput, setStreamOutput] = useState('');
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const selectedAgent = useMemo(
    () => getRuntimeModelByKey(selectedAgentId),
    [selectedAgentId]
  );
  const selectedLoginProfile = useMemo(() => {
    if (!selectedAgent) return null;
    const compatible = profiles.filter((profile) => profile.provider === selectedAgent.provider);
    return compatible.find((profile) => profile.isDefault) ?? compatible[0] ?? null;
  }, [profiles, selectedAgent]);
  const selectedLoginProfileReady = selectedLoginProfile ? isLoginProfileActive(selectedLoginProfile) : false;
  const resolvedAuthoringAgent = useMemo<FlowAuthoringAgent | undefined>(() => {
    if (authoringAgent) return authoringAgent;
    if (!selectedAgent || !selectedLoginProfile || !selectedLoginProfileReady || !agentClient.hasRuntime()) {
      return undefined;
    }
    return {
      complete: async (prompt) => {
        const requestId = crypto.randomUUID();
        activeRequestIdRef.current = requestId;
        setActiveRequestId(requestId);
        const response = await agentClient.completeInternalPrompt({
          purpose: 'flow_authoring',
          provider: selectedAgent.provider,
          model: selectedAgent.modelId,
          reasoningEffort: selectedAgent.reasoningEffort ?? null,
          loginProfileId: selectedLoginProfile.id,
          requestId,
          prompt,
        });
        if (activeRequestIdRef.current === requestId) {
          activeRequestIdRef.current = null;
          setActiveRequestId(null);
        }
        return response.text;
      },
    };
  }, [authoringAgent, selectedAgent, selectedLoginProfile, selectedLoginProfileReady]);
  const authoringUnavailableReason = useMemo(() => {
    if (resolvedAuthoringAgent) return null;
    if (!selectedAgentId || !selectedAgent) {
      return 'Select a model before drafting a flow.';
    }
    if (!agentClient.hasRuntime()) {
      return 'Flow authoring requires the Agentree desktop runtime.';
    }
    if (!selectedLoginProfile) {
      return `${selectedAgent.label} uses ${selectedAgent.providerLabel}. Add or connect a ready ${selectedAgent.providerLabel} account in Logins before drafting a flow.`;
    }
    if (!selectedLoginProfileReady) {
      return selectedLoginProfile.statusMessage
        ?? `${selectedLoginProfile.displayName} is not ready. Open Logins and reconnect or check readiness before drafting a flow.`;
    }
    return null;
  }, [resolvedAuthoringAgent, selectedAgent, selectedAgentId, selectedLoginProfile, selectedLoginProfileReady]);
  const effectiveAuthoringLabel = authoringAgentLabel ?? selectedAgent?.label ?? 'selected agent';

  useEffect(() => startSync(), [startSync]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void agentClient.onInternalCompletionEvent?.((event) => {
      if (disposed || event.requestId !== activeRequestIdRef.current) return;
      setStreamOutput((current) => applyInternalCompletionStreamUpdate(current, event.line, event.stream));
    }).then((cleanup) => {
      unlisten = cleanup;
      if (disposed) cleanup();
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleDraft = useCallback(async () => {
    const trimmed = request.trim();
    if (!trimmed || !resolvedAuthoringAgent) return;
    setStatus('drafting');
    setStreamOutput('');
    const telemetryBase = flowAuthoringTelemetryBase({
      requestLength: trimmed.length,
      workspaceId,
      registry,
    });
    track('Flow Authoring Started', telemetryBase);
    try {
      const authored = await authorFlowFromNaturalLanguage({
        request: trimmed,
        workspaceId,
        registry,
        agent: resolvedAuthoringAgent,
      });
      setResult(authored);
      if (authored.status === 'failed') {
        track('Flow Authoring Failed', {
          ...telemetryBase,
          failure_type: 'validation',
          attempts: authored.attempts,
          issue_count: authored.issues.length,
          first_issue_path: authored.issues[0]?.path || null,
        });
        console.warn('[FlowAuthoring] validation_failed', {
          attempts: authored.attempts,
          issueCount: authored.issues.length,
          issues: authored.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        });
      } else {
        track('Flow Authoring Succeeded', {
          ...telemetryBase,
          attempts: authored.attempts,
          registry_addition_count: authored.registryAdditionIds.length,
          registry_node_count: authored.registryNodeIds.length,
          inline_node_count: authored.inlineNodeIds.length,
          node_count: authored.definition.nodes.length,
          source_length: authored.source.source.length,
        });
      }
      setStatus(authored.status === 'ready' ? 'ready' : 'failed');
    } catch (error) {
      track('Flow Authoring Failed', {
        ...telemetryBase,
        failure_type: 'exception',
        attempts: 0,
        issue_count: 0,
        error_name: error instanceof Error ? error.name : typeof error,
      });
      console.error('[FlowAuthoring] draft failed', error);
      setResult({
        status: 'failed',
        source: {
          id: 'flow_authoring_failed',
          label: 'Flow authoring failed',
          scope: workspaceId ? 'workspace' : 'global',
          workspaceId,
          source: '',
          version: 1,
          enabled: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        issues: [{
          path: '',
          message: formatFlowAuthoringError(error),
        }],
        attempts: 0,
      });
      setStatus('failed');
    } finally {
      activeRequestIdRef.current = null;
      setActiveRequestId(null);
    }
  }, [registry, request, resolvedAuthoringAgent, workspaceId]);

  const handleCancel = useCallback(() => {
    const requestId = activeRequestIdRef.current ?? activeRequestId;
    if (!requestId) return;
    void agentClient.cancelInternalCompletion?.(requestId);
  }, [activeRequestId]);

  const handleApprove = useCallback(() => {
    if (!result || result.status !== 'ready') return;
    saveUserFlowNodeDefinitions({ definitions: result.registryAdditions });
    saveUserFlowSource(result.source);
    toast.success('Flow saved and enabled');
    setRequest('');
    setResult(null);
    setStreamOutput('');
    setStatus('idle');
  }, [result, toast]);

  const readyResult = result?.status === 'ready' ? result : null;
  const failedResult = result?.status === 'failed' ? result : null;

  return (
    <section className="space-y-3" aria-label="Create flow">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Plus className="h-4 w-4 text-[hsl(var(--app-accent))]" />
            Create flow
          </h2>
          <p className="mt-1 max-w-[64ch] text-xs leading-5 text-muted-foreground">
            Draft a user-defined flow from natural language, validate it, review the compiled artifacts, then approve it for the selector.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Popover open={isModelPickerOpen} onOpenChange={setIsModelPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={status === 'drafting'}
                className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg border border-[hsl(var(--app-border))] bg-background/72 px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-background disabled:pointer-events-none disabled:opacity-50"
                aria-label="Select flow authoring model"
              >
                <Bot className="h-3.5 w-3.5 text-[hsl(var(--app-accent))]" />
                <span className="truncate">{selectedAgent?.label ?? 'Choose model'}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[620px] p-0" side="bottom" align="end" sideOffset={8}>
              <div className="h-[390px]">
                <UnifiedAgentModelSelector
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={(agentId) => {
                    setSelectedAgentId(agentId);
                    setIsModelPickerOpen(false);
                  }}
                />
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel-strong)/0.78)] shadow-[inset_0_1px_0_hsl(var(--app-border)/0.42)] transition-colors focus-within:border-[hsl(var(--app-accent)/0.48)] focus-within:bg-[hsl(var(--app-panel-strong)/0.9)]">
        <textarea
          value={request}
          onChange={(event) => {
            setRequest(event.target.value);
          }}
          placeholder="Example: Run 3 implementers in parallel, synthesize the best result, review it against the original request, then ask a fixer to iterate until the review passes."
          className="min-h-24 w-full resize-y border-0 bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/65"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--app-border)/0.52)] bg-background/34 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            Describe the flow; Agentree will draft YAML and validate it before saving.
          </span>
          {status === 'drafting' ? (
            <button
              type="button"
              onClick={handleCancel}
              disabled={!activeRequestId}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/35 bg-destructive/8 px-3 text-xs font-semibold text-destructive transition-[background-color,transform] duration-150 hover:bg-destructive/12 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleDraft()}
              disabled={!request.trim() || Boolean(authoringUnavailableReason)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[hsl(var(--app-border))] bg-background/82 px-3 text-xs font-semibold text-foreground transition-[background-color,transform] duration-150 hover:bg-background active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50"
            >
              <Workflow className="h-3.5 w-3.5" />
              Draft
            </button>
          )}
        </div>
      </div>
      {status === 'drafting' ? (
        <div className="rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-background/48">
          <div className="flex items-center gap-2 border-b border-[hsl(var(--app-border)/0.48)] px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Drafting and validating flow YAML with {effectiveAuthoringLabel}.
          </div>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
            {streamOutput.trim() ? streamOutput : 'Waiting for model output...'}
          </pre>
        </div>
      ) : null}
      {authoringUnavailableReason ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {authoringUnavailableReason}
        </div>
      ) : null}
      {failedResult ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {failedResult.issues.map(formatIssue).join(' ')}
        </div>
      ) : null}
      {readyResult ? (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
          <div className="space-y-3 rounded-xl border border-[hsl(var(--app-border)/0.64)] bg-background/44 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">{readyResult.source.label}</div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                  <code className="rounded-md border border-[hsl(var(--app-border)/0.66)] bg-background/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                    {readyResult.source.id}
                  </code>
                  <span>{readyResult.definition.nodes.length} nodes</span>
                  <span>{readyResult.registryNodeIds.length} registry</span>
                  <span>{readyResult.registryAdditionIds.length} new reusable</span>
                  <span>{readyResult.inlineNodeIds.length} inline</span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleApprove}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-500/28 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Approve
              </button>
            </div>
            {readyResult.registryAdditions.length > 0 ? (
              <div className="rounded-lg border border-[hsl(var(--app-accent)/0.22)] bg-[hsl(var(--app-accent-soft))] px-3 py-2 text-xs text-[hsl(var(--app-accent))]">
                Adds reusable templates: {readyResult.registryAdditions.map((definition) => definition.id).join(', ')}
              </div>
            ) : null}
            <FlowCanvasEditor definition={readyResult.definition} />
          </div>
          <pre className="max-h-80 overflow-auto rounded-xl border border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--app-panel-strong))] p-3.5 font-mono text-[11px] leading-5 text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--app-border)/0.45)]">
            {readyResult.source.source.trim()}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

function formatFlowAuthoringError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (typeof error === 'object' && error !== null) {
    const message = 'message' in error ? (error as { message?: unknown }).message : null;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Flow authoring failed.';
}

function flowAuthoringTelemetryBase(input: {
  requestLength: number;
  workspaceId: string | null;
  registry: FlowNodeRegistry;
}): Record<string, string | number | boolean | null> {
  return {
    request_length: input.requestLength,
    workspace_scoped: Boolean(input.workspaceId),
    registry_size: Object.keys(input.registry).length,
  };
}

function hasStoredUserFlowArtifacts(): boolean {
  if (typeof window === 'undefined') return false;
  const flowSource = window.localStorage?.getItem(USER_FLOW_STORE_KEY);
  const nodeRegistry = window.localStorage?.getItem(USER_FLOW_NODE_REGISTRY_STORE_KEY);
  return Boolean(flowSource || nodeRegistry);
}

type InternalCompletionStreamUpdate =
  | { kind: 'delta'; text: string }
  | { kind: 'snapshot'; text: string }
  | { kind: 'diagnostic'; text: string };

export function applyInternalCompletionStreamUpdate(current: string, line: string, stream: string): string {
  const update = parseInternalCompletionStreamUpdate(line, stream);
  if (!update) return current;
  if (update.kind === 'delta') return `${current}${update.text}`;
  if (update.kind === 'snapshot') return mergeStreamingOutput(current, update.text);
  return current ? `${current}\n${update.text}` : update.text;
}

function parseInternalCompletionStreamUpdate(line: string, stream: string): InternalCompletionStreamUpdate | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const type = typeof parsed.type === 'string' ? parsed.type : '';
    if (type === 'message_delta') {
      const text = rawStringField(parsed.delta) ?? rawStringField(parsed.content);
      return text ? { kind: 'delta', text } : null;
    }
    if (type === 'message_completed' || type === 'message') {
      const text = rawStringField(parsed.content);
      return text ? { kind: 'snapshot', text } : null;
    }
    if (type === 'provider_stop' || type === 'stop') {
      const finalContent = rawStringField(parsed.final_content);
      if (finalContent) return { kind: 'snapshot', text: finalContent };
      const reason = stringField(parsed.provider_stop_reason) ?? stringField(parsed.stop_reason);
      return reason ? { kind: 'diagnostic', text: `Provider stopped: ${reason}` } : null;
    }
    if (type === 'error') {
      return { kind: 'diagnostic', text: stringField(parsed.content) ?? 'Provider reported an error.' };
    }
    return null;
  } catch {
    return stream === 'stderr' ? { kind: 'diagnostic', text: trimmed } : null;
  }
}

function rawStringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function FlowCatalogEntry({
  flow,
  registry,
  workspaceId,
  authoringAgent,
  authoringAgentLabel,
}: {
  flow: FlowCatalogItem;
  registry: FlowNodeRegistry;
  workspaceId: string | null;
  authoringAgent?: FlowAuthoringAgent;
  authoringAgentLabel?: string | null;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const definition = flow.definition;
  const label = definition?.flow.label ?? flow.source.label;
  const inputCount = Object.keys(definition?.inputs ?? {}).length;
  const returnCount = definition?.nodes.reduce((total, node) => total + Object.keys(node.returns ?? {}).length, 0) ?? 0;
  const maxLoopRounds = findMaxLoopRounds(definition?.run ?? []);
  const toast = useToastHelpers();
  const handleSaveDefinition = useCallback((nextDefinition: FlowDefinition) => {
    const saved = saveFlowDefinitionAsUserSource({
      flow,
      definition: nextDefinition,
      workspaceId,
    });
    toast.success(flow.kind === 'predefined' ? 'Flow saved as user version' : 'Flow updated and validated');
    return saved;
  }, [flow, toast, workspaceId]);

  return (
    <article
      className={cn(
        "overflow-hidden rounded-2xl border bg-background/46 shadow-[0_18px_48px_-42px_hsl(var(--app-accent)/0.72)] transition-[background-color,border-color,box-shadow] duration-200",
        isExpanded
          ? "border-[hsl(var(--app-accent)/0.28)] bg-background/58 shadow-[0_24px_64px_-46px_hsl(var(--app-accent)/0.82)]"
          : "border-[hsl(var(--app-border)/0.64)] hover:border-[hsl(var(--app-border)/0.9)] hover:bg-background/56"
      )}
    >
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <button
          type="button"
          onClick={() => setIsExpanded((expanded) => !expanded)}
          aria-expanded={isExpanded}
          aria-label={`Toggle ${label} flow details`}
          className="group min-w-0 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel-strong)/0.78)] text-[hsl(var(--app-accent))] shadow-[inset_0_1px_0_hsl(var(--app-border)/0.42)] transition-transform duration-200 group-active:scale-[0.96]">
              <Workflow className="h-4 w-4" strokeWidth={2.1} />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  role="heading"
                  aria-level={2}
                  className="max-w-[34ch] truncate text-base font-semibold leading-6 tracking-[-0.015em] text-foreground"
                >
                  {label}
                </span>
                <span className={cn(
                  "inline-flex h-6 items-center rounded-full border px-2 text-[11px] font-semibold",
                  flow.runnable
                    ? "border-emerald-500/24 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-destructive/24 bg-destructive/5 text-destructive"
                )}>
                  {flow.runnable ? 'Runnable' : 'Needs fix'}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <code className="rounded-md border border-[hsl(var(--app-border)/0.66)] bg-background/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {flow.source.id}
                </code>
                <span className="rounded-md border border-[hsl(var(--app-border)/0.58)] bg-background/54 px-1.5 py-0.5">
                  {flow.source.scope}
                </span>
                <span className="rounded-md border border-[hsl(var(--app-border)/0.58)] bg-background/54 px-1.5 py-0.5">
                  {formatFlowKindLabel(flow.kind)}
                </span>
                <span className="rounded-md border border-[hsl(var(--app-border)/0.58)] bg-background/54 px-1.5 py-0.5 tabular-nums">
                  version {flow.sourceVersion}
                </span>
                {maxLoopRounds ? (
                  <span className="rounded-md border border-[hsl(var(--app-border)/0.58)] bg-background/54 px-1.5 py-0.5 tabular-nums">
                    loop cap {maxLoopRounds}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </button>

        <div className="flex flex-wrap items-center justify-between gap-3 lg:justify-end">
          <dl className="grid grid-cols-3 overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.58)] bg-background/54 text-center">
            <CompactMetric label="inputs" value={inputCount} />
            <CompactMetric label="nodes" value={definition?.nodes.length ?? 0} />
            <CompactMetric label="returns" value={returnCount} />
          </dl>
          <button
            type="button"
            onClick={() => setIsExpanded((expanded) => !expanded)}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${label} flow details`}
            className="inline-flex h-9 min-w-24 items-center justify-center gap-1.5 rounded-xl border border-[hsl(var(--app-border)/0.66)] bg-background/72 px-3 text-xs font-semibold text-foreground shadow-[0_12px_28px_-24px_hsl(var(--app-accent)/0.72)] transition-[background-color,transform] duration-150 hover:bg-background active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]"
          >
            {isExpanded ? 'Collapse' : 'Details'}
            <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", isExpanded && "rotate-180")} />
          </button>
        </div>
      </div>

      {isExpanded ? (
        <div className="border-t border-[hsl(var(--app-border)/0.58)] px-4 pb-4 pt-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)]">
            <div className="min-w-0 space-y-5">
              {flow.issues.length > 0 ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {flow.issues.map(formatIssue).join(' ')}
                </div>
              ) : definition ? (
                <>
                  <section className="space-y-2.5">
                    <SectionHeading icon={<ListChecks className="h-3.5 w-3.5" />} label="Inputs" />
                    <div className="grid gap-2 sm:grid-cols-2">
                      {Object.entries(definition.inputs ?? {}).map(([name, input]) => (
                        <InputDefinitionRow key={name} name={name} input={input} />
                      ))}
                    </div>
                  </section>

                  <section className="space-y-2.5">
                    <SectionHeading icon={<Network className="h-3.5 w-3.5" />} label="Nodes" />
                    <div className="overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.64)] bg-background/42">
                      {definition.nodes.map((node, index) => (
                        <NodeTemplateRow
                          key={node.id}
                          node={node}
                          index={index}
                          onSavePrompt={(prompt) => {
                            handleSaveDefinition({
                              ...definition,
                              nodes: definition.nodes.map((candidate) => (
                                candidate.id === node.id ? { ...candidate, prompt } : candidate
                              )),
                            });
                          }}
                        />
                      ))}
                    </div>
                  </section>

                  <section className="space-y-2.5">
                    <SectionHeading icon={<Workflow className="h-3.5 w-3.5" />} label="Run Shape" />
                    <FlowCanvasEditor
                      definition={definition}
                    />
                  </section>
                </>
              ) : null}
            </div>

            <section className="min-w-0 space-y-2.5">
              <SectionHeading icon={<FileCode2 className="h-3.5 w-3.5" />} label="Source YAML" />
              <pre className="h-[60rem] overflow-auto rounded-xl border border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--app-panel-strong))] p-3.5 font-mono text-[11px] leading-5 text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--app-border)/0.45)]">
                {flow.source.source.trim()}
              </pre>
              <FlowModificationPanel
                flow={flow}
                registry={registry}
                workspaceId={workspaceId}
                authoringAgent={authoringAgent}
                authoringAgentLabel={authoringAgentLabel}
              />
            </section>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function CompactMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-16 border-r border-[hsl(var(--app-border)/0.5)] px-2.5 py-1.5 last:border-r-0">
      <dt className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums tracking-[-0.02em] text-foreground">{value}</dd>
    </div>
  );
}

function formatFlowKindLabel(kind: FlowCatalogItem['kind']): string {
  return kind === 'predefined' ? 'App in-built' : 'User created';
}

function buildFlowModificationRequest(input: {
  currentYaml: string;
  flowId: string;
  changeRequest: string;
}): string {
  return [
    'Modify the existing Agentree FlowSource YAML according to the requested change.',
    '',
    'Modification rules:',
    '- Return the complete updated YAML, not a patch.',
    `- Preserve flow.id and source identity "${input.flowId}" unless the user explicitly asks to rename the flow.`,
    '- Preserve existing behavior unless the requested change requires altering it.',
    '- Keep the flow valid against the Agentree flow DSL.',
    '- Do not include prose or Markdown fences.',
    '',
    'Current YAML:',
    input.currentYaml.trim(),
    '',
    'Requested change:',
    input.changeRequest.trim(),
  ].join('\n');
}

function SectionHeading({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {icon}
      {label}
    </h3>
  );
}

function InputDefinitionRow({ name, input }: { name: string; input: FlowInputDefinition }) {
  return (
    <div className="rounded-xl border border-[hsl(var(--app-border)/0.62)] bg-background/48 px-3 py-2.5 shadow-[0_12px_32px_-30px_hsl(var(--app-accent)/0.65)]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-foreground">{name}</span>
        <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{input.type}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
        <span>{formatInputRange(input)}</span>
        {input.default !== undefined ? <span>default {String(input.default)}</span> : null}
      </div>
    </div>
  );
}

function FlowModificationPanel({
  flow,
  registry,
  workspaceId,
  authoringAgent,
  authoringAgentLabel,
}: {
  flow: FlowCatalogItem;
  registry: FlowNodeRegistry;
  workspaceId: string | null;
  authoringAgent?: FlowAuthoringAgent;
  authoringAgentLabel?: string | null;
}) {
  const editableSource = flow.source;
  const selectedAgentId = useWorkspaceStore((state) => state.selectedAgentId);
  const { profiles, startSync } = useLoginProfilesStore();
  const toast = useToastHelpers();
  const [isOpen, setIsOpen] = useState(false);
  const [request, setRequest] = useState('');
  const [status, setStatus] = useState<'idle' | 'drafting' | 'ready' | 'failed'>('idle');
  const [result, setResult] = useState<FlowAuthoringResult | null>(null);
  const [streamOutput, setStreamOutput] = useState('');
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const selectedAgent = useMemo(
    () => getRuntimeModelByKey(selectedAgentId),
    [selectedAgentId]
  );
  const selectedLoginProfile = useMemo(() => {
    if (!selectedAgent) return null;
    const compatible = profiles.filter((profile) => profile.provider === selectedAgent.provider);
    return compatible.find((profile) => profile.isDefault) ?? compatible[0] ?? null;
  }, [profiles, selectedAgent]);
  const selectedLoginProfileReady = selectedLoginProfile ? isLoginProfileActive(selectedLoginProfile) : false;
  const resolvedAuthoringAgent = useMemo<FlowAuthoringAgent | undefined>(() => {
    if (authoringAgent) return authoringAgent;
    if (!selectedAgent || !selectedLoginProfile || !selectedLoginProfileReady || !agentClient.hasRuntime()) {
      return undefined;
    }
    return {
      complete: async (prompt) => {
        const requestId = crypto.randomUUID();
        activeRequestIdRef.current = requestId;
        setActiveRequestId(requestId);
        const response = await agentClient.completeInternalPrompt({
          purpose: 'flow_authoring',
          provider: selectedAgent.provider,
          model: selectedAgent.modelId,
          reasoningEffort: selectedAgent.reasoningEffort ?? null,
          loginProfileId: selectedLoginProfile.id,
          requestId,
          prompt,
        });
        if (activeRequestIdRef.current === requestId) {
          activeRequestIdRef.current = null;
          setActiveRequestId(null);
        }
        return response.text;
      },
    };
  }, [authoringAgent, selectedAgent, selectedLoginProfile, selectedLoginProfileReady]);
  const authoringUnavailableReason = useMemo(() => {
    if (resolvedAuthoringAgent) return null;
    if (!selectedAgentId || !selectedAgent) {
      return 'Select a model in Create flow before modifying this flow.';
    }
    if (!agentClient.hasRuntime()) {
      return 'Flow modification requires the Agentree desktop runtime.';
    }
    if (!selectedLoginProfile) {
      return `${selectedAgent.label} uses ${selectedAgent.providerLabel}. Add or connect a ready ${selectedAgent.providerLabel} account in Logins before modifying this flow.`;
    }
    if (!selectedLoginProfileReady) {
      return selectedLoginProfile.statusMessage
        ?? `${selectedLoginProfile.displayName} is not ready. Open Logins and reconnect or check readiness before modifying this flow.`;
    }
    return null;
  }, [resolvedAuthoringAgent, selectedAgent, selectedAgentId, selectedLoginProfile, selectedLoginProfileReady]);
  const effectiveAuthoringLabel = authoringAgentLabel ?? selectedAgent?.label ?? 'selected agent';
  const readyResult = result?.status === 'ready' ? result : null;
  const failedResult = result?.status === 'failed' ? result : null;

  useEffect(() => startSync(), [startSync]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void agentClient.onInternalCompletionEvent?.((event) => {
      if (disposed || event.requestId !== activeRequestIdRef.current) return;
      setStreamOutput((current) => applyInternalCompletionStreamUpdate(current, event.line, event.stream));
    }).then((cleanup) => {
      unlisten = cleanup;
      if (disposed) cleanup();
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleDraftModification = useCallback(async () => {
    const trimmed = request.trim();
    if (!trimmed || !resolvedAuthoringAgent) return;
    setStatus('drafting');
    setResult(null);
    setStreamOutput('');
    try {
      const authored = await authorFlowFromNaturalLanguage({
        request: buildFlowModificationRequest({
          currentYaml: editableSource.source,
          flowId: editableSource.id,
          changeRequest: trimmed,
        }),
        workspaceId: 'workspaceId' in editableSource ? editableSource.workspaceId ?? workspaceId : workspaceId,
        registry,
        agent: resolvedAuthoringAgent,
      });
      setResult(authored);
      setStatus(authored.status === 'ready' ? 'ready' : 'failed');
    } catch (error) {
      console.error('[FlowModification] draft failed', error);
      setResult({
        status: 'failed',
        source: {
          id: editableSource.id,
          label: editableSource.label,
          scope: 'workspaceId' in editableSource && editableSource.workspaceId ? 'workspace' : editableSource.scope,
          workspaceId: 'workspaceId' in editableSource ? editableSource.workspaceId : workspaceId,
          source: editableSource.source,
          version: 'version' in editableSource ? editableSource.version : 1,
          enabled: false,
          createdAt: 'createdAt' in editableSource ? editableSource.createdAt : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        issues: [{
          path: '',
          message: formatFlowAuthoringError(error),
        }],
        attempts: 0,
      });
      setStatus('failed');
    } finally {
      activeRequestIdRef.current = null;
      setActiveRequestId(null);
    }
  }, [editableSource, registry, request, resolvedAuthoringAgent, workspaceId]);

  const handleCancel = useCallback(() => {
    const requestId = activeRequestIdRef.current ?? activeRequestId;
    if (!requestId) return;
    void agentClient.cancelInternalCompletion?.(requestId);
  }, [activeRequestId]);

  const handleApproveModification = useCallback(() => {
    if (!readyResult) return;
    saveUserFlowNodeDefinitions({ definitions: readyResult.registryAdditions });
    saveFlowDefinitionAsUserSource({
      flow,
      definition: readyResult.definition,
      sourceYaml: readyResult.source.source,
      workspaceId,
    });
    toast.success(flow.kind === 'predefined' ? 'Flow saved as user version' : 'Flow updated and validated');
    setRequest('');
    setResult(null);
    setStreamOutput('');
    setStatus('idle');
  }, [flow, readyResult, toast, workspaceId]);

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-[hsl(var(--app-border)/0.66)] bg-background/72 px-3 text-sm font-semibold text-foreground shadow-[0_14px_32px_-28px_hsl(var(--app-accent)/0.78)] transition-[background-color,transform] duration-150 hover:bg-background active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]"
      >
        <Bot className="h-4 w-4 text-[hsl(var(--app-accent))]" />
        Modify with AI
      </button>
    );
  }

  return (
    <section className="space-y-2.5 rounded-xl border border-[hsl(var(--app-border)/0.64)] bg-background/36 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeading icon={<Bot className="h-3.5 w-3.5" />} label="Modify with AI" />
        <button
          type="button"
          onClick={() => {
            setIsOpen(false);
            setRequest('');
            setResult(null);
            setStreamOutput('');
            setStatus('idle');
          }}
          disabled={status === 'drafting'}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[hsl(var(--app-border)/0.66)] bg-background/70 px-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          Close
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.64)] bg-background/44 shadow-[0_14px_38px_-34px_hsl(var(--app-accent)/0.72)]">
        <div className="border-b border-[hsl(var(--app-border)/0.52)] px-3 py-2.5">
          <p className="text-xs leading-5 text-muted-foreground">
            Describe the change. Agentree will send the current YAML and your request to AI, validate the full replacement flow, then ask for approval before saving.
          </p>
        </div>
        <textarea
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder="Example: Add a reviewer after the implementer and hand off only when the review passes."
          aria-label={`Describe AI modification for ${editableSource.label}`}
          className="min-h-20 w-full resize-y border-0 bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/65"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--app-border)/0.52)] bg-background/34 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            Uses {effectiveAuthoringLabel}. Current flow details remain read-only.
          </span>
          {status === 'drafting' ? (
            <button
              type="button"
              onClick={handleCancel}
              disabled={!activeRequestId}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/35 bg-destructive/8 px-3 text-xs font-semibold text-destructive transition-[background-color,transform] duration-150 hover:bg-destructive/12 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleDraftModification()}
              disabled={!request.trim() || Boolean(authoringUnavailableReason)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[hsl(var(--app-border))] bg-background/82 px-3 text-xs font-semibold text-foreground transition-[background-color,transform] duration-150 hover:bg-background active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50"
            >
              <Workflow className="h-3.5 w-3.5" />
              Draft modification
            </button>
          )}
        </div>
      </div>
      {authoringUnavailableReason ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {authoringUnavailableReason}
        </div>
      ) : null}
      {status === 'drafting' ? (
        <div className="rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-background/48">
          <div className="flex items-center gap-2 border-b border-[hsl(var(--app-border)/0.48)] px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Drafting and validating updated flow YAML with {effectiveAuthoringLabel}.
          </div>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
            {streamOutput.trim() ? streamOutput : 'Waiting for model output...'}
          </pre>
        </div>
      ) : null}
      {failedResult ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {failedResult.issues.map(formatIssue).join(' ')}
        </div>
      ) : null}
      {readyResult ? (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
          <div className="space-y-3 rounded-xl border border-emerald-500/24 bg-emerald-500/5 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">{readyResult.definition.flow.label ?? editableSource.label}</div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                  <span>{readyResult.definition.nodes.length} nodes</span>
                  <span>{readyResult.registryNodeIds.length} registry</span>
                  <span>{readyResult.registryAdditionIds.length} new reusable</span>
                  <span>{readyResult.inlineNodeIds.length} inline</span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleApproveModification}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-500/28 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Approve changes
              </button>
            </div>
            <FlowCanvasEditor definition={readyResult.definition} />
          </div>
          <pre className="max-h-80 overflow-auto rounded-xl border border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--app-panel-strong))] p-3.5 font-mono text-[11px] leading-5 text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--app-border)/0.45)]">
            {readyResult.source.source.trim()}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

function NodeTemplateRow({
  node,
  index,
  onSavePrompt,
}: {
  node: FlowNodeTemplate;
  index: number;
  onSavePrompt?: (prompt: string) => void;
}) {
  const returns = Object.entries(node.returns ?? {}).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(node.prompt);

  useEffect(() => {
    setPromptDraft(node.prompt);
    setIsEditingPrompt(false);
  }, [node.prompt]);

  return (
    <details
      data-flow-node-prompt="true"
      className="group border-b border-[hsl(var(--app-border)/0.52)] last:border-b-0"
    >
      <summary className="grid cursor-pointer list-none gap-3 px-3 py-3 transition-colors hover:bg-background/35 sm:grid-cols-[2.5rem_minmax(0,1fr)] [&::-webkit-details-marker]:hidden">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft))] font-mono text-xs font-semibold tabular-nums text-[hsl(var(--app-accent))]">
          {String(index + 1).padStart(2, '0')}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-foreground">{node.id}</span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">parent: {node.parent}</span>
              <span className="inline-flex h-6 items-center gap-1 rounded-md border border-[hsl(var(--app-border)/0.62)] bg-background/70 px-1.5 text-[10.5px] font-semibold text-muted-foreground transition-colors group-hover:text-foreground">
                <FileCode2 className="h-3 w-3" />
                Prompt
                <ChevronDown className="h-3 w-3 transition-transform duration-150 group-open:rotate-180" />
              </span>
            </div>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <span>{node.params?.length ? `params: ${formatNodeParams(node)}` : 'no params'}</span>
            {node.registryId ? <span>uses {node.registryId}</span> : null}
            {node.requiresFinalizedCommit ? <span>requires commit</span> : null}
          </div>
          {returns.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {returns.map((item) => (
                <span key={item} className="rounded-md border border-[hsl(var(--app-accent)/0.18)] bg-[hsl(var(--app-accent-soft))] px-1.5 py-0.5 text-[11px] font-medium text-[hsl(var(--app-accent))]">
                  {item}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </summary>
      <div className="border-t border-[hsl(var(--app-border)/0.48)] bg-background/30 px-3 pb-3 pt-2 sm:pl-[4.5rem]">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Compiled prompt</span>
          <div className="flex items-center gap-1.5">
            <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {node.registryId ? `from ${node.registryId}` : 'inline'}
            </span>
            {onSavePrompt ? (
              <button
                type="button"
                onClick={() => setIsEditingPrompt((editing) => !editing)}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-[hsl(var(--app-border)/0.62)] bg-background/70 px-1.5 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                aria-label={`${isEditingPrompt ? 'Cancel' : 'Edit'} ${node.id} prompt`}
              >
                {isEditingPrompt ? <X className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
                {isEditingPrompt ? 'Cancel' : 'Edit'}
              </button>
            ) : null}
          </div>
        </div>
        {isEditingPrompt ? (
          <div className="space-y-2">
            <textarea
              value={promptDraft}
              onChange={(event) => setPromptDraft(event.target.value)}
              aria-label={`Prompt for ${node.id}`}
              className="min-h-40 w-full resize-y rounded-lg border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel-strong)/0.78)] px-3 py-2.5 font-mono text-[11px] leading-5 text-foreground outline-none shadow-[inset_0_1px_0_hsl(var(--app-border)/0.42)] focus:border-[hsl(var(--app-accent)/0.48)]"
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  const trimmed = promptDraft.trim();
                  if (!trimmed) return;
                  onSavePrompt?.(trimmed);
                }}
                disabled={!promptDraft.trim() || promptDraft.trim() === node.prompt.trim()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-500/28 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/15 disabled:pointer-events-none disabled:opacity-50 dark:text-emerald-300"
                aria-label={`Save ${node.id} prompt`}
              >
                <Save className="h-3.5 w-3.5" />
                Save prompt
              </button>
            </div>
          </div>
        ) : (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel-strong)/0.78)] px-3 py-2.5 font-mono text-[11px] leading-5 text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--app-border)/0.42)]">
            {node.prompt.trim()}
          </pre>
        )}
      </div>
    </details>
  );
}

function saveFlowDefinitionAsUserSource(input: {
  flow: FlowCatalogItem;
  definition: FlowDefinition;
  workspaceId: string | null;
  sourceYaml?: string;
}): UserFlowSource {
  const now = new Date().toISOString();
  const existingUserSource = input.flow.kind === 'user' && 'version' in input.flow.source ? input.flow.source : null;
  const scope = existingUserSource?.scope ?? (input.workspaceId ? 'workspace' : input.flow.source.scope);
  const workspaceId = existingUserSource?.workspaceId ?? (scope === 'workspace' ? input.workspaceId : null);
  return saveUserFlowSource({
    id: input.flow.source.id,
    label: input.definition.flow.label ?? input.flow.source.label,
    scope,
    workspaceId,
    source: input.sourceYaml ?? flowDefinitionToSourceYaml(input.definition),
    version: (existingUserSource?.version ?? input.flow.sourceVersion) + 1,
    enabled: true,
    createdAt: existingUserSource?.createdAt ?? now,
    updatedAt: now,
  });
}

function flowDefinitionToSourceYaml(definition: FlowDefinition): string {
  const source = {
    flow: definition.flow,
    ...(definition.inputs ? { inputs: definition.inputs } : {}),
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      ...(node.registryId ? { registryId: node.registryId } : {}),
      ...(node.label ? { label: node.label } : {}),
      parent: node.parent,
      ...(node.params?.length ? { params: Object.fromEntries(node.params.map((param) => [
        param,
        formatFlowParamTypes(node.paramTypes?.[param] ?? ['scalar']),
      ])) } : {}),
      ...(node.returns ? { returns: node.returns } : {}),
      prompt: node.prompt,
      ...(node.requiresFinalizedCommit !== undefined ? { requiresFinalizedCommit: node.requiresFinalizedCommit } : {}),
    })),
    run: definition.run,
  };
  return stringify(source).trim();
}

function formatNodeParams(node: FlowNodeTemplate): string {
  return (node.params ?? []).map((param) => {
    const types = node.paramTypes?.[param];
    return types?.length ? `${param}: ${formatFlowParamTypes(types)}` : param;
  }).join(', ');
}

function formatInputRange(input: FlowInputDefinition): string {
  if (typeof input.min === 'number' || typeof input.max === 'number') {
    return `${input.min ?? 'any'} to ${input.max ?? 'any'}`;
  }
  return 'required';
}

function formatIssue(issue: { path: string; message: string }): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

function findMaxLoopRounds(statements: FlowStatement[]): number | null {
  for (const statement of statements) {
    if ('loop' in statement) {
      const nestedMax = findMaxLoopRounds(statement.loop.steps);
      return Math.max(statement.loop.max_rounds, nestedMax ?? 0);
    }
    if ('if' in statement) {
      const thenSteps = Array.isArray(statement.then) ? statement.then : [statement.then];
      const nestedMax = findMaxLoopRounds(thenSteps);
      if (nestedMax !== null) return nestedMax;
    }
  }
  return null;
}
