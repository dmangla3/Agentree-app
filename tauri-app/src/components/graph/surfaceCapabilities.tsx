import { createContext, useContext, type ReactNode } from 'react';
import type { MessageTimestampMode } from '../../lib/messageTimestamp';

export type AgentreeSurfaceMode = 'app' | 'public-share';

export type AgentreeSurfaceCapabilities = {
  canReply: boolean;
  canSteer: boolean;
  canOpenContextMenu: boolean;
  canSelect: boolean;
  canMutate: boolean;
  canShowToolTimeline: boolean;
  canExpandToolCalls: boolean;
};

export const appSurfaceCapabilities: AgentreeSurfaceCapabilities = {
  canReply: true,
  canSteer: true,
  canOpenContextMenu: true,
  canSelect: true,
  canMutate: true,
  canShowToolTimeline: true,
  canExpandToolCalls: true,
};

export const publicShareCapabilities: AgentreeSurfaceCapabilities = {
  canReply: false,
  canSteer: false,
  canOpenContextMenu: false,
  canSelect: false,
  canMutate: false,
  canShowToolTimeline: true,
  canExpandToolCalls: false,
};

type AgentreeSurfaceContextValue = {
  surfaceMode: AgentreeSurfaceMode;
  capabilities: AgentreeSurfaceCapabilities;
  messageTimestampMode?: MessageTimestampMode;
};

const AgentreeSurfaceContext = createContext<AgentreeSurfaceContextValue>({
  surfaceMode: 'app',
  capabilities: appSurfaceCapabilities,
  messageTimestampMode: 'time-only',
});

export function AgentreeSurfaceProvider({
  surfaceMode,
  capabilities,
  messageTimestampMode,
  children,
}: AgentreeSurfaceContextValue & { children: ReactNode }) {
  return (
    <AgentreeSurfaceContext.Provider
      value={{
        surfaceMode,
        capabilities,
        messageTimestampMode: messageTimestampMode ?? 'time-only',
      }}
    >
      {children}
    </AgentreeSurfaceContext.Provider>
  );
}

export function useAgentreeSurface() {
  return useContext(AgentreeSurfaceContext);
}
