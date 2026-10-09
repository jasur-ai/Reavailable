import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, AppState, BackHandler, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AddBookScreen } from '../ui/screens/AddBookScreen';
import { LibraryScreen } from '../ui/screens/LibraryScreen';
import { PlayerScreen } from '../ui/screens/PlayerScreen';
import { SettingsScreen } from '../ui/screens/SettingsScreen';
import { colors } from '../ui/theme';
import { useServices, useStore } from './AppContext';

type Route = { name: 'library' } | { name: 'add' } | { name: 'settings' } | { name: 'player'; bookId: string };

/** Unfinished work is retried this often while the app is open. */
const RESUME_INTERVAL_MS = 30_000;

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function AppRoot() {
  const services = useServices();
  const insets = useSafeAreaInsets();
  // Re-render whenever the library changes. The returned version is not needed here.
  useStore(services.stores.library);
  const playback = useStore(services.stores.playback);
  const voice = useStore(services.stores.voice);
  const books = services.library.books();

  const [stack, setStack] = useState<Route[]>([{ name: 'library' }]);
  const [refreshing, setRefreshing] = useState(false);
  const route = stack[stack.length - 1];

  const push = useCallback((next: Route) => setStack((current) => [...current, next]), []);
  const pop = useCallback(() => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current)), []);

  // Android hardware back button: go up one screen before leaving the app.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        pop();
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [stack.length, pop]);

  // Resume unfinished downloads when the app comes to the foreground and periodically while it is open.
  useEffect(() => {
    const interval = setInterval(() => services.resumeSync(), RESUME_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        services.resumeSync();
      }
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [services]);

  useEffect(() => {
    if (route.name === 'player') {
      services.openBook(route.bookId).catch(() => undefined);
    }
  }, [route, services]);

  const serverUrl = services.library.settings().apiBaseUrl;

  const refresh = () => {
    setRefreshing(true);
    services.resumeSync();
    setTimeout(() => setRefreshing(false), 600);
  };

  const createBook = async (input: { title: string; transcript: string; sentencesPerChunk: 1 | 2 }) => {
    if (!serverUrl) {
      throw new Error('Set the server address in Settings first.');
    }
    await services.sync.submit({ apiBaseUrl: serverUrl, ...input });
    setStack([{ name: 'library' }]);
  };

  const removeBook = (bookId: string) => {
    services.sync.removeBook(bookId).catch((error: unknown) => {
      Alert.alert('The book could not be removed', messageFrom(error, 'Try again.'));
    });
  };

  const toggleVoice = async (enabled: boolean) => {
    await services.setVoiceEnabled(enabled);
  };

  const activeBook = route.name === 'player' ? books.find((book) => book.id === route.bookId) : undefined;

  let screen: ReactNode;
  switch (route.name) {
    case 'library':
      screen = (
        <LibraryScreen
          books={books}
          serverConfigured={serverUrl !== null}
          refreshing={refreshing}
          onRefresh={refresh}
          onOpen={(book) => push({ name: 'player', bookId: book.id })}
          onAdd={() => push({ name: 'add' })}
          onSettings={() => push({ name: 'settings' })}
          onRetry={(book) => {
            services.sync.retry(book.id).catch(() => undefined);
          }}
          onRemove={(book) => removeBook(book.id)}
        />
      );
      break;
    case 'add':
      screen = <AddBookScreen onSubmit={createBook} onCancel={pop} />;
      break;
    case 'settings':
      screen = (
        <SettingsScreen
          initialServerUrl={serverUrl ?? ''}
          initialApiKey={services.getServerKey()}
          voiceEnabled={voice.status === 'listening' || voice.status === 'starting'}
          voiceAvailable={voice.status !== 'unavailable'}
          onSave={(input) => services.saveServerSettings(input)}
          onTest={(input) => services.checkServer(input)}
          onVoiceToggle={toggleVoice}
          onBack={pop}
        />
      );
      break;
    case 'player':
      screen = (
        <PlayerScreen
          book={activeBook}
          playback={playback}
          voice={voice}
          voiceEnabled={voice.status === 'listening' || voice.status === 'starting'}
          onPlayPause={() => {
            if (playback.status === 'playing') {
              void services.playback.pause();
            } else {
              void services.playback.play();
            }
          }}
          onNext={() => void services.playback.next()}
          onRepeat={() => void services.playback.repeat()}
          onGoTo={(index) => void services.playback.goTo(index)}
          onRetry={() => {
            if (activeBook) {
              services.sync.retry(activeBook.id).catch(() => undefined);
            }
          }}
          onBack={pop}
        />
      );
      break;
  }

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right },
      ]}
    >
      {screen}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
});
