export const colors = {
  background: '#F5F5F2',
  surface: '#FFFFFF',
  border: '#DADAD4',
  text: '#1C1C1E',
  muted: '#5F5F66',
  primary: '#1F6F5C',
  primaryText: '#FFFFFF',
  primarySoft: '#DDEFE9',
  danger: '#B3261E',
  dangerSoft: '#F9E1DF',
  warning: '#7A5200',
  warningSoft: '#FCEFD2',
  success: '#1E6B3F',
  successSoft: '#DDF1E4',
  disabled: '#A9A9AE',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 8,
  md: 12,
} as const;

export const typography = {
  title: { fontSize: 24, fontWeight: '700' as const, color: colors.text },
  heading: { fontSize: 18, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 16, lineHeight: 22, color: colors.text },
  small: { fontSize: 14, lineHeight: 19, color: colors.muted },
} as const;

/** Minimum touch target recommended by both platforms. */
export const TOUCH_TARGET = 48;
