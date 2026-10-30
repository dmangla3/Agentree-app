// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DESIGN_REVIEW_NAVIGATION_EVENT,
  createDesignReviewLocation,
  dispatchOpenDesignReviewSurface,
  type DesignReviewNavigationDetail,
} from './designReviewNavigation';

describe('design review navigation', () => {
  it('dispatches a request for the selected real UI surface', () => {
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(DESIGN_REVIEW_NAVIGATION_EVENT, listener);

    dispatchOpenDesignReviewSurface('auth', 'before');

    const event = listener.mock.calls[0]?.[0] as CustomEvent<DesignReviewNavigationDetail>;
    expect(event.detail).toEqual({ surface: 'auth', version: 'before' });

    window.removeEventListener(DESIGN_REVIEW_NAVIGATION_EVENT, listener);
  });

  it('builds an exact safe preview location for auth', () => {
    expect(createDesignReviewLocation('auth', '/workspaces/workspace-1', '?nodeId=node-1', 'run 1'))
      .toBe('/login?designReview=auth&designReviewRun=run%201');
  });

  it('keeps the active workspace while targeting a workspace surface', () => {
    expect(createDesignReviewLocation('panels', '/workspaces/workspace-1', '?nodeId=node-1', '42'))
      .toBe('/workspaces/workspace-1?nodeId=node-1&designReview=panels&designReviewRun=42');
  });

  it('opens the selected version in one action while retaining editable review notes', () => {
    const source = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');

    expect(source).toContain('onClick={() => selectDesignReviewVersion(id, version)}');
    expect(source).toContain('openDesignReviewArea(id, version);');
    expect(source).toContain('value={selection.comment}');
    expect(source).toContain('navigator.clipboard?.writeText');
    expect(source).toContain('window.localStorage.setItem(DESIGN_REVIEW_STORAGE_KEY');
  });

  it('keeps the reviewer open while navigating between surfaces and versions', () => {
    const source = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    const openHandlerStart = source.indexOf('const openDesignReviewArea =');
    const openHandlerEnd = source.indexOf('\n  return (', openHandlerStart);
    const openHandler = source.slice(openHandlerStart, openHandlerEnd);

    expect(openHandlerStart).toBeGreaterThan(-1);
    expect(openHandler).not.toContain('setIsDesignReviewOpen(false)');
  });

  it('keeps the reviewer above every application and development overlay', () => {
    const styles = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');
    const reviewerRule = styles.match(/\.app-design-review\s*\{[^}]+\}/)?.[0] ?? '';

    expect(reviewerRule).toContain('z-index: 2147483647');
  });

  it('computes visibly different shell, navigation, and panel geometry for Before', () => {
    const reviewStyles = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');
    const style = document.createElement('style');
    style.textContent = `
      [data-design-part="workspace-shell"] { height: 100dvh; }
      [data-design-part="primary-rail"] { width: 3.5rem; padding-block: 0.5rem; }
      [data-design-part="workspace-navigator"] { width: 16.5rem; }
      [data-design-part="workspace-view"] { padding: 1rem; }
      [data-design-part="settings-option-description"] { display: none; }
      ${reviewStyles}
    `;
    document.head.appendChild(style);
    document.body.innerHTML = `
      <div data-design-part="workspace-shell"></div>
      <aside data-design-part="primary-rail"></aside>
      <aside data-design-part="workspace-navigator" data-design-state="expanded"></aside>
      <main data-design-part="workspace-view"></main>
      <span data-design-part="settings-option-description"></span>
    `;

    const shell = document.querySelector<HTMLElement>('[data-design-part="workspace-shell"]')!;
    const rail = document.querySelector<HTMLElement>('[data-design-part="primary-rail"]')!;
    const navigator = document.querySelector<HTMLElement>('[data-design-part="workspace-navigator"]')!;
    const panel = document.querySelector<HTMLElement>('[data-design-part="workspace-view"]')!;
    const description = document.querySelector<HTMLElement>('[data-design-part="settings-option-description"]')!;
    const after = {
      shellHeight: getComputedStyle(shell).height,
      railWidth: getComputedStyle(rail).width,
      navigatorWidth: getComputedStyle(navigator).width,
      panelPadding: getComputedStyle(panel).paddingTop,
      descriptionDisplay: getComputedStyle(description).display,
    };

    document.documentElement.setAttribute('data-design-shell', 'before');
    document.documentElement.setAttribute('data-design-navigation', 'before');
    document.documentElement.setAttribute('data-design-panels', 'before');

    const before = {
      shellHeight: getComputedStyle(shell).height,
      railWidth: getComputedStyle(rail).width,
      navigatorWidth: getComputedStyle(navigator).width,
      panelPadding: getComputedStyle(panel).paddingTop,
      descriptionDisplay: getComputedStyle(description).display,
    };

    expect(before.shellHeight).not.toBe(after.shellHeight);
    expect(before.railWidth).not.toBe(after.railWidth);
    expect(before.navigatorWidth).not.toBe(after.navigatorWidth);
    expect(before.panelPadding).not.toBe(after.panelPadding);
    expect(after.descriptionDisplay).toBe('none');
    expect(before.descriptionDisplay).toBe('block');

    document.documentElement.removeAttribute('data-design-shell');
    document.documentElement.removeAttribute('data-design-navigation');
    document.documentElement.removeAttribute('data-design-panels');
    style.remove();
    document.body.replaceChildren();
  });

  it('targets stable parts on the real navigation and settings surfaces', () => {
    const sidebar = readFileSync(join(process.cwd(), 'src/components/Sidebar.tsx'), 'utf8');
    const navigator = readFileSync(join(process.cwd(), 'src/components/navigation/WorkspaceNavigator.tsx'), 'utf8');
    const settings = readFileSync(join(process.cwd(), 'src/components/ConfigButton.tsx'), 'utf8');

    expect(sidebar).toContain('data-design-part="primary-rail"');
    expect(sidebar).toContain('data-design-part="rail-utilities"');
    expect(navigator).toContain('data-design-part="workspace-navigator"');
    expect(navigator).toContain('data-design-state="expanded"');
    expect(navigator).toContain('data-design-state="collapsed"');
    expect(settings).toContain('data-design-scope="panels" data-design-part="settings-dialog"');
    expect(settings).toContain('data-design-part="settings-option-description"');
  });

  it('uses layered neutral tokens instead of pure black for ordinary navigation and settings surfaces', () => {
    const sidebar = readFileSync(join(process.cwd(), 'src/components/Sidebar.tsx'), 'utf8');
    const navigator = readFileSync(join(process.cwd(), 'src/components/navigation/WorkspaceNavigator.tsx'), 'utf8');
    const ordinarySettingsSources = [
      'src/components/ConfigButton.tsx',
      'src/components/DiagnosticsButton.tsx',
      'src/components/WorktreePolicyButton.tsx',
      'src/components/WorkspaceDeleteDialog.tsx',
      'src/components/WorkspaceRenameDialog.tsx',
      'src/components/WorkspaceShareDialog.tsx',
    ].map((path) => readFileSync(join(process.cwd(), path), 'utf8'));

    expect(sidebar).toContain('dark:bg-[hsl(var(--app-panel))]');
    expect(sidebar).not.toContain('dark:bg-black');
    expect(navigator).toContain('data-design-part="repository-menu"');
    expect(navigator).toContain('data-design-part="repository-submenu"');
    expect(navigator).not.toContain('dark:bg-black');
    ordinarySettingsSources.forEach((source) => expect(source).not.toContain('dark:bg-black'));
  });

  it('keeps the navigation Before surface independent from After refinements', () => {
    const styles = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');

    expect(styles).toContain('html.dark[data-design-navigation="before"] [data-design-part="workspace-navigator"]');
    expect(styles).toContain('background: hsl(0 0% 0%);');
    expect(styles).toContain('html.dark[data-design-navigation="before"] [data-design-part="primary-rail"]');
    expect(styles).toContain('html.dark[data-design-navigation="before"] [data-design-part="repository-menu"]');
    expect(styles).toContain('html.dark[data-design-navigation="before"] [data-design-part="repository-submenu"]');
    expect(styles).toContain('html[data-design-navigation="before"] [data-design-part="workspace-picker"]');
    expect(styles).toContain('height: 2.75rem;');
    expect(styles).toContain('html.dark[data-design-navigation="before"] .workspace-thread-unread-badge');
    expect(styles).toContain('background: hsl(0 0% 100%);');
    expect(styles).toContain('color: hsl(0 0% 0%);');
    expect(styles).toContain('[data-design-part="thread-title"][data-design-current="true"]');
    expect(styles).toContain('font-weight: 600;');
    expect(styles).toContain('html.dark[data-design-navigation="before"] [data-design-part="workspace-picker"]');
    expect(styles).toContain('color: hsl(0 0% 100%);');
    expect(styles).toContain('[data-design-part="repository-row-title"]');
    expect(styles).toContain('[data-design-part="workspace-row-title"][data-design-current="true"]');
  });
});
