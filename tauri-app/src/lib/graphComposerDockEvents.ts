export const GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT = 'agentree:graph-composer-dock-collapse';
export const GRAPH_COMPOSER_DOCK_EXPAND_EVENT = 'agentree:graph-composer-dock-expand';
export const GRAPH_COMPOSER_DOCK_STATE_EVENT = 'agentree:graph-composer-dock-state';

export type GraphComposerDockState = {
  isVisible: boolean;
  isCollapsed: boolean;
};

let currentGraphComposerDockState: GraphComposerDockState = {
  isVisible: false,
  isCollapsed: false,
};

export function dispatchGraphComposerDockCollapse() {
  window.dispatchEvent(new Event(GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT));
}

export function dispatchGraphComposerDockExpand() {
  window.dispatchEvent(new Event(GRAPH_COMPOSER_DOCK_EXPAND_EVENT));
}

export function getGraphComposerDockState(): GraphComposerDockState {
  return currentGraphComposerDockState;
}

export function setGraphComposerDockState(state: GraphComposerDockState) {
  currentGraphComposerDockState = state;
  window.dispatchEvent(new CustomEvent<GraphComposerDockState>(GRAPH_COMPOSER_DOCK_STATE_EVENT, {
    detail: state,
  }));
}
