import { OccupiedTable, ContactRequestEvent, ContactResolvedEvent } from '../types/api';

export type SessionState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | {
      status: 'authenticated';
      token: string;
      session: { id: number; pseudo: string; tableId: number };
      tables: OccupiedTable[];
      pendingContactRequests: ContactRequestEvent[];
      resolvedContacts: ContactResolvedEvent[];
    };

export type SessionAction =
  | { type: 'BOOT_UNAUTHENTICATED' }
  | { type: 'AUTHENTICATED'; token: string; session: { id: number; pseudo: string; tableId: number } }
  | { type: 'TABLES_UPDATED'; tables: OccupiedTable[] }
  | { type: 'CONTACT_REQUEST_RECEIVED'; request: ContactRequestEvent }
  | { type: 'CONTACT_REQUEST_DISMISSED'; contactId: number }
  | { type: 'CONTACT_RESOLVED_RECEIVED'; resolution: ContactResolvedEvent }
  | { type: 'CONTACT_RESOLVED_DISMISSED'; contactId: number }
  | { type: 'LEFT' };

export const initialSessionState: SessionState = { status: 'loading' };

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'BOOT_UNAUTHENTICATED':
    case 'LEFT':
      return { status: 'unauthenticated' };

    case 'AUTHENTICATED':
      return {
        status: 'authenticated',
        token: action.token,
        session: action.session,
        tables: [],
        pendingContactRequests: [],
        resolvedContacts: [],
      };

    case 'TABLES_UPDATED':
      if (state.status !== 'authenticated') return state;
      return { ...state, tables: action.tables };

    case 'CONTACT_REQUEST_RECEIVED':
      if (state.status !== 'authenticated') return state;
      if (state.pendingContactRequests.some((r) => r.contactId === action.request.contactId)) {
        return state;
      }
      return {
        ...state,
        pendingContactRequests: [...state.pendingContactRequests, action.request],
      };

    case 'CONTACT_REQUEST_DISMISSED':
      if (state.status !== 'authenticated') return state;
      return {
        ...state,
        pendingContactRequests: state.pendingContactRequests.filter(
          (r) => r.contactId !== action.contactId,
        ),
      };

    case 'CONTACT_RESOLVED_RECEIVED':
      if (state.status !== 'authenticated') return state;
      if (state.resolvedContacts.some((r) => r.contactId === action.resolution.contactId)) {
        return state;
      }
      return {
        ...state,
        resolvedContacts: [...state.resolvedContacts, action.resolution],
      };

    case 'CONTACT_RESOLVED_DISMISSED':
      if (state.status !== 'authenticated') return state;
      return {
        ...state,
        resolvedContacts: state.resolvedContacts.filter((r) => r.contactId !== action.contactId),
      };

    default:
      return state;
  }
}
