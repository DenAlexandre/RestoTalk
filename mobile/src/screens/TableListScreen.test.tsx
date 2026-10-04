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

    const { getByText } = render(
      <TableListScreen {...({ navigation: { navigate: jest.fn() } } as any)} />,
    );

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

    const { getByTestId } = render(
      <TableListScreen {...({ navigation: { navigate } } as any)} />,
    );
    fireEvent.press(getByTestId('table-row-2'));

    expect(navigate).toHaveBeenCalledWith('Chat', {
      toTableId: 2,
      toTableNumber: 5,
      contactId: undefined,
    });
  });
});
