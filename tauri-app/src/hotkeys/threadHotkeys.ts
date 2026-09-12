import { useShortcut } from './useShortcut';

export function useCreateThreadHotkey(options: {
  enabled: boolean;
  createThread: () => void;
}) {
  useShortcut('thread.create', () => {
    options.createThread();
  }, {
    enabled: options.enabled,
    ignoreInputs: true,
  });
}
