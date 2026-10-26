import { useCapturedShortcut } from './useShortcut';

export function useToggleTerminalDockHotkey(toggleTerminalDock: () => void) {
  useCapturedShortcut('terminal.toggle', () => {
    toggleTerminalDock();
  });
}
