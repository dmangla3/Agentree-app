// Minimal Tauri environment helpers kept for feature gating.

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI__' in window ||
    '__TAURI_INTERNALS__' in window ||
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;
}

export const FORCE_SHOW_WORKSPACE_FEATURES = true;

export function shouldShowWorkspaceFeatures(): boolean {
  return FORCE_SHOW_WORKSPACE_FEATURES || isTauriEnvironment();
}
