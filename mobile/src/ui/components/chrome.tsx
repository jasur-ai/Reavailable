/**
 * App-wide chrome: the bottom tab bar and the voice-command indicator that floats over every screen.
 */

import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StringKey } from '../../i18n';
import type { VoiceCommand } from '../../core/voice/commands';
import type { VoiceStatus } from '../../core/voice/voiceService';
import { colors, elevation, radius, spacing, TOUCH_TARGET, typography } from '../theme';
import { useTranslate } from '../TranslateContext';

export type MainTab = 'library' | 'add' | 'settings';

const TABS: readonly { id: MainTab; labelKey: StringKey; glyph: string }[] = [
  { id: 'library', labelKey: 'tabs.library', glyph: '▤' },
  { id: 'add', labelKey: 'tabs.add', glyph: '+' },
  { id: 'settings', labelKey: 'tabs.settings', glyph: '⚙' },
];

export function TabBar({ active, onSelect }: { active: MainTab; onSelect: (tab: MainTab) => void }) {
  const t = useTranslate();
  return (
    <View accessibilityRole="tablist" accessibilityLabel={t('tabs.label')} style={styles.tabBar}>
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={t(tab.labelKey)}
            onPress={() => onSelect(tab.id)}
            style={({ pressed }) => [styles.tab, pressed ? styles.tabPressed : null]}
          >
            <View style={[styles.tabIcon, selected ? styles.tabIconSelected : null]}>
              <Text style={[styles.tabGlyph, selected ? styles.tabGlyphSelected : null]}>{tab.glyph}</Text>
            </View>
            <Text style={[styles.tabLabel, selected ? styles.tabLabelSelected : null]}>{t(tab.labelKey)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** How long a recognised command stays on screen. */
const COMMAND_FLASH_MS = 2_200;

/**
 * A pill at the top of the screen that shows voice control is listening, and flashes the command
 * that was just recognised. It never takes touches, so it cannot block the controls below.
 */
export function VoiceIndicator({
  status,
  lastCommand,
  lastCommandAt,
  top,
}: {
  status: VoiceStatus;
  lastCommand: VoiceCommand | null;
  lastCommandAt: number | null;
  top: number;
}) {
  const t = useTranslate();
  const listening = status === 'listening' || status === 'starting';
  const [flash, setFlash] = useState<VoiceCommand | null>(null);
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!lastCommand || lastCommandAt === null) {
      return undefined;
    }
    // Scheduled rather than set inline, so the flash starts after this render has committed.
    const show = setTimeout(() => setFlash(lastCommand), 0);
    const hide = setTimeout(() => setFlash(null), COMMAND_FLASH_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [lastCommand, lastCommandAt]);

  useEffect(() => {
    if (!listening) {
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [listening, pulse]);

  if (!listening && !flash) {
    return null;
  }

  const text = flash
    ? t('voiceIndicator.heard', { command: t(`voiceCommand.${flash}` as StringKey) })
    : t('voiceIndicator.listening');

  return (
    <View pointerEvents="none" accessibilityLiveRegion="polite" style={[styles.indicatorWrap, { top }]}>
      <View style={[styles.indicator, flash ? styles.indicatorHeard : null]}>
        <Animated.View
          style={[
            styles.dot,
            flash ? styles.dotHeard : null,
            {
              opacity: listening ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) : 1,
              transform: [
                {
                  scale: listening ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.15] }) : 1,
                },
              ],
            },
          ]}
        />
        <Text style={styles.indicatorText}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  tab: { flex: 1, alignItems: 'center', gap: spacing.xxs, minHeight: TOUCH_TARGET, justifyContent: 'center' },
  tabPressed: { opacity: 0.7 },
  tabIcon: {
    width: 56,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIconSelected: { backgroundColor: colors.primarySoft },
  tabGlyph: { fontSize: 18, color: colors.muted, fontWeight: '700' },
  tabGlyphSelected: { color: colors.primary },
  tabLabel: { fontSize: 12, fontWeight: '600', color: colors.muted },
  tabLabelSelected: { color: colors.primary },

  indicatorWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 10 },
  indicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.text,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    maxWidth: '90%',
    ...elevation.raised,
  },
  indicatorHeard: { backgroundColor: colors.primary },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#7FE0C2' },
  dotHeard: { backgroundColor: colors.surface },
  indicatorText: { ...typography.small, color: colors.primaryText, fontWeight: '600', flexShrink: 1 },
});
