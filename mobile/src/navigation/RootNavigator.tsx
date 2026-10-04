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
