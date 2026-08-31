import { CheckCircle2, ChevronDown, FileCode2, ListChecks, Loader2, Network, Plus, Workflow } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import MermaidDiagram from '../MermaidDiagram';
import { authorFlowFromNaturalLanguage, createRuleBasedFlowDraft, type FlowAuthoringResult } from '../../flows/flowAuthoring';
import { buildFlowCatalog, type FlowCatalogItem } from '../../flows/flowCatalog';
import { buildFlowRunMermaid } from '../../flows/flowMermaid';
import { PREDEFINED_FLOW_SOURCES } from '../../flows/predefinedFlows';
import { saveUserFlowSource, useUserFlowSources } from '../../flows/userFlowStore';
import type { FlowDefinition, FlowInputDefinition, FlowNodeTemplate, FlowSource, FlowStatement, UserFlowSource } from '../../flows/types';
import { cn } from '../../lib/utils';

export interface FlowsPanelProps {
  className?: string;
  workspaceId?: string | null;
  sources?: FlowSource[];
  userSources?: UserFlowSource[];
}

export function FlowsPanel({
  className,
  workspaceId = null,
  sources = PREDEFINED_FLOW_SOURCES,
  userSources,
}: FlowsPanelProps) {
  const storedUserSources = useUserFlowSources(workspaceId);
  const effectiveUserSources = userSources ?? storedUserSources;
  const flows = useMemo(
    () => buildFlowCatalog({ predefinedSources: sources, userSources: effectiveUserSources }),
    [effectiveUserSources, sources]
  );
  const enabledCount = flows.filter((flow) => flow.enabled).length;

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
        <div className="border-b border-[hsl(var(--app-border)/0.58)] px-5 py-5">
          <FlowAuthoringReviewPanel workspaceId={workspaceId} />
        </div>
        {flows.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center p-8 text-sm text-muted-foreground">
            No flows are registered.
          </div>
        ) : (
          <div className="divide-y divide-[hsl(var(--app-border)/0.58)]">
            {flows.map((flow) => (
              <FlowCatalogEntry key={`${flow.kind}:${flow.source.id}`} flow={flow} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function FlowAuthoringReviewPanel({ workspaceId }: { workspaceId: string | null }) {
  const [request, setRequest] = useState('');
  const [status, setStatus] = useState<'idle' | 'drafting' | 'ready' | 'failed' | 'saved'>('idle');
  const [result, setResult] = useState<FlowAuthoringResult | null>(null);

  const handleDraft = useCallback(async () => {
    const trimmed = request.trim();
    if (!trimmed) return;
    setStatus('drafting');
    const authored = await authorFlowFromNaturalLanguage({
      request: trimmed,
      workspaceId,
      agent: {
        async complete() {
          return createRuleBasedFlowDraft(trimmed);
        },
      },
    });
    setResult(authored);
    setStatus(authored.status === 'ready' ? 'ready' : 'failed');
  }, [request, workspaceId]);

  const handleApprove = useCallback(() => {
    if (!result || result.status !== 'ready') return;
    saveUserFlowSource(result.source);
    setStatus('saved');
  }, [result]);

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
        <button
          type="button"
          onClick={() => void handleDraft()}
          disabled={!request.trim() || status === 'drafting'}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[hsl(var(--app-border))] bg-background/72 px-3 text-xs font-semibold text-foreground transition-colors hover:bg-background disabled:pointer-events-none disabled:opacity-50"
        >
          {status === 'drafting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Workflow className="h-3.5 w-3.5" />}
          Draft
        </button>
      </div>
      <textarea
        value={request}
        onChange={(event) => {
          setRequest(event.target.value);
          if (status === 'saved') setStatus('idle');
        }}
        placeholder="Describe the automation to create..."
        className="min-h-20 w-full resize-y rounded-xl border border-[hsl(var(--app-border)/0.72)] bg-background/72 px-3 py-2.5 text-sm text-foreground shadow-[inset_0_1px_0_hsl(var(--app-border)/0.38)] outline-none transition-colors placeholder:text-muted-foreground/65 focus:border-[hsl(var(--app-accent)/0.48)]"
      />
      {status === 'drafting' ? (
        <div className="flex items-center gap-2 rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-background/48 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Drafting and validating flow YAML.
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
            <FlowRunMermaidDiagram definition={readyResult.definition} />
          </div>
          <pre className="max-h-80 overflow-auto rounded-xl border border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--app-panel-strong))] p-3.5 font-mono text-[11px] leading-5 text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--app-border)/0.45)]">
            {readyResult.source.source.trim()}
          </pre>
        </div>
      ) : null}
      {status === 'saved' ? (
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          Flow saved and enabled.
        </div>
      ) : null}
    </section>
  );
}

function FlowCatalogEntry({ flow }: { flow: FlowCatalogItem }) {
  const definition = flow.definition;
  const label = definition?.flow.label ?? flow.source.label;
  const inputCount = Object.keys(definition?.inputs ?? {}).length;
  const returnCount = definition?.nodes.reduce((total, node) => total + Object.keys(node.returns ?? {}).length, 0) ?? 0;
  const maxLoopRounds = findMaxLoopRounds(definition?.run ?? []);

  return (
    <article className="px-5 py-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)]">
        <div className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="max-w-[24ch] text-2xl font-semibold leading-tight tracking-[-0.025em] text-foreground text-balance">
                {label}
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <code className="rounded-md border border-[hsl(var(--app-border)/0.66)] bg-background/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {flow.source.id}
                </code>
                <span className="rounded-md border border-[hsl(var(--app-border)/0.66)] bg-background/70 px-1.5 py-0.5">
                  {flow.source.scope}
                </span>
                <span className="rounded-md border border-[hsl(var(--app-border)/0.66)] bg-background/70 px-1.5 py-0.5">
                  {flow.kind}
                </span>
                <span className={cn(
                  "rounded-md border px-1.5 py-0.5",
                  flow.runnable
                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-destructive/25 bg-destructive/5 text-destructive"
                )}>
                  {flow.runnable ? `version ${flow.sourceVersion}` : 'not runnable'}
                </span>
              </div>
            </div>

            <dl className="grid min-w-[16rem] grid-cols-3 overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.64)] bg-background/52 text-center shadow-[0_18px_44px_-34px_hsl(var(--app-accent)/0.7)]">
              <Metric label="inputs" value={inputCount} />
              <Metric label="nodes" value={definition?.nodes.length ?? 0} />
              <Metric label="returns" value={returnCount} />
              <Metric label="loop cap" value={maxLoopRounds || '-'} className="col-span-3 border-t border-[hsl(var(--app-border)/0.58)]" />
            </dl>
          </div>

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
                    <NodeTemplateRow key={node.id} node={node} index={index} />
                  ))}
                </div>
              </section>

              <section className="space-y-2.5">
                <SectionHeading icon={<Workflow className="h-3.5 w-3.5" />} label="Run Shape" />
                <FlowRunMermaidDiagram definition={definition} />
              </section>
            </>
          ) : null}
        </div>

        <section className="min-w-0 space-y-2.5">
          <SectionHeading icon={<FileCode2 className="h-3.5 w-3.5" />} label="Source YAML" />
          <pre className="max-h-[34rem] overflow-auto rounded-xl border border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--app-panel-strong))] p-3.5 font-mono text-[11px] leading-5 text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--app-border)/0.45)]">
            {flow.source.source.trim()}
          </pre>
        </section>
      </div>
    </article>
  );
}

function Metric({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <div className={cn("px-3 py-2.5", className)}>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono text-lg font-semibold tabular-nums tracking-[-0.02em] text-foreground">{value}</dd>
    </div>
  );
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

function NodeTemplateRow({ node, index }: { node: FlowNodeTemplate; index: number }) {
  const returns = Object.entries(node.returns ?? {}).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);

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
            <span>{node.params?.length ? `params: ${node.params.join(', ')}` : 'no params'}</span>
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
          <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {node.registryId ? `from ${node.registryId}` : 'inline'}
          </span>
        </div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel-strong)/0.78)] px-3 py-2.5 font-mono text-[11px] leading-5 text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--app-border)/0.42)]">
          {node.prompt.trim()}
        </pre>
      </div>
    </details>
  );
}

function FlowRunMermaidDiagram({ definition }: { definition: FlowDefinition }) {
  const chart = useMemo(() => buildFlowRunMermaid(definition), [definition]);

  return (
    <div
      aria-label="Flow run activity diagram"
      className="overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.66)] bg-background/58 px-3 py-3 shadow-[0_18px_42px_-36px_hsl(var(--app-accent)/0.72)] [&_.mermaid]:flex [&_.mermaid]:justify-center [&_.mermaid_svg]:h-auto [&_.mermaid_svg]:max-w-full"
    >
      <MermaidDiagram chart={chart} />
    </div>
  );
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
