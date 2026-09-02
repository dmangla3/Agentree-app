export const APP_FONT_SIZE_STORAGE_KEY = 'agentree.app-font-size.v1';
export const DEFAULT_APP_FONT_SIZE_PX = 16;
export const MIN_APP_FONT_SIZE_PX = 13;
export const MAX_APP_FONT_SIZE_PX = 22;
export const APP_FONT_SIZE_STEP_PX = 1;

export function clampAppFontSizePx(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_APP_FONT_SIZE_PX;
  return Math.min(MAX_APP_FONT_SIZE_PX, Math.max(MIN_APP_FONT_SIZE_PX, Math.round(value)));
}

export function applyAppFontSizePx(value: number, root?: HTMLElement | null): number {
  const normalized = clampAppFontSizePx(value);
  const target = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  target?.style.setProperty('font-size', `${normalized}px`);
  target?.style.setProperty('--agentree-app-font-size', `${normalized}px`);
  target?.setAttribute('data-app-font-size', String(normalized));
  return normalized;
}

export function readAppFontSizePx(): number {
  try {
    const raw = typeof window !== 'undefined'
      ? window.localStorage?.getItem(APP_FONT_SIZE_STORAGE_KEY)
      : null;
    if (raw) return clampAppFontSizePx(Number(raw));
  } catch {
    // Fall through to the applied DOM value when storage is blocked.
  }

  if (typeof document === 'undefined') return DEFAULT_APP_FONT_SIZE_PX;
  const applied = document.documentElement.getAttribute('data-app-font-size');
  return applied ? clampAppFontSizePx(Number(applied)) : DEFAULT_APP_FONT_SIZE_PX;
}

export function rememberAppFontSizePx(value: number): number {
  const normalized = applyAppFontSizePx(value);
  if (typeof window === 'undefined') return normalized;

  try {
    window.localStorage.setItem(APP_FONT_SIZE_STORAGE_KEY, String(normalized));
  } catch {
    // Persisting a display preference is best-effort only.
  }

  return normalized;
}

export function applyStoredAppFontSizePreference(): number {
  return applyAppFontSizePx(readAppFontSizePx());
}

export function changeAppFontSizePx(delta: number): number {
  return rememberAppFontSizePx(readAppFontSizePx() + delta);
}
