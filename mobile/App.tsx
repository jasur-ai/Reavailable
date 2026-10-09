import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ServicesProvider } from './src/app/AppContext';
import { AppRoot } from './src/app/AppRoot';
import { getServices } from './src/app/bootstrap';
import type { AppServices } from './src/app/services';
import { Button } from './src/ui/components/common';
import { colors, spacing, typography } from './src/ui/theme';

export default function App() {
  const [services, setServices] = useState<AppServices | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    getServices()
      .then((instance) => {
        if (active) {
          setServices(instance);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setFailure(error instanceof Error ? error.message : 'The app could not start.');
        }
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  let content;
  if (services) {
    content = (
      <ServicesProvider value={services}>
        <AppRoot />
      </ServicesProvider>
    );
  } else if (failure) {
    content = (
      <View style={styles.center}>
        <Text style={typography.heading}>The app could not start</Text>
        <Text style={typography.small}>{failure}</Text>
        <Button
          label="Try again"
          onPress={() => {
            setFailure(null);
            setAttempt((value) => value + 1);
          }}
        />
      </View>
    );
  } else {
    content = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {content}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.lg,
    backgroundColor: colors.background,
  },
});
