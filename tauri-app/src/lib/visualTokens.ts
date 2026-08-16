import { CanonicalNodeKind } from '../domain/nodes';

export const SCOPE_COLORS = [
  '#4f8dd8',
  '#4f9f75',
  '#8b6fd6',
  '#c47a32',
  '#ba6d92',
  '#3d9f97',
];

export const CARD_TOKENS = {
  radius: 'rounded-lg',
  border: 'border border-border/70',
  shadow: 'shadow-[var(--app-shadow-soft)]',
} as const;

export const ROLE_COLORS: Record<CanonicalNodeKind, { bg: string, text: string, border: string, accent?: string, chip?: string }> = {
  thread_origin: {
    bg: 'bg-[hsl(var(--app-bg-muted)/0.86)]',
    text: 'text-foreground',
    border: 'border-[hsl(var(--app-border)/0.75)]',
    accent: 'bg-[hsl(var(--app-muted-foreground))]',
    chip: 'bg-[hsl(var(--app-bg-muted))] text-muted-foreground',
  },
  user_message: {
    bg: 'bg-[hsl(var(--app-bg-muted)/0.9)]',
    text: 'text-foreground',
    border: 'border-[hsl(var(--app-border)/0.8)]',
    accent: 'bg-[hsl(var(--app-graph-user))]',
    chip: 'bg-[hsl(var(--app-graph-user)/0.12)] text-[hsl(var(--app-graph-user))]',
  },
  assistant_message: {
    bg: 'bg-[hsl(var(--app-panel)/0.96)]',
    text: 'text-foreground',
    border: 'border-[hsl(var(--app-border)/0.78)]',
    accent: 'bg-[hsl(var(--app-graph-agent))]',
    chip: 'bg-[hsl(var(--app-graph-agent)/0.12)] text-[hsl(var(--app-graph-agent))]',
  },
  commit_message: {
    bg: 'bg-[hsl(var(--app-panel-strong)/0.96)]',
    text: 'text-[hsl(var(--app-graph-commit))]',
    border: 'border-[hsl(var(--app-graph-commit)/0.28)]',
    accent: 'bg-[hsl(var(--app-graph-commit))]',
    chip: 'bg-[hsl(var(--app-graph-commit)/0.12)] text-[hsl(var(--app-graph-commit))]',
  },
  summary_block: {
    bg: 'bg-[hsl(var(--app-graph-summary)/0.09)]',
    text: 'text-[hsl(var(--app-graph-summary))]',
    border: 'border-[hsl(var(--app-graph-summary)/0.25)]',
    accent: 'bg-[hsl(var(--app-graph-summary))]',
    chip: 'bg-[hsl(var(--app-graph-summary)/0.12)] text-[hsl(var(--app-graph-summary))]',
  }
};

export const withHexAlpha = (color: string | null | undefined, alphaHex: string): string => {
  if (!color) return `#94a3b8${alphaHex}`;
  if (color.startsWith('#') && color.length === 7) {
    return `${color}${alphaHex}`;
  }
  return color;
};
