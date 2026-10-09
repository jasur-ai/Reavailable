import type { ReactNode } from 'react';
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
import { colors, radius, spacing, TOUCH_TARGET, typography } from '../theme';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

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
        { backgroundColor: isDisabled ? colors.disabled : palette.background, borderColor: palette.border },
        pressed && !isDisabled ? styles.pressed : null,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={palette.text} />
      ) : (
        <Text style={[styles.buttonLabel, { color: palette.text }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const BUTTON_PALETTE: Record<ButtonVariant, { background: string; text: string; border: string }> = {
  primary: { background: colors.primary, text: colors.primaryText, border: colors.primary },
  secondary: { background: colors.surface, text: colors.primary, border: colors.primary },
  danger: { background: colors.danger, text: colors.primaryText, border: colors.danger },
  ghost: { background: 'transparent', text: colors.primary, border: 'transparent' },
};

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
        style={[styles.input, multiline ? { minHeight: minHeight ?? 160 } : null, error ? styles.inputError : null]}
        {...rest}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : hint ? <Text style={styles.hintText}>{hint}</Text> : null}
    </View>
  );
}

export function Notice({ tone, children }: { tone: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode }) {
  const palette = {
    info: { background: colors.primarySoft, text: colors.text },
    warning: { background: colors.warningSoft, text: colors.warning },
    danger: { background: colors.dangerSoft, text: colors.danger },
    success: { background: colors.successSoft, text: colors.success },
  }[tone];
  return (
    <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: palette.background }]}>
      <Text style={[styles.noticeText, { color: palette.text }]}>{children}</Text>
    </View>
  );
}

export function Badge({ label, tone }: { label: string; tone: 'neutral' | 'info' | 'warning' | 'danger' | 'success' }) {
  const palette = {
    neutral: { background: '#ECECE8', text: colors.muted },
    info: { background: colors.primarySoft, text: colors.primary },
    warning: { background: colors.warningSoft, text: colors.warning },
    danger: { background: colors.dangerSoft, text: colors.danger },
    success: { background: colors.successSoft, text: colors.success },
  }[tone];
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

export const styles = StyleSheet.create({
  button: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.85 },
  buttonLabel: { fontSize: 16, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  field: { gap: spacing.xs },
  fieldLabel: { ...typography.small, fontWeight: '600', color: colors.text },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    color: colors.text,
    minHeight: TOUCH_TARGET,
  },
  inputError: { borderColor: colors.danger },
  errorText: { ...typography.small, color: colors.danger },
  hintText: { ...typography.small },
  notice: { borderRadius: radius.sm, padding: spacing.md },
  noticeText: { fontSize: 15, lineHeight: 21 },
  badge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: 4 },
  badgeText: { fontSize: 13, fontWeight: '600' },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E4E4DF',
    overflow: 'hidden',
  },
  progressFill: { height: 8, backgroundColor: colors.primary },
  sectionTitle: { ...typography.heading, marginTop: spacing.md },
  segmented: {
    flexDirection: 'row',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    overflow: 'hidden',
  },
  segment: { flex: 1, minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  segmentSelected: { backgroundColor: colors.primary },
  segmentText: { fontSize: 16, fontWeight: '600', color: colors.primary },
  segmentTextSelected: { color: colors.primaryText },
});
