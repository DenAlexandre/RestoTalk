import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Button, FlatList, StyleSheet } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { useSession } from '../session/SessionContext';
import { MessageDto, MessageNewEvent } from '../types/api';
import { appendMessageIfNew, belongsToContact, stripOptimisticMessages } from './chatMessages';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export default function ChatScreen({ route }: Props) {
  const { socket, api, state, dismissResolvedContact } = useSession();
  const { toTableId, toTableNumber } = route.params;
  const [contactId, setContactId] = useState<number | undefined>(route.params.contactId);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [draft, setDraft] = useState('');
  const [pendingApproval, setPendingApproval] = useState(false);

  useEffect(() => {
    if (contactId !== undefined) {
      api.getContactMessages(contactId).then(setMessages).catch(() => {
        // contact not yet accepted or fetch failed — stay with locally-known messages only
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!socket) return;
    function handleMessageNew(event: MessageNewEvent) {
      if (contactId === undefined || !belongsToContact(contactId, event)) return;
      setMessages((prev) => appendMessageIfNew(stripOptimisticMessages(prev), event.message));
    }
    socket.on('message:new', handleMessageNew);
    return () => {
      socket.off?.('message:new', handleMessageNew);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, contactId]);

  useEffect(() => {
    if (state.status !== 'authenticated' || contactId === undefined) return;
    const resolution = state.resolvedContacts.find((r) => r.contactId === contactId);
    if (resolution) {
      setPendingApproval(false);
      dismissResolvedContact(resolution.contactId);
    }
  }, [state, contactId, dismissResolvedContact]);

  async function handleSend() {
    const content = draft.trim();
    if (!content || toTableId === undefined) return;
    setDraft('');
    const result = await api.sendMessage({ toTableId, kind: 'freetext', content });
    setContactId(result.contactId);
    if (result.status === 'pending_approval') {
      setPendingApproval(true);
      if (result.message) {
        setMessages((prev) => appendMessageIfNew(prev, result.message as MessageDto));
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: -Date.now(),
            kind: 'freetext',
            predefinedCode: null,
            content,
            senderSessionId: -1,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    } else if (result.message) {
      setMessages((prev) => appendMessageIfNew(prev, result.message as MessageDto));
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.header}>{toTableNumber ? `Table ${toTableNumber}` : 'Conversation'}</Text>
      {pendingApproval ? (
        <Text style={styles.pending}>En attente d'acceptation par l'autre table…</Text>
      ) : null}
      <FlatList
        data={messages}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <Text style={styles.message}>{item.content}</Text>}
      />
      <View style={styles.composer}>
        <TextInput
          testID="message-input"
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Votre message"
        />
        <Button testID="send-button" title="Envoyer" onPress={handleSend} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { fontSize: 18, fontWeight: 'bold', padding: 12 },
  pending: { padding: 8, color: '#666', fontStyle: 'italic' },
  message: { padding: 8 },
  composer: { flexDirection: 'row', padding: 8, borderTopWidth: 1, borderTopColor: '#eee' },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', padding: 8, marginRight: 8 },
});
