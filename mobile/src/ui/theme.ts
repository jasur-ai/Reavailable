/**
 * Visual system of Reavailable. The brand teal comes from the app icon; everything else is a calm,
 * neutral surface so long Uzbek text stays easy to read in both daylight and dim rooms.
 */
export const colors = {
  background: '#F3F6F5',
  surface: '#FFFFFF',
  surfaceAlt: '#EAF0EE',
  border: '#DCE5E1',
  text: '#15211D',
  muted: '#5E6F69',
  primary: '#1F6F5C',
  primaryPressed: '#17574A',
  primaryText: '#FFFFFF',
  primarySoft: '#E2F0EB',
  accent: '#D98E1F',
  accentSoft: '#FBF0DC',
  danger: '#B3261E',
  dangerSoft: '#F9E3E1',
  warning: '#7A4E00',
  warningSoft: '#FBF0D6',
  success: '#1E6B3F',
  successSoft: '#DFF3E6',
  neutralSoft: '#E9EDEB',
  disabled: '#A9B5B0',
} as const;

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  pill: 999,
} as const;

/** Soft elevation for cards and floating controls. Works on iOS (shadow*) and Android (elevation). */
export const elevation = {
  card: {
    shadowColor: '#0E2A22',
    shadowOpacity: 0.07,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  raised: {
    shadowColor: '#0E2A22',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
} as const;

export const typography = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: '700' as const, color: colors.text, letterSpacing: -0.4 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const, color: colors.text, letterSpacing: -0.2 },
  heading: { fontSize: 17, lineHeight: 23, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 16, lineHeight: 23, color: colors.text },
  small: { fontSize: 14, lineHeight: 20, color: colors.muted },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '600' as const, color: colors.muted, letterSpacing: 0.4 },
} as const;

/** Minimum touch target recommended by both platforms. */
export const TOUCH_TARGET = 48;
export const BUTTON_HEIGHT = 52;
