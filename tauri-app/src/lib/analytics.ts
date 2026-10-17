import type * as Amplitude from '@amplitude/analytics-browser';

export type CountBucket = '0' | '1' | '2-5' | '6-20' | '21+';
export type CharacterCountBucket = '0' | '1-100' | '101-500' | '501-2000' | '2001+';
export type AnalyticsFailureCategory = 'aborted' | 'network' | 'runtime' | 'unknown';

type EmptyProperties = Record<string, never>;

interface AnalyticsEventProperties {
  'App Launched': { app_version: string };
  'Screen Viewed': {
    screen: 'login' | 'workspace' | 'onboarding';
    active_view?: string;
    has_workspace?: boolean;
    workspace_count_bucket?: CountBucket;
  };
  'Onboarding Step Viewed': { step: string };
  'Onboarding Environment Checked': {
    git_installed: boolean;
    codex_authenticated: boolean;
    codex_readiness_status: string;
    claude_authenticated: boolean;
    claude_readiness_status: string;
  };
  'Onboarding Environment Check Failed': EmptyProperties;
  'Onboarding Folder Picker Opened': EmptyProperties;
  'Onboarding Folder Selected': EmptyProperties;
  'Onboarding Existing Workspace Selected': EmptyProperties;
  'Onboarding Completed': EmptyProperties;
  'Onboarding Workspace Setup Action Required': {
    requirement_type: string;
    changed_files_count_bucket: CountBucket;
  };
  'Onboarding Workspace Setup Failed': EmptyProperties;
  'Workspace Created': {
    source: string;
    allow_git_init?: boolean;
    dirty_strategy?: string;
  };
  'Agent Message Submitted': {
    agent_provider?: string;
    agent_run_count_bucket: CountBucket;
    prompt_chars_bucket: CharacterCountBucket;
    attachment_count_bucket: CountBucket;
    context_entry_count_bucket: CountBucket;
    has_parent: boolean;
    edit_and_run: boolean;
  };
  'Agent Run Started': {
    agent_provider?: string;
    provider_thread_strategy: string;
    branch_from_interior: boolean;
    auto_checkout_requested: boolean;
    explicit_context_chars_bucket: CharacterCountBucket;
    injected_context_chars_bucket: CharacterCountBucket;
    provider_context_routing_mode: string;
  };
  'Agent Spawn Succeeded': { agent_provider?: string };
  'Agent Spawn Dispatched': { agent_provider?: string };
  'Agent Run Failed': {
    agent_provider?: string;
    error_phase: 'spawn' | 'setup';
    failure_category: AnalyticsFailureCategory;
  };
}

type AnalyticsEventName = keyof AnalyticsEventProperties;
type PropertyKind = 'boolean' | 'string';

const EVENT_PROPERTY_SCHEMA = {
  'App Launched': { app_version: 'string' },
  'Screen Viewed': {
    screen: 'string',
    active_view: 'string',
    has_workspace: 'boolean',
    workspace_count_bucket: 'string',
  },
  'Onboarding Step Viewed': { step: 'string' },
  'Onboarding Environment Checked': {
    git_installed: 'boolean',
    codex_authenticated: 'boolean',
    codex_readiness_status: 'string',
    claude_authenticated: 'boolean',
    claude_readiness_status: 'string',
  },
  'Onboarding Environment Check Failed': {},
  'Onboarding Folder Picker Opened': {},
  'Onboarding Folder Selected': {},
  'Onboarding Existing Workspace Selected': {},
  'Onboarding Completed': {},
  'Onboarding Workspace Setup Action Required': {
    requirement_type: 'string',
    changed_files_count_bucket: 'string',
  },
  'Onboarding Workspace Setup Failed': {},
  'Workspace Created': {
    source: 'string',
    allow_git_init: 'boolean',
    dirty_strategy: 'string',
  },
  'Agent Message Submitted': {
    agent_provider: 'string',
    agent_run_count_bucket: 'string',
    prompt_chars_bucket: 'string',
    attachment_count_bucket: 'string',
    context_entry_count_bucket: 'string',
    has_parent: 'boolean',
    edit_and_run: 'boolean',
  },
  'Agent Run Started': {
    agent_provider: 'string',
    provider_thread_strategy: 'string',
    branch_from_interior: 'boolean',
    auto_checkout_requested: 'boolean',
    explicit_context_chars_bucket: 'string',
    injected_context_chars_bucket: 'string',
    provider_context_routing_mode: 'string',
  },
  'Agent Spawn Succeeded': { agent_provider: 'string' },
  'Agent Spawn Dispatched': { agent_provider: 'string' },
  'Agent Run Failed': {
    agent_provider: 'string',
    error_phase: 'string',
    failure_category: 'string',
  },
} as const satisfies Record<AnalyticsEventName, Record<string, PropertyKind>>;

let initialized = false;
let amplitude: typeof Amplitude | null = null;
let warnedMissingKey = false;

const parseBoolean = (value: unknown): boolean =>
  ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

const isAnalyticsDisabled = () =>
  parseBoolean(import.meta.env.VITE_AMPLITUDE_DISABLED) ||
  parseBoolean(import.meta.env.VITE_ANALYTICS_DISABLED);

const getAppVersion = (): string => import.meta.env.VITE_APP_VERSION || '0.1.0';

const isAnalyticsEventName = (eventName: string): eventName is AnalyticsEventName =>
  Object.prototype.hasOwnProperty.call(EVENT_PROPERTY_SCHEMA, eventName);

export function bucketCount(value: number): CountBucket {
  if (value <= 0) return '0';
  if (value === 1) return '1';
  if (value <= 5) return '2-5';
  if (value <= 20) return '6-20';
  return '21+';
}

export function bucketCharacterCount(value: number): CharacterCountBucket {
  if (value <= 0) return '0';
  if (value <= 100) return '1-100';
  if (value <= 500) return '101-500';
  if (value <= 2_000) return '501-2000';
  return '2001+';
}

export function analyticsFailureCategory(error: unknown): AnalyticsFailureCategory {
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
  if (name === 'aborterror' || message.includes('aborted') || message.includes('cancelled')) return 'aborted';
  if (message.includes('network') || message.includes('timeout') || message.includes('timed out')) return 'network';
  if (name.includes('tauri') || message.includes('invoke') || message.includes('runtime')) return 'runtime';
  return 'unknown';
}

export function sanitizeAnalyticsEvent(
  eventName: string,
  properties: Record<string, unknown> = {},
): { eventName: AnalyticsEventName; properties: Record<string, string | boolean> } | null {
  if (!isAnalyticsEventName(eventName)) return null;
  const schema = EVENT_PROPERTY_SCHEMA[eventName] as Record<string, PropertyKind>;
  const sanitized: Record<string, string | boolean> = {};

  for (const [key, kind] of Object.entries(schema)) {
    const value = properties[key];
    if (kind === 'boolean' && typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (kind === 'string' && typeof value === 'string' && value.trim()) {
      sanitized[key] = value.trim().slice(0, 64);
    }
  }

  return { eventName, properties: sanitized };
}

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

  amplitude = await import('@amplitude/analytics-browser');
  amplitude.init(apiKey, {
    appVersion: getAppVersion(),
    deviceId: crypto.randomUUID(),
    identityStorage: 'none',
    userId: undefined,
    defaultTracking: false,
    autocapture: false,
    customEnrichment: false,
    fetchRemoteConfig: false,
    remoteConfig: { fetchRemoteConfig: false },
    enableDiagnostics: false,
    trackingOptions: {
      ipAddress: false,
      language: false,
      platform: false,
    },
  });

  initialized = true;
  track('App Launched', { app_version: getAppVersion() });
}

export function track<EventName extends AnalyticsEventName>(
  eventName: EventName,
  properties?: AnalyticsEventProperties[EventName],
): void {
  if (!initialized || !amplitude || isAnalyticsDisabled()) return;
  const sanitized = sanitizeAnalyticsEvent(eventName, properties ?? {});
  if (!sanitized) return;
  amplitude.track(sanitized.eventName, {
    app_context: 'tauri',
    ...sanitized.properties,
  });
}

export function trackScreenViewed(
  screen: AnalyticsEventProperties['Screen Viewed']['screen'],
  properties: Omit<AnalyticsEventProperties['Screen Viewed'], 'screen'> = {},
): void {
  track('Screen Viewed', { screen, ...properties });
}

export function trackOnboardingStepViewed(step: string): void {
  track('Onboarding Step Viewed', { step });
}

export function trackWorkspaceCreated(
  source: string,
  properties: Omit<AnalyticsEventProperties['Workspace Created'], 'source'> = {},
): void {
  track('Workspace Created', { source, ...properties });
}

export function trackAgentRunStarted(properties: AnalyticsEventProperties['Agent Run Started']): void {
  track('Agent Run Started', properties);
}

export function trackAgentRunFailed(properties: AnalyticsEventProperties['Agent Run Failed']): void {
  track('Agent Run Failed', properties);
}
