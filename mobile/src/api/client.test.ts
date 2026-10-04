import { createApiClient, ApiError } from './client';

function mockFetchOnce(status: number, body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe('createApiClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('sends a bearer token when one is available', async () => {
    mockFetchOnce(200, { id: 1, pseudo: 'Alice', tableId: 2, status: 'active' });
    const client = createApiClient({ baseUrl: 'http://test', getToken: () => 'abc123' });

    await client.getMe();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://test/sessions/me',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer abc123' }),
      }),
    );
  });

  it('omits the Authorization header when there is no token', async () => {
    mockFetchOnce(201, {
      sessionToken: 'tok',
      session: { id: 1, pseudo: 'Alice', tableId: 2 },
    });
    const client = createApiClient({ baseUrl: 'http://test', getToken: () => null });

    await client.createSession({ tableId: 2, secret: 's', pseudo: 'Alice' });

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.headers.Authorization).toBeUndefined();
  });

  it('parses a successful JSON response', async () => {
    mockFetchOnce(200, [{ tableId: 3, number: 7, activeSessionCount: 2 }]);
    const client = createApiClient({ baseUrl: 'http://test', getToken: () => 'tok' });

    const result = await client.getOccupiedTables();

    expect(result).toEqual([{ tableId: 3, number: 7, activeSessionCount: 2 }]);
  });

  it('throws ApiError with the response status on a non-2xx response', async () => {
    mockFetchOnce(401, { message: 'Invalid token' });
    mockFetchOnce(401, { message: 'Invalid token' });
    const client = createApiClient({ baseUrl: 'http://test', getToken: () => 'bad' });

    await expect(client.getMe()).rejects.toBeInstanceOf(ApiError);
    await expect(client.getMe()).rejects.toMatchObject({ status: 401 });
  });

  it('sends the request body as JSON for POST calls', async () => {
    mockFetchOnce(201, { status: 'sent', contactId: 5 });
    const client = createApiClient({ baseUrl: 'http://test', getToken: () => 'tok' });

    await client.sendMessage({ toTableId: 9, kind: 'freetext', content: 'Salut' });

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ toTableId: 9, kind: 'freetext', content: 'Salut' });
  });
});
