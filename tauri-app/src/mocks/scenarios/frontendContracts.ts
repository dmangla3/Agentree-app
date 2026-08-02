import type { GraphSnapshot } from '../../hooks/useGraphSnapshot';
import type { Message, Workspace } from '../../stores/workspaceStore';

const now = '2026-05-09T04:00:00.000Z';

export const workspaceId = 'workspace-msw-1';

export const workspaces: Workspace[] = [
  {
    id: workspaceId,
    name: 'MSW Frontend Contract',
    userId: 'user-msw',
    folderPath: '/tmp/agentree-msw',
    repo_path: '/tmp/agentree-msw',
    git_repo_path: '/tmp/agentree-msw',
    base_commit_sha: 'base0001',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'workspace-deleted-local',
    name: 'Locally Deleted Workspace',
    userId: 'user-msw',
    createdAt: now,
    updatedAt: now,
  },
];

export const messages: Message[] = [
  {
    id: 'msg-user-1',
    role: 'user',
    content: 'Build the deterministic MSW test path.',
    parentId: null,
    workspaceId,
    createdAt: '2026-05-09T04:00:01.000Z',
    updatedAt: '2026-05-09T04:00:01.000Z',
  },
  {
    id: 'msg-assistant-1',
    role: 'assistant',
    content: 'MSW scenario is active and stable.',
    parentId: 'msg-user-1',
    workspaceId,
    status: 'completed',
    output_commit_sha: 'commit0001',
    git_branch_name: 'agentree/msw-contract',
    createdAt: '2026-05-09T04:00:02.000Z',
    updatedAt: '2026-05-09T04:00:03.000Z',
  },
];

export const graphSnapshot: GraphSnapshot = {
  version: 2,
  workspaceId,
  generatedAt: '2026-05-09T04:00:04.000Z',
  workspaceUpdatedAt: now,
  messages: messages.map((message) => ({
    id: message.id,
    role: message.role,
    parentId: message.parentId,
    workspaceId: message.workspaceId,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    contentPreview: message.content,
    contentLength: message.content.length,
    status: message.status,
    output_commit_sha: message.output_commit_sha,
    git_branch_name: message.git_branch_name,
  })),
  summaries: [],
  commits: [
    {
      sha: 'commit0001',
      workspace_id: workspaceId,
      subject: 'MSW scenario is active and stable.',
      source_kind: 'agent',
      produced_by_node_id: 'msg-assistant-1',
      first_parent_sha: 'base0001',
      committed_at: '2026-05-09T04:00:03.000Z',
    },
  ],
  commitParents: [
    {
      child_sha: 'commit0001',
      parent_sha: 'base0001',
      parent_index: 0,
    },
  ],
  commitObservations: [],
  cacheWriteDisabled: true,
};

export const sendResponse = {
  userMessage: {
    id: 'msg-user-2',
    role: 'user',
    content: 'Does cache update after a mocked send?',
    parentId: 'msg-assistant-1',
    workspaceId,
    createdAt: '2026-05-09T04:00:05.000Z',
    updatedAt: '2026-05-09T04:00:05.000Z',
  } satisfies Message,
  assistantMessages: [
    {
      id: 'msg-assistant-2',
      role: 'assistant',
      content: '',
      parentId: 'msg-user-2',
      workspaceId,
      status: 'running',
      createdAt: '2026-05-09T04:00:06.000Z',
      updatedAt: '2026-05-09T04:00:06.000Z',
    } satisfies Message,
  ],
  updatedWorkspaceName: 'MSW Frontend Contract',
};
