import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createBestEffortStorage } from '../lib/bestEffortStorage';
import { commands as tauriCommands } from '../generated/tauri-bindings';
import {
  getEffectiveDefaultPromptText as renderEffectiveDefaultPromptText,
  isDefaultPromptId,
  mergeDefaultPromptOverrides,
  normalizeDefaultPromptOverrides,
  type DefaultPromptId,
  type DefaultPromptOverride,
  type EffectiveDefaultPrompt,
} from '../lib/prompts/defaultPrompts';

interface DefaultPromptState {
  userPrompts: DefaultPromptOverride[];
  prompts: EffectiveDefaultPrompt[];
  upsertUserPrompt: (prompt: DefaultPromptOverride) => void;
  deleteUserPrompt: (promptId: DefaultPromptId) => void;
  clearUserPrompts: () => void;
}

const persistNativeUserPrompts = (prompts: DefaultPromptOverride[]): void => {
  void tauriCommands.saveDefaultPromptOverrides(JSON.stringify(prompts)).catch(() => undefined);
};

let nativeHydrationStarted = false;

export const hydrateNativeDefaultPromptOverrides = async (): Promise<void> => {
  const raw = await tauriCommands.getDefaultPromptOverrides().catch(() => null);
  if (!raw) {
    persistNativeUserPrompts(useDefaultPromptStore.getState().userPrompts);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    persistNativeUserPrompts(useDefaultPromptStore.getState().userPrompts);
    return;
  }
  if (!Array.isArray(parsed)) {
    persistNativeUserPrompts(useDefaultPromptStore.getState().userPrompts);
    return;
  }

  const userPrompts = normalizeDefaultPromptOverrides(parsed as DefaultPromptOverride[]);
  useDefaultPromptStore.setState({
    userPrompts,
    prompts: mergeDefaultPromptOverrides(userPrompts),
  });
};

export const useDefaultPromptStore = create<DefaultPromptState>()(
  persist(
    (set) => ({
      userPrompts: [],
      prompts: mergeDefaultPromptOverrides([]),
      upsertUserPrompt: (prompt) => set((state) => {
        const [normalized] = normalizeDefaultPromptOverrides([prompt]);
        if (!normalized) {
          if (!isDefaultPromptId(prompt.id)) return state;
          const nextUserPrompts = state.userPrompts.filter((candidate) => candidate.id !== prompt.id);
          persistNativeUserPrompts(nextUserPrompts);
          return {
            userPrompts: nextUserPrompts,
            prompts: mergeDefaultPromptOverrides(nextUserPrompts),
          };
        }
        const nextUserPrompts = [
          ...state.userPrompts.filter((candidate) => candidate.id !== normalized.id),
          normalized,
        ];
        persistNativeUserPrompts(nextUserPrompts);
        return {
          userPrompts: nextUserPrompts,
          prompts: mergeDefaultPromptOverrides(nextUserPrompts),
        };
      }),
      deleteUserPrompt: (promptId) => set((state) => {
        const nextUserPrompts = state.userPrompts.filter((prompt) => prompt.id !== promptId);
        persistNativeUserPrompts(nextUserPrompts);
        return {
          userPrompts: nextUserPrompts,
          prompts: mergeDefaultPromptOverrides(nextUserPrompts),
        };
      }),
      clearUserPrompts: () => set(() => {
        persistNativeUserPrompts([]);
        return {
          userPrompts: [],
          prompts: mergeDefaultPromptOverrides([]),
        };
      }),
    }),
    {
      name: 'default-prompt-storage',
      storage: createJSONStorage(() => createBestEffortStorage(() => localStorage)),
      partialize: (state) => ({
        userPrompts: state.userPrompts,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.userPrompts = normalizeDefaultPromptOverrides(state.userPrompts);
        state.prompts = mergeDefaultPromptOverrides(state.userPrompts);
        if (!nativeHydrationStarted) {
          nativeHydrationStarted = true;
          void hydrateNativeDefaultPromptOverrides();
        }
      },
    },
  ),
);

export const getDefaultPromptOverridesSnapshot = (): DefaultPromptOverride[] => (
  useDefaultPromptStore.getState().userPrompts
);

export const getEffectiveDefaultPromptText = (
  id: DefaultPromptId,
  variables: Record<string, string> = {},
): string => {
  return renderEffectiveDefaultPromptText(id, getDefaultPromptOverridesSnapshot(), variables);
};
