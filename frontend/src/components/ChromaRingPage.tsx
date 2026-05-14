/**
 * ChromaRingPage
 * ──────────────
 * Full-panel view showing one large ChromaRing per variation,
 * arranged in a wrapping grid.
 *
 * Each ring card shows:
 *   • Large ChromaRing (D3 arc, 12 COF sectors)
 *   • COF note names around the outer edge
 *   • Segment label (V1, V2, …)
 *   • Key badge: tonic + maj / min (if pYIN key available)
 *   • Sector energy tooltip on hover (via <title>)
 */

import { useMemo } from 'react'
import { arc } from 'd3'
import type { PieceData, Segment } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import { chromaOuterRadius } from '../utils/normalize'
import { COF_NAMES } from '../constants/colors'

// ── Geometry constants ───────────────────────────────────────────────
const VBOX       = 280          // SVG viewBox size (px) — enlarged for value labels
const CX         = VBOX / 2
const CY         = VBOX / 2
const INNER_R    = 68           // inner radius of arc ring
const MAX_H      = 50           // max arc extension outward  → outer ≤ 118px
const LABEL_R    = INNER_R + MAX_H + 14  // radius for note name labels
const VALUE_R    = INNER_R + MAX_H + 28  // radius for percentage value labels (beyond note names)

const TWO_PI     = 2 * Math.PI
const ANGLE_STEP = TWO_PI / 12
const START_OFF  = -Math.PI / 2  // 12 o'clock

const arcGen = arc<{ inner: number; outer: number; start: number; end: number }>()
  .innerRadius(d => d.inner)
  .outerRadius(d => d.outer)
  .startAngle(d => d.start)
  .endAngle(d => d.end)
  .padAngle(0.02)
  .padRadius(d => d.inner)
  .cornerRadius(2)

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build arc path + label position for one COF sector.
 * Arc path is centered at (0,0) — caller must apply translate(CX,CY).
 * Label coords (lx,ly) are also relative to (0,0).
 */
function buildSector(value: number, i: number) {
  const startAngle  = START_OFF + i * ANGLE_STEP
  const endAngle    = startAngle + ANGLE_STEP
  const midAngle    = (startAngle + endAngle) / 2
  const outerRadius = chromaOuterRadius(value, INNER_R, MAX_H)
  const d = arcGen({ inner: INNER_R, outer: outerRadius, start: startAngle, end: endAngle })
  // Note name label position (relative to center)
  const lx = LABEL_R * Math.sin(midAngle)
  const ly = -LABEL_R * Math.cos(midAngle)
  // Percentage value label — further out
  const vx = VALUE_R * Math.sin(midAngle)
  const vy = -VALUE_R * Math.cos(midAngle)
  return { d, outerRadius, lx, ly, vx, vy, midAngle }
}

/** Percentage string: "12.3%" */
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

// ── Single Ring Card ─────────────────────────────────────────────────

interface CardProps {
  segment:      Segment
  theme:        ThemeTokens
  isDark:       boolean
  /** If set, only the top-N sectors by energy are shown in colour; others are greyed out */
  highlightTop?: number
  /** SVG display size in px (default 170) */
  size?:         number
}

const GRAY_FILL   = 'rgba(150,150,165,0.30)'
const GRAY_STROKE = 'rgba(150,150,165,0.18)'

export function RingCard({ segment, theme, isDark, highlightTop, size = 170 }: CardProps) {
  const { features, label } = segment
  const chroma = features.chroma_cof   // 12 values, COF order
  const pc     = features.pitch_contour

  // Indices of the top-N sectors (sorted descending by value)
  const topSet = useMemo<Set<number>>(() => {
    if (!highlightTop) return new Set(chroma.map((_, i) => i))
    const sorted = [...chroma.map((v, i) => ({ v, i }))].sort((a, b) => b.v - a.v)
    return new Set(sorted.slice(0, highlightTop).map(x => x.i))
  }, [chroma, highlightTop])

  const sectors = useMemo(() =>
    chroma.map((v, i) => ({ ...buildSector(v, i), value: v, name: COF_NAMES[i], color: theme.chromaColors[i] }))
  , [chroma, theme.chromaColors])

  // Key badge text
  const keyLabel = pc?.tonic_name
    ? `${pc.tonic_name} ${pc.is_major ? 'maj' : 'min'}`
    : null

  // Background tint hue from tonic (COF index of tonic in chroma_cof)
  const tonicCofIdx = pc ? ((pc.tonic_semitone ?? 0) * 7) % 12 : null   // chromatic→COF mapping
  const bgHue = tonicCofIdx !== null ? tonicCofIdx * 30 : 180

  return (
    <div style={{
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      gap:            6,
      padding:        '10px 8px 12px',
      borderRadius:   12,
      border:         theme.cardBorder,
      background:     theme.cardBg,
      boxShadow:      theme.cardShadow,
      minWidth:       160,
    }}>

      {/* Segment label */}
      <div style={{
        fontSize:   13,
        fontWeight: 700,
        color:      theme.labelColor,
        letterSpacing: '0.04em',
      }}>
        {label}
      </div>

      {/* SVG ring — all contents in a centered <g> so D3 arcs render correctly */}
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${VBOX} ${VBOX}`}
        style={{ display: 'block', overflow: 'visible' }}
        aria-label={`Chroma ring for ${label}`}
      >
        {/* Single group translated to center — D3 arc paths are origin-centered */}
        <g transform={`translate(${CX},${CY})`}>

          {/* Subtle background tint */}
          <circle
            r={INNER_R + MAX_H + 2}
            fill={`hsl(${bgHue},55%,55%)`}
            opacity={isDark ? 0.07 : 0.05}
          />

          {/* Dashed reference circle at innerRadius */}
          <circle
            r={INNER_R}
            fill="none"
            stroke={isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}
            strokeWidth={1}
            strokeDasharray="3 3"
          />

          {/* Arc sectors */}
          {sectors.map((s, i) => {
            const isTop = topSet.has(i)
            return (
              <path
                key={i}
                d={s.d ?? ''}
                fill={isTop ? s.color : GRAY_FILL}
                fillOpacity={isTop ? theme.chromaFillOpacity : 1}
                stroke={isTop ? theme.chromaStroke : GRAY_STROKE}
                strokeWidth={theme.chromaStrokeWidth}
              >
                <title>{s.name}: {pct(s.value)}{!isTop ? ' (dimmed)' : ''}</title>
              </path>
            )
          })}

          {/* COF note name labels around the outer edge */}
          {sectors.map((s, i) => {
            const isTop  = topSet.has(i)
            const isEb   = COF_NAMES[i] === 'Eb'
            const isEnat = COF_NAMES[i] === 'E'
            const isKeyNote = isTop && pc && (
              (pc.is_major  && COF_NAMES[i] === 'E')  ||
              (!pc.is_major && COF_NAMES[i] === 'Eb')
            )
            return (
              <text
                key={i}
                x={s.lx} y={s.ly}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={isEb || isEnat ? 11 : 10}
                fontWeight={isKeyNote ? 800 : 500}
                fill={
                  isKeyNote
                    ? s.color
                    : isTop
                      ? (isDark ? 'rgba(255,255,255,0.70)' : 'rgba(0,0,0,0.60)')
                      : (isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.20)')
                }
                style={{ userSelect: 'none' }}
              >
                {s.name}
              </text>
            )
          })}

          {/* Percentage value labels — only shown for top sectors */}
          {sectors.map((s, i) => {
            const isTop     = topSet.has(i)
            const prominent = s.value >= 0.05
            const visible   = isTop ? s.value >= 0.02 : false
            if (!visible) return null
            return (
              <text
                key={i}
                x={s.vx} y={s.vy}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={prominent ? 9.5 : 8.5}
                fontWeight={prominent ? 700 : 400}
                fill={s.color}
                style={{ userSelect: 'none' }}
              >
                {pct(s.value)}
              </text>
            )
          })}

          {/* Center: key label */}
          {keyLabel && (
            <>
              <text
                x={0} y={-7}
                textAnchor="middle" dominantBaseline="central"
                fontSize={17} fontWeight={700}
                fill={theme.labelColor}
                style={{ userSelect: 'none' }}
              >
                {pc!.tonic_name}
              </text>
              <text
                x={0} y={13}
                textAnchor="middle" dominantBaseline="central"
                fontSize={10} fontWeight={500}
                fill={pc!.is_major ? '#E76F51' : '#4895EF'}
                style={{ userSelect: 'none' }}
              >
                {pc!.is_major ? 'major' : 'minor'}
              </text>
            </>
          )}

          {/* Center placeholder if no key info */}
          {!keyLabel && (
            <text
              x={0} y={0}
              textAnchor="middle" dominantBaseline="central"
              fontSize={10}
              fill={isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'}
              style={{ userSelect: 'none' }}
            >
              —
            </text>
          )}

        </g>
      </svg>

      {/* Key badge below ring */}
      {keyLabel && (
        <div style={{
          fontSize:        11,
          fontWeight:      600,
          padding:         '2px 10px',
          borderRadius:    20,
          background:      pc!.is_major
            ? (isDark ? 'rgba(231,111,81,0.18)' : 'rgba(231,111,81,0.12)')
            : (isDark ? 'rgba(72,149,239,0.18)'  : 'rgba(72,149,239,0.12)'),
          color:           pc!.is_major ? '#E76F51' : '#4895EF',
          letterSpacing:   '0.05em',
        }}>
          {keyLabel}
        </div>
      )}
    </div>
  )
}

// ── Legend ────────────────────────────────────────────────────────────

function ChromaLegend({ theme, isDark }: { theme: ThemeTokens; isDark: boolean }) {
  return (
    <div style={{
      display:    'flex',
      flexWrap:   'wrap',
      gap:        '6px 12px',
      padding:    '8px 14px',
      borderRadius: 8,
      background:   isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
      border:       theme.cardBorder,
      fontSize:     11,
      color:        theme.labelSecondaryColor,
    }}>
      <span style={{ fontWeight: 600, color: theme.labelColor, marginRight: 4 }}>
        Circle of Fifths:
      </span>
      {COF_NAMES.map((name, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{
            display: 'inline-block', width: 10, height: 10, borderRadius: 2,
            background: theme.chromaColors[i], opacity: 0.85,
          }} />
          {name}
        </span>
      ))}
      <span style={{ marginLeft: 8 }}>
        · Arc height ∝ pitch class energy · Center = detected key
      </span>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────

interface Props {
  data:        PieceData
  theme:       ThemeTokens
  isDark:      boolean
  lang:        Lang
  selectedSeg?: number | null
}

export function ChromaRingPage({ data, theme, isDark, selectedSeg }: Props) {
  const segments = data.segments

  return (
    <div style={{ padding: '12px 10px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Legend */}
      <ChromaLegend theme={theme} isDark={isDark} />

      {/* Grid of ring cards */}
      <div style={{
        display:               'grid',
        gridTemplateColumns:   'repeat(auto-fill, minmax(175px, 1fr))',
        gap:                   12,
      }}>
        {segments.map(seg => (
          <div
            key={seg.label}
            style={{
              borderRadius: 12,
              boxShadow: selectedSeg === seg.index
                ? '0 0 0 3px #4361EE, 0 0 14px rgba(67,97,238,0.2)'
                : undefined,
            }}
          >
            <RingCard segment={seg} theme={theme} isDark={isDark} />
          </div>
        ))}
      </div>
    </div>
  )
}
