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
    const { queryByTestId } = render(
      <ContactRequestModal {...({ navigation: { navigate: jest.fn() } } as any)} />,
    );
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
      <ContactRequestModal {...({ navigation: { navigate } } as any)} />,
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

    const { getByTestId } = render(
      <ContactRequestModal {...({ navigation: { navigate } } as any)} />,
    );
    fireEvent.press(getByTestId('refuse-button'));

    await waitFor(() => expect(respondToContact).toHaveBeenCalledWith(7, false));
    expect(dismissPendingContactRequest).toHaveBeenCalledWith(7);
    expect(navigate).not.toHaveBeenCalled();
  });
});
