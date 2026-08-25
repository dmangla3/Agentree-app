import { useShortcut } from './useShortcut';

export function useOpenSearchHotkey(openSearch: () => void) {
  useShortcut('search.open', () => {
    openSearch();
  });
}

export function useCloseSearchHotkey(isOpen: boolean, closeSearch: () => void) {
  useShortcut('search.close', () => {
    closeSearch();
  }, { enabled: isOpen, preventDefault: false, stopPropagation: false });
}
