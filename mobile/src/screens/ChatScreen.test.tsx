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
      state: { status: 'authenticated', resolvedContacts: [] },
      dismissResolvedContact: jest.fn(),
    });

    const route = { params: { contactId: 7, toTableNumber: 5 } };
    const { findByText } = render(
      <ChatScreen {...({ route, navigation: {} } as any)} />,
    );

    expect(await findByText('Bonjour')).toBeTruthy();
    expect(getContactMessages).toHaveBeenCalledWith(7);
  });

  it('does not fetch history when no contactId is known yet (compose-only mode)', () => {
    const getContactMessages = jest.fn();
    (useSession as jest.Mock).mockReturnValue({
      socket: makeFakeSocket(),
      api: { getContactMessages, sendMessage: jest.fn() },
      state: { status: 'authenticated', resolvedContacts: [] },
      dismissResolvedContact: jest.fn(),
    });

    const route = { params: { toTableId: 2, toTableNumber: 5 } };
    render(<ChatScreen {...({ route, navigation: {} } as any)} />);

    expect(getContactMessages).not.toHaveBeenCalled();
  });

  it('sends a freetext message and shows it locally', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ status: 'pending_approval', contactId: 9 });
    (useSession as jest.Mock).mockReturnValue({
      socket: makeFakeSocket(),
      api: { getContactMessages: jest.fn(), sendMessage },
      state: { status: 'authenticated', resolvedContacts: [] },
      dismissResolvedContact: jest.fn(),
    });

    const route = { params: { toTableId: 2, toTableNumber: 5 } };
    const { getByTestId, findByText } = render(
      <ChatScreen {...({ route, navigation: {} } as any)} />,
    );

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
      state: { status: 'authenticated', resolvedContacts: [] },
      dismissResolvedContact: jest.fn(),
    });

    const route = { params: { contactId: 7, toTableNumber: 5 } };
    const { findByText, queryByText } = render(
      <ChatScreen {...({ route, navigation: {} } as any)} />,
    );
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

  it('does not show a duplicate when the accepted echo of an optimistic pending message arrives', async () => {
    const socket = makeFakeSocket();
    const sendMessage = jest.fn().mockResolvedValue({ status: 'pending_approval', contactId: 9 });
    (useSession as jest.Mock).mockReturnValue({
      socket,
      api: { getContactMessages: jest.fn(), sendMessage },
      state: { status: 'authenticated', resolvedContacts: [] },
      dismissResolvedContact: jest.fn(),
    });

    const route = { params: { toTableId: 2, toTableNumber: 5 } };
    const { getByTestId, findByText, queryAllByText } = render(
      <ChatScreen {...({ route, navigation: {} } as any)} />,
    );
    await waitFor(() => expect(socket.on).toHaveBeenCalledWith('message:new', expect.any(Function)));

    fireEvent.changeText(getByTestId('message-input'), 'Salut !');
    fireEvent.press(getByTestId('send-button'));

    expect(await findByText('Salut !')).toBeTruthy();

    // The other table accepts the contact; the backend re-delivers the same message
    // with its real, positive id to both sockets, including this sender's.
    act(() => {
      socket.__emit('message:new', {
        contactId: 9,
        message: { id: 42, kind: 'freetext', predefinedCode: null, content: 'Salut !', senderSessionId: 1, createdAt: 'x' },
      });
    });

    await waitFor(() => expect(queryAllByText('Salut !')).toHaveLength(1));
  });

  it('dismisses a resolved contact that matches this screen once it appears in session state', async () => {
    const dismissResolvedContact = jest.fn();
    (useSession as jest.Mock).mockReturnValue({
      socket: makeFakeSocket(),
      api: { getContactMessages: jest.fn().mockResolvedValue([]), sendMessage: jest.fn() },
      state: { status: 'authenticated', resolvedContacts: [{ contactId: 9, status: 'accepted' }] },
      dismissResolvedContact,
    });

    const route = { params: { contactId: 9, toTableNumber: 5 } };
    render(<ChatScreen {...({ route, navigation: {} } as any)} />);

    await waitFor(() => expect(dismissResolvedContact).toHaveBeenCalledWith(9));
  });

  it('clears the pending-approval banner once the contact resolution arrives in session state', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ status: 'pending_approval', contactId: 9 });
    const useSessionMock = useSession as jest.Mock;
    useSessionMock.mockReturnValue({
      socket: makeFakeSocket(),
      api: { getContactMessages: jest.fn(), sendMessage },
      state: { status: 'authenticated', resolvedContacts: [] },
      dismissResolvedContact: jest.fn(),
    });

    const route = { params: { toTableId: 2, toTableNumber: 5 } };
    const { getByTestId, findByText, queryByText, rerender } = render(
      <ChatScreen {...({ route, navigation: {} } as any)} />,
    );

    fireEvent.changeText(getByTestId('message-input'), 'Salut !');
    fireEvent.press(getByTestId('send-button'));

    expect(await findByText("En attente d'acceptation par l'autre table…")).toBeTruthy();

    // The other table accepts: SessionContext's reducer now carries the resolution.
    useSessionMock.mockReturnValue({
      socket: makeFakeSocket(),
      api: { getContactMessages: jest.fn(), sendMessage },
      state: { status: 'authenticated', resolvedContacts: [{ contactId: 9, status: 'accepted' }] },
      dismissResolvedContact: jest.fn(),
    });
    rerender(<ChatScreen {...({ route, navigation: {} } as any)} />);

    await waitFor(() =>
      expect(queryByText("En attente d'acceptation par l'autre table…")).toBeNull(),
    );
  });
});
