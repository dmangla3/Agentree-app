import { createContext, useContext, type ReactNode } from 'react';

const MessageHighlightActiveContext = createContext<string | null>(null);

export function MessageHighlightActiveProvider({
  activeHighlightId,
  children,
}: {
  activeHighlightId: string | null;
  children: ReactNode;
}) {
  return (
    <MessageHighlightActiveContext.Provider value={activeHighlightId}>
      {children}
    </MessageHighlightActiveContext.Provider>
  );
}

export const useActiveMessageHighlightId = () => useContext(MessageHighlightActiveContext);
