import { describe, expect, it } from 'vitest';
import { formatWorkspaceLastActive } from './WorkspaceNavigator';

const formatOptions = {
  now: new Date('2026-08-06T15:00:00.000Z'),
  locale: 'en-US',
  timeZone: 'UTC',
};

describe('formatWorkspaceLastActive', () => {
  it('uses the persisted last-used time when available', () => {
    expect(formatWorkspaceLastActive(
      {
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-05-04T09:07:00.000Z',
      },
      Date.parse('2026-08-06T13:05:00.000Z'),
      formatOptions,
    )).toBe('Aug 6, 1:05 PM');
  });

  it('falls back to the workspace timestamp before its creation time', () => {
    expect(formatWorkspaceLastActive(
      {
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-05-04T09:07:00.000Z',
      },
      undefined,
      formatOptions,
    )).toBe('May 4, 9:07 AM');
  });

  it('includes the year when the activity was in a different year', () => {
    expect(formatWorkspaceLastActive(
      {
        createdAt: '2025-12-31T23:08:00.000Z',
        updatedAt: '',
      },
      undefined,
      formatOptions,
    )).toBe('Dec 31, 2025, 11:08 PM');
  });
});
