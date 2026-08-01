import { http, HttpResponse, delay } from 'msw';
import { API_URL } from '../lib/api';
import {
  graphSnapshot,
  messages,
  sendResponse,
  workspaceId,
  workspaces,
} from './scenarios/frontendContracts';

export const handlers = [
  http.get(`${API_URL}/workspaces`, async () => {
    await delay(5);
    return HttpResponse.json(workspaces);
  }),

  http.get(`${API_URL}/workspaces/:workspaceId/messages`, async ({ params }) => {
    await delay(5);
    if (params.workspaceId !== workspaceId) {
      return HttpResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    return HttpResponse.json(messages);
  }),

  http.get(`${API_URL}/workspaces/:workspaceId/graph-snapshot`, async ({ params }) => {
    await delay(5);
    if (params.workspaceId !== workspaceId) {
      return HttpResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    return HttpResponse.json(graphSnapshot);
  }),

  http.post(`${API_URL}/workspaces/:workspaceId/messages`, async ({ params }) => {
    await delay(5);
    if (params.workspaceId !== workspaceId) {
      return HttpResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    return HttpResponse.json(sendResponse, { status: 201 });
  }),
];
