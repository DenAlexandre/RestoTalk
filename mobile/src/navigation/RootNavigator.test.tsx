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
