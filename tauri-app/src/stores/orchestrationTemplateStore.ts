import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createBestEffortStorage } from '../lib/bestEffortStorage';
import { commands as tauriCommands } from '../generated/tauri-bindings';
import {
  buildTemplateRegistry,
  DEFAULT_ORCHESTRATION_TEMPLATES,
  normalizeTemplateId,
  type OrchestrationPromptTemplate,
} from '../orchestration/templates';

interface OrchestrationTemplateState {
  userTemplates: OrchestrationPromptTemplate[];
  templates: OrchestrationPromptTemplate[];
  upsertUserTemplate: (template: OrchestrationPromptTemplate) => void;
  deleteUserTemplate: (templateId: string) => void;
  clearUserTemplates: () => void;
}

const normalizeTemplates = (templates: OrchestrationPromptTemplate[]): OrchestrationPromptTemplate[] => (
  Array.from(buildTemplateRegistry(templates).values())
);

const persistNativeUserTemplates = (templates: OrchestrationPromptTemplate[]): void => {
  void tauriCommands.saveOrchestrationUserTemplates(JSON.stringify(templates)).catch(() => undefined);
};

let nativeHydrationStarted = false;

export const mergeOrchestrationTemplates = (
  userTemplates: OrchestrationPromptTemplate[],
): OrchestrationPromptTemplate[] => normalizeTemplates([
  ...DEFAULT_ORCHESTRATION_TEMPLATES,
  ...userTemplates.map((template) => ({
    ...template,
    source: template.source ?? 'user',
  } satisfies OrchestrationPromptTemplate)),
]);

export const hydrateNativeOrchestrationUserTemplates = async (): Promise<void> => {
  const raw = await tauriCommands.getOrchestrationUserTemplates().catch(() => null);
  if (!raw) {
    persistNativeUserTemplates(useOrchestrationTemplateStore.getState().userTemplates);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    persistNativeUserTemplates(useOrchestrationTemplateStore.getState().userTemplates);
    return;
  }
  if (!Array.isArray(parsed)) {
    persistNativeUserTemplates(useOrchestrationTemplateStore.getState().userTemplates);
    return;
  }

  const userTemplates = normalizeTemplates(parsed as OrchestrationPromptTemplate[]);
  useOrchestrationTemplateStore.setState({
    userTemplates,
    templates: mergeOrchestrationTemplates(userTemplates),
  });
};

export const useOrchestrationTemplateStore = create<OrchestrationTemplateState>()(
  persist(
    (set) => ({
      userTemplates: [],
      templates: mergeOrchestrationTemplates([]),
      upsertUserTemplate: (template) => set((state) => {
        const [normalized] = normalizeTemplates([{ ...template, source: template.source ?? 'user' }]);
        if (!normalized) return state;
        const nextUserTemplates = [
          ...state.userTemplates.filter((candidate) => candidate.id !== normalized.id),
          normalized,
        ];
        persistNativeUserTemplates(nextUserTemplates);
        return {
          userTemplates: nextUserTemplates,
          templates: mergeOrchestrationTemplates(nextUserTemplates),
        };
      }),
      deleteUserTemplate: (templateId) => set((state) => {
        const normalizedId = normalizeTemplateId(templateId);
        if (!normalizedId) return state;
        const nextUserTemplates = state.userTemplates.filter((template) => template.id !== normalizedId);
        persistNativeUserTemplates(nextUserTemplates);
        return {
          userTemplates: nextUserTemplates,
          templates: mergeOrchestrationTemplates(nextUserTemplates),
        };
      }),
      clearUserTemplates: () => {
        persistNativeUserTemplates([]);
        return {
          userTemplates: [],
          templates: mergeOrchestrationTemplates([]),
        };
      },
    }),
    {
      name: 'orchestration-template-storage',
      storage: createJSONStorage(() => createBestEffortStorage(() => localStorage)),
      partialize: (state) => ({
        userTemplates: state.userTemplates,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.userTemplates = normalizeTemplates(state.userTemplates);
        state.templates = mergeOrchestrationTemplates(state.userTemplates);
        if (!nativeHydrationStarted) {
          nativeHydrationStarted = true;
          void hydrateNativeOrchestrationUserTemplates();
        }
      },
    },
  ),
);
