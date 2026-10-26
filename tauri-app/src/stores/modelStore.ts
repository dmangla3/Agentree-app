import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createBestEffortStorage } from '../lib/bestEffortStorage';
import type { RuntimeProvider } from '../lib/runtimeModels';

// --- Interfaces ---

// Local runtime model metadata used for filtering/search UI.
export interface RuntimeCatalogModel {
  id: string;
  name: string;
  description: string | null;
  pricing: {
    prompt: string; // Price per prompt token, as string
    completion: string; // Price per completion token, as string
    request: string; // Price per request, as string
    image: string; // Price per image, as string
  };
  context_length: number | null;
  architecture: {
    modality: string;
    tokenizer: string;
    instruct_type: string | null;
    input_modalities?: string[]; // Added based on sample
    output_modalities?: string[]; // Added based on sample
  };
  top_provider: {
    max_completion_tokens: number | null;
    is_moderated?: boolean; // Added based on sample
  };
  per_request_limits: object | null;
  created?: number; // Added based on sample
  // Add simple derived properties for easier use
  isFree?: boolean;
  supportsImageInput?: boolean;
}

// Sorting options
export type SortField = 'name' | 'created' | 'promptPrice' | 'completionPrice';
export type SortDirection = 'asc' | 'desc';

interface ModelState {
  favorites: Set<string>; // Set of favorite model IDs
  searchTerm: string;
  filterFree: boolean;
  filterImage: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
  visibleFamilyKeysByProvider: Partial<Record<RuntimeProvider, string[]>>;

  // Actions
  setSearchTerm: (term: string) => void;
  setFilterFree: (value: boolean) => void;
  setFilterImage: (value: boolean) => void;
  setSort: (field: SortField, direction: SortDirection) => void;
  toggleFavorite: (modelId: string) => void;
  setVisibleFamilyKeys: (provider: RuntimeProvider, familyKeys: string[] | null) => void;
}

export const isModelFamilyVisible = (
  visibleFamilyKeysByProvider: ModelState['visibleFamilyKeysByProvider'],
  provider: RuntimeProvider,
  familyKey: string,
) => visibleFamilyKeysByProvider[provider]?.includes(familyKey) ?? true;

// --- Zustand Store Definition ---
export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      // --- Initial State ---
      favorites: new Set<string>(),
      searchTerm: '',
      filterFree: false,
      filterImage: false,
      sortField: 'name',
      sortDirection: 'asc',
      visibleFamilyKeysByProvider: {},

      // --- Actions ---
      setSearchTerm: (term: string) => set({ searchTerm: term }),
      setFilterFree: (value: boolean) => set({ filterFree: value }),
      setFilterImage: (value: boolean) => set({ filterImage: value }),
      setSort: (field: SortField, direction: SortDirection) => set({ sortField: field, sortDirection: direction }),

      toggleFavorite: (modelId: string) => {
        set((state) => {
          const newFavorites = new Set(state.favorites);
          if (newFavorites.has(modelId)) {
            newFavorites.delete(modelId);
            console.log(`[ModelStore] Removed favorite: ${modelId}`);
          } else {
            newFavorites.add(modelId);
            console.log(`[ModelStore] Added favorite: ${modelId}`);
          }
          return { favorites: newFavorites };
        });
      },
      setVisibleFamilyKeys: (provider, familyKeys) => set((state) => {
        const next = { ...state.visibleFamilyKeysByProvider };
        if (familyKeys === null) {
          delete next[provider];
        } else {
          next[provider] = Array.from(new Set(familyKeys));
        }
        return { visibleFamilyKeysByProvider: next };
      }),
    }),
    {
      name: 'model-storage', // Local storage key
      partialize: (state) => ({
        favorites: Array.from(state.favorites), // Persist favorites as an array
        visibleFamilyKeysByProvider: state.visibleFamilyKeysByProvider,
      }),
      storage: createJSONStorage(() => createBestEffortStorage(() => localStorage)),
      // Rehydrate Set from array
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.favorites = new Set(state.favorites);
          console.log('[ModelStore] Rehydrated favorites:', state.favorites);
        }
      },
    }
  )
);
