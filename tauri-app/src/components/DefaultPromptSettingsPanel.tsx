import { useCallback, useEffect, useMemo, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import {
  Check,
  FileText,
  RotateCcw,
  SlidersHorizontal,
  AlertTriangle,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '../../@/components/ui/button';
import {
  DEFAULT_PROMPT_DEFINITIONS,
  getDefaultPromptDefinition,
  getMissingDefaultPromptVariables,
  type DefaultPromptId,
} from '../lib/prompts/defaultPrompts';
import { useDefaultPromptStore } from '../stores/defaultPromptStore';
import { cn } from '../lib/utils';

const firstPromptId = DEFAULT_PROMPT_DEFINITIONS[0]?.id ?? 'dependency_guard';

export function DefaultPromptSettingsPanel() {
  const {
    prompts,
    userPrompts,
    upsertUserPrompt,
    deleteUserPrompt,
    clearUserPrompts,
  } = useDefaultPromptStore(useShallow((state) => ({
    prompts: state.prompts,
    userPrompts: state.userPrompts,
    upsertUserPrompt: state.upsertUserPrompt,
    deleteUserPrompt: state.deleteUserPrompt,
    clearUserPrompts: state.clearUserPrompts,
  })));
  const [selectedPromptId, setSelectedPromptId] = useState<DefaultPromptId>(firstPromptId);
  const selectedPrompt = prompts.find((prompt) => prompt.id === selectedPromptId) ?? prompts[0];
  const [draftPromptId, setDraftPromptId] = useState<DefaultPromptId>(selectedPrompt?.id ?? firstPromptId);
  const [draftText, setDraftText] = useState(selectedPrompt?.text ?? '');

  const editedPromptIds = useMemo(
    () => new Set(userPrompts.map((prompt) => prompt.id)),
    [userPrompts],
  );
  const overrideCount = userPrompts.length;
  const draftPrompt = prompts.find((prompt) => prompt.id === draftPromptId) ?? prompts[0];
  const trimmedDraftText = draftText.trim();
  const missingVariables = draftPrompt
    ? getMissingDefaultPromptVariables(draftPrompt.id, trimmedDraftText)
    : [];
  const draftChanged = Boolean(draftPrompt && trimmedDraftText && trimmedDraftText !== draftPrompt.text);
  const canSavePrompt = Boolean(draftPrompt && draftChanged && missingVariables.length === 0);

  useEffect(() => {
    const prompt = prompts.find((candidate) => candidate.id === selectedPromptId) ?? prompts[0];
    if (!prompt) return;
    setDraftPromptId(prompt.id);
    setDraftText(prompt.text);
  }, [prompts, selectedPromptId]);

  const loadPromptDraft = useCallback((promptId: DefaultPromptId) => {
    const prompt = prompts.find((candidate) => candidate.id === promptId);
    if (!prompt) return;
    setSelectedPromptId(prompt.id);
    setDraftPromptId(prompt.id);
    setDraftText(prompt.text);
  }, [prompts]);

  const savePromptDraft = useCallback(() => {
    if (!canSavePrompt || !draftPrompt) return;
    upsertUserPrompt({
      id: draftPrompt.id,
      text: trimmedDraftText,
      updatedAt: new Date().toISOString(),
    });
    setSelectedPromptId(draftPrompt.id);
    setDraftText(trimmedDraftText);
  }, [canSavePrompt, draftPrompt, trimmedDraftText, upsertUserPrompt]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <div className="border-b border-border/70 px-5 py-3.5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FileText size={17} className="text-muted-foreground" />
              <h2 className="text-base font-semibold leading-6 text-foreground">Default prompts</h2>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              View built-in prompt text and save local overrides for future agent runs.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              clearUserPrompts();
              const builtInPrompt = getDefaultPromptDefinition(draftPromptId);
              setSelectedPromptId(builtInPrompt.id);
              setDraftPromptId(builtInPrompt.id);
              setDraftText(builtInPrompt.defaultText);
            }}
            disabled={overrideCount === 0}
          >
            <RotateCcw size={15} />
            Reset all
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <SlidersHorizontal size={14} className="shrink-0" />
          <span>{overrideCount} prompt override{overrideCount === 1 ? '' : 's'} active</span>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 bg-muted/20 md:grid-cols-[minmax(15rem,0.36fr)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto border-b border-border/70 p-3 md:border-b-0 md:border-r">
          <div className="space-y-1">
            {prompts.map((prompt) => {
              const selected = selectedPromptId === prompt.id;
              const edited = editedPromptIds.has(prompt.id);
              return (
                <button
                  key={prompt.id}
                  type="button"
                  onClick={() => loadPromptDraft(prompt.id)}
                  className={cn(
                    'app-focus-ring flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-[background-color,color,transform] active:scale-[0.99]',
                    selected
                      ? 'bg-background text-foreground shadow-sm ring-1 ring-border/70'
                      : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                  )}
                >
                  <FileText size={15} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium leading-5">{prompt.label}</span>
                      <span className="shrink-0 rounded border border-border/65 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                        {edited ? 'Edited' : 'Built-in'}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                      {prompt.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <section className="flex min-h-0 flex-col bg-background">
          {draftPrompt ? (
            <>
              <div className="shrink-0 border-b border-border/60 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--app-accent))]">
                      Editor
                    </div>
                    <div className="mt-1 truncate text-sm font-semibold text-foreground">
                      {draftPrompt.label}
                    </div>
                    {draftPrompt.variables?.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {draftPrompt.variables.map((variable) => (
                          <span
                            key={variable}
                            className="rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                          >
                            {'{{'}{variable}{'}}'}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <span className="shrink-0 rounded-md border border-border/70 bg-muted/35 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {editedPromptIds.has(draftPrompt.id) ? 'Edited' : 'Built-in'}
                  </span>
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <label className="block space-y-1.5">
                  <span className="text-[11px] font-semibold text-muted-foreground">Prompt text</span>
                  <TextareaAutosize
                    value={draftText}
                    onChange={(event) => setDraftText(event.target.value)}
                    className="min-h-72 w-full resize-y rounded-lg border border-border/70 bg-background/80 px-3 py-2 font-mono text-[11px] leading-5 outline-none transition-[border-color,box-shadow] focus:border-[hsl(var(--app-focus)/0.72)] focus:shadow-[0_0_0_3px_hsl(var(--app-focus)/0.10)]"
                    minRows={14}
                    maxRows={28}
                  />
                </label>

                {editedPromptIds.has(draftPrompt.id) ? (
                  <div className="rounded-lg border border-border/65 bg-muted/30 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Built-in default
                    </div>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-muted-foreground">
                      {draftPrompt.defaultText}
                    </pre>
                  </div>
                ) : null}
                {missingVariables.length > 0 ? (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                    <span>
                      Required variable{missingVariables.length === 1 ? '' : 's'} missing:{' '}
                      {missingVariables.map((variable) => `{{${variable}}}`).join(', ')}
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 p-4">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    deleteUserPrompt(draftPrompt.id);
                    const builtInText = draftPrompt.defaultText;
                    setDraftText(builtInText);
                    setSelectedPromptId(draftPrompt.id);
                  }}
                  disabled={!editedPromptIds.has(draftPrompt.id)}
                >
                  <RotateCcw size={15} />
                  Reset prompt
                </Button>
                <Button
                  type="button"
                  size="sm"
                  data-testid="save-default-prompt-button"
                  onClick={savePromptDraft}
                  disabled={!canSavePrompt}
                >
                  <Check size={15} />
                  Save prompt
                </Button>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
