import { describe, expect, it } from 'vitest';
import { hasAppAccess } from './appAccess';

const baseState = {
  devAuthBypass: false,
  usesDesktopAuth: true,
  hasDesktopUser: false,
  hasDesktopSession: false,
  isKindeAuthenticated: false,
};

describe('hasAppAccess', () => {
  it('requires both a restored user and session on desktop', () => {
    expect(hasAppAccess(baseState)).toBe(false);
    expect(hasAppAccess({ ...baseState, hasDesktopUser: true })).toBe(false);
    expect(hasAppAccess({ ...baseState, hasDesktopSession: true })).toBe(false);
    expect(hasAppAccess({
      ...baseState,
      hasDesktopUser: true,
      hasDesktopSession: true,
    })).toBe(true);
  });

  it('uses Kinde authentication for the web runtime', () => {
    expect(hasAppAccess({ ...baseState, usesDesktopAuth: false })).toBe(false);
    expect(hasAppAccess({
      ...baseState,
      usesDesktopAuth: false,
      isKindeAuthenticated: true,
    })).toBe(true);
  });

  it('allows the explicit development bypass', () => {
    expect(hasAppAccess({ ...baseState, devAuthBypass: true })).toBe(true);
  });
});
