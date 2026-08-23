import { IssuerRouteTypes, PromptTypes, generateAuthUrl } from '@kinde/js-utils';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useAuthStore } from '../stores/authStore';
import { configureDesktopAuthSession } from './authSession';

type AuthIntent = 'login' | 'register';

type PendingDesktopAuth = {
  codeVerifier: string;
  createdAt: number;
  intent: AuthIntent;
  redirectUri: string;
  state: string;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
};

const DEFAULT_AUTH_CALLBACK_URL = 'http://127.0.0.1:34117/kinde/callback';
const DESKTOP_AUTH_PENDING_KEY = 'agentree.desktop-auth.pending';
const DESKTOP_AUTH_MAX_AGE_MS = 10 * 60 * 1000;
const UPSTREAM_ACCOUNT_SELECTION_PROMPT = 'select_account' as PromptTypes;

let kindeRedirectUriCache = import.meta.env.VITE_KINDE_REDIRECT_URI || DEFAULT_AUTH_CALLBACK_URL;
let deepLinkListenerInitialized = false;

const getKindeDomain = () => import.meta.env.VITE_KINDE_DOMAIN;
const getKindeClientId = () => import.meta.env.VITE_KINDE_CLIENT_ID;

const ensureDesktopAuthConfig = () => {
  const domain = getKindeDomain();
  const clientId = getKindeClientId();
  if (!domain || !clientId) {
    throw new Error('Kinde auth is missing VITE_KINDE_DOMAIN or VITE_KINDE_CLIENT_ID');
  }
  return { clientId, domain };
};

const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return atob(padded);
};

const decodeJwtPayload = <T>(token: string): T | null => {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    return JSON.parse(decodeBase64Url(parts[1])) as T;
  } catch (error) {
    console.error('[Auth] Failed to decode JWT payload:', error);
    return null;
  }
};

const serializePendingDesktopAuth = (value: PendingDesktopAuth) => {
  localStorage.setItem(DESKTOP_AUTH_PENDING_KEY, JSON.stringify(value));
};

const readPendingDesktopAuth = (): PendingDesktopAuth | null => {
  const raw = localStorage.getItem(DESKTOP_AUTH_PENDING_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PendingDesktopAuth;
    if ((Date.now() - parsed.createdAt) > DESKTOP_AUTH_MAX_AGE_MS) {
      localStorage.removeItem(DESKTOP_AUTH_PENDING_KEY);
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('[Auth] Failed to parse pending desktop auth state:', error);
    localStorage.removeItem(DESKTOP_AUTH_PENDING_KEY);
    return null;
  }
};

const clearPendingDesktopAuth = () => {
  localStorage.removeItem(DESKTOP_AUTH_PENDING_KEY);
};

const toSha256Base64Url = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = Array.from(new Uint8Array(digest));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const randomHex = (length: number) => {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
};

const hasAuthCallbackParams = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.has('code') || parsed.searchParams.has('error');
  } catch {
    return false;
  }
};

const isKindeRedirectUrl = (url: string) => (
  url.startsWith(getKindeRedirectUri()) && hasAuthCallbackParams(url)
);

const persistDesktopSession = (tokens: {
  accessToken: string;
  expiresAt: number | null;
  idToken: string;
  refreshToken: string;
}) => {
  const payload = decodeJwtPayload<{
    email?: string;
    given_name?: string;
    picture?: string;
    sub?: string;
  }>(tokens.idToken);

  useAuthStore.getState().setDesktopSession({
    accessToken: tokens.accessToken,
    idToken: tokens.idToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });
  useAuthStore.getState().setUser({
    id: payload?.sub || '',
    email: payload?.email || '',
    name: payload?.given_name || payload?.email || '',
    pictureUrl: payload?.picture || undefined,
  });
  useAuthStore.getState().clearAuthErrorReason();
};

const clearDesktopSession = () => {
  clearPendingDesktopAuth();
  useAuthStore.getState().clearSession();
};

const buildDesktopLogoutRedirectUri = () => {
  const url = new URL(getKindeRedirectUri());
  url.searchParams.set('agentree_action', 'logout');
  return url.toString();
};

const ensureKindeCallbackServerStarted = async () => {
  if (!shouldUseDesktopBrowserAuth()) return getKindeRedirectUri();
  kindeRedirectUriCache = await invoke<string>('ensure_auth_callback_server_started');
  return kindeRedirectUriCache;
};

const openDesktopLogoutInBrowser = async () => {
  const domain = getKindeDomain();
  await ensureKindeCallbackServerStarted();
  const logoutUri = buildDesktopLogoutRedirectUri();
  if (domain) {
    await openUrl(`${domain}/logout?redirect=${encodeURIComponent(logoutUri)}`);
  }
};

const exchangeAuthorizationCode = async (params: {
  clientId: string;
  code: string;
  codeVerifier: string;
  domain: string;
  redirectUri: string;
}): Promise<TokenResponse> => {
  const body = new URLSearchParams({
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: params.redirectUri,
  });

  const response = await fetch(`${params.domain}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  return await response.json() as TokenResponse;
};

const refreshDesktopTokens = async (forceRefresh = false) => {
  const { desktopSession, markSessionExpired, setDesktopSession } = useAuthStore.getState();
  if (!desktopSession) return undefined;

  const expiresAt = desktopSession.expiresAt ?? 0;
  if (!forceRefresh && expiresAt > (Date.now() + 30_000)) {
    return desktopSession.accessToken;
  }

  const { clientId, domain } = ensureDesktopAuthConfig();
  const response = await fetch(`${domain}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: desktopSession.refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('[Auth] Desktop token refresh failed:', text);
    markSessionExpired('Your session has expired. Please log in again.');
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const refreshed = await response.json() as TokenResponse;
  const nextAccessToken = refreshed.access_token || desktopSession.accessToken;
  const nextIdToken = refreshed.id_token || desktopSession.idToken;
  const nextRefreshToken = refreshed.refresh_token || desktopSession.refreshToken;
  const nextExpiresAt = typeof refreshed.expires_in === 'number'
    ? Date.now() + (refreshed.expires_in * 1000)
    : desktopSession.expiresAt;

  setDesktopSession({
    accessToken: nextAccessToken,
    idToken: nextIdToken,
    refreshToken: nextRefreshToken,
    expiresAt: nextExpiresAt,
  });
  persistDesktopSession({
    accessToken: nextAccessToken,
    idToken: nextIdToken,
    refreshToken: nextRefreshToken,
    expiresAt: nextExpiresAt,
  });

  return nextAccessToken;
};

const completeDesktopLogin = async (callbackUrl: string) => {
  const { clientId, domain } = ensureDesktopAuthConfig();
  const url = new URL(callbackUrl);
  const error = url.searchParams.get('error');
  if (error) {
    const errorDescription = url.searchParams.get('error_description');
    throw new Error(errorDescription || error);
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  if (!code || !returnedState) {
    throw new Error('Missing code or state in browser callback.');
  }

  const pending = readPendingDesktopAuth();
  if (!pending) {
    throw new Error('Desktop browser authentication expired before the callback completed.');
  }
  if (pending.state !== returnedState) {
    throw new Error('Desktop browser authentication state did not match the callback.');
  }

  const tokens = await exchangeAuthorizationCode({
    clientId,
    code,
    codeVerifier: pending.codeVerifier,
    domain,
    redirectUri: pending.redirectUri,
  });

  if (!tokens.access_token || !tokens.id_token || !tokens.refresh_token) {
    throw new Error('Kinde token response was missing required tokens.');
  }

  const expiresAt = typeof tokens.expires_in === 'number'
    ? Date.now() + (tokens.expires_in * 1000)
    : null;

  persistDesktopSession({
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
  });
  clearPendingDesktopAuth();
};

const routeKindeCallbackUrl = async (url: string) => {
  if (!isKindeRedirectUrl(url)) return;

  try {
    await completeDesktopLogin(url);
    window.history.replaceState({}, document.title, '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  } catch (error) {
    console.error('[Auth] Failed to finish desktop browser auth:', error);
    clearDesktopSession();
    useAuthStore.getState().setAuthErrorReason(
      error instanceof Error ? error.message : 'Could not finish browser authentication. Please try again.',
    );
  }
};

const configureDesktopAuthRuntime = () => {
  configureDesktopAuthSession({
    getToken: async (options) => refreshDesktopTokens(!!options?.forceRefresh),
    logout: async () => {
      clearDesktopSession();
    },
  });
};

export const isTauriRuntime = () => (
  typeof window !== 'undefined' && (
    isTauri() ||
    '__TAURI_INTERNALS__' in window ||
    '__TAURI__' in window
  )
);

export const shouldUseDesktopBrowserAuth = () => (
  isTauriRuntime()
);

export const isDesktopBrowserAuthenticated = () => {
  const { user, desktopSession } = useAuthStore.getState();
  return shouldUseDesktopBrowserAuth() && !!user && !!desktopSession;
};

export const getKindeRedirectUri = () => kindeRedirectUriCache;

export const initKindeDeepLinkHandler = async () => {
  if (!shouldUseDesktopBrowserAuth()) return;
  if (deepLinkListenerInitialized) return;

  try {
    kindeRedirectUriCache = await invoke<string>('get_auth_callback_base_url');
  } catch (error) {
    console.warn('[Auth] Falling back to default Kinde callback URL:', error);
  }

  deepLinkListenerInitialized = true;
  configureDesktopAuthRuntime();

  await listen<string>('kinde-auth-callback', (event) => {
    routeKindeCallbackUrl(event.payload).catch((error) => {
      console.error('[Auth] Failed to process Kinde callback:', error);
      useAuthStore.getState().setAuthErrorReason('Could not finish browser authentication. Please try again.');
    });
  });
};

export const openKindeAuthInSystemBrowser = async (intent: AuthIntent) => {
  const { clientId, domain } = ensureDesktopAuthConfig();
  const redirectURL = await ensureKindeCallbackServerStarted();
  const codeVerifier = randomHex(52);
  const state = randomHex(32);
  const codeChallenge = await toSha256Base64Url(codeVerifier);

  serializePendingDesktopAuth({
    codeVerifier,
    createdAt: Date.now(),
    intent,
    redirectUri: redirectURL,
    state,
  });

  const authUrl = await generateAuthUrl(
    domain,
    intent === 'register' ? IssuerRouteTypes.register : IssuerRouteTypes.login,
    {
      clientId,
      codeChallenge,
      redirectURL,
      state,
      supportsReauth: true,
      prompt: intent === 'register' ? PromptTypes.create : UPSTREAM_ACCOUNT_SELECTION_PROMPT,
    },
  );

  authUrl.url.searchParams.forEach((value, key) => {
    if (!value) {
      authUrl.url.searchParams.delete(key);
    }
  });

  await openUrl(authUrl.url.toString());
};

export const logoutDesktopBrowserAuth = async () => {
  clearDesktopSession();
  await openDesktopLogoutInBrowser();
};
