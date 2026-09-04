import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowDown,
  ArrowUp,
  Braces,
  Check,
  Copy,
  Database,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  ListPlus,
  Maximize2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../@/components/ui/dialog';
import type { FlowDefinition, FlowRuntimeValue, FlowStatement } from '../../flows/types';
import {
  appendStatementToRun,
  createDefaultFlowStatement,
  deleteStatementAtPath,
  duplicateStatementAtPath,
  flowDefinitionToCanvasModel,
  getStatementAtPath,
  getStatementKind,
  insertStatementAfterPath,
  insertStatementIntoPath,
  moveStatementAtPath,
  updateStatementAtPath,
  type FlowCanvasNodeData,
  type FlowCanvasMode,
  type FlowStatementKind,
} from '../../flows/flowCanvasModel';
import { cn } from '../../lib/utils';

export interface FlowCanvasEditorProps {
  definition: FlowDefinition;
  editable?: boolean;
  onSaveDefinition?: (definition: FlowDefinition) => void | Promise<void>;
  className?: string;
}

const EDITABLE_STEP_KINDS: FlowStatementKind[] = ['call', 'parallel', 'set', 'if', 'loop', 'stop', 'break'];
const OVERVIEW_STEP_KINDS: FlowStatementKind[] = ['call', 'parallel', 'if', 'loop'];

export function FlowCanvasEditor({
  definition,
  editable = false,
  onSaveDefinition,
  className,
}: FlowCanvasEditorProps) {
  const [draftDefinition, setDraftDefinition] = useState(definition);
  const [selectedPath, setSelectedPath] = useState<number[] | null>(() => definition.run.length ? [0] : null);
  const [addKind, setAddKind] = useState<FlowStatementKind>('call');
  const [isExpanded, setIsExpanded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [mode, setMode] = useState<FlowCanvasMode>('overview');

  useEffect(() => {
    setDraftDefinition(definition);
    setSelectedPath(definition.run.length ? [0] : null);
    setSaveError(null);
    setIsDirty(false);
  }, [definition]);

  const model = useMemo(
    () => flowDefinitionToCanvasModel(draftDefinition, { mode }),
    [draftDefinition, mode]
  );
  const selectedStatement = useMemo(
    () => selectedPath ? getStatementAtPath(draftDefinition, selectedPath) : null,
    [draftDefinition, selectedPath]
  );

  const nodes = useMemo(
    () => model.nodes.map((node) => ({
      ...node,
      selected: Boolean(selectedPath && sameStatementPath(node.data.statementPath, selectedPath)),
      data: {
        ...node.data,
        editable,
      },
    })),
    [editable, model.nodes, selectedPath]
  );
  const selectedNodeData = useMemo(
    () => selectedPath ? nodes.find((node) => sameStatementPath(node.data.statementPath, selectedPath))?.data ?? null : null,
    [nodes, selectedPath]
  );
  const stepKinds = mode === 'debug' ? EDITABLE_STEP_KINDS : OVERVIEW_STEP_KINDS;

  useEffect(() => {
    if (!stepKinds.includes(addKind)) {
      setAddKind(stepKinds[0]);
    }
  }, [addKind, stepKinds]);

  const commitDraft = useCallback((updater: (current: FlowDefinition) => FlowDefinition, nextSelection?: number[] | null) => {
    setDraftDefinition((current) => updater(current));
    if (nextSelection !== undefined) {
      setSelectedPath(nextSelection);
    }
    setSaveError(null);
    setIsDirty(true);
  }, []);

  const updateSelectedStatement = useCallback((nextStatement: FlowStatement) => {
    if (!selectedPath) return;
    commitDraft((current) => updateStatementAtPath(current, selectedPath, nextStatement), selectedPath);
  }, [commitDraft, selectedPath]);

  const addStatement = useCallback((mode: 'after' | 'inside' | 'end') => {
    const statement = createDefaultFlowStatement(addKind, draftDefinition);
    if (mode === 'end' || !selectedPath) {
      const nextPath = [draftDefinition.run.length];
      commitDraft((current) => appendStatementToRun(current, statement), nextPath);
      return;
    }

    if (mode === 'inside' && selectedStatement && ('if' in selectedStatement || 'loop' in selectedStatement)) {
      const childCount = 'if' in selectedStatement
        ? (Array.isArray(selectedStatement.then) ? selectedStatement.then.length : 1)
        : selectedStatement.loop.steps.length;
      commitDraft((current) => insertStatementIntoPath(current, selectedPath, statement), [...selectedPath, childCount]);
      return;
    }

    const nextPath = [...selectedPath];
    nextPath[nextPath.length - 1] += 1;
    commitDraft((current) => insertStatementAfterPath(current, selectedPath, statement), nextPath);
  }, [addKind, commitDraft, draftDefinition, selectedPath, selectedStatement]);

  const deleteSelected = useCallback(() => {
    if (!selectedPath) return;
    const nextSelection = selectedPath[selectedPath.length - 1] > 0
      ? [...selectedPath.slice(0, -1), selectedPath[selectedPath.length - 1] - 1]
      : null;
    commitDraft((current) => deleteStatementAtPath(current, selectedPath), nextSelection);
  }, [commitDraft, selectedPath]);

  const duplicateSelected = useCallback(() => {
    if (!selectedPath) return;
    const nextPath = [...selectedPath];
    nextPath[nextPath.length - 1] += 1;
    commitDraft((current) => duplicateStatementAtPath(current, selectedPath), nextPath);
  }, [commitDraft, selectedPath]);

  const moveSelected = useCallback((direction: -1 | 1) => {
    if (!selectedPath) return;
    const nextIndex = selectedPath[selectedPath.length - 1] + direction;
    if (nextIndex < 0) return;
    const nextPath = [...selectedPath.slice(0, -1), nextIndex];
    commitDraft((current) => moveStatementAtPath(current, selectedPath, direction), nextPath);
  }, [commitDraft, selectedPath]);

  const handleSave = useCallback(async () => {
    if (!onSaveDefinition) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSaveDefinition(draftDefinition);
      setIsDirty(false);
    } catch (error) {
      setSaveError(formatError(error));
    } finally {
      setIsSaving(false);
    }
  }, [draftDefinition, onSaveDefinition]);

  const canAddInside = Boolean(selectedStatement && ('if' in selectedStatement || 'loop' in selectedStatement));

  return (
    <div className={cn("overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-panel)/0.88)] shadow-[var(--app-shadow-panel)]", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.76)] px-3 py-2 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]">
        <div className="flex min-w-0 items-center gap-2">
          <GitPullRequestArrow className="h-3.5 w-3.5 text-[hsl(var(--app-accent))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
            Flow canvas
          </span>
          <div className="ml-1 flex rounded-md border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.68)] p-0.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]">
            {(['overview', 'context', 'debug'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => setMode(candidate)}
                className={cn(
                  "h-6 rounded px-2 text-[11px] font-semibold transition-[background-color,color,transform] duration-150 active:scale-[0.96]",
                  mode === candidate
                    ? "bg-[hsl(var(--app-bg))] text-foreground shadow-[0_6px_14px_-12px_hsl(var(--foreground)/0.75),inset_0_0_0_1px_hsl(var(--app-border)/0.68)]"
                    : "text-muted-foreground hover:bg-[hsl(var(--app-panel)/0.74)] hover:text-foreground"
                )}
              >
                {getModeLabel(candidate)}
              </button>
            ))}
          </div>
          {isDirty ? (
            <span className="rounded-md border border-amber-500/22 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
              Unsaved
            </span>
          ) : editable ? (
            <span className="rounded-md border border-emerald-500/22 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
              Saved
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {editable ? (
            <>
              <select
                value={addKind}
                onChange={(event) => setAddKind(event.target.value as FlowStatementKind)}
                className="h-7 rounded-md border border-[hsl(var(--app-border)/0.7)] bg-background/78 px-2 text-xs font-medium text-foreground outline-none focus:border-[hsl(var(--app-accent)/0.48)]"
                aria-label="Step type to add"
              >
                {stepKinds.map((kind) => (
                  <option key={kind} value={kind}>{kind}</option>
                ))}
              </select>
              <IconTextButton icon={<Plus className="h-3.5 w-3.5" />} label={selectedPath ? 'After' : 'Add'} onClick={() => addStatement(selectedPath ? 'after' : 'end')} />
              <IconTextButton icon={<ListPlus className="h-3.5 w-3.5" />} label="Inside" onClick={() => addStatement('inside')} disabled={!canAddInside} />
              <IconButton icon={<RotateCcw className="h-3.5 w-3.5" />} label="Reset draft" onClick={() => {
                setDraftDefinition(definition);
                setSelectedPath(definition.run.length ? [0] : null);
                setIsDirty(false);
                setSaveError(null);
              }} disabled={!isDirty} />
              <IconTextButton icon={<Save className="h-3.5 w-3.5" />} label={isSaving ? 'Saving' : 'Save'} onClick={() => void handleSave()} disabled={!isDirty || isSaving || !onSaveDefinition} />
            </>
          ) : null}
          <IconButton icon={<Maximize2 className="h-3.5 w-3.5" />} label="Expand flow canvas" onClick={() => setIsExpanded(true)} />
        </div>
      </div>

      {saveError ? (
        <div className="border-b border-destructive/20 bg-destructive/6 px-3 py-2 text-xs leading-5 text-destructive">
          {saveError}
        </div>
      ) : null}

      <div className={cn("grid min-h-[360px] bg-[hsl(var(--app-bg-muted)/0.28)]", editable ? "lg:grid-cols-[minmax(0,1fr)_20rem]" : "grid-cols-1")}>
        <FlowCanvasSurface
          nodes={nodes}
          edges={model.edges}
          onSelectPath={setSelectedPath}
        />
        {editable ? (
          <FlowStatementInspector
            definition={draftDefinition}
            selectedPath={selectedPath}
            statement={selectedStatement}
            onChange={updateSelectedStatement}
            onDelete={deleteSelected}
            onDuplicate={duplicateSelected}
            onMove={moveSelected}
            nodeData={selectedNodeData}
            mode={mode}
          />
        ) : null}
      </div>

      <Dialog open={isExpanded} onOpenChange={setIsExpanded}>
        <DialogContent className="flex h-[92dvh] !w-[98vw] !max-w-[98vw] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel-strong)/0.84)] px-5 py-3 pr-12">
            <DialogTitle className="text-base">Flow Canvas</DialogTitle>
            <DialogDescription className="sr-only">
              Enlarged flow canvas for the selected flow.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 bg-[hsl(var(--app-bg-muted)/0.28)]">
            <FlowCanvasSurface
              nodes={nodes}
              edges={model.edges}
              onSelectPath={setSelectedPath}
              fitViewPadding={0.18}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FlowCanvasSurface({
  nodes,
  edges,
  onSelectPath,
  fitViewPadding = 0.24,
}: {
  nodes: Node<FlowCanvasNodeData>[];
  edges: ReturnType<typeof flowDefinitionToCanvasModel>['edges'];
  onSelectPath: (path: number[] | null) => void;
  fitViewPadding?: number;
}) {
  return (
    <ReactFlowProvider>
      <div className="agentree-flow-canvas h-full min-h-[360px]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={flowCanvasNodeTypes}
          fitView
          fitViewOptions={{ padding: fitViewPadding, minZoom: 0.42, maxZoom: 1.08 }}
          minZoom={0.28}
          maxZoom={1.45}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          panOnScroll
          proOptions={{ hideAttribution: true }}
          className="agentree-flow-react-flow"
          onPaneClick={() => onSelectPath(null)}
          onNodeClick={(_, node) => {
            const path = Array.isArray(node.data.statementPath)
              ? (node.data.statementPath as number[])
              : null;
            onSelectPath(path ? [...path] : null);
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} color="hsl(var(--app-border) / 0.58)" />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}

const flowCanvasNodeTypes = {
  flowCanvasNode: memo(FlowCanvasNode),
};

function FlowCanvasNode({ data, selected }: NodeProps<Node<FlowCanvasNodeData & { editable?: boolean }>>) {
  const inputPorts = getDataPorts(data, 'input');
  const outputPorts = getDataPorts(data, 'output');
  if (data.kind === 'group') {
    const isParallel = data.groupKind === 'parallel';
    const isContext = data.groupKind === 'context';
    return (
      <div
        className={cn(
          "relative h-full w-full rounded-lg border px-4 py-3 shadow-[0_18px_42px_-34px_hsl(var(--foreground)/0.54),inset_0_1px_0_hsl(var(--foreground)/0.035)] transition-[border-color,box-shadow]",
          isContext
            ? "border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-bg-muted)/0.34)]"
            : isParallel
              ? "border-[hsl(var(--app-graph-user)/0.34)] bg-[hsl(var(--app-graph-user)/0.08)]"
              : "border-[hsl(var(--app-graph-summary)/0.32)] bg-[hsl(var(--app-graph-summary)/0.08)]",
          selected ? "ring-2 ring-[hsl(var(--app-focus))] ring-offset-2 ring-offset-background" : ""
        )}
      >
        {!isContext ? (
          <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-background !bg-[hsl(var(--app-accent))]" />
        ) : null}
        <DataPortStrip ports={inputPorts} direction="input" />
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]",
              isContext
                ? "border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel)/0.78)] text-[hsl(var(--app-muted-foreground))]"
                : isParallel
                  ? "border-[hsl(var(--app-graph-user)/0.22)] bg-[hsl(var(--app-graph-user)/0.12)] text-[hsl(var(--app-graph-user))]"
                  : "border-[hsl(var(--app-graph-summary)/0.22)] bg-[hsl(var(--app-graph-summary)/0.12)] text-[hsl(var(--app-graph-summary))]"
            )}>
              {isContext ? <GitPullRequestArrow className="h-3.5 w-3.5" /> : isParallel ? <GitBranch className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
            </span>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {isContext ? 'Context parent' : isParallel ? 'Concurrent section' : 'Repeat section'}
              </div>
              <div className="truncate text-sm font-semibold text-foreground">
                {data.label}
              </div>
            </div>
          </div>
          {data.meta ? (
            <div className="shrink-0 rounded-md border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel)/0.7)] px-2 py-1 text-[10.5px] font-semibold text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)]">
              {data.meta}
            </div>
          ) : null}
        </div>
        <DataPortStrip ports={outputPorts} direction="output" />
        {!isContext ? (
          <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-background !bg-[hsl(var(--app-accent))]" />
        ) : null}
      </div>
    );
  }

  const tone = getNodeTone(data.kind);
  const isTerminal = data.kind === 'start' || data.kind === 'done';
  const accent = getNodeAccent(data.kind);
  return (
    <div
      className={cn(
        "relative min-w-[188px] max-w-[230px] rounded-lg border px-3 py-2 shadow-[0_14px_34px_-30px_hsl(var(--foreground)/0.58),inset_0_1px_0_hsl(var(--foreground)/0.035)] transition-[border-color,box-shadow]",
        tone,
        selected ? "ring-2 ring-[hsl(var(--app-focus))] ring-offset-2 ring-offset-background" : "",
        isTerminal ? "rounded-full text-center" : ""
      )}
    >
      <Handle type="target" position={Position.Top} className={cn("!h-2 !w-2 !border-background", accent.handle)} />
      <DataPortStrip ports={inputPorts} direction="input" />
      <div className="flex items-center gap-2">
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md border shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]", accent.icon)}>
          {getNodeIcon(data.kind)}
        </span>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {data.kind}
          </div>
          <div className="truncate text-sm font-semibold text-foreground">
            {data.label}
          </div>
        </div>
      </div>
      {data.meta ? (
        <div className="mt-1.5 truncate pl-8 text-[11px] leading-4 text-muted-foreground">
          {data.meta}
        </div>
      ) : null}
      <DataPortStrip ports={outputPorts} direction="output" />
      {data.outcomes?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-8">
          {data.outcomes.map((outcome) => (
            <span key={outcome} className="rounded-md border border-destructive/24 bg-destructive/7 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
              {outcome}
            </span>
          ))}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className={cn("!h-2 !w-2 !border-background", accent.handle)} />
    </div>
  );
}

function DataPortStrip({
  ports,
  direction,
}: {
  ports: NonNullable<FlowCanvasNodeData['dataPorts']>;
  direction: 'input' | 'output';
}) {
  if (!ports.length) return null;
  return (
    <div className={cn(
      "agentree-flow-data-port-section flex min-h-7 flex-wrap items-center justify-center gap-1.5 rounded-md border border-[hsl(var(--app-border)/0.42)] bg-[hsl(var(--app-panel-strong)/0.34)] px-1.5 py-1 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.025)]",
      direction === 'input'
        ? "mb-2"
        : "mt-2"
    )}>
      {ports.map((port) => (
        <span
          key={port.id}
          title={port.expression}
          data-flow-port-direction={direction}
          data-flow-port-kind={port.kind}
          className={cn(
            "agentree-flow-data-port relative inline-flex h-5 items-center gap-1 rounded-md border px-1.5 font-mono text-[9.5px] font-semibold leading-none shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]",
            direction === 'input' ? "agentree-flow-data-port-input" : "agentree-flow-data-port-output",
            getDataPortTone(port)
          )}
        >
          <Handle
            id={port.id}
            type={direction === 'input' ? 'target' : 'source'}
            position={direction === 'input' ? Position.Top : Position.Bottom}
            className={cn(
              "!absolute !left-1/2 !h-1.5 !w-1.5 !border-background !bg-current",
              direction === 'input' ? "!top-[-5px]" : "!bottom-[-5px]"
            )}
          />
          <DataPortIcon port={port} />
          <span>{port.label}</span>
          {port.count && port.count > 1 ? (
            <span className="ml-0.5 text-[8.5px] opacity-70">x{port.count}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function DataPortIcon({ port }: { port: NonNullable<FlowCanvasNodeData['dataPorts']>[number] }) {
  if (port.kind === 'commit' && port.isArray) {
    return (
      <span className="relative inline-flex h-3.5 w-4 shrink-0 items-center">
        <GitCommitHorizontal className="absolute left-0 h-3 w-3 opacity-55" />
        <GitCommitHorizontal className="absolute left-1 h-3 w-3 opacity-75" />
        <GitCommitHorizontal className="absolute left-2 h-3 w-3" />
      </span>
    );
  }
  if (port.kind === 'commit') return <GitCommitHorizontal className="h-3 w-3 shrink-0" />;
  if (port.kind === 'verdict') return <Check className="h-3 w-3 shrink-0" />;
  if (port.kind === 'node') return <GitPullRequestArrow className="h-3 w-3 shrink-0" />;
  return <Database className="h-3 w-3 shrink-0" />;
}

function getDataPortTone(port: NonNullable<FlowCanvasNodeData['dataPorts']>[number]): string {
  if (port.kind === 'commit') {
    return 'border-[hsl(var(--app-graph-commit)/0.28)] bg-[hsl(var(--app-graph-commit)/0.1)] text-[hsl(var(--app-graph-commit))]';
  }
  if (port.kind === 'verdict') {
    return 'border-[hsl(var(--app-warning)/0.24)] bg-[hsl(var(--app-warning)/0.1)] text-[hsl(var(--app-warning))]';
  }
  if (port.kind === 'node') {
    return 'border-[hsl(var(--app-graph-agent)/0.22)] bg-[hsl(var(--app-graph-agent)/0.1)] text-[hsl(var(--app-graph-agent))]';
  }
  return 'border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel-strong)/0.74)] text-muted-foreground';
}

function getDataPorts(
  data: FlowCanvasNodeData,
  direction: 'input' | 'output'
): NonNullable<FlowCanvasNodeData['dataPorts']> {
  return (data.dataPorts ?? []).filter((port) => port.direction === direction);
}

function FlowStatementInspector({
  definition,
  selectedPath,
  statement,
  onChange,
  onDelete,
  onDuplicate,
  onMove,
  nodeData,
  mode,
}: {
  definition: FlowDefinition;
  selectedPath: number[] | null;
  statement: FlowStatement | null;
  onChange: (statement: FlowStatement) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
  nodeData: FlowCanvasNodeData | null;
  mode: FlowCanvasMode;
}) {
  if (!selectedPath || !statement) {
    return (
      <aside className="border-t border-[hsl(var(--app-border)/0.58)] bg-background/34 p-3 lg:border-l lg:border-t-0">
        <div className="rounded-lg border border-dashed border-[hsl(var(--app-border)/0.7)] px-3 py-6 text-center text-xs leading-5 text-muted-foreground">
          Select a flow step to edit its fields.
        </div>
      </aside>
    );
  }

  const kind = getStatementKind(statement);

  return (
    <aside className="min-h-0 overflow-auto border-t border-[hsl(var(--app-border)/0.58)] bg-background/34 p-3 lg:border-l lg:border-t-0">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">Selected</div>
          <div className="mt-1 truncate text-sm font-semibold text-foreground">
            {selectedPath.join('.')} · {kind}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {mode === 'overview' ? 'Overview projection' : mode === 'context' ? 'Context parent projection' : 'Debug AST'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton icon={<ArrowUp className="h-3.5 w-3.5" />} label="Move up" onClick={() => onMove(-1)} />
          <IconButton icon={<ArrowDown className="h-3.5 w-3.5" />} label="Move down" onClick={() => onMove(1)} />
        </div>
      </div>

      <div className="space-y-3">
        <InspectorMetadata nodeData={nodeData} />
        {'call' in statement ? (
          <CallEditor definition={definition} statement={statement} onChange={onChange} />
        ) : 'parallel' in statement ? (
          <ParallelEditor definition={definition} statement={statement} onChange={onChange} />
        ) : 'value' in statement ? (
          <SetEditor statement={statement} onChange={onChange} />
        ) : 'if' in statement ? (
          <TextField label="Condition" value={statement.if} onChange={(value) => onChange({ ...statement, if: value })} />
        ) : 'loop' in statement ? (
          <NumberField
            label="Max rounds"
            value={statement.loop.max_rounds}
            min={1}
            max={8}
            onChange={(value) => onChange({ loop: { ...statement.loop, max_rounds: value } })}
          />
        ) : 'stop' in statement ? (
          <TextField label="Stop reason" value={statement.stop} onChange={(value) => onChange({ stop: value })} />
        ) : (
          <div className="rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-background/52 px-3 py-2 text-xs text-muted-foreground">
            Break exits the nearest loop.
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <IconTextButton icon={<Copy className="h-3.5 w-3.5" />} label="Duplicate" onClick={onDuplicate} />
        <IconTextButton icon={<Trash2 className="h-3.5 w-3.5" />} label="Delete" onClick={onDelete} danger />
      </div>
    </aside>
  );
}

function InspectorMetadata({ nodeData }: { nodeData: FlowCanvasNodeData | null }) {
  if (!nodeData) return null;
  const outputs = nodeData.outputs ?? [];
  const bindings = nodeData.dataBindings ?? [];
  const outcomes = nodeData.outcomes ?? [];
  if (!nodeData.contextLabel && outputs.length === 0 && bindings.length === 0 && outcomes.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2 rounded-lg border border-[hsl(var(--app-border)/0.6)] bg-background/46 p-2.5">
      {nodeData.contextLabel ? (
        <InspectorRow label="Context" value={nodeData.contextLabel} />
      ) : null}
      {outputs.length ? (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">Outputs</div>
          <div className="flex flex-wrap gap-1.5">
            {outputs.map((output) => (
              <span key={`${output.expression}:${output.label}`} className={cn(
                "rounded-md border px-1.5 py-0.5 font-mono text-[10.5px]",
                output.importance === 'primary'
                  ? "border-[hsl(var(--app-accent)/0.28)] bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]"
                  : "border-[hsl(var(--app-border)/0.62)] bg-background/70 text-muted-foreground"
              )}>
                {output.expression}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {bindings.length ? (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">Data</div>
          {bindings.map((binding) => (
            <InspectorRow key={`${binding.target}:${binding.expression}`} label={binding.target} value={binding.expression} />
          ))}
        </div>
      ) : null}
      {outcomes.length ? (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">Outcomes</div>
          <div className="flex flex-wrap gap-1.5">
            {outcomes.map((outcome) => (
              <span key={outcome} className="rounded-md border border-destructive/24 bg-destructive/7 px-1.5 py-0.5 text-[10.5px] font-semibold text-destructive">
                {outcome}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5.2rem_minmax(0,1fr)] gap-2 text-[11px] leading-5">
      <span className="text-muted-foreground">{label}</span>
      <code className="truncate rounded bg-background/70 px-1.5 py-0.5 font-mono text-foreground">{value}</code>
    </div>
  );
}

function CallEditor({
  definition,
  statement,
  onChange,
}: {
  definition: FlowDefinition;
  statement: Extract<FlowStatement, { call: string }>;
  onChange: (statement: FlowStatement) => void;
}) {
  const template = definition.nodes.find((node) => node.id === statement.call) ?? definition.nodes[0] ?? null;
  const args = statement.args ?? {};
  return (
    <>
      <TextField label="Set variable" value={statement.set} onChange={(value) => onChange({ ...statement, set: value })} />
      <TemplateSelect
        definition={definition}
        value={statement.call}
        onChange={(call) => onChange({ ...statement, call, args: pruneArgsForTemplate(args, definition, call) })}
      />
      <TextField label="Parent" value={statement.parent ?? ''} placeholder="root or flow expression" onChange={(value) => {
        const trimmed = value.trim();
        onChange({ ...statement, ...(trimmed ? { parent: trimmed } : { parent: undefined }) });
      }} />
      <ArgsEditor params={template?.params ?? []} args={args} onChange={(nextArgs) => onChange({ ...statement, args: nextArgs })} />
    </>
  );
}

function ParallelEditor({
  definition,
  statement,
  onChange,
}: {
  definition: FlowDefinition;
  statement: Extract<FlowStatement, { parallel: unknown }>;
  onChange: (statement: FlowStatement) => void;
}) {
  const parallel = statement.parallel;
  if ('branches' in parallel) {
    return (
      <div className="space-y-2 rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-background/52 px-3 py-2 text-xs text-muted-foreground">
        <div className="font-semibold text-foreground">Branch parallel</div>
        <div>{parallel.branches.length} branch-specific calls. Edit this flow in YAML for branch details.</div>
      </div>
    );
  }
  const template = definition.nodes.find((node) => node.id === parallel.call) ?? definition.nodes[0] ?? null;
  const args = parallel.args ?? {};
  return (
    <>
      <TextField label="Set variable" value={statement.set} onChange={(value) => onChange({ ...statement, set: value })} />
      <TextField
        label="Count"
        value={String(parallel.count)}
        onChange={(value) => onChange({
          ...statement,
          parallel: { ...parallel, count: parseCountValue(value) },
        })}
      />
      <TemplateSelect
        definition={definition}
        value={parallel.call}
        onChange={(call) => onChange({
          ...statement,
          parallel: { ...parallel, call, args: pruneArgsForTemplate(args, definition, call) },
        })}
      />
      <TextField label="Parent" value={parallel.parent ?? ''} placeholder="root or flow expression" onChange={(value) => {
        const trimmed = value.trim();
        onChange({
          ...statement,
          parallel: { ...parallel, ...(trimmed ? { parent: trimmed } : { parent: undefined }) },
        });
      }} />
      <ArgsEditor
        params={template?.params ?? []}
        args={args}
        onChange={(nextArgs) => onChange({ ...statement, parallel: { ...parallel, args: nextArgs } })}
      />
    </>
  );
}

function SetEditor({
  statement,
  onChange,
}: {
  statement: Extract<FlowStatement, { value: FlowRuntimeValue }>;
  onChange: (statement: FlowStatement) => void;
}) {
  return (
    <>
      <TextField label="Set variable" value={statement.set} onChange={(value) => onChange({ ...statement, set: value })} />
      <TextField
        label="Value expression"
        value={formatEditableValue(statement.value)}
        onChange={(value) => onChange({ ...statement, value: parseEditableValue(value) })}
      />
    </>
  );
}

function ArgsEditor({
  params,
  args,
  onChange,
}: {
  params: string[];
  args: Record<string, string>;
  onChange: (args: Record<string, string>) => void;
}) {
  if (params.length === 0) {
    return (
      <div className="rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-background/52 px-3 py-2 text-xs text-muted-foreground">
        This template declares no args.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">Args</div>
      {params.map((param) => (
        <TextField
          key={param}
          label={param}
          value={args[param] ?? ''}
          placeholder="input.input"
          onChange={(value) => onChange({ ...args, [param]: value })}
        />
      ))}
    </div>
  );
}

function TemplateSelect({
  definition,
  value,
  onChange,
}: {
  definition: FlowDefinition;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-semibold text-muted-foreground">Template</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border border-[hsl(var(--app-border)/0.7)] bg-background/78 px-2 text-xs font-medium text-foreground outline-none focus:border-[hsl(var(--app-accent)/0.48)]"
      >
        {definition.nodes.map((node) => (
          <option key={node.id} value={node.id}>{node.id}</option>
        ))}
      </select>
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-semibold text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 w-full rounded-md border border-[hsl(var(--app-border)/0.7)] bg-background/78 px-2 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/58 focus:border-[hsl(var(--app-accent)/0.48)]"
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-semibold text-muted-foreground">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-8 w-full rounded-md border border-[hsl(var(--app-border)/0.7)] bg-background/78 px-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-[hsl(var(--app-accent)/0.48)]"
      />
    </label>
  );
}

function IconButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[hsl(var(--app-border)/0.7)] bg-background/70 text-muted-foreground transition-colors hover:bg-background hover:text-foreground active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45"
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  );
}

function IconTextButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border bg-background/70 px-2 text-xs font-semibold transition-colors active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45",
        danger
          ? "border-destructive/28 text-destructive hover:bg-destructive/8"
          : active
            ? "border-[hsl(var(--app-accent)/0.28)] bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]"
          : "border-[hsl(var(--app-border)/0.7)] text-muted-foreground hover:bg-background hover:text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function getNodeTone(kind: FlowCanvasNodeData['kind']): string {
  switch (kind) {
    case 'call':
      return 'border-[hsl(var(--app-graph-agent)/0.32)] bg-[hsl(var(--app-panel)/0.96)] text-foreground';
    case 'parallel':
      return 'border-[hsl(var(--app-graph-user)/0.32)] bg-[hsl(var(--app-graph-user)/0.08)] text-foreground';
    case 'if':
      return 'border-[hsl(var(--app-warning)/0.34)] bg-[hsl(var(--app-warning)/0.1)] [clip-path:polygon(8%_0,100%_0,92%_100%,0_100%)]';
    case 'loop':
      return 'border-[hsl(var(--app-graph-summary)/0.32)] bg-[hsl(var(--app-graph-summary)/0.08)] border-dashed';
    case 'set':
      return 'border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-bg-muted)/0.82)]';
    case 'stop':
    case 'break':
      return 'border-destructive/28 bg-destructive/6';
    default:
      return 'border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-panel-strong)/0.92)]';
  }
}

function getNodeAccent(kind: FlowCanvasNodeData['kind']): { icon: string; handle: string } {
  switch (kind) {
    case 'call':
      return {
        icon: 'border-[hsl(var(--app-graph-agent)/0.22)] bg-[hsl(var(--app-graph-agent)/0.12)] text-[hsl(var(--app-graph-agent))]',
        handle: '!bg-[hsl(var(--app-graph-agent))]',
      };
    case 'parallel':
      return {
        icon: 'border-[hsl(var(--app-graph-user)/0.22)] bg-[hsl(var(--app-graph-user)/0.12)] text-[hsl(var(--app-graph-user))]',
        handle: '!bg-[hsl(var(--app-graph-user))]',
      };
    case 'if':
      return {
        icon: 'border-[hsl(var(--app-warning)/0.22)] bg-[hsl(var(--app-warning)/0.12)] text-[hsl(var(--app-warning))]',
        handle: '!bg-[hsl(var(--app-warning))]',
      };
    case 'loop':
      return {
        icon: 'border-[hsl(var(--app-graph-summary)/0.22)] bg-[hsl(var(--app-graph-summary)/0.12)] text-[hsl(var(--app-graph-summary))]',
        handle: '!bg-[hsl(var(--app-graph-summary))]',
      };
    case 'done':
      return {
        icon: 'border-[hsl(var(--app-graph-commit)/0.22)] bg-[hsl(var(--app-graph-commit)/0.12)] text-[hsl(var(--app-graph-commit))]',
        handle: '!bg-[hsl(var(--app-graph-commit))]',
      };
    case 'stop':
    case 'break':
      return {
        icon: 'border-destructive/20 bg-destructive/10 text-destructive',
        handle: '!bg-destructive',
      };
    default:
      return {
        icon: 'border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel)/0.78)] text-muted-foreground',
        handle: '!bg-[hsl(var(--app-muted-foreground))]',
      };
  }
}

function getNodeIcon(kind: FlowCanvasNodeData['kind']) {
  const className = 'h-3.5 w-3.5';
  switch (kind) {
    case 'parallel':
      return <GitBranch className={className} />;
    case 'if':
      return <GitPullRequestArrow className={className} />;
    case 'loop':
      return <RotateCcw className={className} />;
    case 'set':
      return <Braces className={className} />;
    case 'stop':
    case 'break':
      return <Trash2 className={className} />;
    case 'done':
      return <Check className={className} />;
    default:
      return <GitPullRequestArrow className={className} />;
  }
}

function sameStatementPath(left: unknown, right: number[] | null): boolean {
  if (!right || !Array.isArray(left) || left.length !== right.length) return false;
  return left.every((part, index) => part === right[index]);
}

function getModeLabel(mode: FlowCanvasMode): string {
  if (mode === 'overview') return 'Overview';
  if (mode === 'context') return 'Context';
  return 'Debug';
}

function pruneArgsForTemplate(
  args: Record<string, string>,
  definition: FlowDefinition,
  templateId: string
): Record<string, string> | undefined {
  const params = new Set(definition.nodes.find((node) => node.id === templateId)?.params ?? []);
  const nextArgs = Object.fromEntries(Object.entries(args).filter(([key]) => params.has(key)));
  return Object.keys(nextArgs).length ? nextArgs : undefined;
}

function parseCountValue(value: string): string | number {
  const trimmed = value.trim();
  if (/^[1-8]$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function formatEditableValue(value: FlowRuntimeValue): string {
  if (value === null) return 'null';
  return String(value);
}

function parseEditableValue(value: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return value;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Flow canvas changes could not be saved.';
}
