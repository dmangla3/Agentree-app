import { isTauriEnvironment } from '../hooks/useTauriWorkspace';
import { agentClient, type ThreadSessionPayload } from '../lib/agentClient';
import { api } from '../lib/api';

const list = async (workspaceId: string): Promise<Record<string, unknown>[]> => {
  if (isTauriEnvironment()) {
    return await agentClient.listThreadSessions(workspaceId) as unknown as Record<string, unknown>[];
  }
  const response = await api.get(`/workspaces/${workspaceId}/threads`);
  return Array.isArray(response.data) ? response.data as Record<string, unknown>[] : [];
};

const create = async (payload: ThreadSessionPayload): Promise<ThreadSessionPayload> => {
  if (isTauriEnvironment()) {
    return await agentClient.localFirstCreateThreadSession(payload);
  }
  const response = await api.post(`/workspaces/${payload.workspaceId}/threads`, payload);
  return response.data as ThreadSessionPayload;
};

const update = async (payload: ThreadSessionPayload): Promise<ThreadSessionPayload> => {
  if (isTauriEnvironment()) {
    return await agentClient.localFirstCreateThreadSession(payload);
  }
  const response = await api.patch(
    `/workspaces/${payload.workspaceId}/threads/${payload.id}`,
    payload,
  );
  return response.data as ThreadSessionPayload;
};

const remove = async (workspaceId: string, threadId: string): Promise<void> => {
  if (isTauriEnvironment()) {
    await agentClient.localFirstDeleteThreadSession(workspaceId, threadId);
    return;
  }
  await api.delete(`/workspaces/${workspaceId}/threads/${threadId}`);
};

export const threadApplication = { list, create, update, remove };
