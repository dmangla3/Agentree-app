import type { StateStorage } from 'zustand/middleware';

export const createBestEffortStorage = (
  getStorage: () => StateStorage,
  onWriteError?: (error: unknown, key: string) => void,
): StateStorage => ({
  getItem: (key) => getStorage().getItem(key),
  setItem: (key, value) => {
    try {
      getStorage().setItem(key, value);
    } catch (error) {
      onWriteError?.(error, key);
    }
  },
  removeItem: (key) => {
    try {
      getStorage().removeItem(key);
    } catch (error) {
      onWriteError?.(error, key);
    }
  },
});
