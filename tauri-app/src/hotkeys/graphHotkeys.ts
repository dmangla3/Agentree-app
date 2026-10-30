import { useCapturedShortcut, useShortcut } from './useShortcut';

export type GraphNavigationDirection = 'up' | 'down' | 'left' | 'right';

const isDismissableLayerEvent = (event: KeyboardEvent): boolean => {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  return Boolean(target?.closest([
    '[data-slot="dropdown-menu-content"]',
    '[data-slot="dialog-content"]',
    '[data-slot="popover-content"]',
  ].join(',')));
};

export function useGraphViewHotkeys(options: {
  hasSelection: boolean;
  isComposerOpen: boolean;
  closeComposer: () => void;
  clearSelection: () => void;
  openSearch: () => void;
  navigate: (direction: GraphNavigationDirection) => void;
  focusPrevious: () => void;
  focusNext: () => void;
  focusLatest: () => void;
  focusNextThread: () => void;
  focusPreviousThread: () => void;
  closeThread: () => void;
  reopenLastClosedThread: () => void;
}) {
  useShortcut('graph.composer.close', (event) => {
    if (isDismissableLayerEvent(event)) return;
    options.closeComposer();
  }, { enabled: options.isComposerOpen });

  useShortcut('graph.selection.clear', () => {
    options.clearSelection();
  }, { enabled: options.hasSelection && !options.isComposerOpen });

  useShortcut('graph.navigate.up', () => {
    options.navigate('up');
  });

  useShortcut('graph.navigate.down', () => {
    options.navigate('down');
  });

  useShortcut('graph.navigate.left', () => {
    options.navigate('left');
  });

  useShortcut('graph.navigate.right', () => {
    options.navigate('right');
  });

  useShortcut('graph.navigate.previous', () => {
    options.focusPrevious();
  });

  useShortcut('graph.navigate.next', () => {
    options.focusNext();
  });

  useShortcut('graph.navigate.latest', () => {
    options.focusLatest();
  });

  useCapturedShortcut('thread.navigate.next', () => {
    options.focusNextThread();
  });

  useCapturedShortcut('thread.navigate.previous', () => {
    options.focusPreviousThread();
  });

  useCapturedShortcut('thread.close', () => {
    options.closeThread();
  });

  useShortcut('thread.reopen-last-closed', () => {
    options.reopenLastClosedThread();
  });

  useShortcut('search.open', () => {
    options.openSearch();
  });
}
