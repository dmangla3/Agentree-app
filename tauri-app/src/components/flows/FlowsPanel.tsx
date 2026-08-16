import { FileCode2, ListChecks, Network, Workflow } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import MermaidDiagram from '../MermaidDiagram';
import { parseFlowYaml } from '../../flows/parseFlowYaml';
import { PREDEFINED_FLOW_SOURCES } from '../../flows/predefinedFlows';
import type { FlowDefinition, FlowInputDefinition, FlowNodeTemplate, FlowSource, FlowStatement } from '../../flows/types';
import { validateFlowDefinition } from '../../flows/validateFlow';
import { cn } from '../../lib/utils';

export interface FlowsPanelProps {
  className?: string;
  sources?: FlowSource[];
}

interface FlowCatalogItem {
  source: FlowSource;
  definition: FlowDefinition | null;
  issues: string[];
}

export function FlowsPanel({ className, sources = PREDEFINED_FLOW_SOURCES }: FlowsPanelProps) {
  const flows = useMemo(() => sources.map(toCatalogItem), [sources]);

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
              Read-only definitions for composer flows. Source lives in code and compiles from YAML before each run.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-md border border-[hsl(var(--app-border)/0.7)] bg-background/65 px-2.5 py-1 text-xs font-semibold text-foreground shadow-[0_10px_24px_-22px_hsl(var(--app-accent)/0.55)]">
              Code-defined
            </span>
            <span className="rounded-md border border-[hsl(var(--app-border)/0.7)] bg-background/65 px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
              {flows.length} global
            </span>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {flows.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
            No flows are registered.
          </div>
        ) : (
          <div className="divide-y divide-[hsl(var(--app-border)/0.58)]">
            {flows.map((flow) => (
              <FlowCatalogEntry key={flow.source.id} flow={flow} />
            ))}
          </div>
        )}
      </div>
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
              {flow.issues.join(' ')}
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
    <div className="grid gap-3 border-b border-[hsl(var(--app-border)/0.52)] px-3 py-3 last:border-b-0 sm:grid-cols-[2.5rem_minmax(0,1fr)]">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft))] font-mono text-xs font-semibold tabular-nums text-[hsl(var(--app-accent))]">
        {String(index + 1).padStart(2, '0')}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold text-foreground">{node.id}</span>
          <span className="text-xs text-muted-foreground">parent: {node.parent}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {node.params?.length ? `params: ${node.params.join(', ')}` : 'no params'}
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
    </div>
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

export function buildFlowRunMermaid(definition: FlowDefinition): string {
  const statements = definition.run;
  const parallel = statements.find((statement) => 'parallel' in statement);
  const topLevelCall = statements.find((statement) => 'call' in statement);
  const loop = statements.find((statement) => 'loop' in statement);
  const loopCalls = loop && 'loop' in loop
    ? loop.loop.steps.filter((statement) => 'call' in statement)
    : [];
  const reviewer = loopCalls[0];
  const fixer = loopCalls[1];

  if (!parallel || !('parallel' in parallel) || !topLevelCall || !('call' in topLevelCall)) {
    return buildLinearFlowRunMermaid(statements);
  }

  const implementerCount = resolveParallelBranchCount(definition, parallel.parallel.count);
  const implementerIds = Array.from({ length: implementerCount }, (_, index) => `implementer${index + 1}`);
  const judgeLabel = topLevelCall.call;
  const reviewerLabel = reviewer && 'call' in reviewer ? reviewer.call : 'Reviewer';
  const fixerLabel = fixer && 'call' in fixer ? fixer.call : 'Fixer';
  const implementerNodeLines = implementerIds.map(
    (id, index) => `    ${id}["${escapeMermaidLabel(`${parallel.parallel.call} ${index + 1}`)}"]`
  );
  const startEdges = implementerIds.map((id) => `  start --> ${id}`);
  const judgeEdges = implementerIds.map((id) => `  ${id} --> judge`);

  return [
    'flowchart LR',
    '  start(("Start"))',
    '  subgraph implementers["parallel"]',
    '    direction TB',
    ...implementerNodeLines,
    '  end',
    `  judge["${escapeMermaidLabel(judgeLabel)}"]`,
    `  reviewer{"${escapeMermaidLabel(reviewerLabel)}"}`,
    `  fixer["${escapeMermaidLabel(fixerLabel)}"]`,
    '  done(("Done"))',
    ...startEdges,
    ...judgeEdges,
    '  judge --> reviewer',
    '  reviewer -->|pass| done',
    '  reviewer -->|feedback| fixer',
    '  fixer --> reviewer',
    '  classDef terminalStep fill:#f8fafc,stroke:#94a3b8,color:#0f172a,stroke-width:1px;',
    '  classDef agentStep fill:#ecfdf5,stroke:#10b981,color:#064e3b,stroke-width:1px;',
    '  classDef reviewStep fill:#fff7ed,stroke:#f97316,color:#7c2d12,stroke-width:1px;',
    '  class start,done terminalStep;',
    `  class ${implementerIds.join(',')},judge,fixer agentStep;`,
    '  class reviewer reviewStep;',
  ].join('\n');
}

function escapeMermaidLabel(label: string): string {
  return label.replace(/"/g, "'");
}

function pluralizeFlowNodeLabel(label: string): string {
  return label.endsWith('s') ? label : `${label}s`;
}

function resolveParallelBranchCount(definition: FlowDefinition, count: string | number): number {
  if (typeof count === 'number') {
    return clampParallelBranchCount(count);
  }

  const inputName = count.match(/^input\.([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  const inputDefault = inputName ? definition.inputs?.[inputName]?.default : undefined;
  if (typeof inputDefault === 'number') {
    return clampParallelBranchCount(inputDefault);
  }

  const parsed = Number.parseInt(count, 10);
  return Number.isFinite(parsed) ? clampParallelBranchCount(parsed) : 3;
}

function clampParallelBranchCount(count: number): number {
  return Math.max(1, Math.min(5, Math.trunc(count)));
}

function buildLinearFlowRunMermaid(statements: FlowStatement[]): string {
  const labels = statements.flatMap((statement) => {
    if ('parallel' in statement) return [`parallel ${pluralizeFlowNodeLabel(statement.parallel.call)}`];
    if ('call' in statement) return [statement.call];
    if ('loop' in statement) {
      return statement.loop.steps.flatMap((step) => ('call' in step ? [step.call] : []));
    }
    return [];
  });
  const nodeLines = labels.map((label, index) => `  step${index}["${escapeMermaidLabel(label)}"]`);
  const edgeTargets = ['start', ...labels.map((_, index) => `step${index}`), 'done'];
  const edgeLines = edgeTargets.slice(0, -1).map((from, index) => `  ${from} --> ${edgeTargets[index + 1]}`);

  return [
    'flowchart LR',
    '  start(("Start"))',
    ...nodeLines,
    '  done(("Done"))',
    ...edgeLines,
    '  classDef terminalStep fill:#f8fafc,stroke:#94a3b8,color:#0f172a,stroke-width:1px;',
    '  classDef agentStep fill:#ecfdf5,stroke:#10b981,color:#064e3b,stroke-width:1px;',
    '  class start,done terminalStep;',
    labels.length ? `  class ${labels.map((_, index) => `step${index}`).join(',')} agentStep;` : '',
  ].filter(Boolean).join('\n');
}

function toCatalogItem(source: FlowSource): FlowCatalogItem {
  const result = validateFlowDefinition(parseFlowYaml(source.source));
  return {
    source,
    definition: result.definition ?? null,
    issues: result.issues.map((issue) => `${issue.path}: ${issue.message}`),
  };
}

function formatInputRange(input: FlowInputDefinition): string {
  if (typeof input.min === 'number' || typeof input.max === 'number') {
    return `${input.min ?? 'any'} to ${input.max ?? 'any'}`;
  }
  return 'required';
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
