import { useMemo } from 'react';
import { Alert, FlatList, Image, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { BookRecord } from '../../core/types';
import { bookStatusView, voiceLabel, type Tone } from '../presentation';
import { Badge, Button, Card, Notice, ProgressBar } from '../components/common';
import type { UpdateState } from '../../app/useAppUpdate';
import { colors, radius, spacing, typography } from '../theme';
import { useTranslate } from '../TranslateContext';

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
  update: UpdateState;
  onInstallUpdate: () => void;
  onRetry: (book: BookRecord) => void;
  onRemove: (book: BookRecord) => void;
}

export function LibraryScreen(props: LibraryScreenProps) {
  const { books, serverConfigured } = props;
  const t = useTranslate();
  const sorted = useMemo(
    () => [...books].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [books],
  );

  const confirmRemove = (book: BookRecord) => {
    Alert.alert(t('library.removeTitle'), t('library.removeBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.remove'), style: 'destructive', onPress: () => props.onRemove(book) },
    ]);
  };

  return (
    <FlatList
      data={sorted}
      keyExtractor={(book) => book.id}
      contentContainerStyle={styles.content}
      style={styles.screen}
      refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.brand}>
            <Image source={require('../../../assets/brand/logo.png')} style={styles.logo} accessibilityLabel="Reavailable" />
            <Text style={typography.display}>{t('library.title')}</Text>
          </View>
          <UpdateBanner state={props.update} onInstall={props.onInstallUpdate} />
          {!serverConfigured ? <Notice tone="warning">{t('library.serverNeeded')}</Notice> : null}
          <Button
            label={t('library.addBook')}
            onPress={props.onAdd}
            disabled={!serverConfigured}
            accessibilityHint={t('library.addBookHint')}
          />
        </View>
      }
      ListEmptyComponent={
        <Card>
          <Text style={typography.heading}>{t('library.emptyTitle')}</Text>
          <Text style={typography.small}>{t('library.emptyBody')}</Text>
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
      showsVerticalScrollIndicator={false}
    />
  );
}

/** Shown only when a newer build is ready. Tapping it opens the system installer after the download. */
function UpdateBanner({ state, onInstall }: { state: UpdateState; onInstall: () => void }) {
  const t = useTranslate();
  if (state.status !== 'available' && state.status !== 'downloading' && state.status !== 'noApk') {
    return null;
  }
  const version = state.manifest.versionName;
  return (
    <Card style={styles.banner}>
      <Text style={typography.heading}>{t('update.available', { version })}</Text>
      {state.status === 'noApk' ? <Text style={typography.small}>{t('update.noApk')}</Text> : null}
      <Button
        label={state.status === 'downloading' ? t('update.downloading') : t('update.bannerAction')}
        onPress={onInstall}
        busy={state.status === 'downloading'}
      />
    </Card>
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
  const t = useTranslate();
  const view = bookStatusView(book, t);
  return (
    <Card>
      <View style={styles.bookHeader}>
        <Text style={[typography.heading, styles.flex]} numberOfLines={2}>
          {book.title}
        </Text>
        <Badge label={view.label} tone={TONE_TO_BADGE[view.tone]} />
      </View>
      <Text style={typography.small}>
        {book.voice ? t('library.voiceLabel', { voice: voiceLabel(book.voice, t) }) : ''}
        {book.warnings.includes('cyrillic_text') ? ` · ${t('library.cyrillicNote')}` : ''}
      </Text>
      {view.progress ? (
        <ProgressBar
          value={view.progress.value}
          total={view.progress.total}
          label={t('library.progressLabel', { title: book.title })}
        />
      ) : null}
      <Text style={typography.small}>{view.detail}</Text>
      {book.status === 'failed' && book.errorCode ? (
        <Text style={styles.code}>{t('library.errorCode', { code: book.errorCode })}</Text>
      ) : null}
      <View style={styles.actions}>
        {view.canOpen ? <Button label={t('common.open')} onPress={onOpen} style={styles.action} /> : null}
        {view.canRetry ? (
          <Button label={t('common.retry')} variant="secondary" onPress={onRetry} style={styles.action} />
        ) : null}
        <Button label={t('common.remove')} variant="ghost" onPress={onRemove} style={styles.action} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  header: { gap: spacing.md, marginBottom: spacing.xl },
  banner: { borderWidth: 1, borderColor: colors.primary },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexShrink: 1 },
  logo: { width: 44, height: 44, borderRadius: radius.sm },
  flex: { flex: 1 },
  bookHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  code: { ...typography.small, color: colors.danger },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  action: { flexGrow: 1, minWidth: 96 },
});
