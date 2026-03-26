// VariationGlyph — main Glyph assembler
// Combines ChromaRing + RhythmPolygon + TimbreCore into one SVG
import type { Segment } from '../../types/features'
import type { ThemeTokens } from '../../theme'
import type { RhythmAxes } from '../../utils/normalize'
import { cofHue } from '../../constants/colors'
import { ChromaRing } from './ChromaRing'
import { RhythmPolygon } from './RhythmPolygon'
import { TimbreCore } from './TimbreCore'

// ── Glyph geometry constants ──────────────────────────────────────
export const GLYPH_SIZE      = 200   // SVG viewBox px
const CX = GLYPH_SIZE / 2
const CY = GLYPH_SIZE / 2

// Chroma ring
const CHROMA_INNER_R  = 52    // boundary shared with rhythm polygon
const CHROMA_MAX_H    = 36    // max arc extension outward → outerR = 88px max

// Rhythm polygon
const RHYTHM_MAX_R    = 46    // just inside chroma inner radius (52 − 4 gap − 2 margin)

// Timbre hexagon
const TIMBRE_MAX_R    = 30

interface Props {
  segment: Segment
  rhythmAxes: RhythmAxes    // pre-normalized across all segments
  mfccNorm: number[]        // pre-normalized 6 MFCC values
  theme: ThemeTokens
  size?: number             // rendered size (CSS px), default 160
  isSelected?: boolean
}

export function VariationGlyph({
  segment,
  rhythmAxes,
  mfccNorm,
  theme,
  size = 160,
  isSelected = false,
}: Props) {
  const { features } = segment
  const dominantHue = cofHue(features.dominant_pitch.cof_index)

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`}
      style={{
        display: 'block',
        borderRadius: '50%',
        background: theme.glyphBg,
        outline: isSelected ? `2px solid hsl(${dominantHue},70%,52%)` : 'none',
        outlineOffset: 2,
      }}
      aria-label={`Glyph for ${segment.label}`}
    >
      {/* SVG defs: glow filter (artistic theme) */}
      <defs>
        <filter id="glyph-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Background tint from dominant key */}
      <circle
        cx={CX} cy={CY} r={GLYPH_SIZE / 2}
        fill={`hsl(${dominantHue},60%,55%)`}
        opacity={theme.glyphBackgroundTintOpacity}
      />

      {/* Inner background disc (white/dark) */}
      <circle
        cx={CX} cy={CY} r={CHROMA_INNER_R - 1}
        fill={theme.glyphBg === 'transparent' ? '#161628' : '#FFFFFF'}
        opacity={0.9}
      />

      {/* Layer 1: Chroma ring */}
      <ChromaRing
        chromaCof={features.chroma_cof}
        innerRadius={CHROMA_INNER_R}
        maxArcHeight={CHROMA_MAX_H}
        cx={CX} cy={CY}
        theme={theme}
      />

      {/* Layer 2: Rhythm polygon */}
      <RhythmPolygon
        axes={rhythmAxes}
        maxRadius={RHYTHM_MAX_R}
        cx={CX} cy={CY}
        theme={theme}
      />

      {/* Layer 3: Timbre hexagon + mode dot */}
      <TimbreCore
        mfccNorm={mfccNorm}
        chromaCof={features.chroma_cof}
        maxRadius={TIMBRE_MAX_R}
        cx={CX} cy={CY}
        theme={theme}
      />
    </svg>
  )
}
