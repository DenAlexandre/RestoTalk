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
