import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, AppState, BackHandler, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createTranslator } from '../i18n';
import { TranslateProvider } from '../ui/TranslateContext';
import { AddBookScreen, type NewBookInput } from '../ui/screens/AddBookScreen';
import { splitTranscript } from '../core/documents/splitText';
import { PART_MAX_CHARS } from '../ui/presentation';
import { TabBar, VoiceIndicator, type MainTab } from '../ui/components/chrome';
import { useAppUpdate } from './useAppUpdate';
import { LibraryScreen } from '../ui/screens/LibraryScreen';
import { PlayerScreen } from '../ui/screens/PlayerScreen';
import { SettingsScreen } from '../ui/screens/SettingsScreen';
import { colors, spacing } from '../ui/theme';
import { useServices, useStore } from './AppContext';

type Route = { name: 'library' } | { name: 'add' } | { name: 'settings' } | { name: 'player'; bookId: string };

/** Unfinished work is retried this often while the app is open. */
const RESUME_INTERVAL_MS = 30_000;

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function AppRoot() {
  const update = useAppUpdate();
  const services = useServices();
  const insets = useSafeAreaInsets();
  // Re-render whenever the library changes. The returned version is not needed here.
  useStore(services.stores.library);
  const playback = useStore(services.stores.playback);
  const voice = useStore(services.stores.voice);
  const books = services.library.books();
  const language = services.library.settings().language;
  // The library store above re-renders this component when the language setting changes.
  const t = useMemo(() => createTranslator(language), [language]);

  const [stack, setStack] = useState<Route[]>([{ name: 'library' }]);
  const [refreshing, setRefreshing] = useState(false);
  const route = stack[stack.length - 1];

  const push = (next: Route) => setStack((current) => [...current, next]);
  const pop = () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));

  // Android hardware back button: go up one screen before leaving the app.
  const depth = stack.length;
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (depth > 1) {
        setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [depth]);

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

  const createBook = async (input: NewBookInput) => {
    if (!serverUrl) {
      throw new Error(t('app.serverNeeded'));
    }
    // A long text becomes several books, each within the server's per-book limit.
    const parts = splitTranscript(input.transcript, PART_MAX_CHARS);
    for (const [index, part] of parts.entries()) {
      const title = parts.length > 1 ? `${input.title} (${index + 1}/${parts.length})` : input.title;
      await services.sync.submit({
        apiBaseUrl: serverUrl,
        title: title.slice(0, 120),
        transcript: part,
        sentencesPerChunk: input.sentencesPerChunk,
        voice: input.voice ?? undefined,
      });
    }
    setStack([{ name: 'library' }]);
  };

  const removeBook = (bookId: string) => {
    services.sync.removeBook(bookId).catch((error: unknown) => {
      Alert.alert(t('app.removeFailed'), messageFrom(error, t('app.tryAgain')));
    });
  };

  const toggleVoice = async (enabled: boolean) => {
    await services.setVoiceEnabled(enabled);
  };

  const activeBook = route.name === 'player' ? books.find((book) => book.id === route.bookId) : undefined;
  const mainTab: MainTab | null = route.name === 'player' ? null : route.name;
  const voiceOn = voice.status === 'listening' || voice.status === 'starting';
  const selectTab = (tab: MainTab) => setStack([{ name: tab }]);

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
          onAdd={() => selectTab('add')}
          update={update.state}
          onInstallUpdate={() => void update.install()}
          onRetry={(book) => {
            services.sync.retry(book.id).catch(() => undefined);
          }}
          onRemove={(book) => removeBook(book.id)}
        />
      );
      break;
    case 'add':
      screen = <AddBookScreen onSubmit={createBook} onCancel={() => selectTab('library')} />;
      break;
    case 'settings':
      screen = (
        <SettingsScreen
          initialServerUrl={serverUrl ?? ''}
          initialApiKey={services.getServerKey()}
          language={language}
          voiceEnabled={voice.status === 'listening' || voice.status === 'starting'}
          voiceAvailable={voice.status !== 'unavailable'}
          onSave={(input) => services.saveServerSettings(input)}
          onTest={(input) => services.checkServer(input)}
          onLanguageChange={(next) => services.setLanguage(next)}
          onVoiceToggle={toggleVoice}
          update={update.state}
          onCheckUpdate={() => void update.check()}
          onInstallUpdate={() => void update.install()}
        />
      );
      break;
    case 'player':
      screen = (
        <PlayerScreen
          book={activeBook}
          playback={playback}
          voice={voice}
          voiceEnabled={voiceOn}
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
      <TranslateProvider value={t}>
        {screen}
        {mainTab ? <TabBar active={mainTab} onSelect={selectTab} /> : null}
        <VoiceIndicator
          status={voice.status}
          lastCommand={voice.lastCommand}
          lastCommandAt={voice.lastCommandAt}
          top={insets.top + spacing.sm}
        />
      </TranslateProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
});
