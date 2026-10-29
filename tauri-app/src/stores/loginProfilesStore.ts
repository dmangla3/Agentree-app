import { create } from 'zustand';
import {
  agentClient,
  type ActiveLoginProfileRun,
  type ClaudeOAuthLoginStart,
  type CodexLoginStart,
  type ImportLoginCandidateRequest,
  type LoginImportCandidate,
  type UpsertLoginProfileRequest,
} from '../lib/agentClient';
import type { LoginProfileSummary } from '../lib/loginProfiles';

interface LoginProfilesState {
  profiles: LoginProfileSummary[];
  activeRunsByProfile: Record<string, ActiveLoginProfileRun[]>;
  isLoading: boolean;
  isMutating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  readOpenCodeAuth: (profileId: string) => Promise<string>;
  startSync: () => () => void;
  saveProfile: (request: UpsertLoginProfileRequest) => Promise<LoginProfileSummary>;
  connectCodexProfile: (profileId: string) => Promise<CodexLoginStart>;
  connectClaudeOauthProfile: (profileId: string) => Promise<ClaudeOAuthLoginStart>;
  pollClaudeOauthProfile: (profileId: string) => Promise<LoginProfileSummary>;
  submitClaudeOauthCode: (profileId: string, code: string) => Promise<LoginProfileSummary>;
  deleteProfile: (profileId: string) => Promise<void>;
  setDefaultProfile: (provider: string, profileId: string | null) => Promise<void>;
  checkProfile: (profileId: string, providers?: string[] | null) => Promise<void>;
  /** Local-only launch eligibility; live provider verification is explicit account management. */
  ensureReady: (profileId: string) => Promise<LoginProfileSummary>;
  checkAllProfiles: () => Promise<void>;
  discoverImportCandidates: () => Promise<LoginImportCandidate[]>;
  importCandidate: (request: ImportLoginCandidateRequest) => Promise<void>;
}

const messageFromError = (error: unknown) => (
  error instanceof Error ? error.message : String(error)
);

let syncRefCount = 0;
let syncUnlisten: (() => void) | null = null;
let syncStarting = false;

export const useLoginProfilesStore = create<LoginProfilesState>((set) => ({
  profiles: [],
  activeRunsByProfile: {},
  isLoading: false,
  isMutating: false,
  error: null,
  refresh: async () => {
    set({ isLoading: true, error: null });
    try {
      const [profiles, activeRuns] = await Promise.all([
        agentClient.listLoginProfiles(),
        agentClient.listActiveLoginProfileRuns(),
      ]);
      const activeRunsByProfile = activeRuns.reduce<Record<string, ActiveLoginProfileRun[]>>((acc, run) => {
        (acc[run.loginProfileId] ||= []).push(run);
        return acc;
      }, {});
      set({
        profiles: profiles as LoginProfileSummary[],
        activeRunsByProfile,
        isLoading: false,
      });
    } catch (error) {
      set({ error: messageFromError(error), isLoading: false });
    }
  },
  readOpenCodeAuth: async (profileId) => agentClient.readOpenCodeLoginProfileAuth(profileId),
  startSync: () => {
    syncRefCount += 1;
    void useLoginProfilesStore.getState().refresh();

    if (!syncUnlisten && !syncStarting) {
      syncStarting = true;
      void agentClient.onLoginProfilesChanged(() => {
        void useLoginProfilesStore.getState().refresh();
      }).then((cleanup) => {
        syncStarting = false;
        if (syncRefCount <= 0) {
          cleanup();
          return;
        }
        syncUnlisten = cleanup;
      }).catch((error) => {
        syncStarting = false;
        set({ error: messageFromError(error) });
      });
    }

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      syncRefCount = Math.max(0, syncRefCount - 1);
      if (syncRefCount === 0 && syncUnlisten) {
        syncUnlisten();
        syncUnlisten = null;
      }
    };
  },
  saveProfile: async (request) => {
    set({ isMutating: true, error: null });
    try {
      const profile = await agentClient.upsertLoginProfile(request);
      await useLoginProfilesStore.getState().refresh();
      return profile as LoginProfileSummary;
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    } finally {
      set({ isMutating: false });
    }
  },
  connectCodexProfile: async (profileId) => {
    set({ isMutating: true, error: null });
    try {
      const started = await agentClient.connectCodexLoginProfile(profileId);
      await useLoginProfilesStore.getState().refresh();
      return started;
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    } finally {
      set({ isMutating: false });
    }
  },
  connectClaudeOauthProfile: async (profileId) => {
    set({ isMutating: true, error: null });
    try {
      const started = await agentClient.connectClaudeOauthLoginProfile(profileId);
      await useLoginProfilesStore.getState().refresh();
      return started;
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    } finally {
      set({ isMutating: false });
    }
  },
  pollClaudeOauthProfile: async (profileId) => {
    try {
      const profile = await agentClient.pollClaudeOauthLoginProfile(profileId);
      await useLoginProfilesStore.getState().refresh();
      return profile as LoginProfileSummary;
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    }
  },
  submitClaudeOauthCode: async (profileId, code) => {
    set({ isMutating: true, error: null });
    try {
      const profile = await agentClient.submitClaudeOauthLoginCode(profileId, code);
      await useLoginProfilesStore.getState().refresh();
      return profile as LoginProfileSummary;
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    } finally {
      set({ isMutating: false });
    }
  },
  deleteProfile: async (profileId) => {
    set({ isMutating: true, error: null });
    try {
      await agentClient.deleteLoginProfile(profileId);
      await useLoginProfilesStore.getState().refresh();
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    } finally {
      set({ isMutating: false });
    }
  },
  setDefaultProfile: async (provider, profileId) => {
    set({ isMutating: true, error: null });
    try {
      const profiles = await agentClient.setDefaultLoginProfile(provider, profileId);
      set({ profiles: profiles as LoginProfileSummary[] });
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    } finally {
      set({ isMutating: false });
    }
  },
  checkProfile: async (profileId, providers = null) => {
    set({ isMutating: true, error: null });
    try {
      await agentClient.checkLoginProfileReadiness(profileId, providers);
      await useLoginProfilesStore.getState().refresh();
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    } finally {
      set({ isMutating: false });
    }
  },
  ensureReady: async (profileId) => {
    try {
      const profile = await agentClient.ensureLoginProfileReady(profileId);
      set((state) => ({
        profiles: state.profiles.map((item) => (
          item.id === profile.id ? profile as LoginProfileSummary : item
        )),
      }));
      return profile as LoginProfileSummary;
    } catch (error) {
      set({ error: messageFromError(error) });
      await useLoginProfilesStore.getState().refresh();
      throw error;
    }
  },
  checkAllProfiles: async () => {
    set({ isMutating: true, error: null });
    try {
      await agentClient.checkAllLoginProfileReadiness();
      await useLoginProfilesStore.getState().refresh();
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    } finally {
      set({ isMutating: false });
    }
  },
  discoverImportCandidates: async () => {
    set({ isMutating: true, error: null });
    try {
      return await agentClient.discoverLoginImportCandidates();
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    } finally {
      set({ isMutating: false });
    }
  },
  importCandidate: async (request) => {
    set({ isMutating: true, error: null });
    try {
      await agentClient.importDiscoveredLoginProfile(request);
      await useLoginProfilesStore.getState().refresh();
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    } finally {
      set({ isMutating: false });
    }
  },
}));
