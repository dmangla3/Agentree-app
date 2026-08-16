import { GraphNodeDispatcher } from '../nodes/graph/GraphNodeDispatcher';
import { GraphTurnGroupHull } from '../nodes/graph/GraphTurnGroupHull';

export const graphNodeTypes = {
  thread_origin: GraphNodeDispatcher,
  user_message: GraphNodeDispatcher,
  assistant_message: GraphNodeDispatcher,
  commit_message: GraphNodeDispatcher,
  canonical_commit: GraphNodeDispatcher,
  layout_derived_commit_group: GraphNodeDispatcher,
  summary_block: GraphNodeDispatcher,
  turn_group_hull: GraphTurnGroupHull,
};
