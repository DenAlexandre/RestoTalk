# RestoTalk Mobile App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React Native (Expo Dev Client) mobile app — scan a table's QR code, join under a pseudo, see the live list of occupied tables, request/accept/refuse contact, and exchange messages — against the already-implemented and already-shipped RestoTalk backend.

**Architecture:** A new `mobile/` Expo project. Pure, fully unit-testable logic (API client, token storage, session state reducer, chat-message helpers) lives in small dependency-injected modules; a thin `SessionContext` provider wires that logic to React, Socket.io, and `expo-secure-store` side effects; five screens consume the context via `@react-navigation/native-stack`. Camera and real-device/socket behavior cannot be unit-tested in this environment — those tasks end in a guided manual verification step instead of an automated test, per the spec's own testing strategy (spec §6).

**Tech Stack:** Expo SDK (dev client, not Expo Go — camera, and later voice/push, need native modules Expo Go doesn't support), TypeScript, `@react-navigation/native` + `native-stack`, `expo-camera`, `expo-secure-store`, `socket.io-client`, React Context + `useReducer` (no Redux/Zustand), Jest (`jest-expo` preset) + `@testing-library/react-native`.

**Spec:** `docs/superpowers/specs/2026-10-04-phase2-messaging-mobile-design.md` (section 4), which itself extends `docs/superpowers/specs/2026-10-04-restotalk-design.md`.

## Backend API this plan is grounded in (already implemented, shipped, tested)

REST (base URL configurable, `Authorization: Bearer <sessionToken>` header on every route except the first):
- `POST /sessions` — body `{ tableId: number, secret: string, pseudo: string }` → `{ sessionToken: string, session: { id: number, pseudo: string, tableId: number } }`. 404 for an unknown `tableId`, 401 for a wrong `secret`.
- `GET /sessions/me` → `{ id, pseudo, tableId, status }`. 401 if the token is invalid or the session is no longer `active`.
- `POST /sessions/:id/leave` → `{ status: 'left' }`.
- `GET /tables/occupied` → `{ tableId: number, number: number, activeSessionCount: number }[]` (excludes the caller's own table).
- `POST /messages` — body `{ toTableId: number, kind: 'predefined' | 'freetext', predefinedCode?: string, content: string }` → `{ status: 'sent' | 'pending_approval', contactId: number, message?: MessageDto }`. 404 unknown table, 400 own-table/non-occupied-table, 201 otherwise.
- `POST /contacts/:contactId/respond` — body `{ accept: boolean }` → `{ status: 'accepted' | 'refused' }`. 403 if the caller isn't the destination table, 400 if already resolved.
- `GET /contacts/:contactId/messages` → `MessageDto[]` ordered oldest-first. 403 if the caller's table isn't a participant, 400 if the contact isn't `accepted` yet.

`MessageDto = { id: number, kind: 'predefined' | 'freetext', predefinedCode: string | null, content: string, senderSessionId: number, createdAt: string }`.

Socket.io: handshake `io(baseUrl, { auth: { token: sessionToken } })`. Server rejects with `connect_error` if the token is invalid or the session isn't `active`. Events received by the client (exact wire names, colon-separated):
- `tables:update` → the full current `{ tableId, number, activeSessionCount }[]` (same shape as `GET /tables/occupied`, broadcast to everyone).
- `contact:request` → `{ contactId: number, fromTableId: number, fromTableNumber: number }` (sent only to the destination table's room).
- `contact:resolved` → `{ contactId: number, status: 'accepted' | 'refused' }` (sent only to the requesting table's room).
- `message:new` → `{ contactId: number, message: MessageDto }` (sent to both participating tables' rooms).

## Design decisions this plan fills in (spec left these open)

- **QR payload format:** the physical QR encodes a JSON string `{"tableId": <number>, "secret": "<string>"}`. `ScanScreen` `JSON.parse`s the scanned value and validates its shape before navigating onward.
- **Starting a brand-new conversation vs. opening an existing one:** `ChatScreen` is reached two ways. (a) From `TableListScreen` tapping an occupied table — navigated with `{ toTableId, toTableNumber }` and no `contactId` yet; the screen starts in compose-only mode (no history fetch, since none can exist) and learns its `contactId` from the first `POST /messages` response. (b) From accepting a pending request, or from a `contact:resolved` banner — navigated with a known `contactId` (and `toTableNumber` when available); the screen fetches history immediately via `GET /contacts/:id/messages`. A contact in `pending_approval` state never calls `GET /contacts/:id/messages` (the backend 400s until `accepted`) — the sender only sees the messages they themselves sent, held in local component state, until a `contact:resolved` event confirms acceptance.

## Global Constraints

- Use `npx expo install <pkg>` for every Expo-SDK-managed native dependency (`expo-camera`, `expo-secure-store`, `expo-dev-client`, `react-native-screens`, `react-native-safe-area-context`) — never plain `npm install` for these. Lesson from the backend plan's Task 1: unpinned installs of packages with their own release cadence silently resolved to a major version incompatible with the installed core, and the mismatch wasn't caught by a boot check alone. `expo install` resolves the version compatible with the installed Expo SDK.
- A persisted session token is never trusted on its own — the app always revalidates it against `GET /sessions/me` before treating the user as authenticated, and clears it from `SecureStore` on any 401.
- State management is React Context + a plain reducer function (`useReducer`) — no Redux, Zustand, or MobX.
- QR scanning uses `expo-camera`'s built-in barcode scanning — no `react-native-vision-camera` or other third-party scanning library.
- Navigation is `@react-navigation/native` + `@react-navigation/native-stack` only.
- Platform target for this phase is Android only — do not spend effort on iOS-specific configuration, icons, or testing.
- No push notifications in this phase (spec §7 / §14 step 5) — the app only reacts to Socket.io events while the connection is alive (foreground). Don't add any FCM/background-notification code.
- Socket.io auth: `io(baseUrl, { auth: { token } })`, exactly matching the backend's expected handshake shape (verified in the backend plan's `RealtimeGateway`).

## Review Focus

- A persisted token the backend now rejects (`GET /sessions/me` → 401) must clear `SecureStore` and route to `ScanScreen` — not get stuck loading or retry forever. (Task 5)
- A failed `POST /sessions` during the scan flow (wrong secret, unknown/non-occupied table) must surface a clear, recoverable error and must NOT transition the app into the authenticated state. (Task 5)
- Two `contact:request` events for the same `contactId` arriving before the first is dismissed must not produce two duplicate pending-request entries. (Task 4)
- A `message:new` event for a `contactId` the user isn't currently viewing in `ChatScreen` must be ignored by that screen, not misattributed to whatever conversation happens to be open. (Task 8)
- Losing and regaining the Socket.io connection must not leave `TableListScreen` stuck on stale data — reconnecting must trigger a fresh `GET /tables/occupied` fetch. (Task 5)

---

## File Structure

```
mobile/
  app.json
  App.tsx
  babel.config.js
  package.json
  tsconfig.json
  .env
  .env.example
  src/
    config.ts
    types/
      api.ts
    api/
      client.ts
      client.test.ts
    session/
      tokenStorage.ts
      tokenStorage.test.ts
      sessionReducer.ts
      sessionReducer.test.ts
      SessionContext.tsx
      SessionContext.test.tsx
    realtime/
      socket.ts
    navigation/
      types.ts
      RootNavigator.tsx
      RootNavigator.test.tsx
    screens/
      ScanScreen.tsx
      ScanScreen.test.tsx
      PseudoScreen.tsx
      PseudoScreen.test.tsx
      TableListScreen.tsx
      TableListScreen.test.tsx
      ContactRequestModal.tsx
      ContactRequestModal.test.tsx
      ChatScreen.tsx
      ChatScreen.test.tsx
      chatMessages.ts
      chatMessages.test.ts
```

---

### Task 1: Project scaffolding, dependencies, environment

**Files:**
- Create: `mobile/` (via `create-expo-app`)
- Modify: `mobile/app.json` (set `android.package`)
- Create: `mobile/.env`, `mobile/.env.example`
- Create: `mobile/src/config.ts`
- Modify: `mobile/package.json` (jest config)

**Interfaces:**
- Produces: a bootable Expo dev-client project; `API_BASE_URL` exported from `src/config.ts`, read from `process.env.EXPO_PUBLIC_API_BASE_URL`.

- [ ] **Step 1: Scaffold the Expo project**

Run from the repo root (`D:\GitHub\Perso\RestoTalk`):

```bash
npx create-expo-app@latest mobile --template blank-typescript
```

- [ ] **Step 2: Set the Android package identifier**

Edit `mobile/app.json` — inside the `"expo"` object, add (or edit) the `"android"` key:

```json
  "android": {
    "package": "com.restotalk.mobile"
  }
```

(Keep the rest of the generated `app.json` as-is — only add/modify this key. Setting it now avoids an interactive prompt later when building for Android.)

- [ ] **Step 3: Install Expo-managed native dependencies**

```bash
cd mobile
npx expo install expo-camera expo-secure-store expo-dev-client react-native-screens react-native-safe-area-context
```

- [ ] **Step 4: Install navigation and realtime dependencies (plain npm, not Expo-managed)**

```bash
npm install @react-navigation/native @react-navigation/native-stack socket.io-client
```

- [ ] **Step 5: Install test dependencies**

```bash
npm install -D jest jest-expo @testing-library/react-native @types/jest
```

- [ ] **Step 6: Add the Jest configuration**

Add to `mobile/package.json` (merge into the existing top-level object — `create-expo-app`'s template doesn't include a `"jest"` key yet):

```json
  "jest": {
    "preset": "jest-expo",
    "transformIgnorePatterns": [
      "node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg)"
    ]
  },
  "scripts": {
    "test": "jest"
  }
```

(If `"scripts"` already exists from the template, merge `"test": "jest"` into it rather than replacing the whole block — keep the template's existing `"start"`, `"android"`, etc.)

- [ ] **Step 7: Create the environment files**

Create `mobile/.env.example`:

```
EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:3000
```

Copy it to `mobile/.env` (same content — `10.0.2.2` is the Android emulator's alias for the host machine's `localhost`; a physical device on the same network needs the dev machine's actual LAN IP instead, e.g. `http://192.168.1.23:3000`). Verify `mobile/.gitignore` (generated by `create-expo-app`) already ignores `.env` — if not, add `.env` to it.

- [ ] **Step 8: Create the config module**

Create `mobile/src/config.ts`:

```typescript
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://10.0.2.2:3000';
```

- [ ] **Step 9: Verify the project builds and type-checks**

```bash
npx tsc --noEmit
npx expo export --platform android
```

Expected: both commands complete with no errors — this confirms all dependencies resolve and the JS bundle compiles, without requiring an Android emulator/device in this environment. If an Android emulator or physical device is available, additionally run `npx expo run:android` to confirm a real on-device boot; note in your report whether you had a device available and, if so, that it booted successfully.

- [ ] **Step 10: Commit**

```bash
cd ..
git add mobile
git commit -m "chore: scaffold Expo mobile app with dev client and dependencies"
```

(Run from the repo root so the commit covers the whole `mobile/` directory; `node_modules/` and other generated folders should already be excluded by the generated `mobile/.gitignore` — verify this with `git status --short` before committing, the same check that caught a real gap in the backend plan's Task 1.)

---

### Task 2: API client and shared types

**Files:**
- Create: `mobile/src/types/api.ts`
- Create: `mobile/src/api/client.ts`
- Test: `mobile/src/api/client.test.ts`

**Interfaces:**
- Produces: types `OccupiedTable`, `SessionResponse`, `MeResponse`, `MessageDto`, `SendMessageResponse`, `RespondResponse`, `ContactRequestEvent`, `ContactResolvedEvent`, `MessageNewEvent` (all exported from `src/types/api.ts`); `ApiError` class and `createApiClient(config: { baseUrl: string; getToken: () => string | null })` factory (exported from `src/api/client.ts`), returning an object with `createSession`, `getMe`, `leaveSession`, `getOccupiedTables`, `sendMessage`, `respondToContact`, `getContactMessages`.

- [ ] **Step 1: Write the shared types**

Create `mobile/src/types/api.ts`:

```typescript
export type OccupiedTable = {
  tableId: number;
  number: number;
  activeSessionCount: number;
};

export type SessionResponse = {
  sessionToken: string;
  session: { id: number; pseudo: string; tableId: number };
};

export type MeResponse = {
  id: number;
  pseudo: string;
  tableId: number;
  status: string;
};

export type MessageDto = {
  id: number;
  kind: 'predefined' | 'freetext';
  predefinedCode: string | null;
  content: string;
  senderSessionId: number;
  createdAt: string;
};

export type SendMessageResponse = {
  status: 'sent' | 'pending_approval';
  contactId: number;
  message?: MessageDto;
};

export type RespondResponse = {
  status: 'accepted' | 'refused';
};

export type ContactRequestEvent = {
  contactId: number;
  fromTableId: number;
  fromTableNumber: number;
};

export type ContactResolvedEvent = {
  contactId: number;
  status: 'accepted' | 'refused';
};

export type MessageNewEvent = {
  contactId: number;
  message: MessageDto;
};
```

- [ ] **Step 2: Write the failing test**

Create `mobile/src/api/client.test.ts`:

```typescript
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
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `cd mobile && npx jest client.test.ts`
Expected: FAIL with "Cannot find module './client'"

- [ ] **Step 3: Write the client**

Create `mobile/src/api/client.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest client.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add mobile/src/types mobile/src/api
git commit -m "feat: add typed API client"
```

---

### Task 3: Secure token storage

**Files:**
- Create: `mobile/src/session/tokenStorage.ts`
- Test: `mobile/src/session/tokenStorage.test.ts`

**Interfaces:**
- Produces: `saveToken(token: string): Promise<void>`, `loadToken(): Promise<string | null>`, `clearToken(): Promise<void>`, all from `src/session/tokenStorage.ts`.

- [ ] **Step 1: Write the failing test**

Create `mobile/src/session/tokenStorage.test.ts`:

```typescript
import * as SecureStore from 'expo-secure-store';
import { saveToken, loadToken, clearToken, TOKEN_KEY } from './tokenStorage';

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

describe('tokenStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('saves a token under the expected key', async () => {
    await saveToken('abc123');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(TOKEN_KEY, 'abc123');
  });

  it('loads a stored token', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce('stored-token');
    const result = await loadToken();
    expect(result).toBe('stored-token');
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(TOKEN_KEY);
  });

  it('returns null when nothing is stored', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce(null);
    const result = await loadToken();
    expect(result).toBeNull();
  });

  it('clears the stored token', async () => {
    await clearToken();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(TOKEN_KEY);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest tokenStorage.test.ts`
Expected: FAIL with "Cannot find module './tokenStorage'"

- [ ] **Step 3: Write the module**

Create `mobile/src/session/tokenStorage.ts`:

```typescript
import * as SecureStore from 'expo-secure-store';

export const TOKEN_KEY = 'restotalk_session_token';

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function loadToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest tokenStorage.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add mobile/src/session/tokenStorage.ts mobile/src/session/tokenStorage.test.ts
git commit -m "feat: add secure token storage wrapper"
```

---

### Task 4: Session state reducer

**Files:**
- Create: `mobile/src/session/sessionReducer.ts`
- Test: `mobile/src/session/sessionReducer.test.ts`

**Interfaces:**
- Consumes: `OccupiedTable`, `ContactRequestEvent`, `ContactResolvedEvent` (from `src/types/api.ts`).
- Produces: `SessionState` (discriminated union: `{status:'loading'}` | `{status:'unauthenticated'}` | `{status:'authenticated', token, session, tables, pendingContactRequests, resolvedContacts}`), `SessionAction` (union of 8 action types below), `initialSessionState: SessionState`, `sessionReducer(state: SessionState, action: SessionAction): SessionState` — all exported from `src/session/sessionReducer.ts`.

- [ ] **Step 1: Write the failing tests**

Create `mobile/src/session/sessionReducer.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest sessionReducer.test.ts`
Expected: FAIL with "Cannot find module './sessionReducer'"

- [ ] **Step 3: Write the reducer**

Create `mobile/src/session/sessionReducer.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx jest sessionReducer.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add mobile/src/session/sessionReducer.ts mobile/src/session/sessionReducer.test.ts
git commit -m "feat: add session state reducer"
```

---

### Task 5: Socket factory and SessionContext provider

**Files:**
- Create: `mobile/src/realtime/socket.ts`
- Create: `mobile/src/session/SessionContext.tsx`
- Test: `mobile/src/session/SessionContext.test.tsx`

**Interfaces:**
- Consumes: `createApiClient`, `ApiError` (Task 2), `saveToken`/`loadToken`/`clearToken` (Task 3), `sessionReducer`/`initialSessionState`/`SessionState`/`SessionAction` (Task 4), `API_BASE_URL` (Task 1).
- Produces: `createSocket(baseUrl: string, token: string): Socket` (from `src/realtime/socket.ts`); `SessionProvider` (React component) and `useSession()` hook returning `{ state: SessionState; scanAndJoin: (tableId: number, secret: string, pseudo: string) => Promise<void>; leave: () => Promise<void>; dismissPendingContactRequest: (contactId: number) => void; dismissResolvedContact: (contactId: number) => void; api: ApiClient }` (from `src/session/SessionContext.tsx`). `scanAndJoin` rejects (throws) on failure without changing `state` — callers display the error themselves.

- [ ] **Step 1: Write the socket factory**

Create `mobile/src/realtime/socket.ts`:

```typescript
import { io, Socket } from 'socket.io-client';

export function createSocket(baseUrl: string, token: string): Socket {
  return io(baseUrl, { auth: { token } });
}
```

- [ ] **Step 2: Write the failing tests**

Create `mobile/src/session/SessionContext.test.tsx`:

```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd mobile && npx jest SessionContext.test.tsx`
Expected: FAIL with "Cannot find module './SessionContext'"

- [ ] **Step 4: Write the provider**

Create `mobile/src/session/SessionContext.tsx`:

```typescript
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mobile && npx jest SessionContext.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add mobile/src/realtime mobile/src/session/SessionContext.tsx mobile/src/session/SessionContext.test.tsx
git commit -m "feat: add socket factory and SessionContext provider"
```

---

### Task 6: Navigation types, ScanScreen, PseudoScreen

**Files:**
- Create: `mobile/src/navigation/types.ts`
- Create: `mobile/src/screens/ScanScreen.tsx`
- Test: `mobile/src/screens/ScanScreen.test.tsx`
- Create: `mobile/src/screens/PseudoScreen.tsx`
- Test: `mobile/src/screens/PseudoScreen.test.tsx`

**Interfaces:**
- Consumes: `useSession` (Task 5).
- Produces: `RootStackParamList` (type, from `src/navigation/types.ts`): `{ Scan: undefined; Pseudo: { tableId: number; secret: string }; TableList: undefined; Chat: { toTableId?: number; toTableNumber?: number; contactId?: number } }`. `ScanScreen`, `PseudoScreen` (React components, default export each).

- [ ] **Step 1: Write the navigation types**

Create `mobile/src/navigation/types.ts`:

```typescript
export type RootStackParamList = {
  Scan: undefined;
  Pseudo: { tableId: number; secret: string };
  TableList: undefined;
  Chat: { toTableId?: number; toTableNumber?: number; contactId?: number };
};
```

- [ ] **Step 2: Write the failing test for ScanScreen**

Create `mobile/src/screens/ScanScreen.test.tsx`:

```typescript
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import ScanScreen from './ScanScreen';

jest.mock('expo-camera', () => {
  const React = require('react');
  return {
    CameraView: React.forwardRef((props: any, _ref: any) => {
      const { View, Button } = require('react-native');
      return (
        <View testID="camera-view">
          <Button
            testID="simulate-scan"
            title="simulate-scan"
            onPress={() => props.onBarcodeScanned?.({ data: props.__testData })}
          />
        </View>
      );
    }),
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
  };
});

describe('ScanScreen', () => {
  function renderScreen(testData: string) {
    const navigate = jest.fn();
    const utils = render(
      <ScanScreen navigation={{ navigate } as any} />,
    );
    return { navigate, ...utils };
  }

  it('navigates to Pseudo with the parsed tableId and secret on a valid QR', () => {
    const { navigate, getByTestId } = renderScreen(
      JSON.stringify({ tableId: 5, secret: 'abc' }),
    );
    fireEvent(getByTestId('camera-view'), 'onBarcodeScanned', {
      data: JSON.stringify({ tableId: 5, secret: 'abc' }),
    });
    expect(navigate).toHaveBeenCalledWith('Pseudo', { tableId: 5, secret: 'abc' });
  });

  it('shows an error and does not navigate on malformed QR content', () => {
    const { navigate, getByTestId, getByText } = renderScreen('not json');
    fireEvent(getByTestId('camera-view'), 'onBarcodeScanned', { data: 'not json' });
    expect(navigate).not.toHaveBeenCalled();
    expect(getByText(/QR code invalide/i)).toBeTruthy();
  });

  it('shows an error and does not navigate when the QR JSON has the wrong shape', () => {
    const { navigate, getByTestId, getByText } = renderScreen(JSON.stringify({ foo: 'bar' }));
    fireEvent(getByTestId('camera-view'), 'onBarcodeScanned', {
      data: JSON.stringify({ foo: 'bar' }),
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(getByText(/QR code invalide/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd mobile && npx jest ScanScreen.test.tsx`
Expected: FAIL with "Cannot find module './ScanScreen'"

- [ ] **Step 4: Write ScanScreen**

Create `mobile/src/screens/ScanScreen.tsx`:

```typescript
import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Scan'>;

function parseQrPayload(data: string): { tableId: number; secret: string } | null {
  try {
    const parsed = JSON.parse(data);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.tableId === 'number' &&
      typeof parsed.secret === 'string'
    ) {
      return { tableId: parsed.tableId, secret: parsed.secret };
    }
    return null;
  } catch {
    return null;
  }
}

export default function ScanScreen({ navigation }: Props) {
  const [permission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [handled, setHandled] = useState(false);

  function handleBarcodeScanned({ data }: { data: string }) {
    if (handled) return;
    const payload = parseQrPayload(data);
    if (!payload) {
      setError('QR code invalide — réessayez.');
      return;
    }
    setHandled(true);
    setError(null);
    navigation.navigate('Pseudo', { tableId: payload.tableId, secret: payload.secret });
  }

  return (
    <View style={styles.container}>
      {permission?.granted ? (
        <CameraView
          testID="camera-view"
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcodeScanned}
        />
      ) : (
        <Text>Autorisation caméra requise.</Text>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  camera: { flex: 1, width: '100%' },
  error: { color: 'red', padding: 8 },
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd mobile && npx jest ScanScreen.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 6: Write the failing test for PseudoScreen**

Create `mobile/src/screens/PseudoScreen.test.tsx`:

```typescript
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import PseudoScreen from './PseudoScreen';
import { useSession } from '../session/SessionContext';
import { ApiError } from '../api/client';

jest.mock('../session/SessionContext');

describe('PseudoScreen', () => {
  const route = { params: { tableId: 5, secret: 'abc' } } as any;

  it('does not call scanAndJoin when the pseudo is empty', () => {
    const scanAndJoin = jest.fn();
    (useSession as jest.Mock).mockReturnValue({ scanAndJoin });
    const { getByTestId } = render(<PseudoScreen route={route} navigation={{} as any} />);

    fireEvent.press(getByTestId('submit-button'));

    expect(scanAndJoin).not.toHaveBeenCalled();
  });

  it('calls scanAndJoin with the entered pseudo and route params on submit', async () => {
    const scanAndJoin = jest.fn().mockResolvedValue(undefined);
    (useSession as jest.Mock).mockReturnValue({ scanAndJoin });
    const { getByTestId } = render(<PseudoScreen route={route} navigation={{} as any} />);

    fireEvent.changeText(getByTestId('pseudo-input'), 'Alice');
    fireEvent.press(getByTestId('submit-button'));

    await waitFor(() => expect(scanAndJoin).toHaveBeenCalledWith(5, 'abc', 'Alice'));
  });

  it('shows an error message when scanAndJoin rejects', async () => {
    const scanAndJoin = jest.fn().mockRejectedValue(new ApiError(401, 'Invalid QR secret'));
    (useSession as jest.Mock).mockReturnValue({ scanAndJoin });
    const { getByTestId, findByText } = render(
      <PseudoScreen route={route} navigation={{} as any} />,
    );

    fireEvent.changeText(getByTestId('pseudo-input'), 'Alice');
    fireEvent.press(getByTestId('submit-button'));

    expect(await findByText(/impossible de rejoindre/i)).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd mobile && npx jest PseudoScreen.test.tsx`
Expected: FAIL with "Cannot find module './PseudoScreen'"

- [ ] **Step 8: Write PseudoScreen**

Create `mobile/src/screens/PseudoScreen.tsx`:

```typescript
import React, { useState } from 'react';
import { View, Text, TextInput, Button, StyleSheet } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { useSession } from '../session/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Pseudo'>;

export default function PseudoScreen({ route }: Props) {
  const { scanAndJoin } = useSession();
  const [pseudo, setPseudo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!pseudo.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await scanAndJoin(route.params.tableId, route.params.secret, pseudo.trim());
    } catch {
      setError('Impossible de rejoindre cette table — vérifiez le QR code et réessayez.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text>Quel pseudo pour cette table ?</Text>
      <TextInput
        testID="pseudo-input"
        style={styles.input}
        value={pseudo}
        onChangeText={setPseudo}
        placeholder="Votre pseudo"
      />
      <Button testID="submit-button" title="Rejoindre" onPress={handleSubmit} disabled={submitting} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 16 },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 8, marginVertical: 12 },
  error: { color: 'red', marginTop: 8 },
});
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd mobile && npx jest PseudoScreen.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 10: Commit**

```bash
git add mobile/src/navigation/types.ts mobile/src/screens/ScanScreen.tsx mobile/src/screens/ScanScreen.test.tsx mobile/src/screens/PseudoScreen.tsx mobile/src/screens/PseudoScreen.test.tsx
git commit -m "feat: add QR scan and pseudo entry screens"
```

---

### Task 7: TableListScreen and ContactRequestModal

**Files:**
- Create: `mobile/src/screens/TableListScreen.tsx`
- Test: `mobile/src/screens/TableListScreen.test.tsx`
- Create: `mobile/src/screens/ContactRequestModal.tsx`
- Test: `mobile/src/screens/ContactRequestModal.test.tsx`

**Interfaces:**
- Consumes: `useSession` (Task 5), `RootStackParamList` (Task 6).
- Produces: `TableListScreen`, `ContactRequestModal` (React components, default export each). `ContactRequestModal` is rendered by `TableListScreen` (shows the first entry of `state.pendingContactRequests` when non-empty, nothing otherwise).

- [ ] **Step 1: Write the failing test for ContactRequestModal**

Create `mobile/src/screens/ContactRequestModal.test.tsx`:

```typescript
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import ContactRequestModal from './ContactRequestModal';
import { useSession } from '../session/SessionContext';

jest.mock('../session/SessionContext');

describe('ContactRequestModal', () => {
  it('renders nothing when there is no pending request', () => {
    (useSession as jest.Mock).mockReturnValue({
      state: { status: 'authenticated', pendingContactRequests: [] },
      api: {},
      dismissPendingContactRequest: jest.fn(),
    });
    const { queryByTestId } = render(<ContactRequestModal navigation={{ navigate: jest.fn() } as any} />);
    expect(queryByTestId('contact-request-modal')).toBeNull();
  });

  it('shows the requesting table number and accepts on confirm', async () => {
    const respondToContact = jest.fn().mockResolvedValue({ status: 'accepted' });
    const dismissPendingContactRequest = jest.fn();
    const navigate = jest.fn();
    (useSession as jest.Mock).mockReturnValue({
      state: {
        status: 'authenticated',
        pendingContactRequests: [{ contactId: 7, fromTableId: 2, fromTableNumber: 5 }],
      },
      api: { respondToContact },
      dismissPendingContactRequest,
    });

    const { getByTestId, getByText } = render(
      <ContactRequestModal navigation={{ navigate } as any} />,
    );

    expect(getByText(/table 5/i)).toBeTruthy();
    fireEvent.press(getByTestId('accept-button'));

    await waitFor(() => expect(respondToContact).toHaveBeenCalledWith(7, true));
    expect(dismissPendingContactRequest).toHaveBeenCalledWith(7);
    expect(navigate).toHaveBeenCalledWith('Chat', { contactId: 7, toTableId: 2, toTableNumber: 5 });
  });

  it('refuses without navigating to Chat', async () => {
    const respondToContact = jest.fn().mockResolvedValue({ status: 'refused' });
    const dismissPendingContactRequest = jest.fn();
    const navigate = jest.fn();
    (useSession as jest.Mock).mockReturnValue({
      state: {
        status: 'authenticated',
        pendingContactRequests: [{ contactId: 7, fromTableId: 2, fromTableNumber: 5 }],
      },
      api: { respondToContact },
      dismissPendingContactRequest,
    });

    const { getByTestId } = render(<ContactRequestModal navigation={{ navigate } as any} />);
    fireEvent.press(getByTestId('refuse-button'));

    await waitFor(() => expect(respondToContact).toHaveBeenCalledWith(7, false));
    expect(dismissPendingContactRequest).toHaveBeenCalledWith(7);
    expect(navigate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest ContactRequestModal.test.tsx`
Expected: FAIL with "Cannot find module './ContactRequestModal'"

- [ ] **Step 3: Write ContactRequestModal**

Create `mobile/src/screens/ContactRequestModal.tsx`:

```typescript
import React from 'react';
import { Modal, View, Text, Button, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { useSession } from '../session/SessionContext';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList>;
};

export default function ContactRequestModal({ navigation }: Props) {
  const { state, api, dismissPendingContactRequest } = useSession();

  if (state.status !== 'authenticated' || state.pendingContactRequests.length === 0) {
    return null;
  }

  const request = state.pendingContactRequests[0];

  async function respond(accept: boolean) {
    await api.respondToContact(request.contactId, accept);
    dismissPendingContactRequest(request.contactId);
    if (accept) {
      navigation.navigate('Chat', {
        contactId: request.contactId,
        toTableId: request.fromTableId,
        toTableNumber: request.fromTableNumber,
      });
    }
  }

  return (
    <Modal transparent testID="contact-request-modal">
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text>La table {request.fromTableNumber} souhaite vous envoyer un message.</Text>
          <View style={styles.actions}>
            <Button testID="refuse-button" title="Refuser" onPress={() => respond(false)} />
            <Button testID="accept-button" title="Accepter" onPress={() => respond(true)} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  card: { backgroundColor: 'white', padding: 20, borderRadius: 8, width: '80%' },
  actions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest ContactRequestModal.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing test for TableListScreen**

Create `mobile/src/screens/TableListScreen.test.tsx`:

```typescript
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import TableListScreen from './TableListScreen';
import { useSession } from '../session/SessionContext';

jest.mock('../session/SessionContext');
jest.mock('./ContactRequestModal', () => () => null);

describe('TableListScreen', () => {
  it('renders one row per occupied table', () => {
    (useSession as jest.Mock).mockReturnValue({
      state: {
        status: 'authenticated',
        tables: [
          { tableId: 2, number: 5, activeSessionCount: 1 },
          { tableId: 3, number: 8, activeSessionCount: 2 },
        ],
        pendingContactRequests: [],
      },
    });

    const { getByText } = render(<TableListScreen navigation={{ navigate: jest.fn() } as any} />);

    expect(getByText(/table 5/i)).toBeTruthy();
    expect(getByText(/table 8/i)).toBeTruthy();
  });

  it('navigates to Chat in compose-only mode when a table row is tapped', () => {
    const navigate = jest.fn();
    (useSession as jest.Mock).mockReturnValue({
      state: {
        status: 'authenticated',
        tables: [{ tableId: 2, number: 5, activeSessionCount: 1 }],
        pendingContactRequests: [],
      },
    });

    const { getByTestId } = render(<TableListScreen navigation={{ navigate } as any} />);
    fireEvent.press(getByTestId('table-row-2'));

    expect(navigate).toHaveBeenCalledWith('Chat', {
      toTableId: 2,
      toTableNumber: 5,
      contactId: undefined,
    });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd mobile && npx jest TableListScreen.test.tsx`
Expected: FAIL with "Cannot find module './TableListScreen'"

- [ ] **Step 7: Write TableListScreen**

Create `mobile/src/screens/TableListScreen.tsx`:

```typescript
import React from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { useSession } from '../session/SessionContext';
import ContactRequestModal from './ContactRequestModal';

type Props = NativeStackScreenProps<RootStackParamList, 'TableList'>;

export default function TableListScreen({ navigation }: Props) {
  const { state } = useSession();

  if (state.status !== 'authenticated') {
    return null;
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={state.tables}
        keyExtractor={(item) => String(item.tableId)}
        renderItem={({ item }) => (
          <TouchableOpacity
            testID={`table-row-${item.tableId}`}
            style={styles.row}
            onPress={() =>
              navigation.navigate('Chat', {
                toTableId: item.tableId,
                toTableNumber: item.number,
                contactId: undefined,
              })
            }
          >
            <Text>
              Table {item.number} — {item.activeSessionCount} personne(s)
            </Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Text style={styles.empty}>Aucune autre table occupée pour le moment.</Text>}
      />
      <ContactRequestModal navigation={navigation} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  row: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#eee' },
  empty: { padding: 16, color: '#666' },
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd mobile && npx jest TableListScreen.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add mobile/src/screens/TableListScreen.tsx mobile/src/screens/TableListScreen.test.tsx mobile/src/screens/ContactRequestModal.tsx mobile/src/screens/ContactRequestModal.test.tsx
git commit -m "feat: add table list screen and contact request modal"
```

---

### Task 8: ChatScreen

**Files:**
- Create: `mobile/src/screens/chatMessages.ts`
- Test: `mobile/src/screens/chatMessages.test.ts`
- Create: `mobile/src/screens/ChatScreen.tsx`
- Test: `mobile/src/screens/ChatScreen.test.tsx`

**Interfaces:**
- Consumes: `useSession` (Task 5), `RootStackParamList` (Task 6), `MessageDto`/`MessageNewEvent` (Task 2).
- Produces: `appendMessageIfNew(messages: MessageDto[], incoming: MessageDto): MessageDto[]` and `belongsToContact(contactId: number, event: MessageNewEvent): boolean` (from `src/screens/chatMessages.ts`); `ChatScreen` (React component, default export).

- [ ] **Step 1: Write the failing tests for the pure helpers**

Create `mobile/src/screens/chatMessages.test.ts`:

```typescript
import { appendMessageIfNew, belongsToContact } from './chatMessages';
import { MessageDto } from '../types/api';

const baseMessage: MessageDto = {
  id: 1,
  kind: 'freetext',
  predefinedCode: null,
  content: 'Salut',
  senderSessionId: 10,
  createdAt: '2026-10-04T10:00:00.000Z',
};

describe('appendMessageIfNew', () => {
  it('appends a message with a new id', () => {
    const result = appendMessageIfNew([], baseMessage);
    expect(result).toEqual([baseMessage]);
  });

  it('does not duplicate a message with an id already present', () => {
    const result = appendMessageIfNew([baseMessage], { ...baseMessage, content: 'edited' });
    expect(result).toEqual([baseMessage]);
  });
});

describe('belongsToContact', () => {
  it('returns true when the event contactId matches', () => {
    expect(belongsToContact(7, { contactId: 7, message: baseMessage })).toBe(true);
  });

  it('returns false when the event contactId does not match', () => {
    expect(belongsToContact(7, { contactId: 9, message: baseMessage })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest chatMessages.test.ts`
Expected: FAIL with "Cannot find module './chatMessages'"

- [ ] **Step 3: Write the helpers**

Create `mobile/src/screens/chatMessages.ts`:

```typescript
import { MessageDto, MessageNewEvent } from '../types/api';

export function appendMessageIfNew(messages: MessageDto[], incoming: MessageDto): MessageDto[] {
  if (messages.some((m) => m.id === incoming.id)) {
    return messages;
  }
  return [...messages, incoming];
}

export function belongsToContact(contactId: number, event: MessageNewEvent): boolean {
  return event.contactId === contactId;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx jest chatMessages.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing test for ChatScreen**

Create `mobile/src/screens/ChatScreen.test.tsx`:

```typescript
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import ChatScreen from './ChatScreen';
import { useSession } from '../session/SessionContext';

jest.mock('../session/SessionContext');

function makeFakeSocket() {
  const listeners: Record<string, Function[]> = {};
  return {
    on: jest.fn((event: string, cb: Function) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
    }),
    off: jest.fn(),
    __emit: (event: string, payload?: unknown) => {
      (listeners[event] ?? []).forEach((cb) => cb(payload));
    },
  };
}

describe('ChatScreen', () => {
  it('fetches history on mount when a contactId is already known', async () => {
    const getContactMessages = jest.fn().mockResolvedValue([
      { id: 1, kind: 'freetext', predefinedCode: null, content: 'Bonjour', senderSessionId: 5, createdAt: 'x' },
    ]);
    (useSession as jest.Mock).mockReturnValue({
      socket: makeFakeSocket(),
      api: { getContactMessages, sendMessage: jest.fn() },
    });

    const route = { params: { contactId: 7, toTableNumber: 5 } } as any;
    const { findByText } = render(<ChatScreen route={route} navigation={{} as any} />);

    expect(await findByText('Bonjour')).toBeTruthy();
    expect(getContactMessages).toHaveBeenCalledWith(7);
  });

  it('does not fetch history when no contactId is known yet (compose-only mode)', () => {
    const getContactMessages = jest.fn();
    (useSession as jest.Mock).mockReturnValue({
      socket: makeFakeSocket(),
      api: { getContactMessages, sendMessage: jest.fn() },
    });

    const route = { params: { toTableId: 2, toTableNumber: 5 } } as any;
    render(<ChatScreen route={route} navigation={{} as any} />);

    expect(getContactMessages).not.toHaveBeenCalled();
  });

  it('sends a freetext message and shows it locally', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ status: 'pending_approval', contactId: 9 });
    (useSession as jest.Mock).mockReturnValue({
      socket: makeFakeSocket(),
      api: { getContactMessages: jest.fn(), sendMessage },
    });

    const route = { params: { toTableId: 2, toTableNumber: 5 } } as any;
    const { getByTestId, findByText } = render(<ChatScreen route={route} navigation={{} as any} />);

    fireEvent.changeText(getByTestId('message-input'), 'Salut !');
    fireEvent.press(getByTestId('send-button'));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({ toTableId: 2, kind: 'freetext', content: 'Salut !' }),
    );
    expect(await findByText('Salut !')).toBeTruthy();
  });

  it('appends an incoming message:new event for this contact and ignores one for another contact', async () => {
    const socket = makeFakeSocket();
    (useSession as jest.Mock).mockReturnValue({
      socket,
      api: { getContactMessages: jest.fn().mockResolvedValue([]), sendMessage: jest.fn() },
    });

    const route = { params: { contactId: 7, toTableNumber: 5 } } as any;
    const { findByText, queryByText } = render(<ChatScreen route={route} navigation={{} as any} />);
    await waitFor(() => expect(socket.on).toHaveBeenCalledWith('message:new', expect.any(Function)));

    act(() => {
      socket.__emit('message:new', {
        contactId: 999,
        message: { id: 2, kind: 'freetext', predefinedCode: null, content: 'Pas pour vous', senderSessionId: 1, createdAt: 'x' },
      });
    });
    expect(queryByText('Pas pour vous')).toBeNull();

    act(() => {
      socket.__emit('message:new', {
        contactId: 7,
        message: { id: 3, kind: 'freetext', predefinedCode: null, content: 'Pour vous', senderSessionId: 1, createdAt: 'x' },
      });
    });
    expect(await findByText('Pour vous')).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd mobile && npx jest ChatScreen.test.tsx`
Expected: FAIL with "Cannot find module './ChatScreen'"

- [ ] **Step 7: Write ChatScreen**

Create `mobile/src/screens/ChatScreen.tsx`:

```typescript
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Button, FlatList, StyleSheet } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { useSession } from '../session/SessionContext';
import { MessageDto, MessageNewEvent } from '../types/api';
import { appendMessageIfNew, belongsToContact } from './chatMessages';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export default function ChatScreen({ route }: Props) {
  const { socket, api } = useSession();
  const { toTableId, toTableNumber } = route.params;
  const [contactId, setContactId] = useState<number | undefined>(route.params.contactId);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [draft, setDraft] = useState('');
  const [pendingApproval, setPendingApproval] = useState(false);

  useEffect(() => {
    if (contactId !== undefined) {
      api.getContactMessages(contactId).then(setMessages).catch(() => {
        // contact not yet accepted or fetch failed — stay with locally-known messages only
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!socket) return;
    function handleMessageNew(event: MessageNewEvent) {
      if (contactId === undefined || !belongsToContact(contactId, event)) return;
      setMessages((prev) => appendMessageIfNew(prev, event.message));
    }
    socket.on('message:new', handleMessageNew);
    return () => {
      socket.off?.('message:new', handleMessageNew);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, contactId]);

  async function handleSend() {
    const content = draft.trim();
    if (!content || toTableId === undefined) return;
    setDraft('');
    const result = await api.sendMessage({ toTableId, kind: 'freetext', content });
    setContactId(result.contactId);
    if (result.status === 'pending_approval') {
      setPendingApproval(true);
      if (result.message) {
        setMessages((prev) => appendMessageIfNew(prev, result.message as MessageDto));
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: -Date.now(),
            kind: 'freetext',
            predefinedCode: null,
            content,
            senderSessionId: -1,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    } else if (result.message) {
      setMessages((prev) => appendMessageIfNew(prev, result.message as MessageDto));
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.header}>{toTableNumber ? `Table ${toTableNumber}` : 'Conversation'}</Text>
      {pendingApproval ? (
        <Text style={styles.pending}>En attente d'acceptation par l'autre table…</Text>
      ) : null}
      <FlatList
        data={messages}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <Text style={styles.message}>{item.content}</Text>}
      />
      <View style={styles.composer}>
        <TextInput
          testID="message-input"
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Votre message"
        />
        <Button testID="send-button" title="Envoyer" onPress={handleSend} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { fontSize: 18, fontWeight: 'bold', padding: 12 },
  pending: { padding: 8, color: '#666', fontStyle: 'italic' },
  message: { padding: 8 },
  composer: { flexDirection: 'row', padding: 8, borderTopWidth: 1, borderTopColor: '#eee' },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', padding: 8, marginRight: 8 },
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd mobile && npx jest ChatScreen.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 9: Commit**

```bash
git add mobile/src/screens/chatMessages.ts mobile/src/screens/chatMessages.test.ts mobile/src/screens/ChatScreen.tsx mobile/src/screens/ChatScreen.test.tsx
git commit -m "feat: add chat screen with live message updates"
```

---

### Task 9: RootNavigator, App.tsx, and guided end-to-end verification

**Files:**
- Create: `mobile/src/navigation/RootNavigator.tsx`
- Test: `mobile/src/navigation/RootNavigator.test.tsx`
- Modify: `mobile/App.tsx`

**Interfaces:**
- Consumes: `useSession` (Task 5), all five screens (Tasks 6-8).
- Produces: `RootNavigator` (React component, default export) — the single screen the app renders, switching stacks based on `useSession().state.status`.

- [ ] **Step 1: Write the failing test**

Create `mobile/src/navigation/RootNavigator.test.tsx`:

```typescript
import React from 'react';
import { render } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import RootNavigator from './RootNavigator';
import { useSession } from '../session/SessionContext';

jest.mock('../session/SessionContext');
jest.mock('../screens/ScanScreen', () => () => {
  const { Text } = require('react-native');
  return <Text>ScanScreenStub</Text>;
});
jest.mock('../screens/PseudoScreen', () => () => null);
jest.mock('../screens/TableListScreen', () => () => {
  const { Text } = require('react-native');
  return <Text>TableListScreenStub</Text>;
});
jest.mock('../screens/ChatScreen', () => () => null);

describe('RootNavigator', () => {
  it('shows nothing but does not crash while loading', () => {
    (useSession as jest.Mock).mockReturnValue({ state: { status: 'loading' } });
    const { queryByText } = render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    expect(queryByText('ScanScreenStub')).toBeNull();
    expect(queryByText('TableListScreenStub')).toBeNull();
  });

  it('renders the Scan stack when unauthenticated', () => {
    (useSession as jest.Mock).mockReturnValue({ state: { status: 'unauthenticated' } });
    const { getByText } = render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    expect(getByText('ScanScreenStub')).toBeTruthy();
  });

  it('renders the TableList stack when authenticated', () => {
    (useSession as jest.Mock).mockReturnValue({
      state: { status: 'authenticated', tables: [], pendingContactRequests: [] },
    });
    const { getByText } = render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    expect(getByText('TableListScreenStub')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest RootNavigator.test.tsx`
Expected: FAIL with "Cannot find module './RootNavigator'"

- [ ] **Step 3: Write RootNavigator**

Create `mobile/src/navigation/RootNavigator.tsx`:

```typescript
import React from 'react';
import { View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from './types';
import { useSession } from '../session/SessionContext';
import ScanScreen from '../screens/ScanScreen';
import PseudoScreen from '../screens/PseudoScreen';
import TableListScreen from '../screens/TableListScreen';
import ChatScreen from '../screens/ChatScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  const { state } = useSession();

  if (state.status === 'loading') {
    return <View />;
  }

  if (state.status === 'unauthenticated') {
    return (
      <Stack.Navigator>
        <Stack.Screen name="Scan" component={ScanScreen} options={{ title: 'Scanner un QR code' }} />
        <Stack.Screen name="Pseudo" component={PseudoScreen} options={{ title: 'Votre pseudo' }} />
      </Stack.Navigator>
    );
  }

  return (
    <Stack.Navigator>
      <Stack.Screen name="TableList" component={TableListScreen} options={{ title: 'Tables occupées' }} />
      <Stack.Screen name="Chat" component={ChatScreen} options={{ title: 'Conversation' }} />
    </Stack.Navigator>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest RootNavigator.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire App.tsx**

Replace the contents of `mobile/App.tsx` (generated by `create-expo-app`) with:

```typescript
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from './src/session/SessionContext';
import RootNavigator from './src/navigation/RootNavigator';

export default function App() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <NavigationContainer>
          <RootNavigator />
        </NavigationContainer>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
```

- [ ] **Step 6: Run the full test suite**

Run: `cd mobile && npx jest`
Expected: all suites pass (Tasks 2-9), zero failures.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/navigation/RootNavigator.tsx mobile/src/navigation/RootNavigator.test.tsx mobile/App.tsx
git commit -m "feat: wire root navigator and app entry point"
```

- [ ] **Step 8: Guided manual end-to-end verification**

This step requires the backend running (`docker compose up -d` + `npm run start:dev` from `backend/`) and an Android emulator or physical device with the dev client installed (`npx expo run:android` from `mobile/`, or `npx expo start --dev-client` if already installed once). It also requires two QR codes for two different seeded tables — generate one from each table's `qrTokenSecret`:

```bash
# From backend/, with Postgres running and tables already seeded:
npx prisma studio    # open Table, note two rows' "number" and "qrTokenSecret"
```

For each table, generate a scannable QR encoding `{"tableId": <id>, "secret": "<qrTokenSecret>"}` (not the table *number* — the actual `id` column) — e.g. with `npx qrcode-terminal '{"tableId":1,"secret":"<secret>"}'` printed to a second screen, or any QR-generating website pointed at that exact JSON string.

Using two devices/emulators (or the same emulator sequentially, noting the app's behavior in each role):

1. Scan Table A's QR → enter a pseudo → confirm you land on the table list.
2. On a second device/session, scan Table B's QR → enter a different pseudo → confirm Table A appears in Table B's list (and vice versa), proving the live `tables:update` presence broadcast works.
3. From Table A's device, tap Table B's row, type a message, send it → confirm it shows a "pending" state locally.
4. On Table B's device, confirm the contact-request modal appears with "La table A souhaite vous envoyer un message" (no content shown) → tap Accept → confirm it navigates to the chat and shows Table A's original message.
5. From Table B's device, send a reply → confirm it appears live on Table A's device without needing to leave/reopen the screen.
6. Force-close the app on one device and reopen it → confirm it returns directly to the table list (not the scan screen), proving session persistence via `SecureStore`.
7. From the table list, trigger a leave (if a leave action isn't wired to any button yet, call `useSession().leave()` via a temporary debug button, or confirm via the backend that `POST /sessions/:id/leave` was reachable in Task 5's automated tests) and confirm the app returns to the scan screen and the table disappears from the other device's list.

Record the outcome of each numbered step (pass/fail, with a screenshot or note for any failure) in your task report — this is the plan's substitute for an automated e2e test, matching the spec's own testing strategy for this layer (spec §6: "test manuel guidé pour le flux complet scan → pseudo → liste → demande de contact → chat").

---

## Definition of Done for this Plan

- `cd mobile && npx jest` passes with zero failures (Tasks 2-9's automated suites).
- `npx tsc --noEmit` and `npx expo export --platform android` succeed from `mobile/`.
- The guided manual verification script (Task 9, Step 8) has been run at least once against the real backend, with its outcome recorded.
- Voice calls, the web back-office, iOS validation, and push notifications remain explicitly out of scope (later phases per the global spec's §14 build order).
