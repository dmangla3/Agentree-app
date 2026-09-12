import { useCallback, useMemo, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { Check, Plus, Puzzle, Trash2, Workflow } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useOrchestrationTemplateStore } from '../../stores/orchestrationTemplateStore';
import {
  normalizeTemplateId,
  type OrchestrationPromptTemplate,
  type OrchestrationTemplateKind,
} from '../../orchestration/templates';
import { cn } from '../../lib/utils';

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
    <section className="min-h-0 overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.72)] bg-background/42 shadow-[0_14px_34px_-30px_hsl(var(--foreground)/0.42)]">
      <div className="flex items-center justify-between border-b border-border/70 bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.92),hsl(var(--app-panel)/0.72))] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border/70 bg-background/72 text-[hsl(var(--app-accent))] shadow-sm">
            {label === 'Orchestration prompts' ? <Workflow className="h-3.5 w-3.5" /> : <Puzzle className="h-3.5 w-3.5" />}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {label}
            </div>
            <div className="mt-0.5 text-[10px] font-medium text-muted-foreground/75">
              {items.length} saved
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => resetTemplateDraft(kind)}
            className="flex h-7 items-center gap-1 rounded-md border border-[hsl(var(--app-accent)/0.28)] bg-[hsl(var(--app-accent-soft))] px-2 text-[10.5px] font-semibold normal-case tracking-normal text-[hsl(var(--app-accent))] transition-[background-color,filter,transform] hover:brightness-105 active:scale-[0.96]"
          >
            <Plus className="h-3 w-3" />
            New
          </button>
        </div>
      </div>
      <div className="max-h-[18rem] space-y-1 overflow-y-auto p-1.5">
        {items.map((template) => {
          const isUserTemplate = userTemplateIds.has(template.id);
          const selected = selectedTemplateId === template.id;
          return (
            <button
              key={`${template.kind}:${template.id}`}
              type="button"
              onClick={() => loadTemplateDraft(template)}
              className={cn(
                'flex min-h-12 w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-[background-color,color,transform] active:scale-[0.99]',
                selected ? 'bg-[hsl(var(--app-accent-soft))] text-foreground shadow-sm' : 'hover:bg-muted/60',
              )}
            >
              {template.kind === 'orchestration' ? (
                <Workflow className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--app-accent))]" />
              ) : (
                <Puzzle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--app-accent))]" />
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
    <div className={cn('grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)]', className)}>
      <div className="grid min-h-0 gap-4 md:grid-cols-2 lg:grid-cols-1">
        {renderTemplateList('Node prompts', 'node', nodeTemplates)}
        {renderTemplateList('Orchestration prompts', 'orchestration', orchestrationPromptTemplates)}
      </div>

      <section className="app-panel flex min-h-0 flex-col rounded-2xl border border-[hsl(var(--app-border)/0.78)] bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.98),hsl(var(--app-panel)/0.94))]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--app-accent))]">
              Editor
            </div>
            <div className="mt-1 truncate text-sm font-semibold text-foreground">
              {selectedTemplate ? selectedTemplate.label : `New ${getTemplateKindLabel(draftKind).toLowerCase()}`}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-border/70 bg-background/72 p-1">
            {(['node', 'orchestration'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setDraftKind(kind)}
                className={cn(
                  'h-8 rounded-md text-xs font-semibold transition-[background-color,color,transform] active:scale-[0.98]',
                  draftKind === kind ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
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
              className="h-9 w-full rounded-lg border border-border/70 bg-background/80 px-2.5 font-mono text-xs outline-none transition-[border-color,box-shadow] focus:border-[hsl(var(--app-focus)/0.72)] focus:shadow-[0_0_0_3px_hsl(var(--app-focus)/0.10)]"
              placeholder="#custom_reviewer"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[11px] font-semibold text-muted-foreground">Prompt</span>
            <TextareaAutosize
              value={draftPrompt}
              onChange={(event) => setDraftPrompt(event.target.value)}
              className="min-h-48 w-full resize-y rounded-lg border border-border/70 bg-background/80 px-2.5 py-2 text-xs leading-5 outline-none transition-[border-color,box-shadow] focus:border-[hsl(var(--app-focus)/0.72)] focus:shadow-[0_0_0_3px_hsl(var(--app-focus)/0.10)]"
              placeholder="Review {{request}} for correctness and validation gaps."
              minRows={8}
              maxRows={18}
            />
          </label>

          {draftKind === 'node' ? (
            <label className="flex items-center gap-2 rounded-lg border border-border/65 bg-background/58 px-2.5 py-2 text-xs font-medium text-muted-foreground">
              <input
                type="checkbox"
                checked={draftRequiresCommit}
                onChange={(event) => setDraftRequiresCommit(event.target.checked)}
                className="h-3.5 w-3.5 accent-[hsl(var(--app-accent))]"
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
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/68 px-2.5 text-xs font-semibold text-muted-foreground transition-[background-color,color,transform,opacity] hover:bg-red-50 hover:text-red-600 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-red-950/40 dark:hover:text-red-300"
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
              'flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-[background-color,box-shadow,opacity,transform] active:scale-[0.96]',
              canSaveTemplate
                ? 'bg-[hsl(var(--app-accent))] text-white shadow-[0_12px_28px_-18px_hsl(var(--app-accent)/0.62)] hover:brightness-105'
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
