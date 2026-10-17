import { describe, expect, it } from 'vitest';
import { formatMessageTimestamp } from './messageTimestamp';

describe('formatMessageTimestamp', () => {
  const now = '2026-07-21T12:00:00.000Z';
  const options = { now, locale: 'en-US', timeZone: 'UTC' };

  it('shows only the time for messages from the same local day', () => {
    expect(formatMessageTimestamp('2026-07-21T09:15:00.000Z', options)?.label)
      .toBe('9:15 AM');
  });

  it('shows yesterday plus time for the previous local day', () => {
    expect(formatMessageTimestamp('2026-07-20T09:15:00.000Z', options)?.label)
      .toBe('Yesterday, 9:15 AM');
  });

  it('shows month, day, and time for older messages from the same year', () => {
    expect(formatMessageTimestamp('2026-07-18T09:15:00.000Z', options)?.label)
      .toBe('Jul 18, 9:15 AM');
  });

  it('shows the year for messages from previous years', () => {
    expect(formatMessageTimestamp('2025-07-18T09:15:00.000Z', options)?.label)
      .toBe('Jul 18, 2025, 9:15 AM');
  });

  it('can keep compact time-only labels for non-hover surfaces', () => {
    expect(formatMessageTimestamp('2025-07-18T09:15:00.000Z', { ...options, mode: 'time-only' })?.label)
      .toBe('9:15 AM');
  });

  it('provides a full timestamp for the title', () => {
    expect(formatMessageTimestamp('2026-07-18T09:15:30.000Z', options)?.title)
      .toBe('Sat, Jul 18, 2026, 9:15:30 AM');
  });

  it('returns null for missing or invalid values', () => {
    expect(formatMessageTimestamp(null)).toBeNull();
    expect(formatMessageTimestamp('not-a-date')).toBeNull();
  });
});
