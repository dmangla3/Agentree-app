import { Edge, Node, Position } from '@xyflow/react';
import dagre from 'dagre';
import { BranchPointer, Message, Summary } from '../stores/workspaceStore';
import type { AgentStatus } from '@shared/agentStatus';
import { RuntimeCatalogModel } from '../stores/modelStore';
import { getGraphParentId } from './graph/lineage';
import { classifyMessageNodeKind, getAssistantCommitCount, getToolCallCount } from '../domain/nodes';
import type { WorkspaceProjection, ProjectedNodeEntity, ProjectedTurnGroup } from '../domain/workspaceProjection';
import { getGitParentShas } from './graph/turnUtils';
import { hasFreshContextBoundary } from './messageContext';
import { resolveNodeState } from './runStateResolver';
import { getMessageBaseCommitSha, getMessageOutputCommitSha } from './graph/commitAccessors';

// --- Interface ---
export interface LlmNodeData {
  [key: string]: unknown;
  entity?: ProjectedNodeEntity;
  message: Message;
  nodeKind?: 'user_message' | 'assistant_message' | 'commit_message';
  repoPath?: string | null;
  branchPointers?: BranchPointer[];
  isFocused: boolean;
  isInContextPath: boolean;
  llmColor: string;
  matchesTagFilter: boolean;
  filterActive: boolean; // Added to pass filter status
  cumulativeTokens?: number; // Added for cumulative token display
  isSummarized?: boolean; // Added to indicate if node is part of a summary
  onToggleSummary?: (id: string) => void; // Callback to toggle summary
  summaryIds?: string[]; // IDs of the summaries containing this node
  hasDisabledSummary?: boolean; // Flag if this node is the start of a disabled summary
  isDense?: boolean; // Flag for dense mode
  isInsideActiveSummary?: boolean; // Flag if node is inside an active summary
  isGhostBranch?: boolean; // Flag for ghost/background agent branches
  agentType?: 'hypothesis' | 'doubt' | 'meta' | 'association' | 'memory' | 'kb'; // Agent type for ghost nodes
  insight?: any; // Original insight data for ghost nodes
  // Agent activity fields (Unified Adaptive Node)
  toolCallCount?: number; // Number of tool calls in execution_data
  commitCount?: number; // Number of commit children produced by assistant node
  changedFilesCount?: number; // Number of files changed in execution_data
  agentStatus?: AgentStatus | null;
  isAgentRunning?: boolean; // Shorthand for status === running/streaming
  agentId?: string | null; // The agent ID if present
  collapsed?: boolean; // Whether the node is collapsed
  onToggleCollapse?: (id: string, collapsed: boolean) => void; // Callback to toggle collapse
  hiddenDescendantCount?: number; // Number of hidden descendants
  isContextActive?: boolean; // Whether this node is active for context
  scopeId?: string | null;
  scopeName?: string | null;
  scopeColor?: string | null;
  isInActiveScope?: boolean;
  isScopeBoundary?: boolean;
  scopeDimmed?: boolean;
}

export interface SummaryNodeData {
  [key: string]: unknown;
  content: string;
  tokenCountBefore?: number;
  tokenCountAfter?: number;
  startMessageId: string;
  endMessageId: string;
  isInContextPath: boolean;
  isActive: boolean; // Added to track if summary is active (collapsed) or inactive (expanded)
  onToggleSummary: (id: string) => void;
  isDense?: boolean; // Flag for dense mode
  bypassedNodeCount?: number; // Added: Number of nodes bypassed by this summary
  bypassedNodes?: { id: string; role: 'user' | 'assistant'; content: string }[]; // Added: Details of bypassed nodes
}

const isExternalCommitAssistant = (msg: Message | null | undefined): boolean => {
  if (!msg || msg.role !== 'assistant') return false;
  return (msg.execution_data as any)?.meta?.sync_source === 'external_git';
};

const getRawGitParentShas = (msg: Message): string[] => {
  return getGitParentShas(msg);
};

const PREVIEW_HEIGHT_BUCKET_SIZE = 36;

const getPreviewHeightBucket = (value: string | null | undefined, maxBucket: number): number => {
  const length = (value || '').trim().length;
  if (length === 0) return 0;
  return Math.min(maxBucket, Math.ceil(length / PREVIEW_HEIGHT_BUCKET_SIZE));
};

const getMetricPresence = (value: number | null | undefined): 0 | 1 => (
  typeof value === 'number' && value > 0 ? 1 : 0
);

const getFilesChanged = (message: Message): Array<{ additions?: number; deletions?: number }> => {
  const files = (message.execution_data as any)?.files_changed;
  return Array.isArray(files) ? files : [];
};

const createMessageHeightKey = ({
  message,
  entity,
  nodeKind,
  branchPointers,
  toolCallCount,
  commitCount,
  changedFilesCount,
}: {
  message: Message;
  entity: ProjectedNodeEntity;
  nodeKind: 'user_message' | 'assistant_message' | 'commit_message';
  branchPointers: BranchPointer[];
  toolCallCount?: number;
  commitCount?: number;
  changedFilesCount?: number;
}): string => {
  const previewBucket = getPreviewHeightBucket(entity.preview, nodeKind === 'user_message' ? 3 : 2);
  const pointerNames = branchPointers.map((pointer) => pointer.name).sort().join(',');
  const filesChanged = getFilesChanged(message);
  const hasAdditions = filesChanged.some((file) => (file.additions || 0) > 0) ? 1 : 0;
  const hasDeletions = filesChanged.some((file) => (file.deletions || 0) > 0) ? 1 : 0;

  return [
    'turn-cell-v2',
    nodeKind,
    `preview:${previewBucket}`,
    `collapsed:${message.collapsed ? 1 : 0}`,
    `status:${message.status || ''}`,
    `agent:${message.agent_id || ''}`,
    `ai:${message.aiLabel ? 1 : 0}`,
    `tools:${getMetricPresence(toolCallCount)}`,
    `commits:${getMetricPresence(commitCount)}`,
    `tokens:${getMetricPresence(entity.totalTokens)}`,
    `files:${getMetricPresence(changedFilesCount)}`,
    `adds:${hasAdditions}`,
    `dels:${hasDeletions}`,
    `author:${entity.authorName ? 1 : 0}`,
    `external:${entity.importedFromRef ? 1 : 0}`,
    `pointers:${pointerNames}`,
  ].join('|');
};

const createSummaryHeightKey = (summary: Summary, isEnabled: boolean, bypassedNodeCount: number): string => [
  'summary_block',
  `content:${getPreviewHeightBucket(summary.content, 3)}`,
  `enabled:${isEnabled ? 1 : 0}`,
  `bypassed:${bypassedNodeCount}`,
  `tokens:${getMetricPresence(summary.tokenCountAfter)}`,
].join('|');

const ORIGIN_WELCOME_PREFIX = 'Welcome! How can I help you explore your ideas today?';

const isOriginWelcomeMessage = (msg: Message | null | undefined): boolean => {
  if (!msg || msg.role !== 'assistant') return false;
  if (msg.parentId !== null) return false;
  return (msg.content || '').trim().startsWith(ORIGIN_WELCOME_PREFIX);
};

// --- Configuration ---
// --- Configuration ---
const NODE_WIDTH = 180;  // Updated to match new LlmResponseNode width
const NODE_HEIGHT = 140; // Increased to accommodate header + body + footer
const RANK_SEP = 28;    // Keep dagre compact; node sizes still prevent overlap
const NODE_SEP = 12;    // Tighter horizontal packing without touching
const DEFAULT_EDGE_STROKE_WIDTH = 4;
const CONTEXT_PATH_EDGE_STROKE_WIDTH = 7;
const DEFAULT_SUMMARY_EDGE_STROKE_WIDTH = 4;
const FOCUSED_SUMMARY_EDGE_STROKE_WIDTH = 6.5;
const ACTIVE_EDGE_STROKE = '#4f46e5';
const INACTIVE_EDGE_STROKE = '#64748b';

const CANONICAL_MESSAGE_NODE_TYPES = new Set(['user_message', 'assistant_message', 'commit_message']);
const CANONICAL_SUMMARY_NODE_TYPES = new Set(['summary_block']);
const TURN_LAYOUT_NODE_TYPE = '__turn_layout_unit__';
const TURN_NODE_GAP = 0;
const TURN_LANE_GAP = 2;
const TURN_STACK_GAP = 2;
const TURN_CONVERSATION_NODE_WIDTH = 200;
const TURN_COMMIT_NODE_WIDTH = 120;
const TURN_COMMIT_NODE_HEIGHT = 112;
const DAGRE_EDGE_VERTICAL_GAP = 18;
const DAGRE_COLLISION_GAP = 12;

const isHullNodeType = (type?: string | null) => type === 'turn_group_hull';
const isSummaryNodeType = (type?: string | null) => CANONICAL_SUMMARY_NODE_TYPES.has(type || '');
const isMessageNodeType = (type?: string | null) => CANONICAL_MESSAGE_NODE_TYPES.has(type || '');
const isPrimaryLayoutNodeType = (type?: string | null) => !isHullNodeType(type) && type !== 'default';

const getNodeWidth = (node: Node<any>): number => {
  const explicitWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  if (explicitWidth) return explicitWidth;
  if (node.type === 'assistant_message') return TURN_CONVERSATION_NODE_WIDTH;
  if (node.type === 'user_message') return TURN_CONVERSATION_NODE_WIDTH;
  if (node.type === 'commit_message') return TURN_COMMIT_NODE_WIDTH;
  if (node.type === 'canonical_commit') return TURN_COMMIT_NODE_WIDTH;
  if (node.type === 'layout_derived_commit_group') return TURN_COMMIT_NODE_WIDTH;
  return NODE_WIDTH;
};

const getNodeHeight = (node: Node<any>): number => {
  const explicitHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  if (explicitHeight) return explicitHeight;
  if (isSummaryNodeType(node.type)) return 100;
  if (node.type === 'commit_message') return TURN_COMMIT_NODE_HEIGHT;
  if (node.type === 'canonical_commit') return TURN_COMMIT_NODE_HEIGHT;
  if (node.type === 'layout_derived_commit_group') return 118;
  if (node.type === 'assistant_message') return 112;
  if (node.type === 'user_message') return 82;
  return NODE_HEIGHT;
};

const getNodeCreatedAtTs = (node: Node<any>): number | undefined => {
  const sourceNode = (node.data as any)?.sourceNode as Node<any> | undefined;
  if (sourceNode) return getNodeCreatedAtTs(sourceNode);
  const message = (node.data as any)?.message || (node.data as any)?.entity?.message;
  const createdAt = message?.createdAt;
  if (!createdAt) return undefined;
  const ts = new Date(createdAt).getTime();
  return Number.isNaN(ts) ? undefined : ts;
};

const isOriginNode = (node: Node<any>): boolean => {
  const sourceNode = (node.data as any)?.sourceNode as Node<any> | undefined;
  if (sourceNode) return isOriginNode(sourceNode);
  const message = (node.data as any)?.message || (node.data as any)?.entity?.message;
  return isOriginWelcomeMessage(message);
};

const getNodeTurnGroupId = (node: Node<any>): string | null => {
  const sourceNode = (node.data as any)?.sourceNode as Node<any> | undefined;
  if (sourceNode) return getNodeTurnGroupId(sourceNode);
  const entityTurnGroupId = (node.data as any)?.entity?.turnGroupId;
  if (entityTurnGroupId) return entityTurnGroupId;
  return null;
};

const getNodeSortTs = (node: Node<any>): number => {
  const sourceNode = (node.data as any)?.sourceNode as Node<any> | undefined;
  if ((node.data as any)?.sortTs !== undefined) return (node.data as any).sortTs;
  if (sourceNode) return getNodeSortTs(sourceNode);
  return (node.data as any)?.entity?.sortTs
    ?? (node.data as any)?.commit?.sortTs
    ?? (node.data as any)?.group?.sortTs
    ?? (node.data as any)?.batch?.sortTs
    ?? getNodeCreatedAtTs(node)
    ?? 0;
};

const getTurnMemberPriority = (node: Node<any>): number => {
  const kind = (node.data as any)?.entity?.kind;
  if (kind === 'user_message') return 0;
  if (kind === 'assistant_message') return 1;
  if (kind === 'commit_message') return 2;
  if (isSummaryNodeType(node.type)) return 4;
  return 5;
};

const getTurnStackGap = (previousNode: Node<any> | null, currentNode: Node<any>): number => {
  const previousKind = (previousNode?.data as any)?.entity?.kind;
  const currentKind = (currentNode.data as any)?.entity?.kind;

  if (
    (previousKind === 'user_message' && currentKind === 'assistant_message') ||
    (previousKind === 'assistant_message' && currentKind === 'commit_message')
  ) {
    return 0;
  }

  if (currentKind === 'commit_message') {
    return 2;
  }

  if (isSummaryNodeType(currentNode.type)) {
    return 4;
  }

  return TURN_NODE_GAP;
};

const getNodeEntityKind = (node: Node<any>): string | null => (
  (node.data as any)?.entity?.kind ?? null
);

const isTurnCommitLaneMember = (node: Node<any>): boolean => (
  getNodeEntityKind(node) === 'commit_message'
);

const getAssistantOutputCommitNodeId = (assistantId: string): string => `commit:${assistantId}`;

const getTurnConversationMembers = (members: Node<any>[]): Node<any>[] => (
  members.filter((member) => !isTurnCommitLaneMember(member))
);

const getTurnCommitMembers = (members: Node<any>[]): Node<any>[] => (
  members.filter(isTurnCommitLaneMember)
);

const getStackHeight = (members: Node<any>[], gap = TURN_STACK_GAP): number => (
  members.reduce((total, member, index) => total + getNodeHeight(member) + (index > 0 ? gap : 0), 0)
);

const getConversationAssistantYOffset = (members: Node<any>[]): number => {
  const assistantIndex = members.findIndex((member) => getNodeEntityKind(member) === 'assistant_message');
  if (assistantIndex < 0) return 0;
  return members.slice(0, assistantIndex).reduce((total, member) => (
    total + getNodeHeight(member) + TURN_STACK_GAP
  ), 0);
};

const getConversationAssistantHeight = (members: Node<any>[]): number => {
  const assistant = members.find((member) => getNodeEntityKind(member) === 'assistant_message');
  return assistant ? getNodeHeight(assistant) : TURN_COMMIT_NODE_HEIGHT;
};

const getSingleCommitLaneHeight = (conversationMembers: Node<any>[]): number => {
  const assistantIndex = conversationMembers.findIndex((member) => getNodeEntityKind(member) === 'assistant_message');
  if (assistantIndex < 0) return TURN_COMMIT_NODE_HEIGHT;
  const assistant = conversationMembers[assistantIndex];
  const previous = assistantIndex > 0 ? conversationMembers[assistantIndex - 1] : null;
  const previousHalfHeight = previous ? Math.round(getNodeHeight(previous) / 2) : 0;
  const previousGap = previous ? TURN_STACK_GAP : 0;
  return Math.max(TURN_COMMIT_NODE_HEIGHT, getNodeHeight(assistant) + previousHalfHeight + previousGap);
};

const getTurnLayoutDimensions = (members: Node<any>[]): { width: number; height: number; leftWidth: number; rightWidth: number } => {
  const conversationMembers = getTurnConversationMembers(members);
  const commitMembers = getTurnCommitMembers(members);
  const leftWidth = Math.max(...conversationMembers.map(getNodeWidth), NODE_WIDTH);
  const rightWidth = commitMembers.length > 0 ? Math.max(...commitMembers.map(getNodeWidth)) : 0;
  const conversationHeight = getStackHeight(conversationMembers);
  const commitHeight = commitMembers.length === 1
    ? getSingleCommitLaneHeight(conversationMembers)
    : Math.max(conversationHeight, getStackHeight(commitMembers));

  return {
    width: leftWidth + (rightWidth > 0 ? TURN_LANE_GAP + rightWidth : 0),
    height: Math.max(conversationHeight, commitHeight),
    leftWidth,
    rightWidth,
  };
};

interface LayoutUnit {
  id: string;
  memberNodeIds: string[];
  width: number;
  height: number;
  sortTs: number;
  isTurnUnit: boolean;
}

interface LayoutModel {
  layoutNodes: Node<any>[];
  layoutEdges: Edge[];
  unitByNodeId: Map<string, string>;
  membersByUnitId: Map<string, Node<any>[]>;
}

const buildLayoutModel = (
  nodes: Node<any>[],
  edges: Edge[],
  isLayoutEdge: (edge: Edge) => boolean
): LayoutModel => {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const unitByNodeId = new Map<string, string>();
  const membersByUnitId = new Map<string, Node<any>[]>();
  const layoutUnits = new Map<string, LayoutUnit>();

  const registerUnitNode = (unitId: string, node: Node<any>) => {
    unitByNodeId.set(node.id, unitId);
    const members = membersByUnitId.get(unitId) ?? [];
    members.push(node);
    membersByUnitId.set(unitId, members);
  };

  nodes.forEach((node) => {
    if (node.parentId || isHullNodeType(node.type)) return;

    const turnGroupId = getNodeTurnGroupId(node);
    const shouldCollapseIntoTurn = Boolean(turnGroupId) && !isSummaryNodeType(node.type);
    const unitId = shouldCollapseIntoTurn ? `${TURN_LAYOUT_NODE_TYPE}:${turnGroupId}` : node.id;

    registerUnitNode(unitId, node);
  });

  membersByUnitId.forEach((members, unitId) => {
    members.sort((left, right) => {
      const priorityDiff = getTurnMemberPriority(left) - getTurnMemberPriority(right);
      if (priorityDiff !== 0) return priorityDiff;
      return getNodeSortTs(left) - getNodeSortTs(right);
    });

    const turnDimensions = unitId.startsWith(`${TURN_LAYOUT_NODE_TYPE}:`)
      ? getTurnLayoutDimensions(members)
      : null;
    const width = turnDimensions?.width ?? Math.max(...members.map(getNodeWidth), NODE_WIDTH);
    const height = turnDimensions?.height ?? members.reduce((total, member, index) => (
      total + getNodeHeight(member) + (index > 0 ? getTurnStackGap(members[index - 1], member) : 0)
    ), 0);

    layoutUnits.set(unitId, {
      id: unitId,
      memberNodeIds: members.map((member) => member.id),
      width,
      height,
      sortTs: Math.min(...members.map(getNodeSortTs)),
      isTurnUnit: unitId.startsWith(`${TURN_LAYOUT_NODE_TYPE}:`),
    });
  });

  const layoutNodes = Array.from(layoutUnits.values()).map((unit) => ({
    id: unit.id,
    type: unit.isTurnUnit ? TURN_LAYOUT_NODE_TYPE : nodesById.get(unit.memberNodeIds[0])?.type,
    position: { x: 0, y: 0 },
    data: {
      memberNodeIds: unit.memberNodeIds,
      isTurnUnit: unit.isTurnUnit,
      sortTs: unit.sortTs,
      sourceNode: nodesById.get(unit.memberNodeIds[0]) ?? null,
    },
    style: { width: unit.width, height: unit.height },
  })) as Node<any>[];

  const layoutEdges: Edge[] = [];
  const edgeIds = new Set<string>();

  edges.forEach((edge) => {
    if (!isLayoutEdge(edge)) return;

    const sourceUnitId = unitByNodeId.get(edge.source);
    const targetUnitId = unitByNodeId.get(edge.target);
    if (!sourceUnitId || !targetUnitId || sourceUnitId === targetUnitId) return;

    const data = edge.data as { isReference?: boolean; layout?: boolean } | undefined;
    const edgeKey = [
      sourceUnitId,
      targetUnitId,
      edge.type || 'default',
      data?.isReference ? 'ref' : 'tree',
      data?.layout === false ? 'nolayout' : 'layout',
    ].join('::');
    if (edgeIds.has(edgeKey)) return;
    edgeIds.add(edgeKey);

    layoutEdges.push({
      ...edge,
      id: edgeKey,
      source: sourceUnitId,
      target: targetUnitId,
    });
  });

  return { layoutNodes, layoutEdges, unitByNodeId, membersByUnitId };
};

const expandLayoutedUnits = (
  nodes: Node<any>[],
  layoutedUnitNodes: Node<any>[],
  membersByUnitId: Map<string, Node<any>[]>
): Node<any>[] => {
  const unitPositions = new Map(layoutedUnitNodes.map((node) => [node.id, node]));
  const expandedNodes = nodes.map((node) => ({ ...node })) as Node<any>[];

  expandedNodes.forEach((node) => {
    if (node.parentId || isHullNodeType(node.type)) return;

    const turnGroupId = getNodeTurnGroupId(node);
    const unitId = turnGroupId && !isSummaryNodeType(node.type) ? `${TURN_LAYOUT_NODE_TYPE}:${turnGroupId}` : node.id;
    const unitNode = unitPositions.get(unitId);
    if (!unitNode) return;

    const unitMembers = membersByUnitId.get(unitId) ?? [node];
    const unitWidth = getNodeWidth(unitNode);
    const memberIndex = unitMembers.findIndex((member) => member.id === node.id);
    let localXOffset = Math.max(0, (unitWidth - getNodeWidth(node)) / 2);
    let localYOffset = unitMembers.slice(0, Math.max(0, memberIndex)).reduce((total, member, index) => {
      const nextMember = unitMembers[index + 1] ?? null;
      const gap = nextMember ? getTurnStackGap(member, nextMember) : 0;
      return total + getNodeHeight(member) + gap;
    }, 0);

    if (turnGroupId && !isSummaryNodeType(node.type)) {
      const conversationMembers = getTurnConversationMembers(unitMembers);
      const commitMembers = getTurnCommitMembers(unitMembers);
      const turnDimensions = getTurnLayoutDimensions(unitMembers);
      const conversationIndex = conversationMembers.findIndex((member) => member.id === node.id);
      const commitIndex = commitMembers.findIndex((member) => member.id === node.id);

      if (conversationIndex >= 0) {
        localXOffset = 0;
        localYOffset = conversationMembers.slice(0, conversationIndex).reduce((total, member) => (
          total + getNodeHeight(member) + TURN_STACK_GAP
        ), 0);
      } else if (commitIndex >= 0) {
        const commitStackHeight = commitMembers.length === 1
          ? getSingleCommitLaneHeight(conversationMembers)
          : getStackHeight(commitMembers);
        const commitLaneTop = commitMembers.length === 1
          ? Math.max(
            0,
            getConversationAssistantYOffset(conversationMembers)
              - Math.max(0, commitStackHeight - getConversationAssistantHeight(conversationMembers))
          )
          : Math.max(0, (turnDimensions.height - commitStackHeight) / 2);

        localXOffset = turnDimensions.leftWidth + TURN_LANE_GAP;
        localYOffset = commitLaneTop + commitMembers.slice(0, commitIndex).reduce((total, member) => (
          total + getNodeHeight(member) + TURN_STACK_GAP
        ), 0);
      }
    }

    const nodeHeight = turnGroupId && isTurnCommitLaneMember(node) && getTurnCommitMembers(unitMembers).length === 1
      ? getSingleCommitLaneHeight(getTurnConversationMembers(unitMembers))
      : getNodeHeight(node);

    node.position = {
      x: unitNode.position.x + localXOffset,
      y: unitNode.position.y + localYOffset,
    };
    node.style = {
      ...node.style,
      width: getNodeWidth(node),
      height: nodeHeight,
    };
    node.targetPosition = node.type !== 'default' ? unitNode.targetPosition : undefined;
    node.sourcePosition = node.type !== 'default' ? unitNode.sourcePosition : undefined;
  });

  return expandedNodes;
};

const getLayoutBoxWidth = (node: Node<any>): number => (
  typeof node.style?.width === 'number' ? node.style.width : getNodeWidth(node)
);

const getLayoutBoxHeight = (node: Node<any>): number => (
  typeof node.style?.height === 'number' ? node.style.height : getNodeHeight(node)
);

const rangesOverlap = (startA: number, endA: number, startB: number, endB: number): boolean => (
  startA < endB && startB < endA
);

const compactDagreUnitLayout = (
  layoutedUnitNodes: Node<any>[],
  layoutEdges: Edge[],
): Node<any>[] => {
  const nodesById = new Map(layoutedUnitNodes.map((node) => [
    node.id,
    {
      ...node,
      position: { ...node.position },
      style: { ...node.style },
    } as Node<any>,
  ]));

  const incomingByNodeId = new Map<string, string[]>();
  layoutEdges.forEach((edge) => {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) return;
    const incoming = incomingByNodeId.get(edge.target) ?? [];
    incoming.push(edge.source);
    incomingByNodeId.set(edge.target, incoming);
  });

  const orderedNodes = [...layoutedUnitNodes].sort((left, right) => (
    left.position.y - right.position.y || left.position.x - right.position.x || left.id.localeCompare(right.id)
  ));
  const placedNodes: Node<any>[] = [];

  orderedNodes.forEach((node) => {
    const positionedNode = nodesById.get(node.id);
    if (!positionedNode) return;

    const nodeWidth = getLayoutBoxWidth(positionedNode);
    let minY = 0;

    const incomingNodeIds = incomingByNodeId.get(node.id) ?? [];
    incomingNodeIds.forEach((incomingNodeId) => {
      const predecessor = nodesById.get(incomingNodeId);
      if (!predecessor) return;
      minY = Math.max(
        minY,
        predecessor.position.y + getLayoutBoxHeight(predecessor) + DAGRE_EDGE_VERTICAL_GAP
      );
    });

    placedNodes.forEach((otherNode) => {
      const otherWidth = getLayoutBoxWidth(otherNode);
      const otherHeight = getLayoutBoxHeight(otherNode);
      const overlapsInX = rangesOverlap(
        positionedNode.position.x,
        positionedNode.position.x + nodeWidth,
        otherNode.position.x,
        otherNode.position.x + otherWidth
      );
      if (!overlapsInX) return;

      minY = Math.max(minY, otherNode.position.y + otherHeight + DAGRE_COLLISION_GAP);
    });

    positionedNode.position.y = Math.max(0, minY);
    placedNodes.push(positionedNode);
  });

  return layoutedUnitNodes.map((node) => nodesById.get(node.id) ?? node);
};

const applyTurnGroupHullBounds = <T extends Node<any>>(nodes: T[]): T[] => {
  const result = nodes.map(node => ({ ...node })) as T[];
  const nodesById = new Map(result.map(node => [node.id, node]));

  result.forEach((node) => {
    if (node.type !== 'turn_group_hull' || !(node.data as any)?.memberIds) return;

    const memberIds = (node.data as any).memberIds as string[];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    memberIds.forEach((memberId) => {
      const memberNode = nodesById.get(memberId);
      if (!memberNode) return;
      const width = getNodeWidth(memberNode);
      const height = getNodeHeight(memberNode);
      minX = Math.min(minX, memberNode.position.x);
      minY = Math.min(minY, memberNode.position.y);
      maxX = Math.max(maxX, memberNode.position.x + width);
      maxY = Math.max(maxY, memberNode.position.y + height);
    });

    if (minX === Infinity) return;

    const padding = 10;
    node.position = { x: minX - padding, y: minY - padding };
    node.style = {
      ...node.style,
      width: (maxX - minX) + padding * 2,
      height: (maxY - minY) + padding * 2,
      zIndex: -1,
    };
  });

  return result;
};

// Dense Layout Constants - DEPRECATED: Dense mode removed
// Keeping as comments for reference during migration
// const DENSE_NODE_HEIGHT = 48;
// const DENSE_NODE_WIDTH = 48;
// const DENSE_RANK_SEP = 20;
// const DENSE_NODE_SEP = 10;

// --- Consistent LLM Color Mapping ---

// 1. Curated colors for popular/important models
const curatedLlmColorMap: Record<string, string> = {
  'gpt-5.5': 'bg-gradient-to-br from-emerald-400 to-teal-500',
  'gpt-5.2-codex': 'bg-gradient-to-br from-emerald-400 to-teal-500',
  'claude-sonnet-4-6': 'bg-gradient-to-br from-amber-400 to-yellow-500',
  'claude-opus-4-6': 'bg-gradient-to-br from-orange-500 to-amber-600',
  'claude-haiku-4-5-20251001': 'bg-gradient-to-br from-yellow-300 to-amber-400',
};

// 2. Expanded & Diversified Fallback Palette (Aim for visual distinction)
const extendedColorPalette: string[] = [
  // Reds/Oranges/Yellows
  'bg-gradient-to-br from-red-400 to-orange-500',
  'bg-gradient-to-br from-orange-400 to-amber-500',
  'bg-gradient-to-br from-yellow-400 to-lime-500',
  'bg-gradient-to-br from-red-500 to-rose-600',
  'bg-gradient-to-br from-amber-600 to-orange-700',
  // Greens/Limes/Teals
  'bg-gradient-to-br from-lime-400 to-emerald-500',
  'bg-gradient-to-br from-green-400 to-teal-500',
  'bg-gradient-to-br from-emerald-500 to-cyan-600',
  'bg-gradient-to-br from-teal-400 to-green-500',
  'bg-gradient-to-br from-lime-600 to-emerald-700',
  // Blues/Cyans/Skies
  'bg-gradient-to-br from-cyan-400 to-sky-500',
  'bg-gradient-to-br from-sky-400 to-blue-500',
  'bg-gradient-to-br from-blue-400 to-indigo-500',
  'bg-gradient-to-br from-cyan-600 to-blue-700',
  'bg-gradient-to-br from-sky-600 to-indigo-700',
  // Indigos/Violets/Purples
  'bg-gradient-to-br from-indigo-400 to-violet-500',
  'bg-gradient-to-br from-violet-400 to-purple-500',
  'bg-gradient-to-br from-purple-400 to-fuchsia-500',
  'bg-gradient-to-br from-indigo-600 to-purple-700',
  'bg-gradient-to-br from-violet-600 to-fuchsia-700',
  // Fuchsias/Pinks/Roses
  'bg-gradient-to-br from-fuchsia-400 to-pink-500',
  'bg-gradient-to-br from-pink-400 to-rose-500',
  'bg-gradient-to-br from-rose-400 to-red-500',
  'bg-gradient-to-br from-fuchsia-600 to-rose-700',
  'bg-gradient-to-br from-pink-600 to-red-700',
  // Mixed Gradients
  'bg-gradient-to-br from-yellow-300 to-sky-400',
  'bg-gradient-to-br from-lime-300 to-violet-400',
  'bg-gradient-to-br from-cyan-300 to-rose-400',
  'bg-gradient-to-br from-orange-300 to-indigo-400',
  'bg-gradient-to-br from-teal-300 to-pink-400',
  'bg-gradient-to-br from-green-300 to-purple-400',
  'bg-gradient-to-br from-blue-300 to-amber-400',
];

// 3. Simple deterministic string hash function (djb2)
const simpleHash = (str: string): number => {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) + hash) + char; /* hash * 33 + c */
  }
  return Math.abs(hash); // Ensure positive result for modulo
};

// 4. getLlmColor function using the hybrid approach
export const getLlmColor = (modelId?: string | null): string => {
  const defaultColor = 'bg-gradient-to-br from-gray-400 to-gray-500'; // Define default
  if (!modelId) {
    return defaultColor;
  }

  // Check curated map first
  if (curatedLlmColorMap[modelId]) {
    return curatedLlmColorMap[modelId];
  }

  // Fallback to hashing with the expanded palette
  const hash = simpleHash(modelId);
  const index = hash % extendedColorPalette.length;
  return extendedColorPalette[index] || defaultColor; // Fallback to default if index is somehow invalid
};

// 5. Agent Color Mapping
export const getAgentColorClass = (colorName?: string): string | null => {
  if (!colorName) return null;

  const colorMap: Record<string, string> = {
    'amber': 'bg-gradient-to-br from-amber-400 to-yellow-500',
    'green': 'bg-gradient-to-br from-green-400 to-emerald-500',
    'blue': 'bg-gradient-to-br from-blue-400 to-indigo-500',
    'slate': 'bg-gradient-to-br from-slate-400 to-gray-500',
    'red': 'bg-gradient-to-br from-red-400 to-rose-500',
    'purple': 'bg-gradient-to-br from-purple-400 to-fuchsia-500',
    'orange': 'bg-gradient-to-br from-orange-400 to-amber-500',
    'pink': 'bg-gradient-to-br from-pink-400 to-rose-500',
    'cyan': 'bg-gradient-to-br from-cyan-400 to-sky-500',
    'teal': 'bg-gradient-to-br from-teal-400 to-emerald-500',
    'yellow': 'bg-gradient-to-br from-yellow-400 to-amber-500',
    'gray': 'bg-gradient-to-br from-gray-400 to-slate-500',
    'zinc': 'bg-gradient-to-br from-zinc-400 to-neutral-500',
    'neutral': 'bg-gradient-to-br from-neutral-400 to-stone-500',
    'stone': 'bg-gradient-to-br from-stone-400 to-neutral-500',
    'lime': 'bg-gradient-to-br from-lime-400 to-green-500',
    'emerald': 'bg-gradient-to-br from-emerald-400 to-teal-500',
    'sky': 'bg-gradient-to-br from-sky-400 to-blue-500',
    'indigo': 'bg-gradient-to-br from-indigo-400 to-violet-500',
    'violet': 'bg-gradient-to-br from-violet-400 to-purple-500',
    'fuchsia': 'bg-gradient-to-br from-fuchsia-400 to-pink-500',
    'rose': 'bg-gradient-to-br from-rose-400 to-red-500',
  };

  return colorMap[colorName.toLowerCase()] || (colorName.startsWith('bg-') ? colorName : null);
};

// --- Color Mapping Helpers ---

// Tailwind color mapping for canvas rendering (MiniMap uses canvas/SVG which needs hex)
export const TAILWIND_COLORS: Record<string, string> = {
  // Teals/Cyans
  'teal-400': '#2dd4bf', 'teal-500': '#14b8a6',
  'cyan-500': '#06b6d4', 'cyan-600': '#0891b2',
  'sky-300': '#7dd3fc', 'sky-400': '#38bdf8', 'sky-500': '#0ea5e9',

  // Blues/Indigos
  'blue-400': '#60a5fa', 'blue-500': '#3b82f6',
  'indigo-400': '#818cf8', 'indigo-500': '#6366f1', 'indigo-600': '#4f46e5',

  // Purples/Pinks
  'purple-500': '#a855f7', 'purple-600': '#9333ea',
  'fuchsia-500': '#d946ef', 'fuchsia-600': '#c026d3',
  'pink-400': '#f472b6', 'pink-500': '#ec4899',
  'rose-400': '#fb7185', 'rose-500': '#f43f5e',

  // Reds/Oranges/Yellows
  'red-300': '#fca5a5', 'red-400': '#f87171', 'red-500': '#ef4444',
  'orange-400': '#fb923c', 'orange-500': '#f97316',
  'amber-400': '#fbbf24', 'amber-500': '#f59e0b', 'amber-600': '#d97706',
  'yellow-300': '#fde047', 'yellow-400': '#facc15', 'yellow-500': '#eab308',

  // Greens/Limes
  'lime-400': '#a3e635', 'lime-500': '#84cc16', 'lime-600': '#65a30d',
  'green-400': '#4ade80', 'green-500': '#22c55e',
  'emerald-400': '#34d399', 'emerald-500': '#10b981',

  // Grays
  'gray-400': '#9ca3af', 'gray-500': '#6b7280',
};

// Extract the primary color from a Tailwind gradient string (e.g. "bg-gradient-to-br from-teal-400 ...")
export const extractColorFromClasses = (classes?: string): string | null => {
  if (!classes) return null;

  // Try to find 'from-X-Y' pattern
  const fromMatch = classes.match(/from-([a-z]+-\d+)/);
  if (fromMatch && fromMatch[1] && TAILWIND_COLORS[fromMatch[1]]) {
    return TAILWIND_COLORS[fromMatch[1]];
  }

  // Fallback: try to find any color class that matches our map
  for (const colorName of Object.keys(TAILWIND_COLORS)) {
    if (classes.includes(colorName)) {
      return TAILWIND_COLORS[colorName];
    }
  }

  return null;
};

// --- Cumulative Token Calculation Helper ---
export const calculateCumulativeTokens = (
  messages: Message[],
  targetMessageId: string | null,
  summaries: Summary[] = [],
  disabledSummaryIds: Set<string> = new Set()
): number => {
  if (!targetMessageId || messages.length === 0) {
    return 0;
  }

  const messageMap = new Map<string, Message>(messages.map(m => [m.id, m]));

  // Pre-calculate active summaries map (endMessageId -> Summary)
  const activeSummaries = summaries.filter(s => !disabledSummaryIds.has(s.id));
  const summaryEndMap = new Map<string, Summary>(activeSummaries.map(s => [s.endMessageId, s]));

  let cumulativeTokens = 0;
  let currentId: string | null = targetMessageId;
  const visitedIds = new Set<string>(); // To prevent infinite loops in case of data cycles
  const MAX_DEPTH = 100; // Safety break
  let depth = 0;

  while (currentId && depth < MAX_DEPTH && !visitedIds.has(currentId)) {
    visitedIds.add(currentId);

    // Check if current message is the END of an active summary
    if (summaryEndMap.has(currentId)) {
      const summary = summaryEndMap.get(currentId)!;

      // Add estimated tokens for the summary content
      // 1 token ~= 4 chars (English)
      const estimatedSummaryTokens = Math.ceil(summary.content.length / 4);
      cumulativeTokens += estimatedSummaryTokens;

      // Jump to the parent of the summary's start message
      const startMsg = messageMap.get(summary.startMessageId);
      if (startMsg) {
        currentId = startMsg.parentId;
        depth++;
        continue;
      }
    }

    const message = messageMap.get(currentId);

    if (!message) {
      console.warn(`[calculateCumulativeTokens] Message ${currentId} not found during traversal.`);
      break;
    }

    // Add the total tokens for ASSISTANT messages encountered on the path
    if (message.role === 'assistant') {
      cumulativeTokens += message.totalTokens ?? 0; // Add totalTokens if available, otherwise 0
    }

    currentId = message.parentId; // Move up the chain
    depth++;
  }

  if (depth === MAX_DEPTH) console.warn(`[calculateCumulativeTokens] Traversal truncated at ${MAX_DEPTH} for target ${targetMessageId}`);
  if (currentId && visitedIds.has(currentId)) console.warn(`[calculateCumulativeTokens] Loop detected for target ${targetMessageId}.`);

  return cumulativeTokens;
};


// --- Graph Element Mapping Function ---
const readLookupValue = <T,>(
  lookup: Map<string, T> | Record<string, T> | null | undefined,
  key: string
): T | undefined => {
  if (!lookup) return undefined;
  if (lookup instanceof Map) return lookup.get(key);
  return lookup[key];
};

export const mapMessagesToGraphElements = (
  projection: WorkspaceProjection,
  messages: Message[],
  summaries: Summary[], // Added summaries
  focusedMessageId: string | null,
  contextPathMessageIds: Set<string>,
  matchingMessageIds: Set<string>, // Contains IDs of messages matching the filter
  filterActive: boolean, // Whether any graph filter is currently active
  hasNodeTypeFilter: boolean = false,
  keepAncestors: boolean = true,
  keepDescendants: boolean = true,
  disabledSummaryIds: Set<string> = new Set(), // Set of disabled summary IDs
  onToggleSummary: (id: string) => void = () => { }, // Callback to toggle summary
  measuredNodeHeights: Map<string, number> = new Map(),
  insights: any[] = [], // Background agent insights
  showInsightsInGraph: boolean = false, // Whether to show insights as ghost nodes
  workspaceRepoMap: Map<string, string | null> = new Map(),
  branchPointersByNodeId: Map<string, BranchPointer[]> = new Map(),
  activeScopeId: string | null = null,
  scopeViewMode: 'project' | 'scope' = 'project',
  scopeNameById: Map<string, string> = new Map(),
  scopeColorById: Map<string, string | null> = new Map(),
  onToggleCollapse: (id: string, collapsed: boolean) => void = () => { }, // New callback
  onFocus: (id: string) => void = () => { },
  onSelect: (id: string, multi: boolean) => void = () => { },
  onContextMenu: (id: string, e: React.MouseEvent) => void = () => { },
  onMeasureNodeHeight: (id: string, height: number) => void = () => { }
): { nodes: Node<LlmNodeData | SummaryNodeData | Record<string, unknown> | any>[]; edges: Edge[] } => {
  if (!messages || messages.length === 0) {
    return { nodes: [], edges: [] };
  }

  const nodes: Node<LlmNodeData | SummaryNodeData | Record<string, unknown>>[] = [];
  const edges: Edge[] = [];
  const messageMap = new Map<string, Message>(messages.map(m => [m.id, m]));
  const messageIdByCommitSha = new Map<string, string>();
  const renderedCommitNodeIdBySha = new Map<string, string>();
  messages.forEach((message) => {
    const sha = getMessageOutputCommitSha(message) ?? '';
    if (!sha) return;
    messageIdByCommitSha.set(sha, message.id);
    const nodeKind = classifyMessageNodeKind(message, messageMap);
    renderedCommitNodeIdBySha.set(
      sha,
      nodeKind === 'commit_message' ? message.id : getAssistantOutputCommitNodeId(message.id),
    );
  });
  projection.groupIdByCommitSha.forEach((groupId, sha) => {
    renderedCommitNodeIdBySha.set(sha, groupId);
  });

  // Inject branchPointers from the branchPointersByNodeId map onto each message.
  // The server does not eagerly load this association, so we enrich messages here
  // so that all downstream consumers (standalone commit nodes, batch commit nodes,
  // projection entities) can read message.branchPointers naturally.
  for (const [nodeId, pointers] of branchPointersByNodeId) {
    const msg = messageMap.get(nodeId);
    if (msg && pointers.length > 0) {
      (msg as any).branchPointers = pointers;
    }
  }

  const assistantChildrenMap = new Map<string, Message[]>();
  const assistantParentByAssistantId = new Map<string, string | null>();
  const assistantChildIdsByAssistantId = new Map<string, string[]>();
  const contextPathNodes = new Set<string>(contextPathMessageIds);
  const contextPathEdges = new Set<string>();

  // Calculate Origin Message ID for hull labels
  const originMessageId = messages.find(m => m.parentId === null)?.id;

  try {
    // Grouping
    messages.forEach(msg => {
      const graphParentId = getGraphParentId(msg, messageMap);
      if (msg.role === 'assistant' && graphParentId) {
        const directParent = messageMap.get(graphParentId);
        if (directParent?.role === 'assistant') {
          assistantParentByAssistantId.set(msg.id, directParent.id);
          if (!assistantChildIdsByAssistantId.has(directParent.id)) {
            assistantChildIdsByAssistantId.set(directParent.id, []);
          }
          assistantChildIdsByAssistantId.get(directParent.id)!.push(msg.id);
          return;
        }

        if (!assistantChildrenMap.has(graphParentId)) {
          assistantChildrenMap.set(graphParentId, []);
        }
        assistantChildrenMap.get(graphParentId)?.push(msg);

        const parentUserMsg = messageMap.get(graphParentId);
        const parentAssistantId = parentUserMsg?.role === 'user' ? parentUserMsg.parentId : null;
        assistantParentByAssistantId.set(msg.id, parentAssistantId ?? null);
        if (parentAssistantId) {
          if (!assistantChildIdsByAssistantId.has(parentAssistantId)) {
            assistantChildIdsByAssistantId.set(parentAssistantId, []);
          }
          assistantChildIdsByAssistantId.get(parentAssistantId)!.push(msg.id);
        }
      }
    });
    // Context Path Calculation - highlight the messages that will be passed
    // into the next agent run, not the focused graph lineage.
    contextPathNodes.forEach((messageId) => {
      const msg = messageMap.get(messageId);
      const parentId = msg ? getGraphParentId(msg, messageMap) : null;
      if (parentId && contextPathNodes.has(parentId)) {
        contextPathEdges.add(`${parentId}->${msg!.id}`);
      }
    });

    // Identify Summarized Nodes and Pre-calculate Status
    const summarizedMessageIds = new Set<string>();
    const disabledSummaryStartNodeMap = new Map<string, string>();
    const messageToSummaryIdMap = new Map<string, Set<string>>();
    const summaryStatusMap = new Map<string, { isActive: boolean, isEnabled: boolean }>();

    summaries.forEach(summary => {
      const isEnabled = !disabledSummaryIds.has(summary.id);

      // Calculate Active Status (Descendant Focus)
      const isPathThroughSummary = contextPathNodes.has(summary.endMessageId);
      const isFocusedEnd = focusedMessageId === summary.endMessageId;
      const isActive = isPathThroughSummary && !isFocusedEnd;

      summaryStatusMap.set(summary.id, { isActive, isEnabled });

      if (!isEnabled) {
        disabledSummaryStartNodeMap.set(summary.startMessageId, summary.id);
      }

      // Map messages to summary (Support Nested Summaries)
      const addSummaryToMap = (msgId: string) => {
        if (!messageToSummaryIdMap.has(msgId)) {
          messageToSummaryIdMap.set(msgId, new Set());
        }
        messageToSummaryIdMap.get(msgId)!.add(summary.id);
      };

      let currentId: string | null = summary.endMessageId;
      while (currentId && currentId !== summary.startMessageId) {
        summarizedMessageIds.add(currentId);
        addSummaryToMap(currentId);
        const msg = messageMap.get(currentId);
        currentId = msg ? msg.parentId : null;
      }
      if (currentId === summary.startMessageId) {
        summarizedMessageIds.add(summary.startMessageId);
        addSummaryToMap(summary.startMessageId);
      }
    });

    // --- Collapse Logic ---
    const childrenMap = new Map<string, string[]>();
    messages.forEach(m => {
      const graphParentId = getGraphParentId(m, messageMap);
      if (graphParentId) {
        if (!childrenMap.has(graphParentId)) childrenMap.set(graphParentId, []);
        childrenMap.get(graphParentId)!.push(m.id);
      }
    });

    // Collapse detection is handled in isNodeHidden

    const hiddenNodes = new Set<string>();
    const hiddenDescendantCounts = new Map<string, number>();
    const memoizedIsHidden = new Map<string, boolean>();

    const isNodeHidden = (msgId: string): boolean => {
      if (memoizedIsHidden.has(msgId)) return memoizedIsHidden.get(msgId)!;

      const msg = messageMap.get(msgId);
      const graphParentId = msg ? getGraphParentId(msg, messageMap) : null;
      if (!msg || !graphParentId) {
        memoizedIsHidden.set(msgId, false);
        return false;
      }

      // Check parent.
      // External commit-import assistants are rendered as dedicated cluster nodes.
      // Their historical collapsed flag should not hide downstream chat/agent branches.
      const parent = messageMap.get(graphParentId);
      const parentCollapseApplies = parent && parent.collapsed && !isExternalCommitAssistant(parent);
      if (parentCollapseApplies) {
        memoizedIsHidden.set(msgId, true);
        return true;
      }

      const parentHidden = isNodeHidden(graphParentId);
      memoizedIsHidden.set(msgId, parentHidden);
      return parentHidden;
    };

    // Calculate hidden descendants for collapsed nodes
    messages.forEach(msg => {
      if (msg.collapsed) {
        let count = 0;
        const stack = [...(childrenMap.get(msg.id) || [])];
        while (stack.length > 0) {
          const childId = stack.pop()!;
          count++;
          const grandChildren = childrenMap.get(childId) || [];
          stack.push(...grandChildren);
        }
        hiddenDescendantCounts.set(msg.id, count);
      }

      if (isNodeHidden(msg.id)) {
        hiddenNodes.add(msg.id);
      }
    });

    // Branch Visibility Logic:
    // When filter is active, keep only branches connected to matching assistant nodes.
    // A branch is considered visible if it lies on an ancestor path to a match
    // or is a descendant of a match.
    const visibleAssistantIds = new Set<string>();
    if (filterActive) {
      const seedAssistantIds = new Set<string>();

      matchingMessageIds.forEach((messageId) => {
        const message = messageMap.get(messageId);
        if (!message) return;

        if (message.role === 'assistant') {
          seedAssistantIds.add(message.id);
          return;
        }

        const parentAssistant = message.parentId ? messageMap.get(message.parentId) : null;
        if (parentAssistant?.role === 'assistant') {
          seedAssistantIds.add(parentAssistant.id);
        }

        const assistantChildren = assistantChildrenMap.get(message.id) ?? [];
        assistantChildren.forEach((child) => {
          seedAssistantIds.add(child.id);
        });
      });

      const markAncestorsVisible = (assistantId: string) => {
        let currentId: string | null = assistantId;
        const visited = new Set<string>();
        while (currentId && !visited.has(currentId)) {
          visited.add(currentId);
          visibleAssistantIds.add(currentId);
          currentId = assistantParentByAssistantId.get(currentId) ?? null;
        }
      };

      const markDescendantsVisible = (assistantId: string) => {
        const stack = [assistantId];
        const visited = new Set<string>();
        while (stack.length > 0) {
          const currentId = stack.pop()!;
          if (visited.has(currentId)) continue;
          visited.add(currentId);
          visibleAssistantIds.add(currentId);
          const children = assistantChildIdsByAssistantId.get(currentId) ?? [];
          stack.push(...children);
        }
      };

      seedAssistantIds.forEach((assistantId) => {
        visibleAssistantIds.add(assistantId);
        if (keepAncestors) {
          markAncestorsVisible(assistantId);
        }
        if (keepDescendants) {
          markDescendantsVisible(assistantId);
        }
      });
    }

    const isAssistantVisible = (assistantId: string): boolean => {
      if (!filterActive) return true;
      return visibleAssistantIds.has(assistantId);
    };

    const shouldRenderMessageNode = (messageId: string): boolean => {
      if (!filterActive || !hasNodeTypeFilter) return true;
      return matchingMessageIds.has(messageId);
    };

    const isMessageInVisibleBranch = (messageId: string): boolean => {
      if (!filterActive) return true;
      const msg = messageMap.get(messageId);
      if (!msg) return false;
      if (msg.role === 'assistant') return isAssistantVisible(msg.id);
      if (msg.role === 'user') {
        const parentAssistant = msg.parentId ? messageMap.get(msg.parentId) : null;
        if (parentAssistant?.role === 'assistant' && isAssistantVisible(parentAssistant.id)) {
          return true;
        }
        const assistantChildren = assistantChildrenMap.get(msg.id) ?? [];
        return assistantChildren.some(child => isAssistantVisible(child.id));
      }
      return false;
    };

    const hasMaterializedCommitChild = (assistantId: string, commitSha: string): boolean => (
      messages.some((candidate) => (
        candidate.role === 'assistant'
        && classifyMessageNodeKind(candidate, messageMap) === 'commit_message'
        && getGraphParentId(candidate, messageMap) === assistantId
        && getMessageOutputCommitSha(candidate) === commitSha
      ))
    );

    const inferAssistantBaseCommitSha = (assistantMessage: Message): string | null => {
      const explicitBaseSha = getMessageBaseCommitSha(assistantMessage);
      if (explicitBaseSha) return explicitBaseSha;

      const parentUserId = getGraphParentId(assistantMessage, messageMap);
      const parentUserMessage = parentUserId ? messageMap.get(parentUserId) : null;
      if (!parentUserMessage || parentUserMessage.role !== 'user') return null;

      const parentAssistantId = getGraphParentId(parentUserMessage, messageMap);
      const parentAssistantMessage = parentAssistantId ? messageMap.get(parentAssistantId) : null;
      if (!parentAssistantMessage || parentAssistantMessage.role !== 'assistant') return null;

      return getMessageOutputCommitSha(parentAssistantMessage);
    };

    const externalClusterByAssistantId = new Map<string, string>();
    const externalClusterByAssistantCommitKey = new Map<string, string>();

    // Create Nodes and Edges
    messages.forEach((msg) => {
      if (hiddenNodes.has(msg.id)) return;
      if (msg.role === 'assistant' && externalClusterByAssistantId.has(msg.id)) return;
      if (!shouldRenderMessageNode(msg.id)) return;
      if (msg.role === 'assistant' && !isAssistantVisible(msg.id)) return;
      if (msg.role === 'user' && !isMessageInVisibleBranch(msg.id)) return;

      const entity = projection.entitiesByMessageId.get(msg.id);
      if (!entity) return;

      const isFocused = msg.id === focusedMessageId;
      const isInContextPathNode = contextPathNodes.has(msg.id);
      const graphParentId = getGraphParentId(msg, messageMap);
      const matchesTagFilter = !filterActive || matchingMessageIds.has(msg.id);
      const isContextActive = msg.context_active !== false;
      const scopeId = msg.scope_id ?? null;
      const isInActiveScope = !!activeScopeId && scopeId === activeScopeId;
      const isOutsideActiveScope = !!activeScopeId && scopeId !== activeScopeId;
      const isScopeBoundary = isOutsideActiveScope && scopeViewMode === 'scope';
      const scopeDimmed = isOutsideActiveScope && scopeViewMode === 'project' && !isFocused && !isInContextPathNode;
      const nodeKind = classifyMessageNodeKind(msg, messageMap);
      const llmColor = msg.role === 'user'
        ? 'bg-gradient-to-br from-slate-500 to-slate-700'
        : nodeKind === 'commit_message'
          ? 'bg-gradient-to-br from-blue-500 to-indigo-600'
          : getLlmColor(msg.llmModel);

      const width = nodeKind === 'commit_message' ? TURN_COMMIT_NODE_WIDTH : TURN_CONVERSATION_NODE_WIDTH;
      const measuredHeight = nodeKind === 'commit_message' ? undefined : measuredNodeHeights.get(msg.id);
      const height = measuredHeight ?? (nodeKind === 'assistant_message' ? 112 : nodeKind === 'user_message' ? 82 : TURN_COMMIT_NODE_HEIGHT);
      const branchPointers = branchPointersByNodeId.get(msg.id) ?? [];
      const toolCallCount = getToolCallCount(msg);
      const commitCount = getAssistantCommitCount(msg, messages, messageMap);
      const filesChanged = getFilesChanged(msg);
      const changedFilesCount = filesChanged.length || undefined;
      nodes.push({
        id: msg.id,
        type: nodeKind, // Use the canonical node kind as the type
        position: { x: 0, y: 0 },
        data: {
          entity,
          projection,
          isSelected: false, // Selection will be updated in applyVisualProperties
          heightKey: createMessageHeightKey({
            message: msg,
            entity,
            nodeKind,
            branchPointers,
            toolCallCount,
            commitCount,
            changedFilesCount,
          }),
          onMeasureHeight: onMeasureNodeHeight,
          onFocus,
          onSelect,
          onContextMenu,
          message: msg,
          nodeKind,
          repoPath: workspaceRepoMap.get(msg.workspaceId) ?? null,
          branchPointers,
          isFocused,
          isInContextPath: isInContextPathNode,
          llmColor,
          matchesTagFilter: matchesTagFilter,
          filterActive,
          isSummarized: summarizedMessageIds.has(msg.id),
          onToggleSummary,
          summaryIds: messageToSummaryIdMap.has(msg.id) ? Array.from(messageToSummaryIdMap.get(msg.id)!) : undefined,
          hasDisabledSummary: disabledSummaryStartNodeMap.has(msg.id),
          isDense: false,
          collapsed: msg.collapsed,
          onToggleCollapse,
          hiddenDescendantCount: hiddenDescendantCounts.get(msg.id),
          isInsideActiveSummary: (() => {
            const sIds = messageToSummaryIdMap.get(msg.id);
            if (!sIds) return false;
            for (const sId of sIds) {
              const status = summaryStatusMap.get(sId);
              if (status && status.isActive && status.isEnabled) {
                return true;
              }
            }
            return false;
          })(),
          toolCallCount,
          commitCount,
          changedFilesCount,
          agentStatus: resolveNodeState(msg, null).status ?? (msg.agent_id ? 'pending' : null),
          isAgentRunning: ['pending', 'running', 'streaming'].includes(String(resolveNodeState(msg, null).status ?? '')),
          agentId: msg.agent_id ?? null,
          isContextActive,
          scopeId,
          scopeName: scopeId ? (readLookupValue(scopeNameById, scopeId) || null) : null,
          scopeColor: scopeId ? (readLookupValue(scopeColorById, scopeId) || null) : null,
          isInActiveScope,
          isScopeBoundary,
          scopeDimmed,
        },
        style: { width, height, zIndex: 1 },
      } as Node<any>);

      const assistantOutputCommitSha = nodeKind === 'assistant_message' ? getMessageOutputCommitSha(msg) : null;
      const shouldRenderSyntheticOutputCommit = Boolean(
        assistantOutputCommitSha && !hasMaterializedCommitChild(msg.id, assistantOutputCommitSha),
      );
      if (assistantOutputCommitSha && shouldRenderSyntheticOutputCommit) {
        const commitNodeId = getAssistantOutputCommitNodeId(msg.id);
        const parentShas = getRawGitParentShas(msg);
        const baseParentSha = inferAssistantBaseCommitSha(msg);
        const commitParentShas = parentShas.length > 0
          ? parentShas
          : baseParentSha
            ? [baseParentSha]
            : [];
        const commitSubject = ((msg.execution_data as any)?.meta?.commit_message as string | undefined)?.trim()
          || msg.aiLabel?.trim()
          || msg.content?.trim()
          || `Commit ${assistantOutputCommitSha.slice(0, 8)}`;
        const syntheticCommitMessage = {
          ...msg,
          id: `${msg.id}:commit`,
          parentId: msg.id,
          content: commitSubject,
          commit: {
            ...(msg.commit || {}),
            sha: assistantOutputCommitSha,
            subject: commitSubject,
            source_kind: 'agent',
            produced_by_node_id: msg.id,
            first_parent_sha: commitParentShas[0] ?? null,
            parents: commitParentShas.map((parentSha, parentIndex) => ({ parent_sha: parentSha, parent_index: parentIndex })),
          },
        } as Message;
        const syntheticCommitEntity: ProjectedNodeEntity = {
          entityId: `commit_message:${msg.id}:output`,
          kind: 'commit_message',
          messageId: syntheticCommitMessage.id,
          focusMessageId: msg.id,
          parentEntityId: entity.entityId,
          turnGroupId: entity.turnGroupId,
          sortTs: new Date(msg.createdAt).getTime() + 0.5,
          message: syntheticCommitMessage,
          preview: commitSubject,
          shortLabel: assistantOutputCommitSha.slice(0, 8),
          shortSha: assistantOutputCommitSha.slice(0, 8),
          status: null,
          parentShas: commitParentShas,
          commitCount: undefined,
          authorName: typeof ((msg.execution_data as any)?.meta || {}).git_author_name === 'string'
            ? ((msg.execution_data as any).meta.git_author_name as string)
            : null,
          authoredAt: typeof ((msg.execution_data as any)?.meta || {}).git_authored_at === 'string'
            ? ((msg.execution_data as any).meta.git_authored_at as string)
            : msg.updatedAt ?? msg.createdAt ?? null,
          scopeId,
        };
        const commitFilesChanged = getFilesChanged(syntheticCommitMessage);
        nodes.push({
          id: commitNodeId,
          type: 'commit_message',
          position: { x: 0, y: 0 },
          data: {
            entity: syntheticCommitEntity,
            projection,
            isSelected: false,
            heightKey: createMessageHeightKey({
              message: syntheticCommitMessage,
              entity: syntheticCommitEntity,
              nodeKind: 'commit_message',
              branchPointers,
              toolCallCount: undefined,
              commitCount: undefined,
              changedFilesCount: commitFilesChanged.length || undefined,
            }),
            onMeasureHeight: onMeasureNodeHeight,
            onFocus,
            onSelect,
            onContextMenu,
            message: syntheticCommitMessage,
            nodeKind: 'commit_message',
            repoPath: workspaceRepoMap.get(msg.workspaceId) ?? null,
            branchPointers,
            isFocused,
            isInContextPath: isInContextPathNode,
            llmColor: 'bg-gradient-to-br from-blue-500 to-indigo-600',
            matchesTagFilter,
            filterActive,
            isSummarized: summarizedMessageIds.has(msg.id),
            onToggleSummary,
            summaryIds: messageToSummaryIdMap.has(msg.id) ? Array.from(messageToSummaryIdMap.get(msg.id)!) : undefined,
            hasDisabledSummary: disabledSummaryStartNodeMap.has(msg.id),
            isDense: false,
            collapsed: msg.collapsed,
            onToggleCollapse,
            hiddenDescendantCount: hiddenDescendantCounts.get(msg.id),
            isInsideActiveSummary: false,
            changedFilesCount: commitFilesChanged.length || undefined,
            agentStatus: null,
            isAgentRunning: false,
            agentId: msg.agent_id ?? null,
            isContextActive,
            scopeId,
            scopeName: scopeId ? (readLookupValue(scopeNameById, scopeId) || null) : null,
            scopeColor: scopeId ? (readLookupValue(scopeColorById, scopeId) || null) : null,
            isInActiveScope,
            isScopeBoundary,
            scopeDimmed,
          },
          style: { width: TURN_COMMIT_NODE_WIDTH, height: TURN_COMMIT_NODE_HEIGHT, zIndex: 1 },
        } as Node<any>);
      }

      const activeStroke = ACTIVE_EDGE_STROKE;
      const inactiveStroke = INACTIVE_EDGE_STROKE;
      const pushSemanticEdge = ({
        id,
        source,
        target,
        relationship,
        edgeRole,
        layout = true,
        isInContextEdge = false,
        strokeDasharray,
        opacity = 1,
        contextBoundary,
      }: {
        id: string;
        source: string;
        target: string;
        relationship: 'conversation' | 'git-parent' | 'base-used';
        edgeRole: 'conversation' | 'commit-lineage' | 'base';
        layout?: boolean;
        isInContextEdge?: boolean;
        strokeDasharray?: string;
        opacity?: number;
        contextBoundary?: Record<string, unknown>;
      }) => {
        if (source === target) return;
        if (edges.some((edge) => edge.id === id || (edge.source === source && edge.target === target && (edge.data as any)?.relationship === relationship))) return;
        edges.push({
          id,
          source,
          target,
          sourceHandle: 'bottom-source',
          targetHandle: 'top-target',
          type: 'compactLineage',
          animated: isInContextEdge,
          data: {
            edgeLegendType: relationship === 'conversation' && contextBoundary ? 'context-break' : relationship,
            relationship,
            edgeRole,
            layout,
            isOnContextPath: isInContextEdge,
            ...(contextBoundary ? { contextBoundary } : {}),
          },
          style: {
            stroke: isInContextEdge ? activeStroke : inactiveStroke,
            strokeWidth: isInContextEdge ? CONTEXT_PATH_EDGE_STROKE_WIDTH : DEFAULT_EDGE_STROKE_WIDTH,
            strokeDasharray,
            opacity,
          },
          className: isInContextEdge ? 'dark:[stroke:#a5b4fc]' : 'dark:[stroke:#94a3b8]',
          zIndex: isInContextEdge ? 10 : 0,
        });
      };

      if (msg.role === 'user' && graphParentId) {
        const parentMsg = messageMap.get(graphParentId);
        if (parentMsg?.role === 'assistant') {
          if (parentMsg.role === 'assistant' && !externalClusterByAssistantId.has(parentMsg.id) && !isAssistantVisible(parentMsg.id)) return;
          const sourceNodeId = externalClusterByAssistantId.get(parentMsg.id) ?? parentMsg.id;
          const edgeId = `${sourceNodeId}->${msg.id}:conversation`;
          const isInContextEdge = contextPathEdges.has(`${graphParentId}->${msg.id}`) || contextPathEdges.has(`${sourceNodeId}->${msg.id}`);
          const isContextBreak = parentMsg.context_active === false;
          const childAssistantMessages = assistantChildrenMap.get(msg.id) ?? [];
          const hasContextBoundary = hasFreshContextBoundary(msg) || childAssistantMessages.some((child) => hasFreshContextBoundary(child));
          pushSemanticEdge({
            id: edgeId,
            source: sourceNodeId,
            target: msg.id,
            relationship: 'conversation',
            edgeRole: 'conversation',
            isInContextEdge,
            strokeDasharray: isContextBreak ? '6 6' : undefined,
            opacity: isContextBreak ? 0.6 : 1,
            contextBoundary: hasContextBoundary ? {
              type: 'fresh',
              fromNodeId: graphParentId,
              childNodeId: msg.id,
            } : undefined,
          });
        }
      }

      if (nodeKind === 'commit_message') {
        const parentShas = getRawGitParentShas(msg);
        parentShas.forEach((parentSha, parentIndex) => {
          const parentNodeId = renderedCommitNodeIdBySha.get(parentSha);
          if (!parentNodeId || parentNodeId === msg.id) return;
          const parentMessageId = messageIdByCommitSha.get(parentSha);
          if (parentMessageId && !shouldRenderMessageNode(parentMessageId)) return;
          const sourceNodeId = externalClusterByAssistantCommitKey.get(`${parentNodeId}:${parentSha}`)
            ?? externalClusterByAssistantId.get(parentNodeId)
            ?? parentNodeId;
          pushSemanticEdge({
            id: `${sourceNodeId}->${msg.id}:git-parent:${parentIndex}`,
            source: sourceNodeId,
            target: msg.id,
            relationship: 'git-parent',
            edgeRole: 'commit-lineage',
            layout: false,
            isInContextEdge: contextPathEdges.has(`${sourceNodeId}->${msg.id}`),
          });
        });
        if (parentShas.length === 0 && isExternalCommitAssistant(msg) && graphParentId) {
          const parentMsg = messageMap.get(graphParentId);
          const parentNodeKind = parentMsg ? classifyMessageNodeKind(parentMsg, messageMap) : null;
          if (parentMsg?.role === 'assistant' && parentNodeKind === 'commit_message' && shouldRenderMessageNode(parentMsg.id)) {
            pushSemanticEdge({
              id: `${parentMsg.id}->${msg.id}:git-parent:fallback`,
              source: parentMsg.id,
              target: msg.id,
              relationship: 'git-parent',
              edgeRole: 'commit-lineage',
              layout: false,
              isInContextEdge: contextPathEdges.has(`${parentMsg.id}->${msg.id}`),
            });
          }
        }
      }

      if (assistantOutputCommitSha && shouldRenderSyntheticOutputCommit) {
        const commitNodeId = getAssistantOutputCommitNodeId(msg.id);
        const parentShas = getRawGitParentShas(msg);
        const baseParentSha = inferAssistantBaseCommitSha(msg);
        const commitParentShas = parentShas.length > 0
          ? parentShas
          : baseParentSha
            ? [baseParentSha]
            : [];
        commitParentShas.forEach((parentSha, parentIndex) => {
          const parentNodeId = renderedCommitNodeIdBySha.get(parentSha);
          if (!parentNodeId || parentNodeId === commitNodeId) return;
          const parentMessageId = messageIdByCommitSha.get(parentSha);
          if (parentMessageId && !shouldRenderMessageNode(parentMessageId)) return;
          pushSemanticEdge({
            id: `${parentNodeId}->${commitNodeId}:git-parent:${parentIndex}`,
            source: parentNodeId,
            target: commitNodeId,
            relationship: 'git-parent',
            edgeRole: 'commit-lineage',
            layout: false,
            isInContextEdge: contextPathEdges.has(`${parentNodeId}->${commitNodeId}`),
          });
        });
      }

      const assistantBaseCommitSha = nodeKind === 'assistant_message' ? inferAssistantBaseCommitSha(msg) : null;
      if (nodeKind === 'assistant_message' && assistantBaseCommitSha) {
        const baseCommitNodeId = renderedCommitNodeIdBySha.get(assistantBaseCommitSha);
        const baseCommitMessageId = messageIdByCommitSha.get(assistantBaseCommitSha);
        if (baseCommitNodeId && baseCommitNodeId !== msg.id && (!baseCommitMessageId || shouldRenderMessageNode(baseCommitMessageId))) {
          const sourceNodeId = externalClusterByAssistantId.get(baseCommitNodeId) ?? baseCommitNodeId;
          pushSemanticEdge({
            id: `${sourceNodeId}->${msg.id}:base-used`,
            source: sourceNodeId,
            target: msg.id,
            relationship: 'base-used',
            edgeRole: 'base',
            layout: false,
            strokeDasharray: '4 5',
            opacity: 0.72,
          });
        }
      }

    });

    projection.layoutDerivedCommitGroups.forEach((group) => {
      nodes.push({
        id: group.groupId,
        type: 'layout_derived_commit_group',
        position: { x: 0, y: 0 },
        data: {
          group,
          projection,
          sortTs: group.sortTs,
          isSelected: false,
          isFocused: false,
          isInContextPath: false,
          matchesTagFilter: true,
          filterActive,
          onFocus,
          onSelect,
          onContextMenu,
        },
        style: { width: TURN_COMMIT_NODE_WIDTH, height: 118, zIndex: 1 },
      } as Node<any>);
    });

    projection.commitLaneRows.forEach((row) => {
      if (row.type !== 'commit' || !row.commitSha) return;
      if (renderedCommitNodeIdBySha.get(row.commitSha) && renderedCommitNodeIdBySha.get(row.commitSha) !== row.commitSha) return;
      const commit = projection.commitBySha.get(row.commitSha);
      if (!commit) return;
      nodes.push({
        id: commit.sha,
        type: 'canonical_commit',
        position: { x: 0, y: 0 },
        data: {
          commit,
          projection,
          sortTs: commit.sortTs,
          isSelected: false,
          isFocused: false,
          isInContextPath: false,
          matchesTagFilter: true,
          filterActive,
          onFocus,
          onSelect,
          onContextMenu,
        },
        style: { width: TURN_COMMIT_NODE_WIDTH, height: TURN_COMMIT_NODE_HEIGHT, zIndex: 1 },
      } as Node<any>);
      renderedCommitNodeIdBySha.set(commit.sha, commit.sha);
    });

    const renderedNodeIds = new Set(nodes.map((node) => node.id));
    projection.commitBySha.forEach((commit) => {
      const targetNodeId = renderedCommitNodeIdBySha.get(commit.sha);
      if (!targetNodeId || !renderedNodeIds.has(targetNodeId)) return;
      commit.parentRows.forEach((parent, parentIndex) => {
        const sourceNodeId = renderedCommitNodeIdBySha.get(parent.parent_sha);
        if (!sourceNodeId || sourceNodeId === targetNodeId || !renderedNodeIds.has(sourceNodeId)) return;
        const id = `${sourceNodeId}->${targetNodeId}:git-parent:canonical:${parentIndex}`;
        if (edges.some((edge) => edge.id === id || (edge.source === sourceNodeId && edge.target === targetNodeId && (edge.data as any)?.relationship === 'git-parent'))) return;
        edges.push({
          id,
          source: sourceNodeId,
          target: targetNodeId,
          sourceHandle: 'bottom-source',
          targetHandle: 'top-target',
          type: 'compactLineage',
          animated: false,
          data: {
            edgeLegendType: 'git-parent',
            relationship: 'git-parent',
            edgeRole: 'commit-lineage',
            layout: false,
            parentIndex,
            childSha: commit.sha,
            parentSha: parent.parent_sha,
          },
          style: {
            stroke: INACTIVE_EDGE_STROKE,
            strokeWidth: DEFAULT_EDGE_STROKE_WIDTH,
            opacity: 1,
          },
          className: 'dark:[stroke:#94a3b8]',
          zIndex: 0,
        });
      });
    });

    // Create Summary Nodes and Edges
    summaries.forEach(summary => {
      if (filterActive) {
        if (hasNodeTypeFilter && !matchingMessageIds.has(summary.startMessageId) && !matchingMessageIds.has(summary.endMessageId)) {
          return;
        }
        const startVisible = isMessageInVisibleBranch(summary.startMessageId);
        const endVisible = isMessageInVisibleBranch(summary.endMessageId);
        if (!startVisible && !endVisible) return;
      }

      const status = summaryStatusMap.get(summary.id);
      if (!status) return;
      const { isActive, isEnabled } = status;

      // Check if this summary is nested inside another ACTIVE summary
      let isNestedInActive = false;
      const startContainingIds = messageToSummaryIdMap.get(summary.startMessageId);
      const endContainingIds = messageToSummaryIdMap.get(summary.endMessageId);

      if (startContainingIds && endContainingIds) {
        for (const parentId of startContainingIds) {
          if (parentId !== summary.id) {
            // Check if parent also covers the end message (strict containment)
            if (endContainingIds.has(parentId)) {
              const parentStatus = summaryStatusMap.get(parentId);
              if (parentStatus && parentStatus.isActive && parentStatus.isEnabled) {
                isNestedInActive = true;
                break;
              }
            }
          }
        }
      }

      const shouldAnimateEdge = isActive && isEnabled && !isNestedInActive;
      const isNodeHighlighted = isActive && isEnabled && !isNestedInActive;

      // Calculate Bypassed Nodes
      const bypassedNodes: { id: string; role: 'user' | 'assistant'; content: string }[] = [];
      let currentBypassedId: string | null = summary.endMessageId;
      // Traverse backwards from end to start
      while (currentBypassedId && currentBypassedId !== summary.startMessageId) {
        const msg = messageMap.get(currentBypassedId);
        if (msg) {
          bypassedNodes.unshift({ id: msg.id, role: msg.role, content: msg.content }); // Add to front to maintain order
          currentBypassedId = msg.parentId;
        } else {
          break;
        }
      }
      // Add the start message itself
      const startMsgForSummary = messageMap.get(summary.startMessageId);
      if (startMsgForSummary) {
        bypassedNodes.unshift({ id: startMsgForSummary.id, role: startMsgForSummary.role, content: startMsgForSummary.content });
      }
      const measuredSummaryHeight = measuredNodeHeights.get(summary.id);

      // Summary Node
      nodes.push({
        id: summary.id,
        type: 'summary_block', // Use canonical type
        position: { x: 0, y: 0 },
        data: {
          entity: projection.entitiesBySummaryId.get(summary.id),
          projection,
          isSelected: false,
          heightKey: createSummaryHeightKey(summary, isEnabled, bypassedNodes.length),
          onMeasureHeight: onMeasureNodeHeight,
          onFocus,
          onSelect,
          onContextMenu,
          content: summary.content,
          tokenCountBefore: summary.tokenCountBefore,
          tokenCountAfter: summary.tokenCountAfter,
          startMessageId: summary.startMessageId,
          endMessageId: summary.endMessageId,
          isInContextPath: isNodeHighlighted,
          isActive: isEnabled, // Pass enabled state as isActive for toggle button logic
          onToggleSummary: onToggleSummary,
          isDense: false, // DEPRECATED: Always false, dense mode removed
          bypassedNodeCount: bypassedNodes.length,
          bypassedNodes: bypassedNodes,
        },
        style: { width: 180, height: measuredSummaryHeight ?? 100, zIndex: 5, opacity: isEnabled ? 1 : 0.5 },
      } as Node<any>);

      // Edge from Predecessor to Summary
      const startMsg = messageMap.get(summary.startMessageId);
      const predecessorId = startMsg ? getGraphParentId(startMsg, messageMap) : null;
      if (predecessorId) {
        const predecessor = messageMap.get(predecessorId);
        const sourceNodeId = externalClusterByAssistantId.get(predecessorId) ?? predecessorId;
        const predecessorVisible = predecessor
          ? predecessor.role === 'assistant'
            ? isAssistantVisible(predecessor.id)
            : isMessageInVisibleBranch(predecessor.id)
          : false;

        if ((!filterActive || predecessorVisible) && shouldRenderMessageNode(predecessorId)) {
          const activeStroke = ACTIVE_EDGE_STROKE;
          const inactiveStroke = INACTIVE_EDGE_STROKE;
          const baseWidth = shouldAnimateEdge ? FOCUSED_SUMMARY_EDGE_STROKE_WIDTH : DEFAULT_SUMMARY_EDGE_STROKE_WIDTH;

          edges.push({
            id: `${sourceNodeId}->${summary.id}`,
            source: sourceNodeId,
            target: summary.id,
            type: 'summaryEdge',
            animated: shouldAnimateEdge,
            style: {
              stroke: shouldAnimateEdge ? activeStroke : inactiveStroke,
              strokeWidth: baseWidth,
            },
            zIndex: shouldAnimateEdge ? -1 : -3,
            data: { isIngress: true },
          });
        }
      }

      // Edge from Summary to Successors
      // In Parallel Bypass, successors are messages that follow the end of the summary range.
      // i.e., messages whose parent is the endMessageId.
      messages.forEach(msg => {
        if (getGraphParentId(msg, messageMap) !== summary.endMessageId) return;
        if (hiddenNodes.has(msg.id)) return;
        if (msg.role === 'assistant' && externalClusterByAssistantId.has(msg.id)) return;
        if (!projection.entitiesByMessageId.has(msg.id)) return;
        if (!shouldRenderMessageNode(msg.id)) return;

        const targetNodeId = externalClusterByAssistantId.get(msg.id) ?? msg.id;
        const targetVisible = msg.role === 'assistant'
          ? isAssistantVisible(msg.id)
          : isMessageInVisibleBranch(msg.id);
        if (filterActive && !targetVisible) return;

        const isEdgeActive = contextPathNodes.has(msg.id);
        const shouldAnimateSuccessorEdge = isEdgeActive && isEnabled && isActive && !isNestedInActive;
        const activeStroke = ACTIVE_EDGE_STROKE;
        const inactiveStroke = INACTIVE_EDGE_STROKE;
        const baseWidth = shouldAnimateSuccessorEdge ? FOCUSED_SUMMARY_EDGE_STROKE_WIDTH : DEFAULT_SUMMARY_EDGE_STROKE_WIDTH;

        edges.push({
          id: `${summary.id}->${targetNodeId}`,
          source: summary.id,
          target: targetNodeId,
          type: 'summaryEdge',
          animated: shouldAnimateSuccessorEdge,
          style: {
            stroke: shouldAnimateSuccessorEdge ? activeStroke : inactiveStroke,
            strokeWidth: baseWidth,
          },
          zIndex: shouldAnimateSuccessorEdge ? -1 : -3,
          data: { isEgress: true },
        });
      });
    });

    // --- Create Ghost Nodes for Insights ---
    if (showInsightsInGraph && insights.length > 0) {
      insights.forEach(insight => {
        const parentId = insight.parentNodeId;
        if (!parentId) return;

        // Only show if parent exists in the current workspace
        const parentMsg = messageMap.get(parentId);
        if (!parentMsg) return;
        if (!isMessageInVisibleBranch(parentId)) return;

        const ghostNodeId = `ghost_${insight.id}`;
        const llmColor = 'bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-800'; // Neutral for ghost
        const ghostMessage = {
          id: ghostNodeId,
          role: 'assistant',
          content: insight.content,
          parentId,
          createdAt: insight.createdAt,
          llmModel: 'Background Agent',
          workspaceId: parentMsg.workspaceId,
        } as Message;
        const ghostEntity: ProjectedNodeEntity = {
          entityId: `assistant_message:${ghostNodeId}`,
          kind: 'assistant_message',
          messageId: null,
          focusMessageId: parentId,
          parentEntityId: projection.entitiesByMessageId.get(parentId)?.entityId,
          turnGroupId: projection.entitiesByMessageId.get(parentId)?.turnGroupId,
          sortTs: new Date(insight.createdAt).getTime(),
          message: ghostMessage,
          preview: insight.content,
          shortLabel: 'Insight',
          status: null,
          toolCallCount: undefined,
          totalTokens: null,
          commitCount: undefined,
          scopeId: parentMsg.scope_id ?? null,
        };

        nodes.push({
          id: ghostNodeId,
          type: 'assistant_message',
          position: { x: 0, y: 0 },
          data: {
            entity: ghostEntity,
            projection,
            message: ghostMessage,
            isFocused: false,
            isInContextPath: false,
            llmColor: llmColor,
            matchesTagFilter: true, // Always show ghost nodes if enabled
            filterActive: filterActive,
            isGhostBranch: true,
            agentType: insight.agentType,
            insight: insight,
            isDense: false,
          },
          style: {
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            zIndex: 0,
            opacity: 0.7
          },
        } as Node<LlmNodeData>);

        // Edge from parent to ghost node
        // If parent is assistant, connect directly. If user, connect to user's parent (assistant)
        let sourceId: string | undefined;
        if (parentMsg.role === 'assistant') {
          sourceId = externalClusterByAssistantId.get(parentMsg.id) ?? parentMsg.id;
        } else if (parentMsg.role === 'user' && parentMsg.parentId) {
          const grandParent = messageMap.get(parentMsg.parentId);
          if (grandParent?.role === 'assistant') {
            sourceId = externalClusterByAssistantId.get(grandParent.id) ?? grandParent.id;
          }
        }

        if (sourceId) {
          edges.push({
            id: `${sourceId}->${ghostNodeId}`,
            source: sourceId,
            target: ghostNodeId,
            type: 'smoothstep',
            animated: false,
            data: {
              edgeLegendType: 'context-break',
              relationship: 'conversation',
              edgeRole: 'conversation',
              layout: false,
              isReference: true,
            },
            style: {
              stroke: INACTIVE_EDGE_STROKE,
              strokeWidth: DEFAULT_EDGE_STROKE_WIDTH,
              strokeDasharray: '5,5', // Dashed edge for ghost branch
            },
            className: 'dark:[stroke:#94a3b8]',
            zIndex: -1,
          });
        }
      });
    }


    // --- Add Turn Group Hulls ---
    projection.turnGroups.forEach((tg: ProjectedTurnGroup) => {
      // Only add hull if at least one member is visible
      const isVisible = tg.memberEntityIds.some((eid: string) => {
        const mid = projection.entitiesById.get(eid)?.messageId;
        return mid && !hiddenNodes.has(mid);
      });

      if (!isVisible) return;

      const userMsg = messageMap.get(tg.userMessageId);
      const scopeId = userMsg?.scope_id ?? null;
      const scopeColor = scopeId ? (readLookupValue(scopeColorById, scopeId) || null) : null;

      nodes.push({
        id: `hull:${tg.turnGroupId}`,
        type: 'turn_group_hull',
        position: { x: 0, y: 0 }, // Position will be set by layout
        data: {
          label: tg.userMessageId === originMessageId ? 'Origin' : undefined,
          scopeColor,
          memberIds: tg.memberEntityIds
            .map((eid: string) => {
              const entity = projection.entitiesById.get(eid);
              return entity?.messageId || entity?.summary?.id || null;
            })
            .filter(Boolean),
        },
        style: { zIndex: -1 },
      } as Node<any>);
    });

    return { nodes, edges };

  } catch (error) {
    console.error("[mapMessagesToGraphElements] Error during processing:", error);
    return { nodes: [], edges: [] };
  }
};

// --- Layout Calculation ---
export const getLayoutedElements = (nodes: Node<LlmNodeData | SummaryNodeData | Record<string, unknown>>[], edges: Edge[]) => {
  const isLayoutEdge = (edge: Edge) => {
    if (edge.data && (edge.data as { layout?: boolean }).layout === false) return false;
    return true;
  };
  const { layoutNodes, layoutEdges, unitByNodeId, membersByUnitId } = buildLayoutModel(nodes as Node<any>[], edges, isLayoutEdge);
  const dagreGraph = new dagre.graphlib.Graph({ compound: true });
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  // Always use normal layout constants (dense mode removed)
  dagreGraph.setGraph({ rankdir: 'TB', ranksep: RANK_SEP, nodesep: NODE_SEP, align: 'UL' });

  layoutNodes.forEach(currentNode => {
    dagreGraph.setNode(currentNode.id, {
      width: getNodeWidth(currentNode),
      height: getNodeHeight(currentNode),
    });
  });

  layoutEdges.forEach(edge => {
    if (dagreGraph.hasNode(edge.source) && dagreGraph.hasNode(edge.target)) {
      dagreGraph.setEdge(edge.source, edge.target);
    } else {
      console.warn(`[getLayoutedElements] Skipping edge ${edge.id} - source or target node not found.`);
    }
  });

  try {
    dagre.layout(dagreGraph);

    // --- Post-Layout Adjustment: Center Summary Nodes ---
    // Group nodes by summaryId to find the vertical range of each summary
    const summaryRanges = new Map<string, { minY: number, maxY: number }>();

    nodes.forEach(node => {
      if (isMessageNodeType(node.type) && node.data) {
        const data = node.data as LlmNodeData;
        const unitId = unitByNodeId.get(node.id);
        const nodePos = unitId ? dagreGraph.node(unitId) : null;
        if (!nodePos) return;
        if (data.summaryIds) {
          data.summaryIds.forEach(summaryId => {
            const current = summaryRanges.get(summaryId) || { minY: Infinity, maxY: -Infinity };
            summaryRanges.set(summaryId, {
              minY: Math.min(current.minY, nodePos.y),
              maxY: Math.max(current.maxY, nodePos.y)
            });
          });
        }
      }
    });

    // Adjust Y position of summary nodes
    nodes.forEach(node => {
      if (isSummaryNodeType(node.type)) {
        let midY: number | null = null;

        // Strategy 1: Center between Predecessor and Successor (Bracket Endpoints)
        // This ensures the summary node is centered relative to the visual "bracket"
        const unitId = unitByNodeId.get(node.id);
        if (!unitId) return;
        const ingressEdges = layoutEdges.filter(e => e.target === unitId);
        const egressEdges = layoutEdges.filter(e => e.source === unitId);

        if (ingressEdges.length > 0 && egressEdges.length > 0) {
          // Find average bottom of predecessors
          let totalPrevBottom = 0;
          let prevCount = 0;
          ingressEdges.forEach(e => {
            const prevNode = dagreGraph.node(e.source);
            if (prevNode) {
              totalPrevBottom += (prevNode.y + (prevNode.height || NODE_HEIGHT) / 2);
              prevCount++;
            }
          });

          // Find average top of successors
          let totalNextTop = 0;
          let nextCount = 0;
          egressEdges.forEach(e => {
            const nextNode = dagreGraph.node(e.target);
            if (nextNode) {
              totalNextTop += (nextNode.y - (nextNode.height || NODE_HEIGHT) / 2);
              nextCount++;
            }
          });

          if (prevCount > 0 && nextCount > 0) {
            const avgPrevBottom = totalPrevBottom / prevCount;
            const avgNextTop = totalNextTop / nextCount;
            midY = (avgPrevBottom + avgNextTop) / 2;
          }
        }

        // Strategy 2: Fallback to Content Range (Geometric Center of Summarized Nodes)
        if (midY === null) {
          const range = summaryRanges.get(node.id);
          if (range && range.minY !== Infinity) {
            midY = (range.minY + range.maxY) / 2;
          }
        }

        // Apply calculated Y
        if (midY !== null) {
          const nodePos = dagreGraph.node(unitId);
          if (nodePos) {
            nodePos.y = midY;
          }
        }
      }
    });

  } catch (layoutError) {
    console.error("Dagre layout failed:", layoutError);
    const nodesWithDefaultPos = nodes.map(n => ({ ...n, position: { x: 0, y: 0 } }));
    return { nodes: nodesWithDefaultPos, edges: edges };
  }

  const layoutedUnitNodes = layoutNodes.map((currentNode) => {
    const nodeWithPosition = dagreGraph.node(currentNode.id);
    if (!nodeWithPosition) {
      console.warn(`[getLayoutedElements] Dagre missing position for node: ${currentNode.id}`);
      return { ...currentNode, position: { x: 0, y: 0 } };
    }

    const nodeWidth = nodeWithPosition.width || getNodeWidth(currentNode);
    const nodeHeight = nodeWithPosition.height || getNodeHeight(currentNode);
    const finalPosition = { x: nodeWithPosition.x - nodeWidth / 2, y: nodeWithPosition.y - nodeHeight / 2 };

    const targetPosition = currentNode.type !== 'default' ? Position.Top : undefined;
    const sourcePosition = currentNode.type !== 'default' ? Position.Bottom : undefined;

    return {
      ...currentNode,
      targetPosition: targetPosition,
      sourcePosition: sourcePosition,
      position: finalPosition,
      style: { ...currentNode.style, width: nodeWidth, height: nodeHeight }
    };
  });

  const compactedUnitNodes = compactDagreUnitLayout(layoutedUnitNodes as Node<any>[], layoutEdges);

  let layoutedNodes = expandLayoutedUnits(nodes as Node<any>[], compactedUnitNodes as Node<any>[], membersByUnitId);

  // Sanitize positions to prevent NaN errors
  layoutedNodes.forEach(n => {
    if (Number.isNaN(n.position.x) || Number.isNaN(n.position.y)) {
      console.error(`[getLayoutedElements] Node ${n.id} has NaN position! Resetting to (0,0).`);
      n.position = { x: 0, y: 0 };
    }
  });

  // Calculate bounding box to center the graph
  if (layoutedNodes.length > 0) {
    const minX = Math.min(...layoutedNodes.map(n => n.position.x));
    // We don't shift Y because we want to keep top alignment or preserve relative Y
    // Actually, shifting X to start at 0 is good practice
    layoutedNodes.forEach(n => {
      n.position.x -= minX;
    });
  }

  layoutedNodes = applyTurnGroupHullBounds(layoutedNodes);

  return { nodes: layoutedNodes, edges: edges };

};

// --- Lane-Based Temporal Layout (Custom) ---
export const getLaneLayoutedElements = (
  nodes: Node<LlmNodeData | SummaryNodeData | Record<string, unknown>>[],
  edges: Edge[],
  laneStrategy: 'right' | 'balanced' = 'right'
) => {
  const isLayoutEdge = (edge: Edge) => {
    if (edge.data && (edge.data as { isReference?: boolean; layout?: boolean }).layout === false) return false;
    if (edge.data && (edge.data as { isReference?: boolean }).isReference) return false;
    if (edge.type === 'summaryEdge') return false;
    return true;
  };
  const layoutModel = buildLayoutModel(nodes as Node<any>[], edges, isLayoutEdge);
  const layoutNodes = layoutModel.layoutNodes;
  const layoutEdges = layoutModel.layoutEdges;

  // Always use normal layout constants (dense mode removed)
  const maxNodeWidth = Math.max(...layoutNodes.map(getNodeWidth), NODE_WIDTH);
  const maxNodeHeight = Math.max(...layoutNodes.map(getNodeHeight), NODE_HEIGHT);
  const nodeHeight = maxNodeHeight;
  const rowHeight = nodeHeight + RANK_SEP;
  const laneGap = 56;
  const laneWidth = maxNodeWidth + laneGap;
  const groupPadding = 20;

  const nodeIndexMap = new Map<string, number>();
  layoutNodes.forEach((n, idx) => nodeIndexMap.set(n.id, idx));

  const nodesById = new Map<string, Node<any>>();
  layoutNodes.forEach(n => nodesById.set(n.id, n));

  const createdAtMap = new Map<string, number>();
  layoutNodes.forEach(n => {
    const ts = getNodeCreatedAtTs(n);
    if (ts !== undefined) createdAtMap.set(n.id, ts);
  });

  const laneNodeIds = new Set<string>();
  layoutNodes.forEach(n => {
    if (!isSummaryNodeType(n.type) && isPrimaryLayoutNodeType(n.type)) {
      laneNodeIds.add(n.id);
    }
  });

  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();

  layoutEdges.forEach(edge => {
    if (!laneNodeIds.has(edge.source) || !laneNodeIds.has(edge.target)) return;
    if (!incoming.has(edge.target)) incoming.set(edge.target, new Set());
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, new Set());
    incoming.get(edge.target)!.add(edge.source);
    outgoing.get(edge.source)!.add(edge.target);
  });

  const sortByTime = (a: string, b: string) => {
    const nodeA = nodesById.get(a);
    const nodeB = nodesById.get(b);
    const priorityA =
      nodeA && isOriginNode(nodeA)
        ? 1
        : 2;
    const priorityB =
      nodeB && isOriginNode(nodeB)
        ? 1
        : 2;
    if (priorityA !== priorityB) return priorityA - priorityB;

    const ta = createdAtMap.get(a);
    const tb = createdAtMap.get(b);
    if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
    if (ta !== undefined && tb === undefined) return -1;
    if (ta === undefined && tb !== undefined) return 1;
    const ia = nodeIndexMap.get(a) ?? 0;
    const ib = nodeIndexMap.get(b) ?? 0;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  };

  // Global temporal ordering
  const timeOrdered = Array.from(laneNodeIds);
  timeOrdered.sort(sortByTime);
  const rowByNode = new Map<string, number>();
  timeOrdered.forEach((id, idx) => rowByNode.set(id, idx));

  const laneByNode = new Map<string, number>();
  let nextLaneIndex = 0;
  let minLaneIndex = 0;
  const usedLanesByRow = new Map<number, Set<number>>();

  const childrenByParent = new Map<string, string[]>();
  outgoing.forEach((targets, source) => {
    const children = Array.from(targets);
    children.sort(sortByTime);
    childrenByParent.set(source, children);
  });

  const siblingIndexMap = new Map<string, number>();
  const siblingCountMap = new Map<string, number>();
  childrenByParent.forEach((children, parentId) => {
    siblingCountMap.set(parentId, children.length);
    children.forEach((childId, idx) => {
      siblingIndexMap.set(childId, idx);
    });
  });

  const balancedOffset = (index: number) => {
    const n = index;
    const step = Math.ceil(n / 2);
    return n % 2 === 1 ? step : -step;
  };

  const ensureNextLaneIndex = (lane: number) => {
    if (lane >= nextLaneIndex) nextLaneIndex = lane + 1;
    if (lane < minLaneIndex) minLaneIndex = lane;
  };

  const claimLaneForRow = (lane: number, row: number) => {
    let finalLane = lane;
    if (!usedLanesByRow.has(row)) usedLanesByRow.set(row, new Set());
    const used = usedLanesByRow.get(row)!;
    while (used.has(finalLane)) {
      finalLane += 1;
    }
    used.add(finalLane);
    return finalLane;
  };

  let balancedFlip = 1;

  timeOrdered.forEach(nodeId => {
    if (laneByNode.has(nodeId)) return;
    const currentRow = rowByNode.get(nodeId) ?? 0;
    const parents = Array.from(incoming.get(nodeId) ?? []);
    parents.sort(sortByTime);
    const parentId = parents.length > 0 ? parents[0] : null;
    const parentLane = parentId ? laneByNode.get(parentId) ?? null : null;
    const siblingIndex = siblingIndexMap.get(nodeId) ?? 0;
    const siblingCount = parentId ? (siblingCountMap.get(parentId) ?? 0) : 0;

    let lane: number;
    if (parentLane !== null && siblingIndex === 0) {
      lane = parentLane;
    } else if (laneStrategy === 'balanced' && parentLane !== null) {
      let offset: number;
      if (siblingCount === 2 && siblingIndex === 1) {
        offset = balancedFlip;
        balancedFlip = balancedFlip * -1;
      } else {
        offset = balancedOffset(siblingIndex);
      }
      lane = parentLane + offset;
    } else if (laneStrategy === 'right' && parentLane !== null) {
      lane = parentLane + Math.max(1, siblingIndex);
    } else {
      lane = nextLaneIndex++;
    }

    lane = claimLaneForRow(lane, currentRow);
    ensureNextLaneIndex(lane);
    laneByNode.set(nodeId, lane);
  });

  // Assign any remaining nodes (disconnected or cyclic)
  const remaining = Array.from(laneNodeIds).filter(id => !laneByNode.has(id));
  remaining.sort(sortByTime);
  remaining.forEach(id => {
    const lane = nextLaneIndex++;
    const row = rowByNode.get(id) ?? 0;
    const claimedLane = claimLaneForRow(lane, row);
    ensureNextLaneIndex(claimedLane);
    laneByNode.set(id, claimedLane);
  });

  const positions = new Map<string, { x: number; y: number }>();

  const laneOffset = minLaneIndex < 0 ? Math.abs(minLaneIndex) : 0;

  laneNodeIds.forEach(id => {
    const laneIndex = (laneByNode.get(id) ?? 0) + laneOffset;
    const rowIndex = rowByNode.get(id) ?? 0;
    positions.set(id, {
      x: laneIndex * laneWidth,
      y: rowIndex * rowHeight,
    });
  });

  layoutNodes.forEach(node => {
    if (!isSummaryNodeType(node.type)) return;
    const ingress = layoutEdges.filter(e => e.target === node.id);
    const egress = layoutEdges.filter(e => e.source === node.id);

    let laneIndex: number | null = null;
    for (const e of ingress) {
      if (laneByNode.has(e.source)) {
        laneIndex = laneByNode.get(e.source)!;
        break;
      }
    }
    if (laneIndex === null) {
      for (const e of egress) {
        if (laneByNode.has(e.target)) {
          laneIndex = laneByNode.get(e.target)!;
          break;
        }
      }
    }

    const ingressYs: number[] = [];
    const egressYs: number[] = [];
    ingress.forEach(e => {
      const pos = positions.get(e.source);
      if (pos) ingressYs.push(pos.y);
    });
    egress.forEach(e => {
      const pos = positions.get(e.target);
      if (pos) egressYs.push(pos.y);
    });

    let y = 0;
    if (ingressYs.length > 0 && egressYs.length > 0) {
      const avgIn = ingressYs.reduce((a, b) => a + b, 0) / ingressYs.length;
      const avgOut = egressYs.reduce((a, b) => a + b, 0) / egressYs.length;
      y = (avgIn + avgOut) / 2;
    } else if (ingressYs.length > 0) {
      y = ingressYs[0] + rowHeight * 0.5;
    } else if (egressYs.length > 0) {
      y = egressYs[0] - rowHeight * 0.5;
    } else {
      const fallbackIdx = nodeIndexMap.get(node.id) ?? 0;
      y = fallbackIdx * rowHeight;
    }

    const x = ((laneIndex ?? 0) + laneOffset) * laneWidth;
    positions.set(node.id, { x, y });
  });

  // Build initial positioned nodes (absolute coordinates)
  const positionedNodes: Node<any>[] = layoutNodes.map(n => {
    const pos = positions.get(n.id) ?? { x: 0, y: 0 };
    const width = getNodeWidth(n);
    const height = getNodeHeight(n);
    return {
      ...n,
      position: { x: pos.x, y: pos.y },
      targetPosition: n.type !== 'default' ? Position.Top : undefined,
      sourcePosition: n.type !== 'default' ? Position.Bottom : undefined,
      style: { ...n.style, width, height },
    };
  });

  // Shift to ensure no negative coordinates
  const topLevelNodes = positionedNodes.filter(n => !n.parentId);
  if (topLevelNodes.length > 0) {
    const minX = Math.min(...topLevelNodes.map(n => n.position.x));
    const minY = Math.min(...topLevelNodes.map(n => n.position.y));
    if (minX < 0 || minY < 0) {
      positionedNodes.forEach(n => {
        n.position = { x: n.position.x - minX, y: n.position.y - minY };
      });
    }
  }

  const compactedNodes = compactDagreUnitLayout(positionedNodes, layoutEdges);
  const expandedNodes = expandLayoutedUnits(nodes as Node<any>[], compactedNodes, layoutModel.membersByUnitId);
  let finalNodes = expandedNodes.map(n => ({ ...n }));

  // Compute group node bounds and convert children to relative positions
  const childrenByParentGroups = new Map<string, Node[]>();
  finalNodes.forEach(n => {
    if (n.parentId) {
      if (!childrenByParentGroups.has(n.parentId)) childrenByParentGroups.set(n.parentId, []);
      childrenByParentGroups.get(n.parentId)!.push(n);
    }
  });

  childrenByParentGroups.forEach((children, parentId) => {
    const parentNode = finalNodes.find(n => n.id === parentId);
    if (!parentNode) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    children.forEach(child => {
      const width = child.style && (child.style as { width?: number }).width ? (child.style as { width?: number }).width! : NODE_WIDTH;
      const height = child.style && (child.style as { height?: number }).height ? (child.style as { height?: number }).height! : nodeHeight;
      minX = Math.min(minX, child.position.x);
      minY = Math.min(minY, child.position.y);
      maxX = Math.max(maxX, child.position.x + width);
      maxY = Math.max(maxY, child.position.y + height);
    });

    if (minX === Infinity || minY === Infinity) return;

    const parentX = minX - groupPadding;
    const parentY = minY - groupPadding;
    const parentWidth = (maxX - minX) + groupPadding * 2;
    const parentHeight = (maxY - minY) + groupPadding * 2;

    parentNode.position = { x: parentX, y: parentY };
    parentNode.style = { ...parentNode.style, width: parentWidth, height: parentHeight };

    children.forEach(child => {
      child.position = {
        x: child.position.x - parentX,
        y: child.position.y - parentY,
      };
    });
  });

  // Final NaN guard
  finalNodes.forEach(n => {
    if (Number.isNaN(n.position.x) || Number.isNaN(n.position.y)) {
      n.position = { x: 0, y: 0 };
    }
  });

  finalNodes = applyTurnGroupHullBounds(finalNodes);

  return { nodes: finalNodes, edges };
};

// --- Tidy Tree Layout (Custom) ---
export const getTidyTreeLayoutedElements = (
  nodes: Node<LlmNodeData | SummaryNodeData | Record<string, unknown>>[],
  edges: Edge[]
) => {
  const isLayoutEdge = (edge: Edge) => {
    if (edge.data && (edge.data as { isReference?: boolean; layout?: boolean }).layout === false) return false;
    if (edge.data && (edge.data as { isReference?: boolean }).isReference) return false;
    if (edge.type === 'summaryEdge') return false;
    return true;
  };
  const layoutModel = buildLayoutModel(nodes as Node<any>[], edges, isLayoutEdge);
  const layoutNodes = layoutModel.layoutNodes;
  const layoutEdges = layoutModel.layoutEdges;

  // Always use normal layout constants (dense mode removed)
  const maxNodeWidth = Math.max(...layoutNodes.map(getNodeWidth), NODE_WIDTH);
  const maxNodeHeight = Math.max(...layoutNodes.map(getNodeHeight), NODE_HEIGHT);
  const nodeHeight = maxNodeHeight;
  const rowHeight = nodeHeight + RANK_SEP * 0.5; // Reduced vertical gap
  const laneGap = 24;
  const laneWidth = maxNodeWidth + laneGap;
  const groupPadding = 20;

  const nodeIndexMap = new Map<string, number>();
  layoutNodes.forEach((n, idx) => nodeIndexMap.set(n.id, idx));
  const nodesById = new Map<string, Node<any>>();
  layoutNodes.forEach((n) => nodesById.set(n.id, n));

  const createdAtMap = new Map<string, number>();
  layoutNodes.forEach(n => {
    const ts = getNodeCreatedAtTs(n);
    if (ts !== undefined) createdAtMap.set(n.id, ts);
  });

  const laneNodeIds = new Set<string>();
  layoutNodes.forEach(n => {
    if (!isSummaryNodeType(n.type) && isPrimaryLayoutNodeType(n.type)) {
      laneNodeIds.add(n.id);
    }
  });

  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  layoutEdges.forEach(edge => {
    if (!laneNodeIds.has(edge.source) || !laneNodeIds.has(edge.target)) return;
    if (!incoming.has(edge.target)) incoming.set(edge.target, new Set());
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, new Set());
    incoming.get(edge.target)!.add(edge.source);
    outgoing.get(edge.source)!.add(edge.target);
  });

  const sortByTime = (a: string, b: string) => {
    const nodeA = nodesById.get(a);
    const nodeB = nodesById.get(b);
    const priorityA =
      nodeA && isOriginNode(nodeA)
        ? 1
        : 2;
    const priorityB =
      nodeB && isOriginNode(nodeB)
        ? 1
        : 2;
    if (priorityA !== priorityB) return priorityA - priorityB;

    const ta = createdAtMap.get(a);
    const tb = createdAtMap.get(b);
    if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
    if (ta !== undefined && tb === undefined) return -1;
    if (ta === undefined && tb !== undefined) return 1;
    const ia = nodeIndexMap.get(a) ?? 0;
    const ib = nodeIndexMap.get(b) ?? 0;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  };

  const childrenByParent = new Map<string, string[]>();
  outgoing.forEach((targets, source) => {
    const children = Array.from(targets);
    children.sort(sortByTime);
    childrenByParent.set(source, children);
  });

  const roots = Array.from(laneNodeIds).filter(id => !incoming.has(id) || incoming.get(id)!.size === 0);
  roots.sort(sortByTime);

  const subtreeWidth = new Map<string, number>();
  const computeWidth = (rootId: string): number => {
    if (subtreeWidth.has(rootId)) return subtreeWidth.get(rootId)!;

    const activePath = new Set<string>();
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: rootId, expanded: false }];

    while (stack.length > 0) {
      const frame = stack.pop()!;

      if (frame.expanded) {
        activePath.delete(frame.id);
        if (subtreeWidth.has(frame.id)) continue;
        const children = childrenByParent.get(frame.id) ?? [];
        const width = children.reduce((sum, child) => sum + (subtreeWidth.get(child) ?? 1), 0);
        subtreeWidth.set(frame.id, Math.max(1, width));
        continue;
      }

      if (subtreeWidth.has(frame.id)) continue;

      if (activePath.has(frame.id)) {
        subtreeWidth.set(frame.id, 1);
        continue;
      }

      activePath.add(frame.id);
      stack.push({ id: frame.id, expanded: true });

      const children = childrenByParent.get(frame.id) ?? [];
      for (let idx = children.length - 1; idx >= 0; idx--) {
        const child = children[idx];
        if (child === frame.id) {
          subtreeWidth.set(child, 1);
          continue;
        }
        if (activePath.has(child)) {
          subtreeWidth.set(child, 1);
          continue;
        }
        if (!subtreeWidth.has(child)) {
          stack.push({ id: child, expanded: false });
        }
      }
    }

    return subtreeWidth.get(rootId) ?? 1;
  };

  const positions = new Map<string, { x: number; y: number }>();

  const assigned = new Set<string>();
  const assign = (rootId: string, rootLeft: number, rootDepth: number) => {
    const activePath = new Set<string>();
    const stack: Array<{ id: string; left: number; depth: number; exiting: boolean }> = [
      { id: rootId, left: rootLeft, depth: rootDepth, exiting: false },
    ];

    while (stack.length > 0) {
      const frame = stack.pop()!;

      if (frame.exiting) {
        activePath.delete(frame.id);
        continue;
      }

      if (assigned.has(frame.id) || activePath.has(frame.id)) continue;

      activePath.add(frame.id);
      assigned.add(frame.id);

      const width = computeWidth(frame.id);
      const center = frame.left + width / 2;
      positions.set(frame.id, { x: center * laneWidth, y: frame.depth * rowHeight });

      stack.push({ id: frame.id, left: frame.left, depth: frame.depth, exiting: true });

      const children = childrenByParent.get(frame.id) ?? [];
      let cursor = frame.left;
      const childFrames: Array<{ id: string; left: number; depth: number; exiting: boolean }> = [];
      children.forEach(child => {
        const childWidth = computeWidth(child);
        if (!assigned.has(child) && !activePath.has(child) && child !== frame.id) {
          childFrames.push({ id: child, left: cursor, depth: frame.depth + 1, exiting: false });
        }
        cursor += childWidth;
      });

      for (let idx = childFrames.length - 1; idx >= 0; idx--) {
        stack.push(childFrames[idx]);
      }
    }
  };

  let rootCursor = 0;
  roots.forEach(rootId => {
    const width = computeWidth(rootId);
    assign(rootId, rootCursor, 0);
    rootCursor += width + 1;
  });
  Array.from(laneNodeIds).sort(sortByTime).forEach(nodeId => {
    if (positions.has(nodeId)) return;
    const width = computeWidth(nodeId);
    assign(nodeId, rootCursor, 0);
    rootCursor += width + 1;
  });

  layoutNodes.forEach(node => {
    if (!isSummaryNodeType(node.type)) return;
    const ingress = layoutEdges.filter(e => e.target === node.id);
    const egress = layoutEdges.filter(e => e.source === node.id);

    const ingressYs: number[] = [];
    const egressYs: number[] = [];
    const ingressXs: number[] = [];
    const egressXs: number[] = [];

    ingress.forEach(e => {
      const pos = positions.get(e.source);
      if (pos) {
        ingressYs.push(pos.y);
        ingressXs.push(pos.x);
      }
    });
    egress.forEach(e => {
      const pos = positions.get(e.target);
      if (pos) {
        egressYs.push(pos.y);
        egressXs.push(pos.x);
      }
    });

    let y = 0;
    if (ingressYs.length > 0 && egressYs.length > 0) {
      const avgIn = ingressYs.reduce((a, b) => a + b, 0) / ingressYs.length;
      const avgOut = egressYs.reduce((a, b) => a + b, 0) / egressYs.length;
      y = (avgIn + avgOut) / 2;
    } else if (ingressYs.length > 0) {
      y = ingressYs[0] + rowHeight * 0.5;
    } else if (egressYs.length > 0) {
      y = egressYs[0] - rowHeight * 0.5;
    } else {
      const fallbackIdx = nodeIndexMap.get(node.id) ?? 0;
      y = fallbackIdx * rowHeight;
    }

    let x = 0;
    if (ingressXs.length > 0 && egressXs.length > 0) {
      x = (ingressXs.reduce((a, b) => a + b, 0) + egressXs.reduce((a, b) => a + b, 0)) / (ingressXs.length + egressXs.length);
    } else if (ingressXs.length > 0) {
      x = ingressXs[0];
    } else if (egressXs.length > 0) {
      x = egressXs[0];
    }

    positions.set(node.id, { x, y });
  });

  const positionedNodes: Node<any>[] = layoutNodes.map(n => {
    const pos = positions.get(n.id) ?? { x: 0, y: 0 };
    const width = getNodeWidth(n);
    const height = getNodeHeight(n);
    return {
      ...n,
      position: { x: pos.x, y: pos.y },
      targetPosition: n.type !== 'default' ? Position.Top : undefined,
      sourcePosition: n.type !== 'default' ? Position.Bottom : undefined,
      style: { ...n.style, width, height },
    };
  });

  const compactedNodes = compactDagreUnitLayout(positionedNodes, layoutEdges);
  const expandedNodes = expandLayoutedUnits(nodes as Node<any>[], compactedNodes, layoutModel.membersByUnitId);
  let finalNodes = expandedNodes.map(n => ({ ...n }));

  const childrenByParentGroups = new Map<string, Node[]>();
  finalNodes.forEach(n => {
    if (n.parentId) {
      if (!childrenByParentGroups.has(n.parentId)) childrenByParentGroups.set(n.parentId, []);
      childrenByParentGroups.get(n.parentId)!.push(n);
    }
  });

  childrenByParentGroups.forEach((children, parentId) => {
    const parentNode = finalNodes.find(n => n.id === parentId);
    if (!parentNode) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    children.forEach(child => {
      const width = child.style && (child.style as { width?: number }).width ? (child.style as { width?: number }).width! : NODE_WIDTH;
      const height = child.style && (child.style as { height?: number }).height ? (child.style as { height?: number }).height! : nodeHeight;
      minX = Math.min(minX, child.position.x);
      minY = Math.min(minY, child.position.y);
      maxX = Math.max(maxX, child.position.x + width);
      maxY = Math.max(maxY, child.position.y + height);
    });

    if (minX === Infinity || minY === Infinity) return;

    const parentX = minX - groupPadding;
    const parentY = minY - groupPadding;
    const parentWidth = (maxX - minX) + groupPadding * 2;
    const parentHeight = (maxY - minY) + groupPadding * 2;

    parentNode.position = { x: parentX, y: parentY };
    parentNode.style = { ...parentNode.style, width: parentWidth, height: parentHeight };

    children.forEach(child => {
      child.position = {
        x: child.position.x - parentX,
        y: child.position.y - parentY,
      };
    });
  });

  finalNodes.forEach(n => {
    if (Number.isNaN(n.position.x) || Number.isNaN(n.position.y)) {
      n.position = { x: 0, y: 0 };
    }
  });

  finalNodes = applyTurnGroupHullBounds(finalNodes);

  return { nodes: finalNodes, edges };
};

// --- Depth-Ranked Sugiyama Layout (Custom) ---
export const getSugiyamaLayoutedElements = (
  nodes: Node<LlmNodeData | SummaryNodeData | Record<string, unknown>>[],
  edges: Edge[]
) => {
  const isLayoutEdge = (edge: Edge) => {
    if (edge.data && (edge.data as { layout?: boolean }).layout === false) return false;
    if (edge.type === 'summaryEdge') return false;
    return true;
  };
  const layoutModel = buildLayoutModel(nodes as Node<any>[], edges, isLayoutEdge);
  const layoutNodes = layoutModel.layoutNodes;
  const layoutEdges = layoutModel.layoutEdges;

  // Always use normal layout constants (dense mode removed)
  const maxNodeWidth = Math.max(...layoutNodes.map(getNodeWidth), NODE_WIDTH);
  const maxNodeHeight = Math.max(...layoutNodes.map(getNodeHeight), NODE_HEIGHT);
  const nodeHeight = maxNodeHeight;
  const groupPadding = 20;

  const nodeIndexMap = new Map<string, number>();
  layoutNodes.forEach((n, idx) => nodeIndexMap.set(n.id, idx));
  const nodesById = new Map<string, Node<any>>();
  layoutNodes.forEach((n) => nodesById.set(n.id, n));

  const createdAtMap = new Map<string, number>();
  layoutNodes.forEach(n => {
    const ts = getNodeCreatedAtTs(n);
    if (ts !== undefined) createdAtMap.set(n.id, ts);
  });

  const laneNodeIds = new Set<string>();
  layoutNodes.forEach(n => {
    if (!isSummaryNodeType(n.type) && isPrimaryLayoutNodeType(n.type)) {
      laneNodeIds.add(n.id);
    }
  });

  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  layoutEdges.forEach(edge => {
    if (!laneNodeIds.has(edge.source) || !laneNodeIds.has(edge.target)) return;
    if (!incoming.has(edge.target)) incoming.set(edge.target, new Set());
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, new Set());
    incoming.get(edge.target)!.add(edge.source);
    outgoing.get(edge.source)!.add(edge.target);
  });

  const depth = new Map<string, number>();
  const inDegree = new Map<string, number>();

  laneNodeIds.forEach(id => {
    inDegree.set(id, incoming.get(id)?.size ?? 0);
  });

  const queue = Array.from(laneNodeIds).filter(id => (inDegree.get(id) ?? 0) === 0);
  let processedCount = 0;

  while (queue.length > 0) {
    const id = queue.shift()!;
    processedCount++;

    const parents = Array.from(incoming.get(id) ?? []);
    const maxParentDepth = parents.length === 0
      ? -1
      : Math.max(...parents.map(p => depth.get(p) ?? 0));
    depth.set(id, maxParentDepth + 1);

    outgoing.get(id)?.forEach(child => {
      if (laneNodeIds.has(child)) {
        const newDegree = (inDegree.get(child) ?? 0) - 1;
        inDegree.set(child, newDegree);
        if (newDegree === 0) queue.push(child);
      }
    });
  }

  // Handle any remaining nodes in cycles by assigning them a reasonable depth
  if (processedCount < laneNodeIds.size) {
    laneNodeIds.forEach(id => {
      if (!depth.has(id)) {
        const parents = Array.from(incoming.get(id) ?? []);
        const maxParentDepth = parents.length === 0
          ? -1
          : Math.max(...parents.map(p => depth.get(p) ?? 0));
        depth.set(id, maxParentDepth + 1);
      }
    });
  }

  const layers = new Map<number, string[]>();
  laneNodeIds.forEach(id => {
    const d = depth.get(id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(id);
  });

  const sortByTime = (a: string, b: string) => {
    const nodeA = nodesById.get(a);
    const nodeB = nodesById.get(b);
    const priorityA =
      nodeA && isOriginNode(nodeA)
        ? 1
        : 2;
    const priorityB =
      nodeB && isOriginNode(nodeB)
        ? 1
        : 2;
    if (priorityA !== priorityB) return priorityA - priorityB;

    const ta = createdAtMap.get(a);
    const tb = createdAtMap.get(b);
    if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
    if (ta !== undefined && tb === undefined) return -1;
    if (ta === undefined && tb !== undefined) return 1;
    const ia = nodeIndexMap.get(a) ?? 0;
    const ib = nodeIndexMap.get(b) ?? 0;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  };

  layers.forEach((nodesInLayer) => nodesInLayer.sort(sortByTime));

  const order = new Map<string, number>();
  layers.forEach((nodesInLayer) => {
    nodesInLayer.forEach((id, idx) => order.set(id, idx));
  });

  const barycenterSort = (layer: string[], neighborMap: Map<string, Set<string>>) => {
    const withBary = layer.map(id => {
      const neighbors = Array.from(neighborMap.get(id) ?? []);
      if (neighbors.length === 0) return { id, bary: Number.POSITIVE_INFINITY };
      const avg = neighbors.reduce((sum, n) => sum + (order.get(n) ?? 0), 0) / neighbors.length;
      return { id, bary: avg };
    });
    withBary.sort((a, b) => a.bary - b.bary || sortByTime(a.id, b.id));
    withBary.forEach((item, idx) => order.set(item.id, idx));
    return withBary.map(item => item.id);
  };

  const maxLayer = Math.max(...Array.from(layers.keys()), 0);
  // Increase sweeps for better crossing reduction
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let d = 1; d <= maxLayer; d++) {
      const layer = layers.get(d);
      if (!layer) continue;
      layers.set(d, barycenterSort(layer, incoming));
    }
    for (let d = maxLayer - 1; d >= 0; d--) {
      const layer = layers.get(d);
      if (!layer) continue;
      layers.set(d, barycenterSort(layer, outgoing));
    }
  }

  const sugiyamaRowHeight = nodeHeight + 80; // Increased for better flow
  const sugiyamaLaneWidth = maxNodeWidth + 40;

  const positions = new Map<string, { x: number; y: number }>();

  layers.forEach((nodesInLayer, d) => {
    // Center each rank horizontally
    const layerWidth = (nodesInLayer.length - 1) * sugiyamaLaneWidth;
    const offset = -(layerWidth / 2);

    nodesInLayer.forEach((id, idx) => {
      positions.set(id, {
        x: offset + (idx * sugiyamaLaneWidth),
        y: d * sugiyamaRowHeight
      });
    });
  });

  // Position summary nodes between their connected ranks
  layoutNodes.forEach(node => {
    if (!isSummaryNodeType(node.type)) return;
    const ingress = layoutEdges.filter(e => e.target === node.id);
    const egress = layoutEdges.filter(e => e.source === node.id);

    const ingressPositions = ingress.map(e => positions.get(e.source)).filter(Boolean) as { x: number, y: number }[];
    const egressPositions = egress.map(e => positions.get(e.target)).filter(Boolean) as { x: number, y: number }[];

    if (ingressPositions.length > 0 && egressPositions.length > 0) {
      const avgInX = ingressPositions.reduce((a, b) => a + b.x, 0) / ingressPositions.length;
      const avgOutX = egressPositions.reduce((a, b) => a + b.x, 0) / egressPositions.length;
      const avgInY = ingressPositions.reduce((a, b) => a + b.y, 0) / ingressPositions.length;
      const avgOutY = egressPositions.reduce((a, b) => a + b.y, 0) / egressPositions.length;
      positions.set(node.id, { x: (avgInX + avgOutX) / 2, y: (avgInY + avgOutY) / 2 });
    } else if (ingressPositions.length > 0) {
      positions.set(node.id, { x: ingressPositions[0].x, y: ingressPositions[0].y + sugiyamaRowHeight * 0.4 });
    } else if (egressPositions.length > 0) {
      positions.set(node.id, { x: egressPositions[0].x, y: egressPositions[0].y - sugiyamaRowHeight * 0.4 });
    } else {
      const fallbackIdx = nodeIndexMap.get(node.id) ?? 0;
      positions.set(node.id, { x: 0, y: fallbackIdx * sugiyamaRowHeight });
    }
  });

  const positionedNodes: Node<any>[] = layoutNodes.map(n => {
    const pos = positions.get(n.id) ?? { x: 0, y: 0 };
    const width = getNodeWidth(n);
    const height = getNodeHeight(n);
    return {
      ...n,
      position: { x: pos.x, y: pos.y },
      targetPosition: Position.Top,
      sourcePosition: Position.Bottom,
      style: { ...n.style, width, height },
    };
  });

  const compactedNodes = compactDagreUnitLayout(positionedNodes, layoutEdges);
  const expandedNodes = expandLayoutedUnits(nodes as Node<any>[], compactedNodes, layoutModel.membersByUnitId);
  let finalNodes = expandedNodes.map(n => ({ ...n }));

  const childrenByParentGroups = new Map<string, Node[]>();
  finalNodes.forEach(n => {
    if (n.parentId) {
      if (!childrenByParentGroups.has(n.parentId)) childrenByParentGroups.set(n.parentId, []);
      childrenByParentGroups.get(n.parentId)!.push(n);
    }
  });

  childrenByParentGroups.forEach((children, parentId) => {
    const parentNode = finalNodes.find(n => n.id === parentId);
    if (!parentNode) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    children.forEach(child => {
      const width = child.style && (child.style as { width?: number }).width ? (child.style as { width?: number }).width! : NODE_WIDTH;
      const height = child.style && (child.style as { height?: number }).height ? (child.style as { height?: number }).height! : nodeHeight;
      minX = Math.min(minX, child.position.x);
      minY = Math.min(minY, child.position.y);
      maxX = Math.max(maxX, child.position.x + width);
      maxY = Math.max(maxY, child.position.y + height);
    });

    if (minX === Infinity || minY === Infinity) return;

    const parentX = minX - groupPadding;
    const parentY = minY - groupPadding;
    const parentWidth = (maxX - minX) + groupPadding * 2;
    const parentHeight = (maxY - minY) + groupPadding * 2;

    parentNode.position = { x: parentX, y: parentY };
    parentNode.style = { ...parentNode.style, width: parentWidth, height: parentHeight };

    children.forEach(child => {
      child.position = {
        x: child.position.x - parentX,
        y: child.position.y - parentY,
      };
    });
  });

  finalNodes.forEach(n => {
    if (Number.isNaN(n.position.x) || Number.isNaN(n.position.y)) {
      n.position = { x: 0, y: 0 };
    }
  });

  finalNodes = applyTurnGroupHullBounds(finalNodes);

  return { nodes: finalNodes, edges };
};

// --- Branch Path Helper ---
export const getBranchPathIds = (messages: Message[], focusedId: string | null): Set<string> => {
  const pathIds = new Set<string>();
  if (!focusedId || messages.length === 0) {
    return pathIds;
  }
  const messageMap = new Map<string, Message>(messages.map(m => [m.id, m]));
  let currentId: string | null = focusedId;
  while (currentId) {
    const message = messageMap.get(currentId);
    if (!message) {
      break;
    }
    pathIds.add(message.id);
    currentId = message.parentId;
  }
  return pathIds;
};

// --- Legend Utility ---
export const getLlmLegend = (
  messages: Message[],
  allModels: RuntimeCatalogModel[]
): { name: string; color: string }[] => {
  const usedModelIds = new Set<string>();
  messages.forEach(msg => {
    if (msg.role === 'assistant' && msg.llmModel) {
      usedModelIds.add(msg.llmModel);
    }
  });

  const legend: { name: string; color: string }[] = [];
  const allModelsMap = new Map(allModels.map(m => [m.id, m]));

  usedModelIds.forEach(modelId => {
    const modelDetails = allModelsMap.get(modelId);
    const displayName = modelDetails?.name?.split(':').pop()?.trim() || modelId.split('/').pop()?.split(':').shift() || modelId;
    legend.push({
      name: displayName,
      color: getLlmColor(modelId) // Use existing consistent color logic
    });
  });

  legend.sort((a, b) => a.name.localeCompare(b.name));
  return legend;
};

// --- Helper to get model name by ID (accepts model list) ---
export const getModelNameById = (id: string | null | undefined, allModels: RuntimeCatalogModel[]): string => {
  if (!id) return 'Unknown Model';
  const model = allModels.find(m => m.id === id);
  return model?.name?.split(':').pop()?.trim() || id.split('/').pop()?.split(':').shift() || id;
};
