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
});
