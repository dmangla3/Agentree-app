import { create } from 'zustand';
import {
  agentClient,
  type ActiveLoginProfileRun,
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
  saveProfile: (request: UpsertLoginProfileRequest) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  setDefaultProfile: (provider: string, profileId: string | null) => Promise<void>;
  checkProfile: (profileId: string) => Promise<void>;
  checkAllProfiles: () => Promise<void>;
  discoverImportCandidates: () => Promise<LoginImportCandidate[]>;
  importCandidate: (request: ImportLoginCandidateRequest) => Promise<void>;
}

const messageFromError = (error: unknown) => (
  error instanceof Error ? error.message : String(error)
);

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
  saveProfile: async (request) => {
    set({ isMutating: true, error: null });
    try {
      await agentClient.upsertLoginProfile(request);
      await useLoginProfilesStore.getState().refresh();
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
  checkProfile: async (profileId) => {
    set({ isMutating: true, error: null });
    try {
      await agentClient.checkLoginProfileReadiness(profileId);
      await useLoginProfilesStore.getState().refresh();
    } catch (error) {
      set({ error: messageFromError(error) });
      throw error;
    } finally {
      set({ isMutating: false });
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
