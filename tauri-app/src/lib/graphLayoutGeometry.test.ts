// @vitest-environment jsdom
import '../test/setup';
import { describe, expect, it } from 'vitest';
import { buildWorkspaceProjection } from '../domain/workspaceProjection';
import { Position, type Node } from '@xyflow/react';
import {
  getLayoutedElements,
  getLaneLayoutedElements,
  getSugiyamaLayoutedElements,
  getTidyTreeLayoutedElements,
  mapMessagesToGraphElements,
} from './graphUtils';
import type { CommitEntity, Message } from '../stores/workspaceStore';

const workspaceId = 'workspace-graph-layout-qa';
const baseTime = Date.parse('2026-05-10T05:00:00.000Z');

const isoAt = (index: number) => new Date(baseTime + index * 1000).toISOString();

const makeMessage = (
  input: Partial<Message> & Pick<Message, 'id' | 'role' | 'parentId'>,
  index: number,
): Message => ({
  id: input.id,
  role: input.role,
  content: input.content ?? `${input.role} ${input.id}`,
  parentId: input.parentId,
  workspaceId,
  status: input.status ?? null,
  agent_id: input.agent_id ?? null,
  execution_data: input.execution_data ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  base_commit_sha: input.base_commit_sha ?? null,
  base_selected_from_node_id: input.base_selected_from_node_id ?? null,
  git_branch_name: input.git_branch_name ?? null,
  commit: input.commit ?? undefined,
  createdAt: input.createdAt ?? isoAt(index),
  updatedAt: input.updatedAt ?? isoAt(index),
});

const buildTurnWithGeneratedCommit = (): Message[] => [
  makeMessage({
    id: 'user-1',
    role: 'user',
    parentId: null,
    content: 'Add the import graph cleanup and keep the turn compact.',
  }, 0),
  makeMessage({
    id: 'assistant-1',
    role: 'assistant',
    parentId: 'user-1',
    content: 'Implemented the graph cleanup.',
    status: 'completed',
    agent_id: 'agent-1',
    execution_data: { tool_call_count: 2 },
  }, 1),
  makeMessage({
    id: 'commit-1',
    role: 'assistant',
    parentId: 'assistant-1',
    content: 'Tighten graph turn cell layout',
    execution_data: {
      files_changed: [
        { path: 'tauri-app/src/lib/graphUtils.ts', additions: 12, deletions: 4 },
      ],
    },
    commit: {
      sha: 'abc1234def5678',
      subject: 'Tighten graph turn cell layout',
      source_kind: 'agent',
      produced_by_node_id: 'assistant-1',
      files_changed_count: 1,
      total_additions: 12,
      total_deletions: 4,
      parents: [{ parent_sha: 'base0001', parent_index: 0 }],
    },
  }, 2),
];

const buildTurnWithLocalAssistantOutputCommit = (): Message[] => [
  makeMessage({
    id: 'user-1',
    role: 'user',
    parentId: null,
    content: 'Create a local-first generated commit.',
  }, 0),
  makeMessage({
    id: 'assistant-1',
    role: 'assistant',
    parentId: 'user-1',
    content: 'Created hello.md.',
    status: 'completed',
    agent_id: 'agent-1',
    base_commit_sha: 'base0001',
    output_commit_sha: 'localcommit0001',
    execution_data: {
      meta: {
        commit_created: true,
        commit_message: 'Create hello.md',
      },
      files_changed: [
        { path: 'hello.md', additions: 1, deletions: 0 },
      ],
    },
  }, 1),
];

const buildGeneratedCommitFromParentCommitScenario = (): Message[] => [
  makeMessage({
    id: 'user-1',
    role: 'user',
    parentId: null,
    content: 'Create the parent commit.',
  }, 0),
  makeMessage({
    id: 'assistant-1',
    role: 'assistant',
    parentId: 'user-1',
    content: 'Created parent commit.',
    status: 'completed',
    agent_id: 'agent-1',
  }, 1),
  makeMessage({
    id: 'commit-1',
    role: 'assistant',
    parentId: 'assistant-1',
    content: 'Parent commit',
    commit: {
      sha: 'parentcommit0001',
      subject: 'Parent commit',
      source_kind: 'agent',
      produced_by_node_id: 'assistant-1',
      parents: [],
    },
  }, 2),
  makeMessage({
    id: 'user-2',
    role: 'user',
    parentId: 'assistant-1',
    content: 'Continue from parent commit.',
  }, 3),
  makeMessage({
    id: 'assistant-2',
    role: 'assistant',
    parentId: 'user-2',
    content: 'Generated a child commit.',
    status: 'completed',
    agent_id: 'agent-2',
    base_commit_sha: 'parentcommit0001',
    output_commit_sha: 'childcommit0002',
    execution_data: {
      meta: { commit_message: 'Child commit' },
      files_changed: [{ path: 'child.txt', additions: 1, deletions: 0 }],
    },
  }, 4),
];

const buildGeneratedCommitWithInferredBaseScenario = (): Message[] => [
  makeMessage({
    id: 'user-1',
    role: 'user',
    parentId: null,
    content: 'Create the parent commit locally.',
  }, 0),
  makeMessage({
    id: 'assistant-1',
    role: 'assistant',
    parentId: 'user-1',
    content: 'Created parent commit locally.',
    status: 'completed',
    agent_id: 'agent-1',
    output_commit_sha: 'parentcommit0001',
    execution_data: {
      meta: { commit_message: 'Parent commit' },
      files_changed: [{ path: 'parent.txt', additions: 1, deletions: 0 }],
    },
  }, 1),
  makeMessage({
    id: 'user-2',
    role: 'user',
    parentId: 'assistant-1',
    content: 'Continue normally without an explicit base sha.',
  }, 2),
  makeMessage({
    id: 'assistant-2',
    role: 'assistant',
    parentId: 'user-2',
    content: 'Generated child commit locally.',
    status: 'completed',
    agent_id: 'agent-2',
    output_commit_sha: 'childcommit0002',
    execution_data: {
      meta: { commit_message: 'Child commit' },
      files_changed: [{ path: 'child.txt', additions: 1, deletions: 0 }],
    },
  }, 3),
];

const buildLegacyImportedCommitChainWithoutShas = (): Message[] => [
  makeMessage({
    id: 'import-1',
    role: 'assistant',
    parentId: null,
    content: 'Imported first commit',
    execution_data: {
      meta: {
        imported_from_ref: 'refs/heads/main',
        sync_source: 'external_git',
        git_parents: ['legacy-parent-sha-1'],
        git_authored_at: isoAt(0),
      },
    },
  }, 0),
  makeMessage({
    id: 'import-2',
    role: 'assistant',
    parentId: 'import-1',
    content: 'Imported second commit',
    execution_data: {
      meta: {
        imported_from_ref: 'refs/heads/main',
        sync_source: 'external_git',
        git_parents: ['legacy-parent-sha-2'],
        git_authored_at: isoAt(1),
      },
    },
  }, 1),
  makeMessage({
    id: 'import-3',
    role: 'assistant',
    parentId: 'import-2',
    content: 'Imported third commit',
    execution_data: {
      meta: {
        imported_from_ref: 'refs/heads/main',
        sync_source: 'external_git',
        git_parents: ['legacy-parent-sha-3'],
        git_authored_at: isoAt(2),
      },
    },
  }, 2),
];

const buildTwoTurnBaseCommitScenario = (): Message[] => [
  makeMessage({
    id: 'user-1',
    role: 'user',
    parentId: null,
    content: 'Create the first code state.',
  }, 0),
  makeMessage({
    id: 'assistant-1',
    role: 'assistant',
    parentId: 'user-1',
    content: 'Created the first code state.',
    status: 'completed',
    agent_id: 'agent-1',
  }, 1),
  makeMessage({
    id: 'commit-1',
    role: 'assistant',
    parentId: 'assistant-1',
    content: 'Initial graph state',
    commit: {
      sha: 'commit0001',
      subject: 'Initial graph state',
      source_kind: 'agent',
      produced_by_node_id: 'assistant-1',
      parents: [],
    },
  }, 2),
  makeMessage({
    id: 'user-2',
    role: 'user',
    parentId: 'assistant-1',
    content: 'Continue from the first commit.',
    execution_data: { meta: { context_policy: 'fresh' } },
  }, 3),
  makeMessage({
    id: 'assistant-2',
    role: 'assistant',
    parentId: 'user-2',
    content: 'Continued from the selected base commit.',
    status: 'completed',
    agent_id: 'agent-2',
    base_commit_sha: 'commit0001',
    base_selected_from_node_id: 'commit-1',
  }, 4),
  makeMessage({
    id: 'commit-2',
    role: 'assistant',
    parentId: 'assistant-2',
    content: 'Second graph state',
    commit: {
      sha: 'commit0002',
      subject: 'Second graph state',
      source_kind: 'agent',
      produced_by_node_id: 'assistant-2',
      parents: [{ parent_sha: 'commit0001', parent_index: 0 }],
    },
  }, 5),
];

const buildSiblingTurnScenario = (): Message[] => [
  makeMessage({
    id: 'user-1',
    role: 'user',
    parentId: null,
    content: 'Create the parent turn.',
  }, 0),
  makeMessage({
    id: 'assistant-1',
    role: 'assistant',
    parentId: 'user-1',
    content: 'Parent turn complete.',
    status: 'completed',
    agent_id: 'agent-1',
  }, 1),
  makeMessage({
    id: 'commit-1',
    role: 'assistant',
    parentId: 'assistant-1',
    content: 'Parent commit',
    commit: {
      sha: 'parentcommit0001',
      subject: 'Parent commit',
      source_kind: 'agent',
      produced_by_node_id: 'assistant-1',
      parents: [],
    },
  }, 2),
  makeMessage({
    id: 'user-2',
    role: 'user',
    parentId: 'assistant-1',
    content: 'First sibling follow-up.',
  }, 3),
  makeMessage({
    id: 'assistant-2',
    role: 'assistant',
    parentId: 'user-2',
    content: 'First sibling done.',
    status: 'completed',
    agent_id: 'agent-2',
  }, 4),
  makeMessage({
    id: 'commit-2',
    role: 'assistant',
    parentId: 'assistant-2',
    content: 'First sibling commit',
    commit: {
      sha: 'siblingcommit0002',
      subject: 'First sibling commit',
      source_kind: 'agent',
      produced_by_node_id: 'assistant-2',
      parents: [{ parent_sha: 'parentcommit0001', parent_index: 0 }],
    },
  }, 5),
  makeMessage({
    id: 'user-3',
    role: 'user',
    parentId: 'assistant-1',
    content: 'Second sibling follow-up.',
  }, 6),
  makeMessage({
    id: 'assistant-3',
    role: 'assistant',
    parentId: 'user-3',
    content: 'Second sibling done.',
    status: 'completed',
    agent_id: 'agent-3',
  }, 7),
  makeMessage({
    id: 'commit-3',
    role: 'assistant',
    parentId: 'assistant-3',
    content: 'Second sibling commit',
    commit: {
      sha: 'siblingcommit0003',
      subject: 'Second sibling commit',
      source_kind: 'agent',
      produced_by_node_id: 'assistant-3',
      parents: [{ parent_sha: 'parentcommit0001', parent_index: 0 }],
    },
  }, 8),
];

const buildMappedGraph = (
  messages: Message[],
  focusedMessageId = 'assistant-1',
  commitGraph?: {
    commits?: CommitEntity[];
    commitParents?: Array<{ child_sha: string; parent_sha: string; parent_index: number }>;
    commitObservations?: Array<{ commit_sha: string; source_kind: string; git_ref?: string | null; first_seen_at?: string; last_seen_at?: string }>;
  },
  contextPathMessageIds?: Set<string>,
  visibleNodeSections?: Set<'conversation' | 'commits'>,
) => {
  const projection = buildWorkspaceProjection({
    messages,
    summaries: [],
    focusedMessageId,
    ...(commitGraph ?? {}),
  });

  return mapMessagesToGraphElements(
    projection,
    messages,
    [],
    focusedMessageId,
    contextPathMessageIds ?? new Set(),
    new Set(),
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    visibleNodeSections,
  );
};

const buildCanonicalImportedCommitChain = () => {
  const commits: CommitEntity[] = [1, 2, 3, 4].map((index) => ({
    sha: `imported000${index}`,
    workspace_id: workspaceId,
    subject: `Imported commit ${index}`,
    source_kind: 'external',
    produced_by_node_id: null,
    first_parent_sha: index === 1 ? 'base0001' : `imported000${index - 1}`,
    committed_at: isoAt(index),
    authored_at: isoAt(index),
  }));
  const commitParents = commits.map((commit, index) => ({
    child_sha: commit.sha,
    parent_sha: index === 0 ? 'base0001' : commits[index - 1].sha,
    parent_index: 0,
  }));
  const commitObservations = commits.map((commit) => ({
    commit_sha: commit.sha,
    source_kind: 'external',
    git_ref: 'refs/heads/main',
    first_seen_at: isoAt(10),
    last_seen_at: isoAt(11),
  }));
  return { commits, commitParents, commitObservations };
};

const getNode = (nodes: Node[], id: string) => {
  const node = nodes.find((candidate) => candidate.id === id);
  expect(node, `expected node ${id}`).toBeTruthy();
  return node!;
};

const numberStyle = (value: unknown): number => {
  expect(typeof value).toBe('number');
  return value as number;
};

const getVisibleCommitNodeId = (nodes: Node[], sha: string): string => (
  nodes.find((node) => (
    node.type === 'layout_derived_commit_group' &&
    ((node.data as any)?.group?.commitShas ?? []).includes(sha)
  ))?.id ?? sha
);

const getHullByMember = (nodes: Node[], memberId: string) => {
  const node = nodes.find((candidate) => (
    candidate.type === 'turn_group_hull' &&
    ((candidate.data as any)?.memberIds ?? []).includes(memberId)
  ));
  expect(node, `expected hull containing ${memberId}`).toBeTruthy();
  return node!;
};

const assertCompactTurnCellGeometry = (
  nodes: ReturnType<typeof getLayoutedElements>['nodes'],
  edges: ReturnType<typeof getLayoutedElements>['edges'],
) => {
  const user = getNode(nodes, 'user-1');
  const assistant = getNode(nodes, 'assistant-1');
  const commit = getNode(nodes, 'commit-1');
  const userWidth = numberStyle(user.style?.width);
  const userHeight = numberStyle(user.style?.height);
  const assistantWidth = numberStyle(assistant.style?.width);
  const assistantHeight = numberStyle(assistant.style?.height);
  const commitWidth = numberStyle(commit.style?.width);
  const commitHeight = numberStyle(commit.style?.height);

  expect(userWidth).toBe(200);
  expect(userHeight).toBe(82);
  expect(assistantWidth).toBe(200);
  expect(assistantHeight).toBe(112);
  expect(commitWidth).toBe(120);
  expect(commitHeight).toBe(155);

  expect(Math.abs(user.position.x - assistant.position.x)).toBeLessThanOrEqual(1);
  expect(assistant.position.y - (user.position.y + userHeight)).toBeLessThanOrEqual(2);

  const laneGap = commit.position.x - (assistant.position.x + assistantWidth);
  expect(laneGap).toBeGreaterThanOrEqual(0);
  expect(laneGap).toBeLessThanOrEqual(3);

  expect(Math.abs((user.position.y + Math.round(userHeight / 2)) - commit.position.y)).toBeLessThanOrEqual(1);
  expect(Math.abs((assistant.position.y + assistantHeight) - (commit.position.y + commitHeight))).toBeLessThanOrEqual(1);

  const outputEdge = edges.find((edge) => edge.source === 'assistant-1' && edge.target === 'commit-1');
  expect(outputEdge).toBeUndefined();
};

const edgeKey = (source: string, target: string, relationship: string) => `${source}->${target}:${relationship}`;

const semanticEdgeKeys = (edges: ReturnType<typeof getLayoutedElements>['edges']): Set<string> => (
  new Set(edges.map((edge) => edgeKey(edge.source, edge.target, String((edge.data as any)?.relationship ?? ''))))
);

describe('graph layout geometry QA', () => {
  it('keeps a generated commit as a compact sidecar in the default tidy layout', () => {
    const mapped = buildMappedGraph(buildTurnWithGeneratedCommit());
    const layouted = getTidyTreeLayoutedElements(mapped.nodes, mapped.edges);

    assertCompactTurnCellGeometry(layouted.nodes, layouted.edges);
  });

  it('removes hidden node sections before calculating turn lane width', () => {
    const messages = buildTurnWithLocalAssistantOutputCommit();
    const conversationOnly = buildMappedGraph(messages, 'assistant-1', undefined, undefined, new Set(['conversation']));
    const commitsOnly = buildMappedGraph(messages, 'assistant-1', undefined, undefined, new Set(['commits']));

    expect(conversationOnly.nodes.some((node) => node.type === 'commit_message')).toBe(false);
    expect(getNode(conversationOnly.nodes, 'assistant-1').style?.width).toBe(200);

    expect(commitsOnly.nodes.some((node) => node.type === 'user_message' || node.type === 'assistant_message')).toBe(false);
    expect(getNode(commitsOnly.nodes, 'commit:assistant-1').style?.width).toBe(120);

    const layoutedCommitsOnly = getTidyTreeLayoutedElements(commitsOnly.nodes, commitsOnly.edges);
    const commit = getNode(layoutedCommitsOnly.nodes, 'commit:assistant-1');
    expect(numberStyle(commit.style?.width)).toBe(120);

    const siblingMessages = buildSiblingTurnScenario();
    const conversationOnlySiblings = buildMappedGraph(siblingMessages, 'assistant-3', undefined, undefined, new Set(['conversation']));
    const commitsOnlySiblings = buildMappedGraph(siblingMessages, 'assistant-3', undefined, undefined, new Set(['commits']));
    const layoutedConversationOnlySiblings = getTidyTreeLayoutedElements(conversationOnlySiblings.nodes, conversationOnlySiblings.edges);
    const layoutedCommitsOnlySiblings = getTidyTreeLayoutedElements(commitsOnlySiblings.nodes, commitsOnlySiblings.edges);
    const firstConversationSibling = getNode(layoutedConversationOnlySiblings.nodes, 'user-2');
    const secondConversationSibling = getNode(layoutedConversationOnlySiblings.nodes, 'user-3');
    const firstCommitSibling = getNode(layoutedCommitsOnlySiblings.nodes, 'commit-2');
    const secondCommitSibling = getNode(layoutedCommitsOnlySiblings.nodes, 'commit-3');

    expect(Math.abs(firstConversationSibling.position.x - secondConversationSibling.position.x)).toBeLessThanOrEqual(240);
    expect(Math.abs(firstCommitSibling.position.x - secondCommitSibling.position.x)).toBeLessThanOrEqual(240);
  });

  it('keeps a generated commit as a compact sidecar in dagre layout', () => {
    const mapped = buildMappedGraph(buildTurnWithGeneratedCommit());
    const layouted = getLayoutedElements(mapped.nodes, mapped.edges);

    assertCompactTurnCellGeometry(layouted.nodes, layouted.edges);
  });

  it('materializes a local assistant output commit without a server commit node', () => {
    const mapped = buildMappedGraph(buildTurnWithLocalAssistantOutputCommit());
    const syntheticCommit = getNode(mapped.nodes, 'commit:assistant-1');
    const assistant = getNode(mapped.nodes, 'assistant-1');

    expect(syntheticCommit.type).toBe('commit_message');
    expect((syntheticCommit.data as any).entity.kind).toBe('commit_message');
    expect((syntheticCommit.data as any).entity.messageId).toBe('assistant-1:commit');
    expect((syntheticCommit.data as any).entity.focusMessageId).toBe('assistant-1');
    expect((syntheticCommit.data as any).entity.message.id).toBe('assistant-1:commit');
    expect((syntheticCommit.data as any).entity.shortSha).toBe('localcom');
    expect((assistant.data as any).commitCount).toBe(1);
    expect(mapped.edges.some((edge) => edge.source === 'assistant-1' && edge.target === 'commit:assistant-1')).toBe(false);

    const layouted = getTidyTreeLayoutedElements(mapped.nodes, mapped.edges);
    const layoutedAssistant = getNode(layouted.nodes, 'assistant-1');
    const layoutedCommit = getNode(layouted.nodes, 'commit:assistant-1');
    const laneGap = layoutedCommit.position.x - (layoutedAssistant.position.x + numberStyle(layoutedAssistant.style?.width));
    expect(laneGap).toBeGreaterThanOrEqual(0);
    expect(laneGap).toBeLessThanOrEqual(3);
  });

  it('draws a generated commit edge from parent commit bottom to generated commit top', () => {
    const mapped = buildMappedGraph(buildGeneratedCommitFromParentCommitScenario());
    const generatedCommit = getNode(mapped.nodes, 'commit:assistant-2');
    const commitEdge = mapped.edges.find((edge) => edge.source === 'commit-1' && edge.target === 'commit:assistant-2');

    expect(generatedCommit.type).toBe('commit_message');
    expect((commitEdge?.data as any)?.relationship).toBe('git-parent');
    expect((commitEdge?.data as any)?.layout).toBe(true);
    expect(commitEdge?.sourceHandle).toBe('bottom-source');
    expect(commitEdge?.targetHandle).toBe('top-target');

    const layouted = getTidyTreeLayoutedElements(mapped.nodes, mapped.edges);
    const parentCommit = getNode(layouted.nodes, 'commit-1');
    const layoutedGeneratedCommit = getNode(layouted.nodes, 'commit:assistant-2');
    const layoutedCommitEdge = layouted.edges.find((edge) => edge.source === 'commit-1' && edge.target === 'commit:assistant-2');

    expect(parentCommit.sourcePosition).toBe(Position.Bottom);
    expect(layoutedGeneratedCommit.targetPosition).toBe(Position.Top);
    expect(layoutedCommitEdge?.sourceHandle).toBe('bottom-source');
    expect(layoutedCommitEdge?.targetHandle).toBe('top-target');

    const layoutedAssistant = getNode(layouted.nodes, 'assistant-2');
    const parentCommitCenterX = parentCommit.position.x + numberStyle(parentCommit.style?.width) / 2;
    const generatedCommitCenterX = layoutedGeneratedCommit.position.x + numberStyle(layoutedGeneratedCommit.style?.width) / 2;
    expect(Math.abs(generatedCommitCenterX - parentCommitCenterX)).toBeLessThanOrEqual(1);
    expect(layoutedGeneratedCommit.position.x).toBeGreaterThan(layoutedAssistant.position.x);
  });

  it('infers generated commit parent from conversation parent assistant output when base sha is absent', () => {
    const mapped = buildMappedGraph(buildGeneratedCommitWithInferredBaseScenario());
    const parentCommit = getNode(mapped.nodes, 'commit:assistant-1');
    const childCommit = getNode(mapped.nodes, 'commit:assistant-2');
    const commitEdge = mapped.edges.find((edge) => edge.source === parentCommit.id && edge.target === childCommit.id);
    const baseUsedEdge = mapped.edges.find((edge) => edge.source === parentCommit.id && edge.target === 'assistant-2');

    expect((commitEdge?.data as any)?.relationship).toBe('git-parent');
    expect((commitEdge?.data as any)?.layout).toBe(true);
    expect(commitEdge?.sourceHandle).toBe('bottom-source');
    expect(commitEdge?.targetHandle).toBe('top-target');
    expect((baseUsedEdge?.data as any)?.relationship).toBe('base-used');
    expect((baseUsedEdge?.data as any)?.layout).not.toBe(false);
  });

  it('renders imported commit parent chains as individual rows when imported rows lack commit shas', () => {
    const mapped = buildMappedGraph(buildLegacyImportedCommitChainWithoutShas(), 'import-3');
    const first = getNode(mapped.nodes, 'import-1');
    const second = getNode(mapped.nodes, 'import-2');
    const third = getNode(mapped.nodes, 'import-3');
    const firstToSecond = mapped.edges.find((edge) => edge.source === first.id && edge.target === second.id);
    const secondToThird = mapped.edges.find((edge) => edge.source === second.id && edge.target === third.id);

    expect(first.type).toBe('commit_message');
    expect(second.type).toBe('commit_message');
    expect(third.type).toBe('commit_message');
    expect((firstToSecond?.data as any)?.relationship).toBe('git-parent');
    expect((firstToSecond?.data as any)?.layout).toBe(true);
    expect((firstToSecond?.data as any)?.edgeRole).toBe('commit-lineage');
    expect((secondToThird?.data as any)?.relationship).toBe('git-parent');
    expect((secondToThird?.data as any)?.layout).toBe(true);
    expect((secondToThird?.data as any)?.edgeRole).toBe('commit-lineage');
  });

  it('renders canonical imported commit-only chains as a layout-derived group without message rows', () => {
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0),
      makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', status: 'completed' }, 1),
    ];
    const commitGraph = buildCanonicalImportedCommitChain();
    const projection = buildWorkspaceProjection({
      messages,
      summaries: [],
      focusedMessageId: 'assistant-1',
      ...commitGraph,
    });
    const mapped = buildMappedGraph(messages, 'assistant-1', commitGraph);
    const group = projection.layoutDerivedCommitGroups[0];
    const groupNode = getNode(mapped.nodes, group.groupId);

    expect(projection.layoutDerivedCommitGroups).toHaveLength(1);
    expect(group.commitShas).toEqual(['imported0001', 'imported0002', 'imported0003', 'imported0004']);
    expect(groupNode.type).toBe('layout_derived_commit_group');
    expect((groupNode.data as any).group.commitShas).toEqual(group.commitShas);
    expect(mapped.nodes.some((node) => node.id === 'imported0001')).toBe(false);
  });

  it('renders short canonical imported commit-only chains as individual commit nodes', () => {
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0),
      makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', status: 'completed' }, 1),
    ];
    const commitGraph = buildCanonicalImportedCommitChain();
    const shortCommitGraph = {
      commits: commitGraph.commits.slice(0, 2),
      commitParents: commitGraph.commitParents.slice(0, 2),
      commitObservations: commitGraph.commitObservations.slice(0, 2),
    };
    const projection = buildWorkspaceProjection({
      messages,
      summaries: [],
      focusedMessageId: 'assistant-1',
      ...shortCommitGraph,
    });
    const mapped = buildMappedGraph(messages, 'assistant-1', shortCommitGraph);

    expect(projection.layoutDerivedCommitGroups).toHaveLength(0);
    expect(getNode(mapped.nodes, 'imported0001').type).toBe('canonical_commit');
    expect(getNode(mapped.nodes, 'imported0002').type).toBe('canonical_commit');
    const edge = mapped.edges.find((candidate) => candidate.source === 'imported0001' && candidate.target === 'imported0002');
    expect((edge?.data as any)?.relationship).toBe('git-parent');
    expect((edge?.data as any)?.edgeRole).toBe('commit-lineage');
  });

  it('uses produced_by_node_id, not source_kind, to decide generated commit placement', () => {
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0),
      makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', status: 'completed' }, 1),
    ];
    const commitGraph = {
      commits: [{
        sha: 'agentorphan0001',
        workspace_id: workspaceId,
        subject: 'Agent-like commit without producing node',
        source_kind: 'agent',
        produced_by_node_id: null,
        first_parent_sha: null,
        committed_at: isoAt(2),
        authored_at: isoAt(2),
      }],
      commitParents: [],
      commitObservations: [],
    };

    const mapped = buildMappedGraph(messages, 'assistant-1', commitGraph);
    const commit = getNode(mapped.nodes, 'agentorphan0001');

    expect(commit.type).toBe('canonical_commit');
    expect((commit.data as any).commit.producedByNodeId).toBe(null);
    expect((commit.data as any).commit.kind).not.toBe('generated_commit');
  });

  it('uses imported commit parents as layout edges for individual commit rows', () => {
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0),
      makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', status: 'completed' }, 1),
    ];
    const commitGraph = buildCanonicalImportedCommitChain();
    const shortCommitGraph = {
      commits: commitGraph.commits.slice(0, 2),
      commitParents: commitGraph.commitParents.slice(0, 2),
      commitObservations: commitGraph.commitObservations.slice(0, 2),
    };

    const mapped = buildMappedGraph(messages, 'assistant-1', shortCommitGraph);
    const edge = mapped.edges.find((candidate) => candidate.source === 'imported0001' && candidate.target === 'imported0002');

    expect((edge?.data as any)?.relationship).toBe('git-parent');
    expect((edge?.data as any)?.layout).toBe(true);
  });

  it('uses derived imported commit batches as layout nodes in commit lineage', () => {
    const messages = buildTurnWithLocalAssistantOutputCommit().map((message) => (
      message.id === 'assistant-1'
        ? { ...message, base_commit_sha: 'imported0004' }
        : message
    ));
    const importedGraph = buildCanonicalImportedCommitChain();
    const commitGraph = {
      commits: [
        ...importedGraph.commits,
        {
          sha: 'localcommit0001',
          workspace_id: workspaceId,
          subject: 'Create hello.md',
          source_kind: 'agent',
          produced_by_node_id: 'assistant-1',
          first_parent_sha: 'imported0004',
          committed_at: isoAt(20),
          authored_at: isoAt(20),
        },
      ],
      commitParents: [
        ...importedGraph.commitParents,
        { child_sha: 'localcommit0001', parent_sha: 'imported0004', parent_index: 0 },
      ],
      commitObservations: importedGraph.commitObservations,
    };

    const mapped = buildMappedGraph(messages, 'assistant-1', commitGraph);
    const group = mapped.nodes.find((node) => node.type === 'layout_derived_commit_group');
    expect(group).toBeTruthy();

    const edgeToGeneratedCommit = mapped.edges.find((edge) => edge.source === group!.id && edge.target === 'commit:assistant-1');
    expect((edgeToGeneratedCommit?.data as any)?.relationship).toBe('git-parent');
    expect((edgeToGeneratedCommit?.data as any)?.layout).toBe(true);
  });

  it('keeps the first conversation child below origin when origin also has an imported sidecar', () => {
    const messages = [
      makeMessage({
        id: 'origin-assistant',
        role: 'assistant',
        parentId: null,
        content: 'Origin assistant message.',
        status: 'completed',
      }, 0),
      makeMessage({
        id: 'first-child-user',
        role: 'user',
        parentId: 'origin-assistant',
        content: 'First child branch.',
      }, 10),
      makeMessage({
        id: 'first-child-assistant',
        role: 'assistant',
        parentId: 'first-child-user',
        content: 'First child reply.',
        status: 'completed',
      }, 11),
      makeMessage({
        id: 'second-child-user',
        role: 'user',
        parentId: 'origin-assistant',
        content: 'Second child branch from an imported base.',
      }, 12),
      makeMessage({
        id: 'second-child-assistant',
        role: 'assistant',
        parentId: 'second-child-user',
        content: 'Second child reply.',
        status: 'completed',
        base_commit_sha: 'imported0004',
      }, 13),
    ];
    const mapped = buildMappedGraph(messages, 'second-child-assistant', buildCanonicalImportedCommitChain());

    [getTidyTreeLayoutedElements, getLayoutedElements].forEach((layoutFn) => {
      const layouted = layoutFn(mapped.nodes, mapped.edges);
      const origin = getNode(layouted.nodes, 'origin-assistant');
      const firstChild = getNode(layouted.nodes, 'first-child-user');
      const secondChild = getNode(layouted.nodes, 'second-child-user');

      expect(firstChild.position.y).toBeGreaterThan(origin.position.y);
      expect(secondChild.position.y).toBeGreaterThan(origin.position.y);
      expect(secondChild.position.x).toBeGreaterThan(firstChild.position.x);
    });
  });

  it('lays out commits after an imported batch as children of the batch node', () => {
    const messages = buildTurnWithLocalAssistantOutputCommit();
    const importedGraph = buildCanonicalImportedCommitChain();
    const commitGraph = {
      commits: [
        ...importedGraph.commits,
        {
          sha: 'postbatch0001',
          workspace_id: workspaceId,
          subject: 'Commit after imported batch',
          source_kind: 'external',
          produced_by_node_id: null,
          first_parent_sha: 'imported0004',
          committed_at: isoAt(20),
          authored_at: isoAt(20),
        },
      ],
      commitParents: [
        ...importedGraph.commitParents,
        { child_sha: 'postbatch0001', parent_sha: 'imported0004', parent_index: 0 },
      ],
      commitObservations: [
        ...importedGraph.commitObservations,
        {
          commit_sha: 'postbatch0001',
          source_kind: 'external',
          git_ref: 'refs/heads/main',
          first_seen_at: isoAt(30),
          last_seen_at: isoAt(31),
        },
      ],
    };

    const mapped = buildMappedGraph(messages, 'assistant-1', commitGraph);
    const group = mapped.nodes.find((node) => node.type === 'layout_derived_commit_group');
    expect(group).toBeTruthy();
    expect((group!.data as any).group.commitShas).toContain('postbatch0001');
    expect(mapped.nodes.some((node) => node.id === 'postbatch0001')).toBe(false);

    const layouted = getLayoutedElements(mapped.nodes, mapped.edges);
    const layoutedGroup = getNode(layouted.nodes, group!.id);
    const postBatchCommit = getNode(layouted.nodes, getVisibleCommitNodeId(mapped.nodes, 'postbatch0001'));
    expect(postBatchCommit.id).toBe(layoutedGroup.id);

    const tidyLayouted = getTidyTreeLayoutedElements(mapped.nodes, mapped.edges);
    const tidyGroup = getNode(tidyLayouted.nodes, group!.id);
    const tidyPostBatchCommit = getNode(tidyLayouted.nodes, getVisibleCommitNodeId(mapped.nodes, 'postbatch0001'));
    expect(tidyPostBatchCommit.id).toBe(tidyGroup.id);
  });

  it('keeps a conversation turn and its generated commit together below the selected base commit', () => {
    const messages = buildTurnWithLocalAssistantOutputCommit().map((message) => (
      message.id === 'assistant-1'
        ? {
          ...message,
          base_commit_sha: 'imported0004',
          output_commit_sha: 'localcommit0001',
        }
        : message
    ));
    const commitGraph = buildCanonicalImportedCommitChain();

    const mapped = buildMappedGraph(messages, 'assistant-1', commitGraph);
    const group = mapped.nodes.find((node) => node.type === 'layout_derived_commit_group');
    expect(group).toBeTruthy();

    const baseUsedEdge = mapped.edges.find((edge) => edge.source === group!.id && edge.target === 'assistant-1');
    expect((baseUsedEdge?.data as any)?.relationship).toBe('base-used');
    expect((baseUsedEdge?.data as any)?.layout).not.toBe(false);

    const layouted = getTidyTreeLayoutedElements(mapped.nodes, mapped.edges);
    const layoutedGroup = getNode(layouted.nodes, group!.id);
    const user = getNode(layouted.nodes, 'user-1');
    const assistant = getNode(layouted.nodes, 'assistant-1');
    const generatedCommit = getNode(layouted.nodes, 'commit:assistant-1');

    expect(user.position.y).toBeGreaterThan(layoutedGroup.position.y);
    expect(assistant.position.y).toBeGreaterThan(user.position.y);
    expect(generatedCommit.position.y).toBeGreaterThan(layoutedGroup.position.y);
    expect(generatedCommit.position.x).toBeGreaterThan(assistant.position.x);
    const assistantCenterY = assistant.position.y + numberStyle(assistant.style?.height) / 2;
    const generatedCommitCenterY = generatedCommit.position.y + numberStyle(generatedCommit.style?.height) / 2;
    expect(Math.abs(generatedCommitCenterY - assistantCenterY)).toBeLessThanOrEqual(32);
  });

  it('lets layout engines place turn boxes while keeping intra-turn slots fixed', () => {
    const mapped = buildMappedGraph(buildSiblingTurnScenario());
    const layouts = [
      getLayoutedElements(mapped.nodes, mapped.edges),
      getLaneLayoutedElements(mapped.nodes, mapped.edges),
      getTidyTreeLayoutedElements(mapped.nodes, mapped.edges),
      getSugiyamaLayoutedElements(mapped.nodes, mapped.edges),
    ];

    const signatures = layouts.map((layouted) => [
      'user-2',
      'assistant-2',
      'commit-2',
      'user-3',
      'assistant-3',
      'commit-3',
    ].map((id) => {
      const node = getNode(layouted.nodes, id);
      return `${id}:${Math.round(node.position.x)},${Math.round(node.position.y)}`;
    }).join('|'));

    expect(new Set(signatures).size).toBeGreaterThan(1);

    layouts.forEach((layouted) => {
      const firstAssistant = getNode(layouted.nodes, 'assistant-2');
      const firstGeneratedCommit = getNode(layouted.nodes, 'commit-2');
      const secondAssistant = getNode(layouted.nodes, 'assistant-3');
      const secondGeneratedCommit = getNode(layouted.nodes, 'commit-3');

      expect(firstGeneratedCommit.position.x).toBeGreaterThan(firstAssistant.position.x);
      expect(secondGeneratedCommit.position.x).toBeGreaterThan(secondAssistant.position.x);
      expect(Math.abs(
        firstGeneratedCommit.position.x - (firstAssistant.position.x + numberStyle(firstAssistant.style?.width) + 2)
      )).toBeLessThanOrEqual(1);
      expect(Math.abs(
        secondGeneratedCommit.position.x - (secondAssistant.position.x + numberStyle(secondAssistant.style?.width) + 2)
      )).toBeLessThanOrEqual(1);
    });
  });

  it('sizes turn hulls as a full-slot wash around generated commits', () => {
    const mapped = buildMappedGraph(buildTurnWithLocalAssistantOutputCommit());
    const layouted = getLayoutedElements(mapped.nodes, mapped.edges);
    const user = getNode(layouted.nodes, 'user-1');
    const assistant = getNode(layouted.nodes, 'assistant-1');
    const generatedCommit = getNode(layouted.nodes, 'commit:assistant-1');
    const hull = getHullByMember(layouted.nodes, 'commit:assistant-1');

    const minY = Math.min(user.position.y, assistant.position.y, generatedCommit.position.y);
    const maxY = Math.max(
      user.position.y + numberStyle(user.style?.height),
      assistant.position.y + numberStyle(assistant.style?.height),
      generatedCommit.position.y + numberStyle(generatedCommit.style?.height),
    );

    expect(hull.position.x).toBe(user.position.x);
    expect(hull.position.y).toBe(minY);
    expect(numberStyle(hull.style?.width)).toBe(
      generatedCommit.position.x + numberStyle(generatedCommit.style?.width) - user.position.x,
    );
    expect(numberStyle(hull.style?.height)).toBe(maxY - minY);
  });

  it('sizes independent commit hulls as full turn slots with an empty conversation lane', () => {
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0),
      makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', status: 'completed' }, 1),
    ];
    const commitGraph = buildCanonicalImportedCommitChain();
    const shortCommitGraph = {
      commits: commitGraph.commits.slice(0, 2),
      commitParents: commitGraph.commitParents.slice(0, 2),
      commitObservations: commitGraph.commitObservations.slice(0, 2),
    };

    const mapped = buildMappedGraph(messages, 'assistant-1', shortCommitGraph);
    const layouted = getLayoutedElements(mapped.nodes, mapped.edges);
    const commit = getNode(layouted.nodes, 'imported0001');
    const hull = getHullByMember(layouted.nodes, 'imported0001');

    expect((hull.data as any).slotKind).toBe('commit-only');
    expect(hull.position.x).toBe(commit.position.x - 202);
    expect(hull.position.y).toBe(commit.position.y);
    expect(numberStyle(hull.style?.width)).toBe(322);
    expect(numberStyle(hull.style?.height)).toBe(numberStyle(commit.style?.height));
  });

  it('fans out multiple generated commit turns from the same parent commit without overlapping them', () => {
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0),
      makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', status: 'completed' }, 1),
      makeMessage({
        id: 'commit-1',
        role: 'assistant',
        parentId: 'assistant-1',
        content: 'Parent commit',
        commit: {
          sha: 'parentcommit0001',
          subject: 'Parent commit',
          source_kind: 'agent',
          produced_by_node_id: 'assistant-1',
          parents: [],
        },
      }, 2),
      makeMessage({ id: 'user-2', role: 'user', parentId: 'assistant-1' }, 3),
      makeMessage({
        id: 'assistant-2',
        role: 'assistant',
        parentId: 'user-2',
        status: 'completed',
        base_commit_sha: 'parentcommit0001',
        output_commit_sha: 'childcommit0002',
        execution_data: { meta: { commit_message: 'First child commit' } },
      }, 4),
      makeMessage({ id: 'user-3', role: 'user', parentId: 'assistant-1' }, 5),
      makeMessage({
        id: 'assistant-3',
        role: 'assistant',
        parentId: 'user-3',
        status: 'completed',
        base_commit_sha: 'parentcommit0001',
        output_commit_sha: 'childcommit0003',
        execution_data: { meta: { commit_message: 'Second child commit' } },
      }, 6),
    ];

    const mapped = buildMappedGraph(messages, 'assistant-3');
    const layouted = getTidyTreeLayoutedElements(mapped.nodes, mapped.edges);
    const firstAssistant = getNode(layouted.nodes, 'assistant-2');
    const secondAssistant = getNode(layouted.nodes, 'assistant-3');
    const firstGeneratedCommit = getNode(layouted.nodes, 'commit:assistant-2');
    const secondGeneratedCommit = getNode(layouted.nodes, 'commit:assistant-3');

    expect(firstGeneratedCommit.position.x).toBeGreaterThan(firstAssistant.position.x);
    expect(secondGeneratedCommit.position.x).toBeGreaterThan(secondAssistant.position.x);
    expect(Math.abs(firstGeneratedCommit.position.x - secondGeneratedCommit.position.x)).toBeGreaterThanOrEqual(
      numberStyle(firstGeneratedCommit.style?.width),
    );
  });

  it('uses imported commit-only turns as lineage bridges between conversation turns', () => {
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0),
      makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', status: 'completed' }, 1),
      makeMessage({ id: 'user-2', role: 'user', parentId: 'assistant-1' }, 3),
      makeMessage({
        id: 'assistant-2',
        role: 'assistant',
        parentId: 'user-2',
        status: 'completed',
        base_commit_sha: 'imported0004',
        output_commit_sha: 'childcommit0002',
        execution_data: { meta: { commit_message: 'Child from bridge commit' } },
      }, 4),
    ];
    const commitGraph = buildCanonicalImportedCommitChain();

    const mapped = buildMappedGraph(messages, 'assistant-2', commitGraph);
    const layouted = getTidyTreeLayoutedElements(mapped.nodes, mapped.edges);
    const bridgeCommit = layouted.nodes.find((node) => node.type === 'layout_derived_commit_group');
    expect(bridgeCommit).toBeTruthy();
    const childGeneratedCommit = getNode(layouted.nodes, 'commit:assistant-2');

    expect(childGeneratedCommit.position.y).toBeGreaterThan(bridgeCommit!.position.y);

    const bridgeCommitCenterX = bridgeCommit!.position.x + numberStyle(bridgeCommit!.style?.width) / 2;
    const childGeneratedCommitCenterX = childGeneratedCommit.position.x + numberStyle(childGeneratedCommit.style?.width) / 2;
    expect(Math.abs(childGeneratedCommitCenterX - bridgeCommitCenterX)).toBeLessThanOrEqual(1);
  });

  it('orders imported sidecar, commit-only bridge, conversation, and generated commit as turn rows', () => {
    const messages = [
      makeMessage({
        id: 'origin-assistant',
        role: 'assistant',
        parentId: null,
        content: 'Origin assistant message.',
        status: 'completed',
      }, 0),
      makeMessage({
        id: 'conversation-user',
        role: 'user',
        parentId: 'origin-assistant',
        content: 'Conversation after imported code.',
      }, 10),
      makeMessage({
        id: 'conversation-assistant',
        role: 'assistant',
        parentId: 'conversation-user',
        content: 'Conversation-only reply.',
        status: 'completed',
      }, 11),
      makeMessage({
        id: 'generated-user',
        role: 'user',
        parentId: 'conversation-assistant',
        content: 'Now create a commit from the bridge.',
      }, 12),
      makeMessage({
        id: 'generated-assistant',
        role: 'assistant',
        parentId: 'generated-user',
        content: 'Created the child commit.',
        status: 'completed',
        base_commit_sha: 'postbatch0001',
        output_commit_sha: 'generated0002',
        execution_data: { meta: { commit_message: 'Generated child commit' } },
      }, 13),
    ];
    const importedGraph = buildCanonicalImportedCommitChain();
    const commitGraph = {
      commits: [
        ...importedGraph.commits,
        {
          sha: 'postbatch0001',
          workspace_id: workspaceId,
          subject: 'Commit after imported batch',
          source_kind: 'external',
          produced_by_node_id: null,
          first_parent_sha: 'imported0004',
          committed_at: isoAt(8),
          authored_at: isoAt(8),
        },
      ],
      commitParents: [
        ...importedGraph.commitParents,
        { child_sha: 'postbatch0001', parent_sha: 'imported0004', parent_index: 0 },
      ],
      commitObservations: [
        ...importedGraph.commitObservations,
        {
          commit_sha: 'postbatch0001',
          source_kind: 'external',
          git_ref: 'refs/heads/main',
          first_seen_at: isoAt(20),
          last_seen_at: isoAt(21),
        },
      ],
    };

    const mapped = buildMappedGraph(messages, 'generated-assistant', commitGraph);
    const group = mapped.nodes.find((node) => node.type === 'layout_derived_commit_group');
    expect(group).toBeTruthy();

    [getTidyTreeLayoutedElements, getLayoutedElements].forEach((layoutFn) => {
      const layouted = layoutFn(mapped.nodes, mapped.edges);
      const origin = getNode(layouted.nodes, 'origin-assistant');
      const importedBatch = getNode(layouted.nodes, group!.id);
      const bridgeCommit = getNode(layouted.nodes, getVisibleCommitNodeId(mapped.nodes, 'postbatch0001'));
      const conversationUser = getNode(layouted.nodes, 'conversation-user');
      const conversationAssistant = getNode(layouted.nodes, 'conversation-assistant');
      const generatedUser = getNode(layouted.nodes, 'generated-user');
      const generatedAssistant = getNode(layouted.nodes, 'generated-assistant');
      const generatedCommit = getNode(layouted.nodes, 'commit:generated-assistant');

      expect(Math.abs(importedBatch.position.y - origin.position.y)).toBeLessThanOrEqual(8);
      expect(bridgeCommit.id).toBe(importedBatch.id);
      expect(conversationUser.position.y).toBeGreaterThan(bridgeCommit.position.y);
      expect(conversationAssistant.position.y).toBeGreaterThan(conversationUser.position.y);
      expect(generatedUser.position.y).toBeGreaterThan(conversationAssistant.position.y);
      expect(generatedAssistant.position.y).toBeGreaterThan(generatedUser.position.y);
      expect(Math.abs(conversationUser.position.x - origin.position.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(generatedUser.position.x - origin.position.x)).toBeLessThanOrEqual(1);

      const bridgeCommitCenterX = bridgeCommit.position.x + numberStyle(bridgeCommit.style?.width) / 2;
      const generatedCommitCenterX = generatedCommit.position.x + numberStyle(generatedCommit.style?.width) / 2;
      expect(Math.abs(generatedCommitCenterX - bridgeCommitCenterX)).toBeLessThanOrEqual(1);
    });
  });

  it('keeps imported bridge ordering when the bridge commit also has an independent commit sibling', () => {
    const messages = [
      makeMessage({
        id: 'origin-assistant',
        role: 'assistant',
        parentId: null,
        content: 'Origin assistant message.',
        status: 'completed',
      }, 0),
      makeMessage({
        id: 'conversation-user',
        role: 'user',
        parentId: 'origin-assistant',
        content: 'Conversation after imported code.',
      }, 10),
      makeMessage({
        id: 'conversation-assistant',
        role: 'assistant',
        parentId: 'conversation-user',
        content: 'Conversation-only reply.',
        status: 'completed',
      }, 11),
      makeMessage({
        id: 'generated-user',
        role: 'user',
        parentId: 'conversation-assistant',
        content: 'Now create a commit from the bridge.',
      }, 12),
      makeMessage({
        id: 'generated-assistant',
        role: 'assistant',
        parentId: 'generated-user',
        content: 'Created the child commit.',
        status: 'completed',
        base_commit_sha: 'postbatch0001',
        output_commit_sha: 'generated0002',
        execution_data: { meta: { commit_message: 'Generated child commit' } },
      }, 13),
    ];
    const importedGraph = buildCanonicalImportedCommitChain();
    const commitGraph = {
      commits: [
        ...importedGraph.commits,
        {
          sha: 'postbatch0001',
          workspace_id: workspaceId,
          subject: 'Commit after imported batch',
          source_kind: 'external',
          produced_by_node_id: null,
          first_parent_sha: 'imported0004',
          committed_at: isoAt(8),
          authored_at: isoAt(8),
        },
        {
          sha: 'independent0003',
          workspace_id: workspaceId,
          subject: 'Independent later commit',
          source_kind: 'external',
          produced_by_node_id: null,
          first_parent_sha: 'postbatch0001',
          committed_at: isoAt(30),
          authored_at: isoAt(30),
        },
        {
          sha: 'generated0002',
          workspace_id: workspaceId,
          subject: 'Generated child commit',
          source_kind: 'agent',
          produced_by_node_id: 'generated-assistant',
          first_parent_sha: 'postbatch0001',
          committed_at: isoAt(14),
          authored_at: isoAt(14),
        },
      ],
      commitParents: [
        ...importedGraph.commitParents,
        { child_sha: 'postbatch0001', parent_sha: 'imported0004', parent_index: 0 },
        { child_sha: 'independent0003', parent_sha: 'postbatch0001', parent_index: 0 },
        { child_sha: 'generated0002', parent_sha: 'postbatch0001', parent_index: 0 },
      ],
      commitObservations: [
        ...importedGraph.commitObservations,
        {
          commit_sha: 'postbatch0001',
          source_kind: 'external',
          git_ref: 'refs/heads/main',
          first_seen_at: isoAt(20),
          last_seen_at: isoAt(21),
        },
        {
          commit_sha: 'independent0003',
          source_kind: 'external',
          git_ref: 'refs/heads/main',
          first_seen_at: isoAt(31),
          last_seen_at: isoAt(32),
        },
        {
          commit_sha: 'generated0002',
          source_kind: 'agent',
          git_ref: 'refs/heads/generated',
          first_seen_at: isoAt(14),
          last_seen_at: isoAt(15),
        },
      ],
    };

    const mapped = buildMappedGraph(messages, 'generated-assistant', commitGraph);

    [getTidyTreeLayoutedElements, getLayoutedElements].forEach((layoutFn) => {
      const layouted = layoutFn(mapped.nodes, mapped.edges);
      const origin = getNode(layouted.nodes, 'origin-assistant');
      const bridgeCommit = getNode(layouted.nodes, getVisibleCommitNodeId(mapped.nodes, 'postbatch0001'));
      const independentCommit = getNode(layouted.nodes, getVisibleCommitNodeId(mapped.nodes, 'independent0003'));
      const conversationUser = getNode(layouted.nodes, 'conversation-user');
      const generatedUser = getNode(layouted.nodes, 'generated-user');
      const generatedCommit = getNode(layouted.nodes, 'commit:generated-assistant');

      expect(conversationUser.position.y).toBeGreaterThan(bridgeCommit.position.y);
      expect(generatedUser.position.y).toBeGreaterThan(conversationUser.position.y);
      expect(independentCommit.id).toBe(bridgeCommit.id);
      expect(Math.abs(conversationUser.position.x - origin.position.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(generatedUser.position.x - origin.position.x)).toBeLessThanOrEqual(1);

      const bridgeCommitCenterX = bridgeCommit.position.x + numberStyle(bridgeCommit.style?.width) / 2;
      const generatedCommitCenterX = generatedCommit.position.x + numberStyle(generatedCommit.style?.width) / 2;
      expect(Math.abs(generatedCommitCenterX - bridgeCommitCenterX)).toBeLessThanOrEqual(1);
    });
  });

  it('uses the downstream generated commit lineage as the imported bridge when later imported batches also branch from the batch', () => {
    const messages = [
      makeMessage({
        id: 'origin-assistant',
        role: 'assistant',
        parentId: null,
        content: 'Origin assistant message.',
        status: 'completed',
      }, 0),
      makeMessage({
        id: 'conversation-user',
        role: 'user',
        parentId: 'origin-assistant',
        content: 'Conversation after imported code.',
      }, 10),
      makeMessage({
        id: 'conversation-assistant',
        role: 'assistant',
        parentId: 'conversation-user',
        content: 'Conversation-only reply.',
        status: 'completed',
      }, 11),
      makeMessage({
        id: 'generated-user',
        role: 'user',
        parentId: 'conversation-assistant',
        content: 'Now create a commit from the bridge.',
      }, 12),
      makeMessage({
        id: 'generated-assistant',
        role: 'assistant',
        parentId: 'generated-user',
        content: 'Created the child commit.',
        status: 'completed',
        base_commit_sha: 'postbatch0001',
        output_commit_sha: 'generated0002',
        execution_data: { meta: { commit_message: 'Generated child commit' } },
      }, 13),
    ];
    const importedGraph = buildCanonicalImportedCommitChain();
    const laterImportedCommits: CommitEntity[] = [1, 2, 3].map((index) => ({
      sha: `laterimported000${index}`,
      workspace_id: workspaceId,
      subject: `Later imported commit ${index}`,
      source_kind: 'external',
      produced_by_node_id: null,
      first_parent_sha: index === 1 ? 'imported0002' : `laterimported000${index - 1}`,
      committed_at: isoAt(30 + index),
      authored_at: isoAt(30 + index),
    }));
    const commitGraph = {
      commits: [
        ...importedGraph.commits,
        {
          sha: 'postbatch0001',
          workspace_id: workspaceId,
          subject: 'Commit after imported batch',
          source_kind: 'external',
          produced_by_node_id: null,
          first_parent_sha: 'imported0004',
          committed_at: isoAt(8),
          authored_at: isoAt(8),
        },
        {
          sha: 'generated0002',
          workspace_id: workspaceId,
          subject: 'Generated child commit',
          source_kind: 'agent',
          produced_by_node_id: 'generated-assistant',
          first_parent_sha: 'postbatch0001',
          committed_at: isoAt(14),
          authored_at: isoAt(14),
        },
        ...laterImportedCommits,
      ],
      commitParents: [
        ...importedGraph.commitParents,
        { child_sha: 'postbatch0001', parent_sha: 'imported0004', parent_index: 0 },
        { child_sha: 'generated0002', parent_sha: 'postbatch0001', parent_index: 0 },
        { child_sha: 'laterimported0001', parent_sha: 'imported0002', parent_index: 0 },
        { child_sha: 'laterimported0002', parent_sha: 'laterimported0001', parent_index: 0 },
        { child_sha: 'laterimported0003', parent_sha: 'laterimported0002', parent_index: 0 },
      ],
      commitObservations: [
        ...importedGraph.commitObservations,
        {
          commit_sha: 'postbatch0001',
          source_kind: 'external',
          git_ref: 'refs/heads/main',
          first_seen_at: isoAt(20),
          last_seen_at: isoAt(21),
        },
        {
          commit_sha: 'generated0002',
          source_kind: 'agent',
          git_ref: 'refs/heads/generated',
          first_seen_at: isoAt(14),
          last_seen_at: isoAt(15),
        },
        ...laterImportedCommits.map((commit) => ({
          commit_sha: commit.sha,
          source_kind: 'external',
          git_ref: 'refs/heads/main',
          first_seen_at: isoAt(40),
          last_seen_at: isoAt(41),
        })),
      ],
    };

    const mapped = buildMappedGraph(messages, 'generated-assistant', commitGraph);
    const importedBatches = mapped.nodes
      .filter((node) => node.type === 'layout_derived_commit_group')
      .sort((left, right) => numberStyle((left.data as any)?.group?.sortTs) - numberStyle((right.data as any)?.group?.sortTs));
    expect(importedBatches.length).toBeGreaterThanOrEqual(1);

    [getTidyTreeLayoutedElements, getLayoutedElements].forEach((layoutFn) => {
      const layouted = layoutFn(mapped.nodes, mapped.edges);
      const origin = getNode(layouted.nodes, 'origin-assistant');
      const firstImportedBatch = getNode(layouted.nodes, importedBatches[0].id);
      const bridgeCommit = getNode(layouted.nodes, getVisibleCommitNodeId(mapped.nodes, 'postbatch0001'));
      const conversationUser = getNode(layouted.nodes, 'conversation-user');
      const generatedUser = getNode(layouted.nodes, 'generated-user');
      const generatedCommit = getNode(layouted.nodes, 'commit:generated-assistant');

      expect(Math.abs(firstImportedBatch.position.y - origin.position.y)).toBeLessThanOrEqual(8);
      expect(bridgeCommit.id).toBe(firstImportedBatch.id);
      expect(conversationUser.position.y).toBeGreaterThan(bridgeCommit.position.y);
      expect(generatedUser.position.y).toBeGreaterThan(conversationUser.position.y);
      expect(Math.abs(conversationUser.position.x - origin.position.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(generatedUser.position.x - origin.position.x)).toBeLessThanOrEqual(1);

      const bridgeCommitCenterX = bridgeCommit.position.x + numberStyle(bridgeCommit.style?.width) / 2;
      const firstBatchCenterX = firstImportedBatch.position.x + numberStyle(firstImportedBatch.style?.width) / 2;
      const generatedCommitCenterX = generatedCommit.position.x + numberStyle(generatedCommit.style?.width) / 2;
      expect(Math.abs(bridgeCommitCenterX - firstBatchCenterX)).toBeLessThanOrEqual(1);
      expect(Math.abs(generatedCommitCenterX - bridgeCommitCenterX)).toBeLessThanOrEqual(1);
    });
  });

  it('uses a standalone base commit as the imported bridge when the assistant creates no output commit', () => {
    const messages = [
      makeMessage({
        id: 'origin-assistant',
        role: 'assistant',
        parentId: null,
        content: 'Origin assistant message.',
        status: 'completed',
      }, 0),
      makeMessage({
        id: 'base-user',
        role: 'user',
        parentId: 'origin-assistant',
        content: 'Use the later base commit but do not create a commit.',
      }, 10),
      makeMessage({
        id: 'base-assistant',
        role: 'assistant',
        parentId: 'base-user',
        content: 'Answered without changing files.',
        status: 'completed',
        base_commit_sha: 'postbatch0001',
      }, 11),
    ];
    const importedGraph = buildCanonicalImportedCommitChain();
    const commitGraph = {
      commits: [
        ...importedGraph.commits,
        {
          sha: 'postbatch0001',
          workspace_id: workspaceId,
          subject: 'Commit after imported batch',
          source_kind: 'external',
          produced_by_node_id: null,
          first_parent_sha: 'imported0004',
          committed_at: isoAt(8),
          authored_at: isoAt(8),
        },
      ],
      commitParents: [
        ...importedGraph.commitParents,
        { child_sha: 'postbatch0001', parent_sha: 'imported0004', parent_index: 0 },
      ],
      commitObservations: [
        ...importedGraph.commitObservations,
        {
          commit_sha: 'postbatch0001',
          source_kind: 'external',
          git_ref: 'refs/heads/main',
          first_seen_at: isoAt(20),
          last_seen_at: isoAt(21),
        },
      ],
    };

    const mapped = buildMappedGraph(messages, 'base-assistant', commitGraph);
    const visibleBaseCommitNodeId = getVisibleCommitNodeId(mapped.nodes, 'postbatch0001');
    expect(mapped.edges.some((edge) => (
      edge.source === visibleBaseCommitNodeId &&
      edge.target === 'base-assistant' &&
      (edge.data as any)?.relationship === 'base-used'
    ))).toBe(true);

    [getTidyTreeLayoutedElements, getLayoutedElements].forEach((layoutFn) => {
      const layouted = layoutFn(mapped.nodes, mapped.edges);
      const origin = getNode(layouted.nodes, 'origin-assistant');
      const bridgeCommit = getNode(layouted.nodes, getVisibleCommitNodeId(mapped.nodes, 'postbatch0001'));
      const baseUser = getNode(layouted.nodes, 'base-user');
      const baseAssistant = getNode(layouted.nodes, 'base-assistant');

      expect(baseUser.position.y).toBeGreaterThan(bridgeCommit.position.y);
      expect(baseAssistant.position.y).toBeGreaterThan(baseUser.position.y);
      expect(Math.abs(baseUser.position.x - origin.position.x)).toBeLessThanOrEqual(1);
    });
  });

  it('spaces an imported batch as a sibling of a no-output conversation turn from the same base commit', () => {
    const messages = [
      makeMessage({
        id: 'origin-assistant',
        role: 'assistant',
        parentId: null,
        content: 'Origin assistant message.',
        status: 'completed',
      }, 0),
      makeMessage({
        id: 'base-user',
        role: 'user',
        parentId: 'origin-assistant',
        content: 'Use the later base commit but do not create a commit.',
      }, 10),
      makeMessage({
        id: 'base-assistant',
        role: 'assistant',
        parentId: 'base-user',
        content: 'Answered without changing files.',
        status: 'completed',
        base_commit_sha: 'postbatch0001',
      }, 11),
    ];
    const importedGraph = buildCanonicalImportedCommitChain();
    const laterImportedCommits: CommitEntity[] = [1, 2, 3].map((index) => ({
      sha: `laterimported000${index}`,
      workspace_id: workspaceId,
      subject: `Later imported commit ${index}`,
      source_kind: 'external',
      produced_by_node_id: null,
      first_parent_sha: index === 1 ? 'postbatch0001' : `laterimported000${index - 1}`,
      committed_at: isoAt(30 + index),
      authored_at: isoAt(30 + index),
    }));
    const commitGraph = {
      commits: [
        ...importedGraph.commits,
        {
          sha: 'postbatch0001',
          workspace_id: workspaceId,
          subject: 'Commit after imported batch',
          source_kind: 'external',
          produced_by_node_id: null,
          first_parent_sha: 'imported0004',
          committed_at: isoAt(8),
          authored_at: isoAt(8),
        },
        ...laterImportedCommits,
      ],
      commitParents: [
        ...importedGraph.commitParents,
        { child_sha: 'postbatch0001', parent_sha: 'imported0004', parent_index: 0 },
        { child_sha: 'laterimported0001', parent_sha: 'postbatch0001', parent_index: 0 },
        { child_sha: 'laterimported0002', parent_sha: 'laterimported0001', parent_index: 0 },
        { child_sha: 'laterimported0003', parent_sha: 'laterimported0002', parent_index: 0 },
      ],
      commitObservations: [
        ...importedGraph.commitObservations,
        {
          commit_sha: 'postbatch0001',
          source_kind: 'external',
          git_ref: 'refs/heads/main',
          first_seen_at: isoAt(20),
          last_seen_at: isoAt(21),
        },
        ...laterImportedCommits.map((commit) => ({
          commit_sha: commit.sha,
          source_kind: 'external',
          git_ref: 'refs/heads/main',
          first_seen_at: isoAt(40),
          last_seen_at: isoAt(41),
        })),
      ],
    };

    const mapped = buildMappedGraph(messages, 'base-assistant', commitGraph);
    const laterImportedBatch = mapped.nodes
      .filter((node) => node.type === 'layout_derived_commit_group')
      .find((node) => ((node.data as any)?.group?.commitShas ?? []).includes('laterimported0001'));
    expect(laterImportedBatch).toBeTruthy();

    [getTidyTreeLayoutedElements, getLayoutedElements].forEach((layoutFn) => {
      const layouted = layoutFn(mapped.nodes, mapped.edges);
      const bridgeCommit = getNode(layouted.nodes, getVisibleCommitNodeId(mapped.nodes, 'postbatch0001'));
      const baseUser = getNode(layouted.nodes, 'base-user');
      const baseAssistant = getNode(layouted.nodes, 'base-assistant');
      const importedBatch = getNode(layouted.nodes, laterImportedBatch!.id);

      expect(baseUser.position.y).toBeGreaterThan(bridgeCommit.position.y);
      expect(importedBatch.id).toBe(bridgeCommit.id);
      expect(baseAssistant.position.y).toBeGreaterThan(baseUser.position.y);
    });
  });

  it('keeps conversation turns as siblings when git parent belongs to another conversation turn', () => {
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0),
      makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', status: 'completed' }, 1),
      makeMessage({ id: 'user-2', role: 'user', parentId: 'assistant-1' }, 2),
      makeMessage({
        id: 'assistant-2',
        role: 'assistant',
        parentId: 'user-2',
        status: 'completed',
        output_commit_sha: 'branchbcommit0002',
        execution_data: { meta: { commit_message: 'Branch B commit' } },
      }, 3),
      makeMessage({ id: 'user-3', role: 'user', parentId: 'assistant-1' }, 4),
      makeMessage({
        id: 'assistant-3',
        role: 'assistant',
        parentId: 'user-3',
        status: 'completed',
        base_commit_sha: 'branchbcommit0002',
        output_commit_sha: 'branchccommit0003',
        execution_data: { meta: { commit_message: 'Branch C commit' } },
      }, 5),
    ];

    const mapped = buildMappedGraph(messages, 'assistant-3');
    const layouted = getTidyTreeLayoutedElements(mapped.nodes, mapped.edges);
    const branchBUser = getNode(layouted.nodes, 'user-2');
    const branchCUser = getNode(layouted.nodes, 'user-3');
    const branchBAssistant = getNode(layouted.nodes, 'assistant-2');
    const branchCAssistant = getNode(layouted.nodes, 'assistant-3');
    const branchCGeneratedCommit = getNode(layouted.nodes, 'commit:assistant-3');

    expect(Math.abs(branchBUser.position.y - branchCUser.position.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(branchBAssistant.position.y - branchCAssistant.position.y)).toBeLessThanOrEqual(1);
    expect(branchCGeneratedCommit.position.x).toBeGreaterThan(branchCAssistant.position.x);
  });

  it('keeps a single observed imported ref batch even when merge commits are included', () => {
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0),
      makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', status: 'completed' }, 1),
    ];
    const commits: CommitEntity[] = [1, 2, 3, 4, 5].map((index) => ({
      sha: `batch000${index}`,
      workspace_id: workspaceId,
      subject: `Imported batch commit ${index}`,
      source_kind: 'external',
      produced_by_node_id: null,
      first_parent_sha: index === 1 ? 'base0001' : `batch000${index - 1}`,
      committed_at: isoAt(index),
      authored_at: isoAt(index),
    }));
    const commitParents = [
      { child_sha: 'batch0001', parent_sha: 'base0001', parent_index: 0 },
      { child_sha: 'batch0002', parent_sha: 'batch0001', parent_index: 0 },
      { child_sha: 'batch0003', parent_sha: 'batch0002', parent_index: 0 },
      { child_sha: 'batch0004', parent_sha: 'batch0003', parent_index: 0 },
      { child_sha: 'batch0004', parent_sha: 'side0001', parent_index: 1 },
      { child_sha: 'batch0005', parent_sha: 'batch0004', parent_index: 0 },
    ];
    const commitObservations = commits.map((commit) => ({
      commit_sha: commit.sha,
      source_kind: 'external',
      git_ref: 'refs/heads/main',
      first_seen_at: isoAt(20),
      last_seen_at: isoAt(20),
    }));

    const mapped = buildMappedGraph(messages, 'assistant-1', { commits, commitParents, commitObservations });
    const groups = mapped.nodes.filter((node) => node.type === 'layout_derived_commit_group');
    const individualImportedCommits = mapped.nodes.filter((node) => (
      node.type === 'canonical_commit' &&
      String(node.id).startsWith('batch')
    ));

    expect(groups).toHaveLength(1);
    expect((groups[0].data as any).group.commitShas).toHaveLength(5);
    expect(individualImportedCommits).toHaveLength(0);

    const layouted = getLayoutedElements(mapped.nodes, mapped.edges);
    const origin = getNode(layouted.nodes, 'user-1');
    const group = getNode(layouted.nodes, groups[0].id);
    const originRight = origin.position.x + numberStyle(origin.style?.width);
    expect(group.position.x).toBeGreaterThan(origin.position.x);
    expect(group.position.x - originRight).toBeLessThanOrEqual(8);
    expect(group.position.x - origin.position.x).toBeLessThan(280);
    expect(Math.abs(group.position.y - origin.position.y)).toBeLessThan(80);
    expect(layouted.edges.some((edge) => edge.source === 'user-1' && edge.target === group.id)).toBe(false);
  });

  it('emits only inter-turn conversation, commit-parent, and base-used semantic edges', () => {
    const mapped = buildMappedGraph(buildTwoTurnBaseCommitScenario());
    const keys = semanticEdgeKeys(mapped.edges);

    expect(keys).toContain(edgeKey('assistant-1', 'user-2', 'conversation'));
    expect(keys).toContain(edgeKey('commit-1', 'commit-2', 'git-parent'));
    expect(keys).toContain(edgeKey('commit-1', 'assistant-2', 'base-used'));

    expect(keys).not.toContain(edgeKey('user-1', 'assistant-1', 'conversation'));
    expect(keys).not.toContain(edgeKey('assistant-1', 'commit-1', 'git-parent'));
    expect(keys).not.toContain(edgeKey('user-2', 'assistant-2', 'conversation'));
    expect(keys).not.toContain(edgeKey('assistant-2', 'commit-2', 'git-parent'));

    const allowedRelationships = new Set(['conversation', 'git-parent', 'base-used']);
    expect(mapped.edges.every((edge) => allowedRelationships.has(String((edge.data as any)?.relationship)))).toBe(true);

    const baseEdge = mapped.edges.find((edge) => edge.source === 'commit-1' && edge.target === 'assistant-2');
    expect((baseEdge?.data as any)?.layout).not.toBe(false);
    expect(baseEdge?.style?.strokeDasharray).toBe('4 5');

    const conversationEdge = mapped.edges.find((edge) => edge.source === 'assistant-1' && edge.target === 'user-2');
    const commitParentEdge = mapped.edges.find((edge) => edge.source === 'commit-1' && edge.target === 'commit-2');
    expect((conversationEdge?.data as any)?.layout).toBe(true);
    expect((conversationEdge?.data as any)?.relationship).toBe('conversation');
    expect((conversationEdge?.data as any)?.edgeLegendType).toBe('context-break');
    expect((commitParentEdge?.data as any)?.layout).toBe(true);
    expect(commitParentEdge?.sourceHandle).toBe('bottom-source');
    expect(commitParentEdge?.targetHandle).toBe('top-target');
    expect(conversationEdge?.sourceHandle).toBe('bottom-source');
    expect(conversationEdge?.targetHandle).toBe('top-target');
    expect(baseEdge?.sourceHandle).toBe('bottom-source');
    expect(baseEdge?.targetHandle).toBe('top-target');
  });

  it('highlights the supplied context path rather than the focused node lineage', () => {
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0),
      makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1' }, 1),
      makeMessage({ id: 'user-2', role: 'user', parentId: 'assistant-1' }, 2),
      makeMessage({ id: 'assistant-2', role: 'assistant', parentId: 'user-2' }, 3),
    ];
    const mapped = buildMappedGraph(
      messages,
      'assistant-2',
      undefined,
      new Set(['user-1', 'assistant-1', 'user-2']),
    );

    expect((getNode(mapped.nodes, 'user-1').data as any).isInContextPath).toBe(true);
    expect((getNode(mapped.nodes, 'assistant-1').data as any).isInContextPath).toBe(true);
    expect((getNode(mapped.nodes, 'user-2').data as any).isInContextPath).toBe(true);
    expect((getNode(mapped.nodes, 'assistant-2').data as any).isInContextPath).toBe(false);

    const highlightedEdge = mapped.edges.find((edge) => edge.source === 'assistant-1' && edge.target === 'user-2');
    const focusedLineageEdge = mapped.edges.find((edge) => edge.source === 'user-2' && edge.target === 'assistant-2');
    expect(highlightedEdge?.animated).toBe(true);
    expect(focusedLineageEdge?.animated).not.toBe(true);
  });

  it('emits semantic edges from node bottoms after layout', () => {
    const mapped = buildMappedGraph(buildTwoTurnBaseCommitScenario());
    const layouted = getTidyTreeLayoutedElements(mapped.nodes, mapped.edges);
    const assistant = getNode(layouted.nodes, 'assistant-1');
    const commit = getNode(layouted.nodes, 'commit-1');
    const user = getNode(layouted.nodes, 'user-2');

    expect(assistant.sourcePosition).toBe(Position.Bottom);
    expect(commit.sourcePosition).toBe(Position.Bottom);
    expect(user.targetPosition).toBe(Position.Top);
  });

  it('keeps sibling turns on the same row in tidy layout', () => {
    const mapped = buildMappedGraph(buildSiblingTurnScenario());
    const layouted = getTidyTreeLayoutedElements(mapped.nodes, mapped.edges);
    const firstSiblingUser = getNode(layouted.nodes, 'user-2');
    const secondSiblingUser = getNode(layouted.nodes, 'user-3');
    const firstSiblingAssistant = getNode(layouted.nodes, 'assistant-2');
    const secondSiblingAssistant = getNode(layouted.nodes, 'assistant-3');

    expect(Math.abs(firstSiblingUser.position.y - secondSiblingUser.position.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(firstSiblingAssistant.position.y - secondSiblingAssistant.position.y)).toBeLessThanOrEqual(1);
  });
});
