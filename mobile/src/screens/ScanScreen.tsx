import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Scan'>;

function parseQrPayload(data: string): { tableId: number; secret: string } | null {
  try {
    const parsed = JSON.parse(data);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.tableId === 'number' &&
      typeof parsed.secret === 'string'
    ) {
      return { tableId: parsed.tableId, secret: parsed.secret };
    }
    return null;
  } catch {
    return null;
  }
}

export default function ScanScreen({ navigation }: Props) {
  const [permission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [handled, setHandled] = useState(false);

  function handleBarcodeScanned({ data }: { data: string }) {
    if (handled) return;
    const payload = parseQrPayload(data);
    if (!payload) {
      setError('QR code invalide — réessayez.');
      return;
    }
    setHandled(true);
    setError(null);
    navigation.navigate('Pseudo', { tableId: payload.tableId, secret: payload.secret });
  }

  return (
    <View style={styles.container}>
      {permission?.granted ? (
        <CameraView
          testID="camera-view"
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcodeScanned}
        />
      ) : (
        <Text>Autorisation caméra requise.</Text>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  camera: { flex: 1, width: '100%' },
  error: { color: 'red', padding: 8 },
});
