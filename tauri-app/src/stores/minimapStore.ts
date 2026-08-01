import { create } from 'zustand';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type MinimapPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

interface MinimapState {
    // Visibility and expansion
    isVisible: boolean;
    isExpanded: boolean;  // Full-screen expanded mode

    // Corner position when minimized
    position: MinimapPosition;

    // Actions
    toggleVisible: () => void;
    setVisible: (visible: boolean) => void;
    toggleExpanded: () => void;
    setExpanded: (expanded: boolean) => void;
    setPosition: (pos: MinimapPosition) => void;
    reset: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// INITIAL STATE
// ═══════════════════════════════════════════════════════════════════════════

const initialState = {
    isVisible: true,
    isExpanded: false,
    position: 'bottom-right' as MinimapPosition,
};

// ═══════════════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════════════

export const useMinimapStore = create<MinimapState>((set) => ({
    ...initialState,

    toggleVisible: () => set((s) => ({ isVisible: !s.isVisible })),

    setVisible: (visible: boolean) => set({ isVisible: visible }),

    toggleExpanded: () => set((s) => ({ isExpanded: !s.isExpanded })),

    setExpanded: (expanded: boolean) => set({ isExpanded: expanded }),

    setPosition: (position: MinimapPosition) => set({ position }),

    reset: () => set(initialState),
}));
