import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { BUTTON_HEIGHT, colors, elevation, radius, spacing, TOUCH_TARGET, typography } from '../theme';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_PALETTE: Record<ButtonVariant, { background: string; pressed: string; text: string; border: string }> = {
  primary: { background: colors.primary, pressed: colors.primaryPressed, text: colors.primaryText, border: colors.primary },
  secondary: { background: colors.surface, pressed: colors.primarySoft, text: colors.primary, border: colors.border },
  danger: { background: colors.danger, pressed: '#8E1D17', text: colors.primaryText, border: colors.danger },
  ghost: { background: 'transparent', pressed: colors.surfaceAlt, text: colors.primary, border: 'transparent' },
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  accessibilityHint,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
  style?: ViewStyle;
}) {
  const isDisabled = disabled || busy;
  const palette = BUTTON_PALETTE[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled, busy }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: isDisabled
            ? variant === 'ghost' || variant === 'secondary'
              ? 'transparent'
              : colors.disabled
            : pressed
              ? palette.pressed
              : palette.background,
          borderColor: isDisabled && variant === 'secondary' ? colors.border : palette.border,
        },
        variant === 'primary' && !isDisabled ? elevation.card : null,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={palette.text} />
      ) : (
        <Text style={[styles.buttonLabel, { color: isDisabled && variant !== 'primary' ? colors.disabled : palette.text }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** Large circular control, used for play/pause in the player. */
export function RoundButton({
  label,
  glyph,
  onPress,
  disabled = false,
  size = 72,
  tone = 'primary',
  accessibilityHint,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
  disabled?: boolean;
  size?: number;
  tone?: 'primary' | 'secondary';
  accessibilityHint?: string;
}) {
  const filled = tone === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.round,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: disabled ? colors.neutralSoft : filled ? (pressed ? colors.primaryPressed : colors.primary) : colors.surface,
          borderWidth: filled ? 0 : 1,
          borderColor: colors.border,
        },
        filled && !disabled ? elevation.raised : elevation.card,
      ]}
    >
      <Text
        style={{
          fontSize: size * 0.36,
          color: disabled ? colors.disabled : filled ? colors.primaryText : colors.primary,
          fontWeight: '700',
        }}
      >
        {glyph}
      </Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Field({
  label,
  value,
  onChangeText,
  error,
  hint,
  multiline = false,
  minHeight,
  ...rest
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string | null;
  hint?: string;
  multiline?: boolean;
  minHeight?: number;
} & Omit<TextInputProps, 'value' | 'onChangeText' | 'multiline'>) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        placeholderTextColor={colors.muted}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          multiline ? { minHeight: minHeight ?? 160, lineHeight: 23 } : null,
          focused ? styles.inputFocused : null,
          error ? styles.inputError : null,
        ]}
        {...rest}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : hint ? <Text style={styles.hintText}>{hint}</Text> : null}
    </View>
  );
}

const NOTICE_PALETTE = {
  info: { background: colors.primarySoft, text: colors.text },
  warning: { background: colors.warningSoft, text: colors.warning },
  danger: { background: colors.dangerSoft, text: colors.danger },
  success: { background: colors.successSoft, text: colors.success },
} as const;

export function Notice({ tone, children }: { tone: keyof typeof NOTICE_PALETTE; children: ReactNode }) {
  const palette = NOTICE_PALETTE[tone];
  return (
    <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: palette.background }]}>
      <Text style={[styles.noticeText, { color: palette.text }]}>{children}</Text>
    </View>
  );
}

const BADGE_PALETTE = {
  neutral: { background: colors.neutralSoft, text: colors.muted },
  info: { background: colors.primarySoft, text: colors.primary },
  warning: { background: colors.warningSoft, text: colors.warning },
  danger: { background: colors.dangerSoft, text: colors.danger },
  success: { background: colors.successSoft, text: colors.success },
} as const;

export function Badge({ label, tone }: { label: string; tone: keyof typeof BADGE_PALETTE }) {
  const palette = BADGE_PALETTE[tone];
  return (
    <View style={[styles.badge, { backgroundColor: palette.background }]}>
      <Text style={[styles.badgeText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

export function ProgressBar({ value, total, label }: { value: number; total: number; label: string }) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: total, now: value }}
      style={styles.progressTrack}
    >
      <View style={[styles.progressFill, { width: `${Math.round(ratio * 100)}%` }]} />
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.segmented}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={[styles.segment, selected ? styles.segmentSelected : null]}
          >
            <Text style={[styles.segmentText, selected ? styles.segmentTextSelected : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: BUTTON_HEIGHT,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 16, fontWeight: '600', letterSpacing: 0.1 },
  round: { alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    ...elevation.card,
  },
  field: { gap: spacing.xs },
  fieldLabel: { ...typography.small, fontWeight: '600', color: colors.text },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 16,
    color: colors.text,
    minHeight: TOUCH_TARGET,
  },
  inputFocused: { borderColor: colors.primary },
  inputError: { borderColor: colors.danger },
  errorText: { ...typography.small, color: colors.danger },
  hintText: { ...typography.small },
  notice: { borderRadius: radius.md, padding: spacing.md },
  noticeText: { fontSize: 15, lineHeight: 21 },
  badge: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  badgeText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.2 },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  sectionTitle: { ...typography.caption, textTransform: 'uppercase', marginTop: spacing.md },
  segmented: {
    flexDirection: 'row',
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    padding: spacing.xxs,
    gap: spacing.xxs,
  },
  segment: {
    flex: 1,
    minHeight: TOUCH_TARGET - 4,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentSelected: { backgroundColor: colors.surface, ...elevation.card },
  segmentText: { fontSize: 15, fontWeight: '600', color: colors.muted },
  segmentTextSelected: { color: colors.primary },
});
