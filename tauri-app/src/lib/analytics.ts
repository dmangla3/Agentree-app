import type * as Amplitude from '@amplitude/analytics-browser';

type AnalyticsProperties = Record<string, string | number | boolean | null | undefined>;

interface AnalyticsUser {
  id: string;
  email?: string | null;
}

let initialized = false;
let amplitude: typeof Amplitude | null = null;
let warnedMissingKey = false;
let lastIdentifiedUserId: string | null = null;

const parseBoolean = (value: unknown): boolean =>
  ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

const parseSampleRate = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
};

const isAnalyticsDisabled = () =>
  import.meta.env.VITE_AGENTREE_OFFICIAL_CLOUD !== 'true' ||
  parseBoolean(import.meta.env.VITE_AMPLITUDE_DISABLED) ||
  parseBoolean(import.meta.env.VITE_ANALYTICS_DISABLED);

const getEmailDomain = (email?: string | null): string | null => {
  const domain = email?.split('@')[1]?.trim().toLowerCase();
  return domain || null;
};

const getAppVersion = (): string => import.meta.env.VITE_APP_VERSION || '0.1.0';

export async function initAnalytics(): Promise<void> {
  if (initialized || isAnalyticsDisabled()) return;

  const apiKey = import.meta.env.VITE_AMPLITUDE_API_KEY?.trim();
  if (!apiKey) {
    if (import.meta.env.DEV && !warnedMissingKey) {
      console.info('[analytics] Amplitude disabled: VITE_AMPLITUDE_API_KEY is not set.');
      warnedMissingKey = true;
    }
    return;
  }

  const replaySampleRate = parseSampleRate(import.meta.env.VITE_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE);
  amplitude = await import('@amplitude/analytics-browser');

  if (replaySampleRate > 0) {
    const { sessionReplayPlugin } = await import('@amplitude/plugin-session-replay-browser');
    amplitude.add(sessionReplayPlugin({
      sampleRate: replaySampleRate,
      privacyConfig: {
        defaultMaskLevel: 'conservative',
        blockSelector: ['.amp-block', '[data-analytics-block="true"]'],
      },
    }));
  }

  amplitude.init(apiKey, {
    appVersion: getAppVersion(),
    defaultTracking: {
      attribution: false,
      fileDownloads: false,
      formInteractions: false,
      pageViews: false,
      sessions: true,
    },
  });

  initialized = true;
  track('App Launched', {
    app_context: 'tauri',
    app_version: getAppVersion(),
    session_replay_enabled: replaySampleRate > 0,
    session_replay_sample_rate: replaySampleRate,
  });
}

export function track(eventName: string, properties: AnalyticsProperties = {}): void {
  if (!initialized || !amplitude || isAnalyticsDisabled()) return;
  amplitude.track(eventName, {
    app_context: 'tauri',
    ...properties,
  });
}

export function identifyUser(user: AnalyticsUser | null): void {
  if (!initialized || !amplitude || isAnalyticsDisabled()) return;

  if (!user?.id) {
    lastIdentifiedUserId = null;
    amplitude.reset();
    return;
  }

  amplitude.setUserId(user.id);
  if (lastIdentifiedUserId === user.id) return;

  const identify = new amplitude.Identify();
  const emailDomain = getEmailDomain(user.email);
  if (emailDomain) {
    identify.set('email_domain', emailDomain);
  }
  identify.set('app_context', 'tauri');
  identify.set('app_version', getAppVersion());
  amplitude.identify(identify);
  lastIdentifiedUserId = user.id;
}

export function trackScreenViewed(screen: string, properties: AnalyticsProperties = {}): void {
  track('Screen Viewed', { screen, ...properties });
}

export function trackOnboardingStepViewed(step: string): void {
  track('Onboarding Step Viewed', { step });
}

export function trackWorkspaceCreated(source: string, properties: AnalyticsProperties = {}): void {
  track('Workspace Created', { source, ...properties });
}

export function trackAgentRunStarted(properties: AnalyticsProperties = {}): void {
  track('Agent Run Started', properties);
}

export function trackAgentRunCompleted(properties: AnalyticsProperties = {}): void {
  track('Agent Run Completed', properties);
}

export function trackAgentRunFailed(properties: AnalyticsProperties = {}): void {
  track('Agent Run Failed', properties);
}
