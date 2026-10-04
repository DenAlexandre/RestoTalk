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
