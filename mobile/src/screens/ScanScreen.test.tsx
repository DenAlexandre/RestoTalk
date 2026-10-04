import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import ScanScreen from './ScanScreen';

jest.mock('expo-camera', () => {
  const React = require('react');
  return {
    CameraView: React.forwardRef((props: any, _ref: any) => {
      const { View, Button } = require('react-native');
      return (
        <View testID="camera-view">
          <Button
            testID="simulate-scan"
            title="simulate-scan"
            onPress={() => props.onBarcodeScanned?.({ data: props.__testData })}
          />
        </View>
      );
    }),
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
  };
});

describe('ScanScreen', () => {
  function renderScreen(testData: string) {
    const navigate = jest.fn();
    const utils = render(
      <ScanScreen {...({ navigation: { navigate } } as any)} />,
    );
    return { navigate, ...utils };
  }

  it('navigates to Pseudo with the parsed tableId and secret on a valid QR', () => {
    const { navigate, getByTestId } = renderScreen(
      JSON.stringify({ tableId: 5, secret: 'abc' }),
    );
    fireEvent(getByTestId('camera-view'), 'onBarcodeScanned', {
      data: JSON.stringify({ tableId: 5, secret: 'abc' }),
    });
    expect(navigate).toHaveBeenCalledWith('Pseudo', { tableId: 5, secret: 'abc' });
  });

  it('shows an error and does not navigate on malformed QR content', () => {
    const { navigate, getByTestId, getByText } = renderScreen('not json');
    fireEvent(getByTestId('camera-view'), 'onBarcodeScanned', { data: 'not json' });
    expect(navigate).not.toHaveBeenCalled();
    expect(getByText(/QR code invalide/i)).toBeTruthy();
  });

  it('shows an error and does not navigate when the QR JSON has the wrong shape', () => {
    const { navigate, getByTestId, getByText } = renderScreen(JSON.stringify({ foo: 'bar' }));
    fireEvent(getByTestId('camera-view'), 'onBarcodeScanned', {
      data: JSON.stringify({ foo: 'bar' }),
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(getByText(/QR code invalide/i)).toBeTruthy();
  });
});
