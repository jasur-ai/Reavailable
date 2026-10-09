import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PlaybackSnapshot } from '../../core/playback/playbackController';
import type { BookRecord } from '../../core/types';
import type { VoiceSnapshot } from '../../core/voice/voiceService';
import { Badge, Button, Card, Notice, ProgressBar } from '../components/common';
import {
  partStatus,
  playbackMessage,
  storedCount,
  totalParts,
  voiceMessage,
  type Tone,
} from '../presentation';
import { colors, radius, spacing, TOUCH_TARGET, typography } from '../theme';

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
  if (!book) {
    return (
      <View style={styles.center}>
        <Text style={typography.heading}>This book is no longer on this phone.</Text>
        <Button label="Back to library" onPress={props.onBack} />
      </View>
    );
  }

  const total = totalParts(book);
  const stored = storedCount(book);
  const isPlaying = playback.status === 'playing';
  const playPauseLabel = isPlaying ? 'Pause' : 'Play';
  const currentChunk = book.chunks.find((chunk) => chunk.index === playback.index);
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
            <Button label="Library" variant="ghost" onPress={props.onBack} />
          </View>
          <Text style={typography.title} numberOfLines={2}>
            {book.title}
          </Text>
          <Text style={typography.small}>
            Part {Math.min(playback.index + 1, Math.max(total, 1))} of {total} · {stored} on this phone
          </Text>
          <ProgressBar value={stored} total={total} label="Parts on this phone" />

          <Card>
            <Text style={[typography.body, styles.status]} accessibilityLiveRegion="polite">
              {playbackMessage(playback)}
            </Text>
            {playback.status === 'error' || (book.status === 'failed' && playback.status !== 'waiting') ? (
              <Notice tone="danger">{book.errorMessage ?? playback.error ?? 'Playback needs attention.'}</Notice>
            ) : null}
            {currentChunk && currentChunk.state !== 'stored' && playback.status === 'waiting' ? (
              <Badge label={partStatus(currentChunk).label} tone={partStatus(currentChunk).tone} />
            ) : null}
            <View style={styles.controls}>
              <Button
                label="Repeat"
                variant="secondary"
                onPress={props.onRepeat}
                disabled={playback.status === 'idle' || playback.status === 'waiting'}
                accessibilityHint="Plays the current part again from the beginning"
                style={styles.control}
              />
              <Button
                label={playPauseLabel}
                onPress={props.onPlayPause}
                disabled={playback.status === 'idle'}
                accessibilityHint={isPlaying ? 'Pauses playback' : 'Starts or resumes playback'}
                style={styles.control}
              />
              <Button
                label="Next"
                variant="secondary"
                onPress={props.onNext}
                disabled={playback.status === 'idle'}
                accessibilityHint="Moves to the next part"
                style={styles.control}
              />
            </View>
            {canRetry ? <Button label="Retry download" variant="secondary" onPress={props.onRetry} /> : null}
          </Card>

          <Card>
            <View style={styles.voiceRow}>
              <Text style={[typography.heading, styles.flex]}>Voice commands</Text>
              <Badge
                label={props.voiceEnabled ? 'On' : 'Off'}
                tone={props.voiceEnabled ? 'success' : 'neutral'}
              />
            </View>
            <Text style={typography.small} accessibilityLiveRegion="polite">
              {voiceMessage(props.voice)}
            </Text>
            {props.voice.lastCommand ? (
              <Text style={typography.small}>Last command: {props.voice.lastCommand}</Text>
            ) : null}
            <Text style={typography.small}>
              Works offline. Use headphones, or keep the phone close, so the speaker does not trigger commands.
            </Text>
          </Card>

          <Text style={styles.sectionTitle}>Parts</Text>
        </View>
      }
      renderItem={({ item }) => {
        const status = partStatus(item);
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
      ListEmptyComponent={
        <Text style={typography.small}>
          Parts appear here when the server has finished preparing the book.
        </Text>
      }
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Part ${index + 1}, ${label}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.partRow, selected ? styles.partRowSelected : null, pressed ? styles.pressed : null]}
    >
      <Text style={[typography.body, styles.flex]}>Part {index + 1}</Text>
      <Badge label={label} tone={tone} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  header: { gap: spacing.md, marginBottom: spacing.sm },
  topRow: { flexDirection: 'row', justifyContent: 'flex-start' },
  status: { fontSize: 17, fontWeight: '600' },
  controls: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  control: { flex: 1, minHeight: 56 },
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
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    marginTop: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  partRowSelected: { borderColor: colors.primary, borderWidth: 2 },
  pressed: { opacity: 0.8 },
});
