export const GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT = 'agentree:graph-composer-dock-collapse';
export const GRAPH_COMPOSER_DOCK_EXPAND_EVENT = 'agentree:graph-composer-dock-expand';

export function dispatchGraphComposerDockCollapse() {
  window.dispatchEvent(new Event(GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT));
}

export function dispatchGraphComposerDockExpand() {
  window.dispatchEvent(new Event(GRAPH_COMPOSER_DOCK_EXPAND_EVENT));
}
