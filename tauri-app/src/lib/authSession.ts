import { useAuthStore } from '../stores/authStore';

type TokenGetter = (options?: { forceRefresh?: boolean }) => Promise<string | undefined>;
type OptionalTokenGetter = () => Promise<string | null | undefined>;
type LogoutHandler = () => Promise<void> | void;

interface AuthRuntimeConfig {
  getToken?: TokenGetter | null;
  logout?: LogoutHandler | null;
}

let tokenGetter: TokenGetter | null = null;
let logoutHandler: LogoutHandler | null = null;
let desktopTokenGetter: TokenGetter | null = null;
let desktopLogoutHandler: LogoutHandler | null = null;
let tokenRequestInFlight: Promise<string> | null = null;
let sessionExpiryInFlight: Promise<void> | null = null;

const isDevBypassEnabled = () => import.meta.env.VITE_DEV_AUTH_BYPASS === 'true';

export const isMissingCloudAuthError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.message === 'No access token available'
    || error.message === 'Authentication is not initialized';
};

const resolveToken = async (options?: { forceRefresh?: boolean }): Promise<string> => {
  if (isDevBypassEnabled()) {
    return 'mock-token';
  }

  if (desktopTokenGetter) {
    const token = await desktopTokenGetter(options);
    if (token) return token;
  }

  if (!tokenGetter) {
    throw new Error('Authentication is not initialized');
  }

  const token = await tokenGetter(options);
  if (!token) {
    throw new Error('No access token available');
  }

  return token;
};

export const configureAuthSession = ({ getToken, logout }: AuthRuntimeConfig) => {
  tokenGetter = getToken ?? null;
  logoutHandler = logout ?? null;
};

export const configureDesktopAuthSession = ({ getToken, logout }: AuthRuntimeConfig) => {
  desktopTokenGetter = getToken ?? null;
  desktopLogoutHandler = logout ?? null;
};

export const getAccessToken = async (options?: { forceRefresh?: boolean }): Promise<string> => {
  if (tokenRequestInFlight && !options?.forceRefresh) {
    return tokenRequestInFlight;
  }

  tokenRequestInFlight = resolveToken(options).finally(() => {
    tokenRequestInFlight = null;
  });

  return tokenRequestInFlight;
};

export const getOptionalCloudAuthToken = async (
  getToken: OptionalTokenGetter = getAccessToken,
): Promise<string> => {
  try {
    return await getToken() ?? '';
  } catch (error) {
    if (isMissingCloudAuthError(error)) return '';
    throw error;
  }
};

export const handleSessionExpired = async (reason?: string) => {
  if (sessionExpiryInFlight) {
    return sessionExpiryInFlight;
  }

  const { markSessionExpired } = useAuthStore.getState();
  sessionExpiryInFlight = (async () => {
    markSessionExpired(reason);
    if (logoutHandler) {
      try {
        await logoutHandler();
      } catch (error) {
        console.warn('[authSession] Logout handler failed during session expiry:', error);
      }
    }
    if (desktopLogoutHandler) {
      try {
        await desktopLogoutHandler();
      } catch (error) {
        console.warn('[authSession] Desktop logout handler failed during session expiry:', error);
      }
    }
  })().finally(() => {
    sessionExpiryInFlight = null;
  });

  return sessionExpiryInFlight;
};

export const logoutCurrentSession = async () => {
  const { clearSession } = useAuthStore.getState();
  clearSession();

  if (logoutHandler) {
    try {
      await logoutHandler();
    } catch (error) {
      console.warn('[authSession] Logout handler failed during logout:', error);
    }
  }

  if (desktopLogoutHandler) {
    try {
      await desktopLogoutHandler();
    } catch (error) {
      console.warn('[authSession] Desktop logout handler failed during logout:', error);
    }
  }
};
