// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, type Toast, useToast } from './Toast';

function ToastTrigger({ toast }: { toast: Omit<Toast, 'id'> }) {
    const { addToast } = useToast();

    return <button onClick={() => addToast(toast)}>Show toast</button>;
}

function renderToast(toast: Omit<Toast, 'id'>) {
    return render(
        <ToastProvider>
            <ToastTrigger toast={toast} />
        </ToastProvider>
    );
}

describe('ToastProvider accessibility', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('announces error content assertively without including its actions', () => {
        renderToast({
            title: 'Sync failed',
            description: 'Check your connection',
            variant: 'error',
            persistent: true,
            action: {
                label: 'Retry',
                onClick: vi.fn(),
            },
        });

        fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));

        const announcement = screen.getByRole('alert');
        expect(announcement.textContent).toContain('Sync failed');
        expect(announcement.textContent).toContain('Check your connection');
        expect(announcement.getAttribute('aria-atomic')).toBe('true');
        expect(announcement.contains(screen.getByRole('button', { name: 'Retry' }))).toBe(false);
    });

    it('announces non-error content politely', () => {
        renderToast({
            title: 'Workspace ready',
            description: 'Files are up to date',
            variant: 'success',
            persistent: true,
        });

        fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));

        const announcement = screen.getByRole('status');
        expect(announcement.textContent).toContain('Workspace ready');
        expect(announcement.textContent).toContain('Files are up to date');
        expect(announcement.getAttribute('aria-atomic')).toBe('true');
    });

    it('labels the dismiss control and hides decorative icons', () => {
        const { container } = renderToast({
            title: 'Workspace ready',
            variant: 'info',
            persistent: true,
            action: {
                label: 'Open workspace',
                onClick: vi.fn(),
            },
        });

        fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));

        const dismissButton = screen.getByRole('button', { name: 'Dismiss Workspace ready' });
        expect(dismissButton.getAttribute('type')).toBe('button');
        expect(
            Array.from(container.querySelectorAll('svg')).every(
                (icon) => icon.getAttribute('aria-hidden') === 'true'
            )
        ).toBe(true);
    });

    it('removes a dismissed toast after its existing exit delay', () => {
        vi.useFakeTimers();
        renderToast({
            title: 'Workspace ready',
            variant: 'success',
            persistent: true,
        });

        fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss Workspace ready' }));

        act(() => {
            vi.advanceTimersByTime(199);
        });
        expect(screen.queryByText('Workspace ready')).not.toBeNull();

        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(screen.queryByText('Workspace ready')).toBeNull();
    });
});
