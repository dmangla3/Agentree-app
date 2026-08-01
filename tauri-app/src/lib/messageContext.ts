import type { Message } from '../stores/workspaceStore';

export type MessageContextPolicy = 'continue' | 'fresh';

export const getMessageContextPolicy = (message: Message | null | undefined): MessageContextPolicy | null => {
  const policy = message?.execution_data?.meta?.context_policy;
  return policy === 'fresh' || policy === 'continue' ? policy : null;
};

export const hasFreshContextBoundary = (message: Message | null | undefined): boolean => (
  getMessageContextPolicy(message) === 'fresh'
);
