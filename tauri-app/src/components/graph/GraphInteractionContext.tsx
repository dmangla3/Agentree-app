import { createContext, useContext } from 'react';

interface GraphInteractionContextValue {
  selectedNodeIds: Set<string>;
  isSelectionGestureActive: boolean;
  isViewportInteracting: boolean;
}

const DEFAULT_VALUE: GraphInteractionContextValue = {
  selectedNodeIds: new Set<string>(),
  isSelectionGestureActive: false,
  isViewportInteracting: false,
};

export const GraphInteractionContext = createContext<GraphInteractionContextValue>(DEFAULT_VALUE);

export const useGraphInteractionContext = () => useContext(GraphInteractionContext);
