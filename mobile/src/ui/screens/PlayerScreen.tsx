import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PlaybackSnapshot } from '../../core/playback/playbackController';
import type { BookRecord } from '../../core/types';
import type { VoiceSnapshot } from '../../core/voice/voiceService';
import { Badge, Button, Card, Notice, ProgressBar, RoundButton } from '../components/common';
import {
  partStatus,
  playbackMessage,
  storedCount,
  totalParts,
  voiceMessage,
  type Tone,
} from '../presentation';
import { colors, elevation, radius, spacing, TOUCH_TARGET, typography } from '../theme';
import { useTranslate } from '../TranslateContext';

export interface PlayerScreenProps {
  book: BookRecord | undefined;
  playback: PlaybackSnapshot;
  voice: VoiceSnapshot;
  voiceEnabled: boolean;
  onPlayPause: () => void;
  onNext: () => void;
  onRepeat: () => void;
  onGoTo: (index: number) => void;
  onRetry: () => void;
  onBack: () => void;
}

export function PlayerScreen(props: PlayerScreenProps) {
  const { book, playback } = props;
  const t = useTranslate();
  if (!book) {
    return (
      <View style={styles.center}>
        <Text style={typography.heading}>{t('player.bookMissing')}</Text>
        <Button label={t('player.backToLibrary')} onPress={props.onBack} />
      </View>
    );
  }

  const total = totalParts(book);
  const stored = storedCount(book);
  const isPlaying = playback.status === 'playing';
  const playPauseLabel = isPlaying ? t('player.pause') : t('player.play');
  const currentChunk = book.chunks.find((chunk) => chunk.index === playback.index);
  const currentStatus = partStatus(currentChunk, t);
  const canRetry = book.status === 'failed' && !book.serverGone;

  return (
    <FlatList
      data={book.chunks}
      keyExtractor={(chunk) => String(chunk.index)}
      contentContainerStyle={styles.content}
      initialNumToRender={20}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.topRow}>
            <Button label={t('library.title')} variant="ghost" onPress={props.onBack} />
          </View>
          <Text style={typography.title} numberOfLines={2}>
            {book.title}
          </Text>
          <Text style={typography.small}>
            {t('player.position', { index: Math.min(playback.index + 1, Math.max(total, 1)), total, stored })}
          </Text>
          <ProgressBar value={stored} total={total} label={t('player.progressLabel')} />

          <Card>
            <Text style={[typography.body, styles.status]} accessibilityLiveRegion="polite">
              {playbackMessage(playback, t)}
            </Text>
            {playback.status === 'error' || (book.status === 'failed' && playback.status !== 'waiting') ? (
              <Notice tone="danger">{book.errorMessage ?? playback.error ?? t('player.attention')}</Notice>
            ) : null}
            {currentChunk && currentChunk.state !== 'stored' && playback.status === 'waiting' ? (
              <Badge label={currentStatus.label} tone={currentStatus.tone} />
            ) : null}
            <View style={styles.controls}>
              <RoundButton
                label={t('player.repeat')}
                glyph="↺"
                tone="secondary"
                size={56}
                onPress={props.onRepeat}
                disabled={playback.status === 'idle' || playback.status === 'waiting'}
                accessibilityHint={t('player.repeatHint')}
              />
              <RoundButton
                label={playPauseLabel}
                glyph={isPlaying ? '❚❚' : '▶'}
                size={84}
                onPress={props.onPlayPause}
                disabled={playback.status === 'idle'}
                accessibilityHint={isPlaying ? t('player.pauseHint') : t('player.playHint')}
              />
              <RoundButton
                label={t('player.next')}
                glyph="»"
                tone="secondary"
                size={56}
                onPress={props.onNext}
                disabled={playback.status === 'idle'}
                accessibilityHint={t('player.nextHint')}
              />
            </View>
            {canRetry ? <Button label={t('player.retryDownload')} variant="secondary" onPress={props.onRetry} /> : null}
          </Card>

          <Card>
            <View style={styles.voiceRow}>
              <Text style={[typography.heading, styles.flex]}>{t('player.voiceTitle')}</Text>
              <Badge
                label={props.voiceEnabled ? t('common.on') : t('common.off')}
                tone={props.voiceEnabled ? 'success' : 'neutral'}
              />
            </View>
            <Text style={typography.small} accessibilityLiveRegion="polite">
              {voiceMessage(props.voice, t)}
            </Text>
            {props.voice.lastCommand ? (
              <Text style={typography.small}>{t('player.lastCommand', { command: props.voice.lastCommand })}</Text>
            ) : null}
            <Text style={typography.small}>{t('player.voiceOfflineHint')}</Text>
          </Card>

          <Text style={styles.sectionTitle}>{t('player.parts')}</Text>
        </View>
      }
      renderItem={({ item }) => {
        const status = partStatus(item, t);
        const selected = item.index === playback.index;
        return (
          <PartRow
            index={item.index}
            label={status.label}
            tone={status.tone}
            selected={selected}
            onPress={() => props.onGoTo(item.index)}
          />
        );
      }}
      ListEmptyComponent={<Text style={typography.small}>{t('player.partsEmpty')}</Text>}
    />
  );
}

function PartRow({
  index,
  label,
  tone,
  selected,
  onPress,
}: {
  index: number;
  label: string;
  tone: Tone;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTranslate();
  const number = index + 1;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('player.partA11y', { index: number, label })}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.partRow, selected ? styles.partRowSelected : null, pressed ? styles.pressed : null]}
    >
      <Text style={[typography.body, styles.flex]}>{t('player.partLabel', { index: number })}</Text>
      <Badge label={label} tone={tone} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg, backgroundColor: colors.background },
  header: { gap: spacing.md, marginBottom: spacing.sm },
  topRow: { flexDirection: 'row', justifyContent: 'flex-start' },
  status: { fontSize: 17, lineHeight: 24, fontWeight: '600', textAlign: 'center' },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xl, marginVertical: spacing.md },
  voiceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  flex: { flex: 1 },
  sectionTitle: { ...typography.heading, marginTop: spacing.md },
  partRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginTop: spacing.sm,
    ...elevation.card,
  },
  partRowSelected: { backgroundColor: colors.primarySoft },
  pressed: { opacity: 0.8 },
});
