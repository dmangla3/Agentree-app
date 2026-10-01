import { openUrl } from '@tauri-apps/plugin-opener';
import { Command } from '@tauri-apps/plugin-shell';
import type { MouseEvent } from 'react';
import { commands } from '../generated/tauri-bindings';
import type { Editor } from '../generated/tauri-bindings';
import { isTauriEnvironment } from '../hooks/useTauriWorkspace';
import { buildAgentreePath, navigateToAgentreeDeepLink, parseAgentreeDeepLink } from './agentreeDeepLinks';

export type LinkActivationTarget =
  | { kind: 'internal'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string; line: number | null; column: number | null }
  | { kind: 'blocked'; reason: string };

const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const UNSAFE_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:']);

const trimTrailingLineLocation = (value: string): { value: string; line: number | null; column: number | null } => {
  const match = value.match(/^(.*?):([1-9]\d*)(?::([1-9]\d*))?$/);
  if (!match) return { value, line: null, column: null };
  return {
    value: match[1],
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : null,
  };
};

const normalizeSlashes = (value: string): string => value.replace(/\\/g, '/');

const joinWorkspacePath = (workspaceRepoPath: string, relativePath: string): string => {
  const base = normalizeSlashes(workspaceRepoPath).replace(/\/+$/, '');
  const relative = normalizeSlashes(relativePath).replace(/^\.\/+/, '');
  return `${base}/${relative}`;
};

const decodeFileUrlPath = (href: string): string | null => {
  try {
    const url = new URL(href);
    if (url.protocol !== 'file:') return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
};

export function resolveLinkActivationTarget(
  href: string | null | undefined,
  workspaceRepoPath?: string | null
): LinkActivationTarget {
  const trimmed = (href ?? '').trim();
  if (!trimmed) return { kind: 'blocked', reason: 'empty-link' };
  if (trimmed.startsWith('#')) return { kind: 'blocked', reason: 'in-page-anchor' };

  const agentreeTarget = parseAgentreeDeepLink(trimmed);
  if (agentreeTarget) {
    return { kind: 'internal', path: buildAgentreePath(agentreeTarget) };
  }

  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z\d+.-]*:)/);
  const scheme = schemeMatch?.[1]?.toLowerCase() ?? null;
  if (scheme && UNSAFE_SCHEMES.has(scheme)) {
    return { kind: 'blocked', reason: 'unsafe-scheme' };
  }

  if (scheme && SAFE_EXTERNAL_SCHEMES.has(scheme)) {
    return { kind: 'external', url: trimmed };
  }

  if (scheme === 'file:') {
    const path = decodeFileUrlPath(trimmed);
    if (!path) return { kind: 'blocked', reason: 'invalid-file-url' };
    const location = trimTrailingLineLocation(path);
    return { kind: 'file', path: location.value, line: location.line, column: location.column };
  }

  if (scheme) {
    return { kind: 'blocked', reason: 'unsupported-scheme' };
  }

  const location = trimTrailingLineLocation(trimmed);
  const path = normalizeSlashes(location.value);
  if (path.startsWith('/')) {
    return { kind: 'file', path, line: location.line, column: location.column };
  }
  if (!workspaceRepoPath?.trim()) {
    return { kind: 'blocked', reason: 'relative-file-without-workspace' };
  }
  return {
    kind: 'file',
    path: joinWorkspacePath(workspaceRepoPath, path),
    line: location.line,
    column: location.column,
  };
}

const editorArg = (editor: Editor, path: string, line: number | null, column: number | null): string[] => {
  if (line === null) return [path];
  if (editor.command === 'code' || editor.command === 'cursor') {
    return ['--goto', `${path}:${line}${column ? `:${column}` : ''}`];
  }
  if (editor.command === 'zed' || editor.command === 'subl') {
    return [`${path}:${line}${column ? `:${column}` : ''}`];
  }
  return [path];
};

const chooseEditor = async (): Promise<Editor> => {
  const editors = await commands.getAvailableEditors();
  return editors.find((editor) => !['open', 'xdg-open', 'explorer'].includes(editor.command)) ?? editors[0] ?? {
    name: 'Finder',
    command: 'open',
    icon_key: 'finder',
  };
};

export async function activateLink(href: string, workspaceRepoPath?: string | null): Promise<LinkActivationTarget> {
  const target = resolveLinkActivationTarget(href, workspaceRepoPath);
  if (target.kind === 'blocked') return target;

  if (target.kind === 'internal') {
    navigateToAgentreeDeepLink(target.path);
    return target;
  }

  if (target.kind === 'external') {
    if (isTauriEnvironment()) {
      await openUrl(target.url);
    } else {
      window.open(target.url, '_blank', 'noopener,noreferrer');
    }
    return target;
  }

  if (isTauriEnvironment()) {
    const editor = await chooseEditor();
    await Command.create(editor.command, editorArg(editor, target.path, target.line, target.column)).execute();
  } else {
    window.open(`file://${target.path}`, '_blank', 'noopener,noreferrer');
  }

  return target;
}

export function createMarkdownLinkClickHandler(workspaceRepoPath?: string | null) {
  return async (event: MouseEvent<HTMLAnchorElement>) => {
    const href = event.currentTarget.getAttribute('href');
    if (!href || href.startsWith('#nodelink/')) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      await activateLink(href, workspaceRepoPath);
    } catch (error) {
      console.error('[linkActivation] Failed to activate link', { href, error });
    }
  };
}
