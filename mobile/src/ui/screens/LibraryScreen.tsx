import { useMemo } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { BookRecord } from '../../core/types';
import { bookStatusView, type Tone } from '../presentation';
import { Badge, Button, Card, Notice, ProgressBar } from '../components/common';
import { colors, spacing, typography } from '../theme';

const TONE_TO_BADGE: Record<Tone, Tone> = {
  neutral: 'neutral',
  info: 'info',
  warning: 'warning',
  danger: 'danger',
  success: 'success',
};

export interface LibraryScreenProps {
  books: readonly BookRecord[];
  serverConfigured: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (book: BookRecord) => void;
  onAdd: () => void;
  onSettings: () => void;
  onRetry: (book: BookRecord) => void;
  onRemove: (book: BookRecord) => void;
}

export function LibraryScreen(props: LibraryScreenProps) {
  const { books, serverConfigured } = props;
  const sorted = useMemo(
    () => [...books].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [books],
  );

  const confirmRemove = (book: BookRecord) => {
    Alert.alert(
      'Remove this book?',
      'The audio is deleted from this phone. If the server still has it, the server copy is deleted too. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => props.onRemove(book) },
      ],
    );
  };

  return (
    <FlatList
      data={sorted}
      keyExtractor={(book) => book.id}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Text style={typography.title}>Library</Text>
            <Button label="Settings" variant="ghost" onPress={props.onSettings} />
          </View>
          {!serverConfigured ? (
            <Notice tone="warning">Set the server address in Settings before adding a book.</Notice>
          ) : null}
          <Button
            label="Add a book"
            onPress={props.onAdd}
            disabled={!serverConfigured}
            accessibilityHint="Opens a form to paste or load a transcript"
          />
        </View>
      }
      ListEmptyComponent={
        <Card>
          <Text style={typography.heading}>No books yet</Text>
          <Text style={typography.small}>
            Add an Uzbek text. The server turns it into audio in short parts, your phone stores them, and you can then
            listen offline and control playback with English voice commands.
          </Text>
        </Card>
      }
      renderItem={({ item }) => (
        <BookCard
          book={item}
          onOpen={() => props.onOpen(item)}
          onRetry={() => props.onRetry(item)}
          onRemove={() => confirmRemove(item)}
        />
      )}
      ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
    />
  );
}

function BookCard({
  book,
  onOpen,
  onRetry,
  onRemove,
}: {
  book: BookRecord;
  onOpen: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const view = bookStatusView(book);
  return (
    <Card>
      <View style={styles.bookHeader}>
        <Text style={[typography.heading, styles.flex]} numberOfLines={2}>
          {book.title}
        </Text>
        <Badge label={view.label} tone={TONE_TO_BADGE[view.tone]} />
      </View>
      <Text style={typography.small}>
        {book.voice ? `Voice: ${voiceLabel(book.voice)}` : ''}
        {book.warnings.includes('cyrillic_text') ? ' · Contains Cyrillic text (may be mispronounced)' : ''}
      </Text>
      {view.progress ? (
        <ProgressBar value={view.progress.value} total={view.progress.total} label={`${book.title} progress`} />
      ) : null}
      <Text style={typography.small}>{view.detail}</Text>
      {book.status === 'failed' && book.errorCode ? (
        <Text style={styles.code}>Code: {book.errorCode}</Text>
      ) : null}
      <View style={styles.actions}>
        {view.canOpen ? <Button label="Open" onPress={onOpen} style={styles.action} /> : null}
        {view.canRetry ? (
          <Button label="Retry" variant="secondary" onPress={onRetry} style={styles.action} />
        ) : null}
        <Button label="Remove" variant="ghost" onPress={onRemove} style={styles.action} />
      </View>
    </Card>
  );
}

function voiceLabel(voice: string): string {
  if (voice.includes('Madina')) {
    return 'Madina (female)';
  }
  if (voice.includes('Sardor')) {
    return 'Sardor (male)';
  }
  return voice;
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xl },
  header: { gap: spacing.md, marginBottom: spacing.lg },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  flex: { flex: 1 },
  bookHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  code: { ...typography.small, color: colors.danger },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  action: { flexGrow: 1, minWidth: 96 },
});
