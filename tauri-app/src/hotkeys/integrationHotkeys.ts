import { useShortcut } from './useShortcut';

export function useEmbeddedIntegrationHotkeys(options: {
  isApplying: boolean;
  close: () => void;
}) {
  useShortcut('integration.embedded.close', () => {
    options.close();
  }, {
    enabled: !options.isApplying,
    preventDefault: false,
    stopPropagation: false,
  });
}

export function useIntegrationWorkspaceHotkeys(options: {
  isOpen: boolean;
  isApplying: boolean;
  close: () => void;
}) {
  useShortcut('integration.workspace.close', () => {
    options.close();
  }, {
    enabled: options.isOpen && !options.isApplying,
    preventDefault: false,
    stopPropagation: false,
  });
}
