import { CHROMA_COLORS_SCIENTIFIC } from './colors'

export interface ThemeTokens {
  // Layout
  pageBg: string
  cardBg: string
  cardBorder: string
  cardShadow: string

  // Glyph
  glyphBg: string
  glyphBackgroundTintOpacity: number
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
  glyphFilter: string

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

  showAxisLabels: boolean
  chromaColors: string[]
}

export const theme: ThemeTokens = {
  pageBg:         '#F8F9FC',
  cardBg:         '#FFFFFF',
  cardBorder:     '1px solid rgba(0,0,0,0.07)',
  cardShadow:     '0 1px 3px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)',

  glyphBg:                    '#FFFFFF',
  glyphBackgroundTintOpacity: 0.06,
  chromaFillOpacity:          0.75,
  chromaStroke:               '#FFFFFF',
  chromaStrokeWidth:          0.8,
  rhythmFill:                 '#334155',
  rhythmFillOpacity:          0.10,
  rhythmStroke:               '#475569',
  rhythmStrokeWidth:          1.5,
  timbreFill:                 '#64748B',
  timbreFillOpacity:          0.14,
  timbreStroke:               '#64748B',
  timbreStrokeWidth:          1.2,
  modeDotRadius:              9,
  glyphFilter:                '',

  stripeBg:              '#F8FAFC',
  stripeRowGap:          1,

  labelColor:            '#0F172A',
  labelSecondaryColor:   '#64748B',
  axisLabelColor:        '#94A3B8',
  axisLabelVisible:      true,
  fontFamily:            '"Inter", "IBM Plex Sans", system-ui, sans-serif',
  fontSizeLabel:         13,
  fontSizeMeta:          10,

  showAxisLabels:        true,
  chromaColors:          CHROMA_COLORS_SCIENTIFIC,
}
