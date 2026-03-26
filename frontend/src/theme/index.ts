// VariVis — Theme tokens
// Two modes: 'scientific' (white, precise) and 'artistic' (dark, vivid)

export type ThemeMode = 'scientific' | 'artistic'

export interface ThemeTokens {
  // Layout
  pageBg: string
  cardBg: string
  cardBorder: string
  cardShadow: string

  // Glyph
  glyphBg: string
  glyphBackgroundTintOpacity: number   // opacity of dominant-hue tint
  chromaFillOpacity: number
  chromaStroke: string
  chromaStrokeWidth: number
  rhythmFill: string
  rhythmFillOpacity: number
  rhythmStroke: string
  rhythmStrokeWidth: number
  timbreFill: string
  timbreFillOpacity: number
  timbreStroke: string
  timbreStrokeWidth: number
  modeDotRadius: number
  glyphFilter: string                  // SVG filter id ('' = none)

  // Feature stripe
  stripeBg: string
  stripeRowGap: number

  // Typography
  labelColor: string
  labelSecondaryColor: string
  axisLabelColor: string
  axisLabelVisible: boolean
  fontFamily: string
  fontSizeLabel: number
  fontSizeMeta: number

  // Rhythm polygon axis labels
  showAxisLabels: boolean

  // Chroma colors key
  chromaColors: string[]
}

import { CHROMA_COLORS_SCIENTIFIC, CHROMA_COLORS_ARTISTIC } from '../constants/colors'

export const SCIENTIFIC: ThemeTokens = {
  pageBg: '#F5F6F8',
  cardBg: '#FFFFFF',
  cardBorder: '1px solid #E2E6EA',
  cardShadow: '0 2px 8px rgba(0,0,0,0.07)',
  glyphBg: '#FFFFFF',
  glyphBackgroundTintOpacity: 0.07,
  chromaFillOpacity: 0.72,
  chromaStroke: '#FFFFFF',
  chromaStrokeWidth: 0.8,
  rhythmFill: '#334155',
  rhythmFillOpacity: 0.12,
  rhythmStroke: '#475569',
  rhythmStrokeWidth: 1.5,
  timbreFill: '#64748B',
  timbreFillOpacity: 0.18,
  timbreStroke: '#64748B',
  timbreStrokeWidth: 1.2,
  modeDotRadius: 9,
  glyphFilter: '',
  stripeBg: '#F8FAFC',
  stripeRowGap: 1,
  labelColor: '#1E293B',
  labelSecondaryColor: '#64748B',
  axisLabelColor: '#94A3B8',
  axisLabelVisible: true,
  fontFamily: '"Inter", "IBM Plex Sans", system-ui, sans-serif',
  fontSizeLabel: 13,
  fontSizeMeta: 10,
  showAxisLabels: true,
  chromaColors: CHROMA_COLORS_SCIENTIFIC,
}

export const ARTISTIC: ThemeTokens = {
  pageBg: '#0D0D1A',
  cardBg: '#161628',
  cardBorder: '1px solid #252545',
  cardShadow: '0 4px 24px rgba(0,0,0,0.5)',
  glyphBg: 'transparent',
  glyphBackgroundTintOpacity: 0.18,
  chromaFillOpacity: 0.88,
  chromaStroke: 'rgba(0,0,0,0.3)',
  chromaStrokeWidth: 0.4,
  rhythmFill: '#C8D6E5',
  rhythmFillOpacity: 0.08,
  rhythmStroke: '#A8BFCF',
  rhythmStrokeWidth: 1.2,
  timbreFill: '#94A3B8',
  timbreFillOpacity: 0.14,
  timbreStroke: '#94A3B8',
  timbreStrokeWidth: 1.0,
  modeDotRadius: 9,
  glyphFilter: 'url(#glyph-glow)',
  stripeBg: '#0F0F1E',
  stripeRowGap: 1,
  labelColor: '#E2E8F0',
  labelSecondaryColor: '#64748B',
  axisLabelColor: 'transparent',
  axisLabelVisible: false,
  fontFamily: '"Inter", system-ui, sans-serif',
  fontSizeLabel: 13,
  fontSizeMeta: 10,
  showAxisLabels: false,
  chromaColors: CHROMA_COLORS_ARTISTIC,
}

export function getTheme(mode: ThemeMode): ThemeTokens {
  return mode === 'scientific' ? SCIENTIFIC : ARTISTIC
}
