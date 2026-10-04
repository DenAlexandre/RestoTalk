import { sessionReducer, initialSessionState, SessionState } from './sessionReducer';

const authenticatedBase: SessionState = {
  status: 'authenticated',
  token: 'tok',
  session: { id: 1, pseudo: 'Alice', tableId: 10 },
  tables: [],
  pendingContactRequests: [],
  resolvedContacts: [],
};

describe('sessionReducer', () => {
  it('starts in the loading state', () => {
    expect(initialSessionState).toEqual({ status: 'loading' });
  });

  it('BOOT_UNAUTHENTICATED moves to unauthenticated from any state', () => {
    const result = sessionReducer(authenticatedBase, { type: 'BOOT_UNAUTHENTICATED' });
    expect(result).toEqual({ status: 'unauthenticated' });
  });

  it('AUTHENTICATED moves to authenticated with empty lists', () => {
    const result = sessionReducer(initialSessionState, {
      type: 'AUTHENTICATED',
      token: 'tok',
      session: { id: 1, pseudo: 'Alice', tableId: 10 },
    });
    expect(result).toEqual({
      status: 'authenticated',
      token: 'tok',
      session: { id: 1, pseudo: 'Alice', tableId: 10 },
      tables: [],
      pendingContactRequests: [],
      resolvedContacts: [],
    });
  });

  it('TABLES_UPDATED replaces the tables list when authenticated', () => {
    const result = sessionReducer(authenticatedBase, {
      type: 'TABLES_UPDATED',
      tables: [{ tableId: 2, number: 5, activeSessionCount: 1 }],
    });
    expect(result).toMatchObject({ tables: [{ tableId: 2, number: 5, activeSessionCount: 1 }] });
  });

  it('TABLES_UPDATED is a no-op when not authenticated', () => {
    const result = sessionReducer(
      { status: 'unauthenticated' },
      { type: 'TABLES_UPDATED', tables: [{ tableId: 2, number: 5, activeSessionCount: 1 }] },
    );
    expect(result).toEqual({ status: 'unauthenticated' });
  });

  it('CONTACT_REQUEST_RECEIVED adds a new pending request', () => {
    const result = sessionReducer(authenticatedBase, {
      type: 'CONTACT_REQUEST_RECEIVED',
      request: { contactId: 7, fromTableId: 2, fromTableNumber: 5 },
    });
    expect(result).toMatchObject({
      pendingContactRequests: [{ contactId: 7, fromTableId: 2, fromTableNumber: 5 }],
    });
  });

  it('CONTACT_REQUEST_RECEIVED ignores a duplicate contactId', () => {
    const withOne: SessionState = {
      ...authenticatedBase,
      pendingContactRequests: [{ contactId: 7, fromTableId: 2, fromTableNumber: 5 }],
    };
    const result = sessionReducer(withOne, {
      type: 'CONTACT_REQUEST_RECEIVED',
      request: { contactId: 7, fromTableId: 2, fromTableNumber: 5 },
    });
    expect(result).toMatchObject({ pendingContactRequests: [{ contactId: 7 }] });
    if (result.status === 'authenticated') {
      expect(result.pendingContactRequests).toHaveLength(1);
    }
  });

  it('CONTACT_REQUEST_DISMISSED removes the matching request', () => {
    const withOne: SessionState = {
      ...authenticatedBase,
      pendingContactRequests: [{ contactId: 7, fromTableId: 2, fromTableNumber: 5 }],
    };
    const result = sessionReducer(withOne, { type: 'CONTACT_REQUEST_DISMISSED', contactId: 7 });
    expect(result).toMatchObject({ pendingContactRequests: [] });
  });

  it('CONTACT_RESOLVED_RECEIVED adds a new resolution and ignores duplicates', () => {
    const once = sessionReducer(authenticatedBase, {
      type: 'CONTACT_RESOLVED_RECEIVED',
      resolution: { contactId: 9, status: 'accepted' },
    });
    const twice = sessionReducer(once, {
      type: 'CONTACT_RESOLVED_RECEIVED',
      resolution: { contactId: 9, status: 'accepted' },
    });
    if (twice.status === 'authenticated') {
      expect(twice.resolvedContacts).toHaveLength(1);
    }
  });

  it('CONTACT_RESOLVED_DISMISSED removes the matching resolution', () => {
    const withOne: SessionState = {
      ...authenticatedBase,
      resolvedContacts: [{ contactId: 9, status: 'accepted' }],
    };
    const result = sessionReducer(withOne, { type: 'CONTACT_RESOLVED_DISMISSED', contactId: 9 });
    expect(result).toMatchObject({ resolvedContacts: [] });
  });

  it('LEFT moves back to unauthenticated', () => {
    const result = sessionReducer(authenticatedBase, { type: 'LEFT' });
    expect(result).toEqual({ status: 'unauthenticated' });
  });
});
