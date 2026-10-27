import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createBestEffortStorage } from '../lib/bestEffortStorage';
import {
  bootstrapRuntimeModels,
  type RuntimeProvider,
} from '../lib/runtimeModels';

// Compatibility export for graph/search surfaces. The model domain itself
// lives in runtimeModels.ts rather than this UI preference store.
export type { RuntimeCatalogModel } from '../lib/runtimeModels';

type VisibleFamilyKeysByProvider = Partial<Record<RuntimeProvider, string[]>>;

interface ModelState {
  // Desired user choices. Keys that temporarily disappear from the effective
  // catalog remain here as tombstones and can become visible again later.
  visibleFamilyKeysByProvider: VisibleFamilyKeysByProvider;
  initializeVisibleFamilyKeys: (provider: RuntimeProvider, familyKeys: string[]) => void;
  setVisibleFamilyKeys: (provider: RuntimeProvider, familyKeys: string[]) => void;
}

const uniqueFamilyKeys = (familyKeys: readonly string[]) => Array.from(new Set(familyKeys));

const bootstrapVisibleFamilyKeys = (): VisibleFamilyKeysByProvider => {
  const byProvider: VisibleFamilyKeysByProvider = {};
  for (const provider of ['codex', 'claude'] as const) {
    byProvider[provider] = uniqueFamilyKeys(
      bootstrapRuntimeModels
        .filter((model) => model.provider === provider)
        .map((model) => model.familyKey),
    );
  }
  return byProvider;
};

export const isModelFamilyVisible = (
  visibleFamilyKeysByProvider: VisibleFamilyKeysByProvider,
  provider: RuntimeProvider,
  familyKey: string,
) => visibleFamilyKeysByProvider[provider]?.includes(familyKey) === true;

export const getEffectiveVisibleFamilyKeys = (
  desiredFamilyKeys: readonly string[] | undefined,
  currentCatalogFamilyKeys: readonly string[],
) => {
  if (!desiredFamilyKeys) return [];
  const currentKeys = new Set(currentCatalogFamilyKeys);
  return desiredFamilyKeys.filter((familyKey) => currentKeys.has(familyKey));
};

const initialVisibleFamilyKeys = bootstrapVisibleFamilyKeys();

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      visibleFamilyKeysByProvider: initialVisibleFamilyKeys,
      initializeVisibleFamilyKeys: (provider, familyKeys) => set((state) => {
        if (state.visibleFamilyKeysByProvider[provider] !== undefined) return state;
        return {
          visibleFamilyKeysByProvider: {
            ...state.visibleFamilyKeysByProvider,
            [provider]: uniqueFamilyKeys(familyKeys),
          },
        };
      }),
      setVisibleFamilyKeys: (provider, familyKeys) => set((state) => ({
        visibleFamilyKeysByProvider: {
          ...state.visibleFamilyKeysByProvider,
          [provider]: uniqueFamilyKeys(familyKeys),
        },
      })),
    }),
    {
      name: 'model-storage',
      version: 1,
      partialize: (state) => ({
        visibleFamilyKeysByProvider: state.visibleFamilyKeysByProvider,
      }),
      migrate: (persistedState) => {
        const persisted = (persistedState && typeof persistedState === 'object')
          ? persistedState as Partial<ModelState>
          : {};
        return {
          ...persisted,
          visibleFamilyKeysByProvider: {
            ...initialVisibleFamilyKeys,
            ...(persisted.visibleFamilyKeysByProvider ?? {}),
          },
        } as ModelState;
      },
      storage: createJSONStorage(() => createBestEffortStorage(() => localStorage)),
    },
  ),
);
