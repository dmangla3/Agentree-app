// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useAuthStore } from '../../stores/authStore';
import { LoginPage } from './LoginPage';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openAuth: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [mocks.searchParams],
}));

vi.mock('@kinde-oss/kinde-auth-react', () => ({
  useKindeAuth: () => ({
    isAuthenticated: false,
    login: vi.fn(),
    register: vi.fn(),
  }),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../lib/kindeDesktopAuth', () => ({
  openKindeAuthInSystemBrowser: mocks.openAuth,
  shouldUseDesktopBrowserAuth: () => true,
}));

describe('LoginPage saved-session fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute('data-design-auth');
    mocks.searchParams = new URLSearchParams();
    useAuthStore.getState().clearSession();
    useAuthStore.getState().clearAuthErrorReason();
  });

  afterEach(() => {
    useAuthStore.getState().clearSession();
  });

  test('shows a normal sign-in action without internal session-recovery UI', () => {
    render(<LoginPage />);

    expect(screen.queryByText(/failed to load saved session/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry saved session/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(mocks.openAuth).toHaveBeenNthCalledWith(1, 'login');
    expect(mocks.openAuth).toHaveBeenNthCalledWith(2, 'register');
  });

  test('keeps authentication actions inert in the design review preview', () => {
    mocks.searchParams = new URLSearchParams('designReview=auth');
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(mocks.openAuth).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  test('provides an isolated pre-redesign login presentation while leaving After untouched', () => {
    const styles = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');
    const style = document.createElement('style');
    style.textContent = styles;
    document.head.append(style);

    const view = render(<LoginPage />);
    const layout = view.container.querySelector<HTMLElement>('[data-design-part="auth-layout"]');
    const legacyPanel = view.container.querySelector<HTMLElement>('[data-design-part="auth-before"]');
    const currentPanel = view.container.querySelector<HTMLElement>('[data-design-part="auth-after"]');

    expect(layout).toBeTruthy();
    expect(legacyPanel).toBeTruthy();
    expect(currentPanel).toBeTruthy();
    expect(getComputedStyle(legacyPanel!).display).toBe('none');

    document.documentElement.setAttribute('data-design-auth', 'before');
    expect(getComputedStyle(layout!).display).toBe('grid');
    expect(getComputedStyle(legacyPanel!).display).toBe('block');
    expect(getComputedStyle(currentPanel!).maxWidth).toBe('none');

    document.documentElement.setAttribute('data-design-auth', 'after');
    expect(getComputedStyle(legacyPanel!).display).toBe('none');
    expect(styles).not.toContain('data-design-auth="after"');

    style.remove();
  });
});
