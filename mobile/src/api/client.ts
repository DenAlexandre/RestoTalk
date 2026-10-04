import {
  OccupiedTable,
  SessionResponse,
  MeResponse,
  MessageDto,
  SendMessageResponse,
  RespondResponse,
} from '../types/api';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ApiClientConfig = {
  baseUrl: string;
  getToken: () => string | null;
};

export function createApiClient(config: ApiClientConfig) {
  async function request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const token = config.getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(`${config.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, text || res.statusText);
    }

    return res.json() as Promise<T>;
  }

  return {
    createSession: (body: { tableId: number; secret: string; pseudo: string }) =>
      request<SessionResponse>('/sessions', { method: 'POST', body }),

    getMe: () => request<MeResponse>('/sessions/me'),

    leaveSession: (sessionId: number) =>
      request<{ status: string }>(`/sessions/${sessionId}/leave`, { method: 'POST' }),

    getOccupiedTables: () => request<OccupiedTable[]>('/tables/occupied'),

    sendMessage: (body: {
      toTableId: number;
      kind: 'predefined' | 'freetext';
      predefinedCode?: string;
      content: string;
    }) => request<SendMessageResponse>('/messages', { method: 'POST', body }),

    respondToContact: (contactId: number, accept: boolean) =>
      request<RespondResponse>(`/contacts/${contactId}/respond`, {
        method: 'POST',
        body: { accept },
      }),

    getContactMessages: (contactId: number) =>
      request<MessageDto[]>(`/contacts/${contactId}/messages`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
