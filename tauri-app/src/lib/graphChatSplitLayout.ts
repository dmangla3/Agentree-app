export type GraphChatSplit = [graphPercent: number, chatPercent: number];

export const DEFAULT_GRAPH_CHAT_SPLIT: GraphChatSplit = [50, 50];
export const GRAPH_CHAT_SPLIT_STORAGE_KEY = 'agentree.graph-chat-split.v1';

const MIN_RESTORABLE_PANEL_PERCENT = 20;
const TOTAL_PERCENT = 100;

export function normalizeGraphChatSplit(layout: readonly number[]): GraphChatSplit | null {
  if (layout.length < 2) return null;

  const [graphPercent, chatPercent] = layout;
  if (!Number.isFinite(graphPercent) || !Number.isFinite(chatPercent)) return null;
  if (graphPercent < 0 || chatPercent < 0) return null;

  const total = graphPercent + chatPercent;
  if (total <= 0) return null;

  const normalizedGraphPercent = Math.round((graphPercent / total) * TOTAL_PERCENT);
  const normalizedChatPercent = TOTAL_PERCENT - normalizedGraphPercent;

  return [normalizedGraphPercent, normalizedChatPercent];
}

export function shouldRememberGraphChatSplit(layout: readonly number[]): boolean {
  const normalized = normalizeGraphChatSplit(layout);
  if (!normalized) return false;

  const [graphPercent, chatPercent] = normalized;
  return graphPercent >= MIN_RESTORABLE_PANEL_PERCENT && chatPercent >= MIN_RESTORABLE_PANEL_PERCENT;
}

export function getGraphChatRestoreSplit(rememberedSplit: readonly number[] | null): GraphChatSplit {
  if (!rememberedSplit || !shouldRememberGraphChatSplit(rememberedSplit)) {
    return DEFAULT_GRAPH_CHAT_SPLIT;
  }

  return normalizeGraphChatSplit(rememberedSplit) ?? DEFAULT_GRAPH_CHAT_SPLIT;
}

export function readRememberedGraphChatSplit(): GraphChatSplit | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(GRAPH_CHAT_SPLIT_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;

    return shouldRememberGraphChatSplit(parsed) ? normalizeGraphChatSplit(parsed) : null;
  } catch {
    return null;
  }
}

export function rememberGraphChatSplit(layout: readonly number[]): GraphChatSplit | null {
  const normalized = normalizeGraphChatSplit(layout);
  if (!normalized || !shouldRememberGraphChatSplit(normalized)) return null;
  if (typeof window === 'undefined') return normalized;

  try {
    window.localStorage.setItem(GRAPH_CHAT_SPLIT_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Persisting panel layout is best-effort only.
  }

  return normalized;
}
