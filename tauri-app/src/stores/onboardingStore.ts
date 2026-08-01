import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface OnboardingRecord {
  completedAt: string;
  workspaceId?: string | null;
}

interface OnboardingState {
  completedByUserId: Record<string, OnboardingRecord>;
  hasCompletedForUser: (userId: string | null | undefined) => boolean;
  markCompleted: (userId: string, workspaceId?: string | null) => void;
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      completedByUserId: {},
      hasCompletedForUser: (userId) => {
        if (!userId) return false;
        return Boolean(get().completedByUserId[userId]);
      },
      markCompleted: (userId, workspaceId = null) =>
        set((state) => ({
          completedByUserId: {
            ...state.completedByUserId,
            [userId]: {
              completedAt: new Date().toISOString(),
              workspaceId,
            },
          },
        })),
    }),
    {
      name: 'onboarding-storage',
    }
  )
);
