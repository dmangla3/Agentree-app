import { create } from 'zustand';

interface User {
  id: string;
  email: string;
  name: string;
  pictureUrl?: string;
}

interface DesktopAuthSession {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

interface AuthState {
  user: User | null;
  desktopSession: DesktopAuthSession | null;
  authErrorReason: string | null;
  setUser: (user: User | null) => void;
  setDesktopSession: (session: DesktopAuthSession | null) => void;
  setAuthErrorReason: (reason: string | null) => void;
  clearAuthErrorReason: () => void;
  clearSession: () => void;
  markSessionExpired: (reason?: string) => void;
}

if (typeof window !== 'undefined' && window.localStorage) {
  window.localStorage.removeItem('auth-storage');
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  desktopSession: null,
  authErrorReason: null,

  setUser: (user: User | null) => set({ user }),

  setDesktopSession: (session: DesktopAuthSession | null) => set({ desktopSession: session }),

  setAuthErrorReason: (reason: string | null) => set({ authErrorReason: reason }),

  clearAuthErrorReason: () => {
    set({ authErrorReason: null });
  },

  clearSession: () => {
    set({ user: null, desktopSession: null, authErrorReason: null });
  },

  markSessionExpired: (reason?: string) => {
    set({
      authErrorReason: reason || 'Your session has expired. Please log in again.',
      user: null,
      desktopSession: null
    });
  }
}));
