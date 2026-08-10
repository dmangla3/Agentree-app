import { describe, expect, it, vi } from 'vitest';
import { createBestEffortStorage } from './bestEffortStorage';

describe('createBestEffortStorage', () => {
  it('swallows quota-style write failures', () => {
    const onWriteError = vi.fn();
    const storage = createBestEffortStorage(() => ({
      getItem: () => null,
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
    }), onWriteError);

    expect(() => storage.setItem('workspace-storage', '{}')).not.toThrow();
    expect(() => storage.removeItem('workspace-storage')).not.toThrow();
    expect(onWriteError).toHaveBeenCalledTimes(2);
  });
});
