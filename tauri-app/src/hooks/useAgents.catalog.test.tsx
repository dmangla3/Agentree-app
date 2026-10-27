import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
// @ts-expect-error jsdom ships without a project-local declaration in this workspace.
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeRuntimeModelCatalog, useAgents } from './useAgents';

const cachedModel = {
  id: 'openai/cached',
  providerId: 'openai',
  providerName: 'OpenAI',
  modelId: 'cached',
  name: 'Cached OpenCode Model',
  reasoning: true,
  attachment: false,
  toolCall: true,
  inputModalities: ['text'],
  outputModalities: ['text'],
  variants: [],
  contextWindow: null,
  maxOutputTokens: null,
  releaseDate: null,
  status: 'active',
  isFree: false,
};

let profileState = {
  profiles: [{
    id: 'opencode-profile',
    provider: 'opencode',
    displayName: 'OpenCode',
    authType: 'opencode_auth',
    status: 'ready',
    isDefault: true,
    config: {
      opencode_model_catalog_checked_at: 123,
      opencode_model_catalog: [cachedModel],
    },
  }],
};

vi.mock('../stores/loginProfilesStore', () => ({
  useLoginProfilesStore: (selector: (state: typeof profileState) => unknown) => selector(profileState),
}));

const createWrapper = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: PropsWithChildren) => createElement(
    QueryClientProvider,
    { client },
    children,
  );
};

describe('useAgents OpenCode catalog behavior', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    profileState = {
      profiles: [{
        id: 'opencode-profile',
        provider: 'opencode',
        displayName: 'OpenCode',
        authType: 'opencode_auth',
        status: 'ready',
        isDefault: true,
        config: {
          opencode_model_catalog_checked_at: 123,
          opencode_model_catalog: [cachedModel],
        },
      }],
    };
  });

  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  it('uses the persisted catalog without starting discovery during render', async () => {
    const { result } = renderHook(() => useAgents(), { wrapper: createWrapper() });

    expect(result.current.data?.some((agent) => agent.name === 'Cached OpenCode Model')).toBe(true);
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
  });

  it('uses the shared profile policy and prefers a ready profile over an inactive default', async () => {
    profileState = {
      profiles: [
        {
          id: 'inactive-default',
          provider: 'opencode',
          displayName: 'Inactive default',
          authType: 'opencode_auth',
          status: 'invalid',
          isDefault: true,
          config: {
            opencode_model_catalog_checked_at: 124,
            opencode_model_catalog: [cachedModel],
          },
        },
        {
          id: 'ready-profile',
          provider: 'opencode',
          displayName: 'Ready profile',
          authType: 'opencode_auth',
          status: 'ready',
          isDefault: false,
          config: {
            opencode_model_catalog_checked_at: 125,
            opencode_model_catalog: [
              { ...cachedModel, id: 'openai/ready', modelId: 'ready', name: 'Ready Profile Model' },
            ],
          },
        },
      ],
    };

    const { result } = renderHook(() => useAgents(), { wrapper: createWrapper() });

    expect(result.current.data?.some((agent) => agent.name === 'Ready Profile Model')).toBe(true);
    expect(result.current.data?.some((agent) => agent.name === 'Cached OpenCode Model')).toBe(false);
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
  });

  it('does not expose a stale catalog when no OpenCode profile is ready', async () => {
    profileState = {
      profiles: [{
        id: 'inactive-default',
        provider: 'opencode',
        displayName: 'Inactive default',
        authType: 'opencode_auth',
        status: 'invalid',
        isDefault: true,
        config: {
          opencode_model_catalog_checked_at: 126,
          opencode_model_catalog: [cachedModel],
        },
      }],
    };

    const { result } = renderHook(() => useAgents(), { wrapper: createWrapper() });

    expect(result.current.data?.some((agent) => agent.name === 'Cached OpenCode Model')).toBe(false);
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
  });

  it('replaces provider bootstrap slices and intersects OpenCode access with runtime support', () => {
    const catalog = composeRuntimeModelCatalog({
      supported: [
        {
          provider: 'codex',
          scope: 'supported',
          profileId: 'codex-profile',
          sourceVersion: '1',
          checkedAt: 100,
          models: [{
            provider: 'codex',
            canonicalModelId: 'gpt-6',
            cliModelId: 'gpt-latest',
            name: 'GPT 6',
            supportedReasoningEfforts: ['medium'],
            checkedAt: 100,
          }],
        },
        {
          provider: 'opencode',
          scope: 'supported',
          profileId: null,
          sourceVersion: '1',
          checkedAt: 100,
          models: [{
            provider: 'opencode',
            canonicalModelId: cachedModel.id,
            cliModelId: cachedModel.id,
            name: cachedModel.name,
            checkedAt: 100,
          }],
        },
      ],
      opencodeAccessible: null,
      staleProviders: [],
    }, [
      cachedModel,
      { ...cachedModel, id: 'openai/not-supported', modelId: 'not-supported', name: 'Not Supported' },
    ]);

    expect(catalog.some((model) => model.key === 'codex:gpt-6:medium')).toBe(true);
    expect(catalog.some((model) => model.provider === 'codex' && model.familyKey === 'codex:gpt-5.5')).toBe(false);
    expect(catalog.some((model) => model.label === 'Cached OpenCode Model')).toBe(true);
    expect(catalog.some((model) => model.label === 'Not Supported')).toBe(false);
  });

  it('treats native OpenCode access, including an empty snapshot, as authoritative', () => {
    const supportedModel = {
      provider: 'opencode',
      canonicalModelId: 'openai/native',
      cliModelId: 'openai/native',
      name: 'Native Accessible',
      upstreamProviderId: 'openai',
      providerName: 'OpenAI',
      inputModalities: ['text'],
      outputModalities: ['text'],
      checkedAt: 200,
    };
    const baseCache = {
      supported: [{
        provider: 'opencode',
        scope: 'supported',
        profileId: null,
        sourceVersion: '1',
        checkedAt: 200,
        models: [supportedModel],
      }],
      staleProviders: [],
    };
    const nativeCatalog = composeRuntimeModelCatalog({
      ...baseCache,
      opencodeAccessible: {
        provider: 'opencode',
        scope: 'accessible',
        profileId: 'opencode-profile',
        sourceVersion: '1',
        checkedAt: 200,
        models: [supportedModel],
      },
    }, [cachedModel]);

    expect(nativeCatalog.some((model) => model.label === 'Native Accessible')).toBe(true);
    expect(nativeCatalog.some((model) => model.label === 'Cached OpenCode Model')).toBe(false);

    const emptyCatalog = composeRuntimeModelCatalog({
      ...baseCache,
      opencodeAccessible: {
        provider: 'opencode',
        scope: 'accessible',
        profileId: 'opencode-profile',
        sourceVersion: '1',
        checkedAt: 201,
        models: [],
      },
    }, [cachedModel]);
    expect(emptyCatalog.some((model) => model.provider === 'opencode')).toBe(false);
  });
});
