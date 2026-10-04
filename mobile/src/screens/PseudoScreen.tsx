import React, { useState } from 'react';
import { View, Text, TextInput, Button, StyleSheet } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { useSession } from '../session/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Pseudo'>;

export default function PseudoScreen({ route }: Props) {
  const { scanAndJoin } = useSession();
  const [pseudo, setPseudo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!pseudo.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await scanAndJoin(route.params.tableId, route.params.secret, pseudo.trim());
    } catch {
      setError('Impossible de rejoindre cette table — vérifiez le QR code et réessayez.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text>Quel pseudo pour cette table ?</Text>
      <TextInput
        testID="pseudo-input"
        style={styles.input}
        value={pseudo}
        onChangeText={setPseudo}
        placeholder="Votre pseudo"
      />
      <Button testID="submit-button" title="Rejoindre" onPress={handleSubmit} disabled={submitting} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 16 },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 8, marginVertical: 12 },
  error: { color: 'red', marginTop: 8 },
});
