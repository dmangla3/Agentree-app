// @vitest-environment jsdom
import '../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TimelineErrorNotice } from './TimelineErrorNotice';

describe('TimelineErrorNotice', () => {
  it('shows retry progress and keeps raw provider diagnostics collapsed', () => {
    render(
      <TimelineErrorNotice
        error={JSON.stringify({
          error: {
            additionalDetails: 'unexpected status 503 Service Unavailable',
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: 503 },
            },
            message: 'Reconnecting... 3/5',
          },
          threadId: 'thread-1',
          willRetry: true,
        })}
      />,
    );

    expect(screen.getByText('Connection interrupted')).toBeTruthy();
    expect(screen.getByText('Retrying 3 of 5')).toBeTruthy();
    expect(screen.getByText('HTTP 503')).toBeTruthy();
    expect(screen.queryByText(/thread-1/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Technical details' }));

    expect(screen.getByText(/thread-1/)).toBeTruthy();
  });

  it('renders ordinary failures as alerts without an empty details control', () => {
    render(<TimelineErrorNotice error="Provider timed out." />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Provider timed out.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
