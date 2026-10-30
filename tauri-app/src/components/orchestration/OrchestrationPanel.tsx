import { useCallback, useMemo, useState } from 'react';
import { Check, Plus, Puzzle, Trash2, Workflow } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useOrchestrationTemplateStore } from '../../stores/orchestrationTemplateStore';
import {
  normalizeTemplateId,
  type OrchestrationPromptTemplate,
  type OrchestrationTemplateKind,
} from '../../orchestration/templates';
import { cn } from '../../lib/utils';
import { TemplateMentionTextarea } from '../composer/TemplateMentionTextarea';

const getTemplateKindLabel = (kind: OrchestrationTemplateKind): string => (
  kind === 'node' ? 'Node prompt' : 'Orchestration prompt'
);

const getTemplateDraftLabel = (id: string): string => {
  const normalized = normalizeTemplateId(id);
  return normalized ? `#${normalized.replace(/^@/, '')}` : '#template';
};

export function OrchestrationPanel({ className }: { className?: string }) {
  const {
    templates,
    userTemplates,
    upsertUserTemplate,
    deleteUserTemplate,
  } = useOrchestrationTemplateStore(useShallow((state) => ({
    templates: state.templates,
    userTemplates: state.userTemplates,
    upsertUserTemplate: state.upsertUserTemplate,
    deleteUserTemplate: state.deleteUserTemplate,
  })));
  const [draftKind, setDraftKind] = useState<OrchestrationTemplateKind>('node');
  const [draftId, setDraftId] = useState('#custom_reviewer');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftRequiresCommit, setDraftRequiresCommit] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  const userTemplateIds = useMemo(
    () => new Set(userTemplates.map((template) => template.id)),
    [userTemplates],
  );
  const nodeTemplates = useMemo(
    () => templates.filter((template) => template.kind === 'node'),
    [templates],
  );
  const orchestrationPromptTemplates = useMemo(
    () => templates.filter((template) => template.kind === 'orchestration'),
    [templates],
  );
  const normalizedDraftId = normalizeTemplateId(draftId);
  const selectedTemplate = selectedTemplateId
    ? templates.find((template) => template.id === selectedTemplateId) ?? null
    : null;
  const trimmedDraftPrompt = draftPrompt.trim();
  const draftRequiresCommitValue = draftKind === 'node' ? draftRequiresCommit : undefined;
  const templateDraftChanged = selectedTemplate
    ? normalizedDraftId !== selectedTemplate.id
      || draftKind !== selectedTemplate.kind
      || trimmedDraftPrompt !== selectedTemplate.prompt
      || draftRequiresCommitValue !== (selectedTemplate.kind === 'node' ? Boolean(selectedTemplate.requiresCommit) : undefined)
    : Boolean(normalizedDraftId || trimmedDraftPrompt || draftRequiresCommit);
  const canSaveTemplate = Boolean(normalizedDraftId && trimmedDraftPrompt && templateDraftChanged);

  const loadTemplateDraft = useCallback((template: OrchestrationPromptTemplate) => {
    setSelectedTemplateId(template.id);
    setDraftKind(template.kind);
    setDraftId(`#${template.id.replace(/^@/, '')}`);
    setDraftPrompt(template.prompt);
    setDraftRequiresCommit(Boolean(template.requiresCommit));
  }, []);

  const resetTemplateDraft = useCallback((kind: OrchestrationTemplateKind = 'node') => {
    setSelectedTemplateId(null);
    setDraftKind(kind);
    setDraftId(kind === 'node' ? '#custom_reviewer' : '#custom_orchestration');
    setDraftPrompt('');
    setDraftRequiresCommit(false);
  }, []);

  const saveTemplateDraft = useCallback(() => {
    if (!canSaveTemplate) return;
    const normalizedId = normalizeTemplateId(draftId);
    upsertUserTemplate({
      id: normalizedId,
      kind: draftKind,
      label: `#${normalizedId.replace(/^@/, '')}`,
      prompt: trimmedDraftPrompt,
      requiresCommit: draftRequiresCommitValue,
      source: 'user',
      updatedAt: new Date().toISOString(),
    });
    setSelectedTemplateId(normalizedId);
    setDraftId(`#${normalizedId.replace(/^@/, '')}`);
  }, [canSaveTemplate, draftId, draftKind, draftRequiresCommitValue, trimmedDraftPrompt, upsertUserTemplate]);

  const renderTemplateList = (
    label: string,
    kind: OrchestrationTemplateKind,
    items: OrchestrationPromptTemplate[],
  ) => (
    <section className={cn(
      'min-h-0 overflow-hidden',
      kind === 'node' && 'border-b border-[hsl(var(--app-border)/0.68)] md:border-b-0 md:border-r lg:border-b lg:border-r-0 dark:border-white/10',
    )}>
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-2.5 dark:border-white/10">
        <div className="flex min-w-0 items-center gap-2">
          {label === 'Orchestration prompts'
            ? <Workflow className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--app-accent))] dark:text-white/70" />
            : <Puzzle className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--app-accent))] dark:text-white/70" />}
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-foreground">
              {label}
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {items.length} saved
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => resetTemplateDraft(kind)}
            className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-[hsl(var(--app-accent))] transition-[background-color,color,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] hover:bg-[hsl(var(--app-accent)/0.1)] active:scale-[0.96] motion-reduce:transition-none dark:text-foreground dark:hover:bg-white/[0.08]"
          >
            <Plus className="h-3 w-3" />
            New
          </button>
        </div>
      </div>
      <div className="max-h-[18rem] overflow-y-auto p-1.5">
        {items.map((template) => {
          const isUserTemplate = userTemplateIds.has(template.id);
          const selected = selectedTemplateId === template.id;
          return (
            <button
              key={`${template.kind}:${template.id}`}
              type="button"
              onClick={() => loadTemplateDraft(template)}
              className={cn(
                'flex min-h-12 w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-[background-color,color,transform] duration-150 active:scale-[0.96] motion-reduce:transition-none',
                selected
                  ? 'bg-[hsl(var(--app-accent)/0.1)] text-foreground shadow-[inset_2px_0_0_hsl(var(--app-accent))] dark:bg-white/[0.08] dark:shadow-[inset_2px_0_0_hsl(0_0%_100%)]'
                  : 'hover:bg-muted/60 dark:hover:bg-white/[0.06]',
              )}
            >
              {template.kind === 'orchestration' ? (
                <Workflow className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--app-accent))] dark:text-white/70" />
              ) : (
                <Puzzle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--app-accent))] dark:text-white/70" />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[12px] font-semibold">{template.label}</span>
                  <span className="shrink-0 rounded border border-border/65 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                    {isUserTemplate ? 'Edited' : 'Built-in'}
                  </span>
                </span>
                <span className="mt-1 block truncate text-[10.5px] text-muted-foreground">
                  {template.prompt}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );

  return (
    <div data-design-scope="panels" className={cn('grid h-full min-h-0 overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel)/0.72)] antialiased dark:border-white/10 dark:bg-[hsl(var(--app-bg-elevated))] lg:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)]', className)}>
      <div className="grid min-h-0 border-b border-[hsl(var(--app-border)/0.68)] md:grid-cols-2 lg:grid-cols-1 lg:border-b-0 lg:border-r dark:border-white/10">
        {renderTemplateList('Node prompts', 'node', nodeTemplates)}
        {renderTemplateList('Orchestration prompts', 'orchestration', orchestrationPromptTemplates)}
      </div>

      <section className="flex min-h-0 flex-col bg-[hsl(var(--app-panel)/0.58)] dark:bg-[hsl(var(--app-panel))]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {selectedTemplate ? selectedTemplate.label : `New ${getTemplateKindLabel(draftKind).toLowerCase()}`}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="grid grid-cols-2 border-b border-border/70 dark:border-white/10">
            {(['node', 'orchestration'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setDraftKind(kind)}
                className={cn(
                  'h-10 border-b-2 text-xs font-semibold transition-[background-color,border-color,color,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] active:scale-[0.96] motion-reduce:transition-none',
                  draftKind === kind
                    ? 'border-[hsl(var(--app-accent))] text-foreground dark:border-white'
                    : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-white/[0.06]',
                )}
              >
                {getTemplateKindLabel(kind)}
              </button>
            ))}
          </div>

          <label className="block space-y-1.5">
            <span className="text-[11px] font-semibold text-muted-foreground">Template id</span>
            <input
              value={draftId}
              onChange={(event) => setDraftId(event.target.value)}
              className="h-10 w-full rounded-lg border border-border/70 bg-background/80 px-3 font-mono text-xs outline-none transition-[border-color,box-shadow] duration-150 focus:border-[hsl(var(--app-focus)/0.72)] focus:shadow-[0_0_0_3px_hsl(var(--app-focus)/0.10)] motion-reduce:transition-none dark:border-white/15 dark:bg-white/[0.04]"
              placeholder="#custom_reviewer"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[11px] font-semibold text-muted-foreground">Prompt</span>
            <TemplateMentionTextarea
              value={draftPrompt}
              templates={templates}
              onChange={(event) => setDraftPrompt(event.target.value)}
              className="min-h-48 w-full resize-y rounded-lg border border-border/70 bg-background/80 px-2.5 py-2 text-xs leading-5 outline-none transition-[border-color,box-shadow] focus:border-[hsl(var(--app-focus)/0.72)] focus:shadow-[0_0_0_3px_hsl(var(--app-focus)/0.10)] dark:border-white/15 dark:bg-white/[0.04]"
              placeholder="Review {{request}} for correctness and validation gaps."
              minRows={8}
              maxRows={18}
            />
          </label>

          {draftKind === 'node' ? (
            <label className="flex min-h-10 items-center gap-2 border-y border-border/65 py-2 text-xs font-medium text-muted-foreground dark:border-white/10">
              <input
                type="checkbox"
                checked={draftRequiresCommit}
                onChange={(event) => setDraftRequiresCommit(event.target.checked)}
                className="h-3.5 w-3.5 accent-[hsl(var(--app-accent))] dark:accent-white"
              />
              Requires commit
            </label>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 p-4">
          <button
            type="button"
            onClick={() => {
              if (!selectedTemplateId || !userTemplateIds.has(selectedTemplateId)) return;
              deleteUserTemplate(selectedTemplateId);
              resetTemplateDraft();
            }}
            disabled={!selectedTemplateId || !userTemplateIds.has(selectedTemplateId)}
            className="flex h-10 items-center gap-1.5 rounded-lg border border-border/70 bg-background/68 px-3 text-xs font-semibold text-muted-foreground transition-[background-color,color,transform,opacity] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] hover:bg-destructive/10 hover:text-destructive active:scale-[0.96] motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
            Delete edit
          </button>
          <button
            type="button"
            data-testid="save-orchestration-template-button"
            onClick={saveTemplateDraft}
            disabled={!canSaveTemplate}
            className={cn(
              'flex h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-[background-color,box-shadow,opacity,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] active:scale-[0.96] motion-reduce:transition-none',
              canSaveTemplate
                ? 'bg-[hsl(var(--app-accent))] text-white hover:brightness-105 dark:bg-white dark:text-black dark:hover:bg-white/90'
                : 'cursor-not-allowed bg-muted text-muted-foreground opacity-60',
            )}
          >
            <Check className="h-3 w-3" />
            Save {getTemplateDraftLabel(normalizedDraftId)}
          </button>
        </div>
      </section>
    </div>
  );
}
