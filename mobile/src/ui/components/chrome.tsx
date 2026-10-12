/**
 * App-wide chrome: the bottom tab bar and the voice-command indicator that floats over every screen.
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StringKey } from '../../i18n';
import type { LastHeard } from '../../core/voice/voiceService';
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

/** How long the heard-command pill stays on screen. */
const HEARD_FLASH_MS = 2_000;

/**
 * A pill at the top of the screen that appears only when the recognizer hears a command word, and
 * says whether it was carried out. Nothing is shown while the app is merely listening, so the screen
 * stays still. It never takes touches, so it cannot block the controls below.
 */
export function VoiceIndicator({ lastHeard, top }: { lastHeard: LastHeard | null | undefined; top: number }) {
  const t = useTranslate();
  const [shown, setShown] = useState<LastHeard | null>(null);

  useEffect(() => {
    if (!lastHeard) {
      return undefined;
    }
    // Scheduled rather than set inline, so the pill appears after this render has committed.
    const show = setTimeout(() => setShown(lastHeard), 0);
    const hide = setTimeout(() => setShown(null), HEARD_FLASH_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [lastHeard]);

  if (!shown) {
    return null;
  }

  const command = t(`voiceCommand.${shown.command}` as StringKey);
  const text = shown.accepted ? t('voiceIndicator.done', { command }) : t('voiceIndicator.heard', { command });

  return (
    <View pointerEvents="none" accessibilityLiveRegion="polite" style={[styles.indicatorWrap, { top }]}>
      <View style={[styles.indicator, shown.accepted ? styles.indicatorDone : null]}>
        <View style={[styles.dot, shown.accepted ? styles.dotDone : null]} />
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
  indicatorDone: { backgroundColor: colors.primary },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  dotDone: { backgroundColor: '#7FE0C2' },
  indicatorText: { ...typography.small, color: colors.primaryText, fontWeight: '600', flexShrink: 1 },
});
