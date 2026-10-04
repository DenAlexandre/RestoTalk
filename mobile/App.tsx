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
