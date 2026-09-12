import { GraphNodeDispatcher } from '../nodes/graph/GraphNodeDispatcher';
import { GraphTurnGroupHull } from '../nodes/graph/GraphTurnGroupHull';
import { GraphOrchestrationHull } from '../nodes/graph/GraphOrchestrationHull';

export const graphNodeTypes = {
  thread_origin: GraphNodeDispatcher,
  thread_link: GraphNodeDispatcher,
  user_message: GraphNodeDispatcher,
  assistant_message: GraphNodeDispatcher,
  commit_message: GraphNodeDispatcher,
  canonical_commit: GraphNodeDispatcher,
  layout_derived_commit_group: GraphNodeDispatcher,
  summary_block: GraphNodeDispatcher,
  turn_group_hull: GraphTurnGroupHull,
  orchestration_hull: GraphOrchestrationHull,
  orchestration_node: GraphNodeDispatcher,
};
