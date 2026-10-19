// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useAuthStore } from '../../stores/authStore';
import { LoginPage } from './LoginPage';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openAuth: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
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
    expect(mocks.openAuth).toHaveBeenCalledTimes(1);
  });
});
