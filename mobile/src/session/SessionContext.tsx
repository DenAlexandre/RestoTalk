import React, { createContext, useContext, useEffect, useReducer, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { API_BASE_URL } from '../config';
import { createApiClient, ApiClient } from '../api/client';
import { createSocket } from '../realtime/socket';
import { loadToken, saveToken, clearToken } from './tokenStorage';
import { sessionReducer, initialSessionState, SessionState } from './sessionReducer';
import { OccupiedTable, ContactRequestEvent, ContactResolvedEvent } from '../types/api';

type SessionContextValue = {
  state: SessionState;
  api: ApiClient;
  socket: Socket | null;
  scanAndJoin: (tableId: number, secret: string, pseudo: string) => Promise<void>;
  leave: () => Promise<void>;
  dismissPendingContactRequest: (contactId: number) => void;
  dismissResolvedContact: (contactId: number) => void;
};

const SessionReactContext = createContext<SessionContextValue | undefined>(undefined);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const tokenRef = useRef<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const api = createApiClient({ baseUrl: API_BASE_URL, getToken: () => tokenRef.current });

  function connectRealtime(token: string) {
    const socket = createSocket(API_BASE_URL, token);
    socketRef.current = socket;

    socket.on('connect', async () => {
      try {
        const tables = await api.getOccupiedTables();
        dispatch({ type: 'TABLES_UPDATED', tables });
      } catch {
        // transient — the next successful fetch (e.g. the next tables:update) will recover
      }
    });

    socket.on('tables:update', (tables: OccupiedTable[]) => {
      dispatch({ type: 'TABLES_UPDATED', tables });
    });

    socket.on('contact:request', (request: ContactRequestEvent) => {
      dispatch({ type: 'CONTACT_REQUEST_RECEIVED', request });
    });

    socket.on('contact:resolved', (resolution: ContactResolvedEvent) => {
      dispatch({ type: 'CONTACT_RESOLVED_RECEIVED', resolution });
    });
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const stored = await loadToken();
      if (!stored) {
        dispatch({ type: 'BOOT_UNAUTHENTICATED' });
        return;
      }

      tokenRef.current = stored;
      try {
        const me = await api.getMe();
        if (cancelled) return;
        dispatch({
          type: 'AUTHENTICATED',
          token: stored,
          session: { id: me.id, pseudo: me.pseudo, tableId: me.tableId },
        });
        connectRealtime(stored);
      } catch {
        tokenRef.current = null;
        await clearToken();
        if (!cancelled) dispatch({ type: 'BOOT_UNAUTHENTICATED' });
      }
    })();

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scanAndJoin(tableId: number, secret: string, pseudo: string) {
    const result = await api.createSession({ tableId, secret, pseudo });
    tokenRef.current = result.sessionToken;
    await saveToken(result.sessionToken);
    dispatch({ type: 'AUTHENTICATED', token: result.sessionToken, session: result.session });
    connectRealtime(result.sessionToken);
  }

  async function leave() {
    if (state.status === 'authenticated') {
      await api.leaveSession(state.session.id);
    }
    socketRef.current?.disconnect();
    socketRef.current = null;
    tokenRef.current = null;
    await clearToken();
    dispatch({ type: 'LEFT' });
  }

  function dismissPendingContactRequest(contactId: number) {
    dispatch({ type: 'CONTACT_REQUEST_DISMISSED', contactId });
  }

  function dismissResolvedContact(contactId: number) {
    dispatch({ type: 'CONTACT_RESOLVED_DISMISSED', contactId });
  }

  return (
    <SessionReactContext.Provider
      value={{
        state,
        api,
        socket: socketRef.current,
        scanAndJoin,
        leave,
        dismissPendingContactRequest,
        dismissResolvedContact,
      }}
    >
      {children}
    </SessionReactContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionReactContext);
  if (!ctx) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return ctx;
}
