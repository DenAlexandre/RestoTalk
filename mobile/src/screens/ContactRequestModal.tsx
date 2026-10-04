import React from 'react';
import { Modal, View, Text, Button, StyleSheet } from 'react-native';
import { NavigationProp } from '@react-navigation/native';
import { RootStackParamList } from '../navigation/types';
import { useSession } from '../session/SessionContext';

type Props = {
  navigation: NavigationProp<RootStackParamList>;
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
