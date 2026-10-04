import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SessionProvider, useSession } from './SessionContext';
import * as tokenStorage from './tokenStorage';
import { createApiClient, ApiError } from '../api/client';
import { createSocket } from '../realtime/socket';

jest.mock('./tokenStorage');
jest.mock('../api/client');
jest.mock('../realtime/socket');

function makeFakeSocket() {
  const listeners: Record<string, Function[]> = {};
  return {
    on: jest.fn((event: string, cb: Function) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
    }),
    disconnect: jest.fn(),
    __emit: (event: string, payload?: unknown) => {
      (listeners[event] ?? []).forEach((cb) => cb(payload));
    },
  };
}

function Probe() {
  const session = useSession();
  return <Text testID="status">{session.state.status}</Text>;
}

describe('SessionProvider', () => {
  let fakeSocket: ReturnType<typeof makeFakeSocket>;
  let fakeApi: {
    getMe: jest.Mock;
    createSession: jest.Mock;
    getOccupiedTables: jest.Mock;
    leaveSession: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    fakeSocket = makeFakeSocket();
    (createSocket as jest.Mock).mockReturnValue(fakeSocket);
    fakeApi = {
      getMe: jest.fn(),
      createSession: jest.fn(),
      getOccupiedTables: jest.fn().mockResolvedValue([]),
      leaveSession: jest.fn().mockResolvedValue({ status: 'left' }),
    };
    (createApiClient as jest.Mock).mockReturnValue(fakeApi);
  });

  it('boots to unauthenticated when no token is stored', async () => {
    (tokenStorage.loadToken as jest.Mock).mockResolvedValue(null);

    const { getByTestId } = render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => expect(getByTestId('status').props.children).toBe('unauthenticated'));
  });

  it('boots to authenticated when a stored token is still valid', async () => {
    (tokenStorage.loadToken as jest.Mock).mockResolvedValue('good-token');
    fakeApi.getMe.mockResolvedValue({ id: 1, pseudo: 'Alice', tableId: 10, status: 'active' });

    const { getByTestId } = render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => expect(getByTestId('status').props.children).toBe('authenticated'));
    expect(createSocket).toHaveBeenCalledWith(expect.any(String), 'good-token');
  });

  it('clears the token and boots to unauthenticated when the stored token is rejected', async () => {
    (tokenStorage.loadToken as jest.Mock).mockResolvedValue('stale-token');
    fakeApi.getMe.mockRejectedValue(new ApiError(401, 'Unauthorized'));

    const { getByTestId } = render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => expect(getByTestId('status').props.children).toBe('unauthenticated'));
    expect(tokenStorage.clearToken).toHaveBeenCalled();
  });

  it('scanAndJoin authenticates on success and does not throw', async () => {
    (tokenStorage.loadToken as jest.Mock).mockResolvedValue(null);
    fakeApi.createSession = jest.fn().mockResolvedValue({
      sessionToken: 'new-token',
      session: { id: 2, pseudo: 'Bob', tableId: 11 },
    });

    let hook: ReturnType<typeof useSession> | undefined;
    function Capture() {
      hook = useSession();
      return null;
    }
    const { getByTestId } = render(
      <SessionProvider>
        <Probe />
        <Capture />
      </SessionProvider>,
    );
    await waitFor(() => expect(getByTestId('status').props.children).toBe('unauthenticated'));

    await act(async () => {
      await hook!.scanAndJoin(11, 'secret', 'Bob');
    });

    expect(getByTestId('status').props.children).toBe('authenticated');
    expect(tokenStorage.saveToken).toHaveBeenCalledWith('new-token');
  });

  it('scanAndJoin rejects and stays unauthenticated when the backend rejects the secret', async () => {
    (tokenStorage.loadToken as jest.Mock).mockResolvedValue(null);
    fakeApi.createSession = jest.fn().mockRejectedValue(new ApiError(401, 'Invalid QR secret'));

    let hook: ReturnType<typeof useSession> | undefined;
    function Capture() {
      hook = useSession();
      return null;
    }
    const { getByTestId } = render(
      <SessionProvider>
        <Probe />
        <Capture />
      </SessionProvider>,
    );
    await waitFor(() => expect(getByTestId('status').props.children).toBe('unauthenticated'));

    await expect(
      act(async () => {
        await hook!.scanAndJoin(11, 'wrong-secret', 'Bob');
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(getByTestId('status').props.children).toBe('unauthenticated');
  });

  it('re-fetches the table list when the socket reconnects', async () => {
    (tokenStorage.loadToken as jest.Mock).mockResolvedValue('good-token');
    fakeApi.getMe.mockResolvedValue({ id: 1, pseudo: 'Alice', tableId: 10, status: 'active' });

    const { getByTestId } = render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(getByTestId('status').props.children).toBe('authenticated'));

    const callsBeforeReconnect = fakeApi.getOccupiedTables.mock.calls.length;

    act(() => {
      fakeSocket.__emit('connect');
    });

    await waitFor(() =>
      expect(fakeApi.getOccupiedTables.mock.calls.length).toBeGreaterThan(callsBeforeReconnect),
    );
  });
});
