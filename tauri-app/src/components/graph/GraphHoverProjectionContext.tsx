import { createContext, useContext } from 'react';
import type { Message, Summary } from '../../stores/workspaceStore';

interface GraphHoverProjectionInput {
  messages: Message[];
  summaries: Summary[];
  disabledSummaryIds: Set<string>;
}

const EMPTY_DISABLED_SUMMARY_IDS = new Set<string>();

const DEFAULT_GRAPH_HOVER_PROJECTION_INPUT: GraphHoverProjectionInput = {
  messages: [],
  summaries: [],
  disabledSummaryIds: EMPTY_DISABLED_SUMMARY_IDS,
};

export const GraphHoverProjectionContext = createContext<GraphHoverProjectionInput>(
  DEFAULT_GRAPH_HOVER_PROJECTION_INPUT
);

export function useGraphHoverProjectionInput() {
  return useContext(GraphHoverProjectionContext);
}
