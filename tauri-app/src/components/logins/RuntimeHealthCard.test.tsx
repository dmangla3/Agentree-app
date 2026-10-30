// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedRuntimeDoctorEntry } from '../../generated/tauri-bindings';
import { __resetRuntimeRepairStateForTests, RuntimeHealthCard } from './RuntimeHealthCard';

const mocks = vi.hoisted(() => ({
  checkManagedRuntimeDoctor: vi.fn(),
  repairManagedRuntimeComponent: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('../../lib/agentClient', () => ({
  agentClient: {
    checkManagedRuntimeDoctor: mocks.checkManagedRuntimeDoctor,
    repairManagedRuntimeComponent: mocks.repairManagedRuntimeComponent,
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));

const runtimeEntry = (
  overrides: Partial<ManagedRuntimeDoctorEntry> = {}
): ManagedRuntimeDoctorEntry => ({
  component: 'codex',
  label: 'Codex CLI',
  pinnedVersion: '0.139.0',
  status: 'missing',
  installDir: null,
  downloadable: true,
  detail:
    'Codex CLI 0.139.0 is not installed yet at /a/very/long/path/that/should/not/force/the/runtime/health/card/to/overflow/out/of/its/container.',
  ...overrides,
});

describe('RuntimeHealthCard', () => {
  let progressListener:
    | ((event: {
        payload: { component: string; receivedBytes: number; totalBytes: number | null };
      }) => void)
    | null;

  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn(),
    });
    progressListener = null;
    mocks.checkManagedRuntimeDoctor.mockReset();
    mocks.repairManagedRuntimeComponent.mockReset();
    mocks.listen.mockReset();
    mocks.checkManagedRuntimeDoctor.mockResolvedValue([
      runtimeEntry({
        component: 'node',
        label: 'Node runtime',
        detail: 'Node runtime is missing.',
      }),
      runtimeEntry(),
    ]);
    mocks.listen.mockImplementation(
      async (
        _eventName: string,
        listener: (event: {
          payload: { component: string; receivedBytes: number; totalBytes: number | null };
        }) => void
      ) => {
        progressListener = listener;
        return vi.fn();
      }
    );
  });

  afterEach(() => {
    cleanup();
    __resetRuntimeRepairStateForTests();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('uses cached runtime validation on open and forces validation only on refresh', async () => {
    render(<RuntimeHealthCard />);

    await waitFor(() => expect(mocks.checkManagedRuntimeDoctor).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh runtime health' }));

    await waitFor(() => expect(mocks.checkManagedRuntimeDoctor).toHaveBeenLastCalledWith(true));
  });

  it('shows immediate indeterminate progress while a runtime install is pending', async () => {
    let resolveRepair: (entry: ManagedRuntimeDoctorEntry) => void = () => {};
    mocks.repairManagedRuntimeComponent.mockImplementation(
      () =>
        new Promise<ManagedRuntimeDoctorEntry>((resolve) => {
          resolveRepair = resolve;
        })
    );

    render(<RuntimeHealthCard />);

    fireEvent.click((await screen.findAllByRole('button', { name: /install/i }))[0]);

    expect(mocks.repairManagedRuntimeComponent).toHaveBeenCalledWith('node');
    expect(screen.getAllByText('Preparing runtime install').length).toBeGreaterThan(0);
    expect(screen.getByText('Starting...')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /node runtime install progress/i })).toBeTruthy();
    expect(
      screen
        .getAllByRole('button', { name: /install/i })
        .every((button) => button.hasAttribute('disabled'))
    ).toBe(true);

    await act(async () => {
      resolveRepair(
        runtimeEntry({
          component: 'node',
          label: 'Node runtime',
          status: 'ready',
          detail: 'Node runtime installed.',
        })
      );
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
  });

  it('updates the visible progress bar when download totals are available', async () => {
    mocks.repairManagedRuntimeComponent.mockReturnValue(new Promise<ManagedRuntimeDoctorEntry>(() => {}));

    render(<RuntimeHealthCard />);
    fireEvent.click((await screen.findAllByRole('button', { name: /install/i }))[0]);

    act(() => {
      progressListener?.({
        payload: {
          component: 'node',
          receivedBytes: 1024 * 1024,
          totalBytes: 4 * 1024 * 1024,
        },
      });
    });

    expect(screen.getAllByText('Downloading runtime archive').length).toBeGreaterThan(0);
    expect(screen.getByText('1.0 / 4.0 MB')).toBeTruthy();
    expect(
      screen
        .getByRole('progressbar', { name: /node runtime install progress/i })
        .getAttribute('aria-valuenow')
    ).toBe('25');
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'Downloading runtime archive'
    );
    expect(document.querySelector('[aria-live="polite"]')?.textContent).not.toContain('1.0');
  });

  it('preserves in-flight repair state across Logins view remounts', async () => {
    mocks.repairManagedRuntimeComponent.mockReturnValue(
      new Promise<ManagedRuntimeDoctorEntry>(() => {})
    );

    const { unmount } = render(<RuntimeHealthCard />);
    fireEvent.click((await screen.findAllByRole('button', { name: /install/i }))[0]);
    unmount();

    act(() => {
      progressListener?.({
        payload: {
          component: 'node',
          receivedBytes: 2 * 1024 * 1024,
          totalBytes: 4 * 1024 * 1024,
        },
      });
    });

    render(<RuntimeHealthCard />);

    expect(
      await screen.findByRole('progressbar', { name: /node runtime install progress/i })
    ).toBeTruthy();
    expect(screen.getByText('2.0 / 4.0 MB')).toBeTruthy();
    expect(
      screen
        .getAllByRole('button', { name: /install/i })
        .every((button) => button.hasAttribute('disabled'))
    ).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: /install/i })[0]);

    expect(mocks.repairManagedRuntimeComponent).toHaveBeenCalledTimes(1);
  });

});
