/**
 * PitchContourPage
 * ────────────────
 * Card-grid layout (mirrors ChromaRingPage).
 * Each card shows a compact pitch contour chart with:
 *   • Y axis: semitones from tonic, labeled T / P5 / 8va / 15va / 4↓
 *   • Solid colored horizontal line at the tonic
 *   • Dashed grid lines at P5, 8va, 15va, 4↓
 *   • Area fill + contour line
 *   • Segment label + tonic badge
 * Click a card to open the full ContourModal (single or overlay).
 */

import { useState, useMemo } from 'react'
import type { PieceData } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import {
  getContourData,
  normaliseContour,
  contourToPath,
  contourToAreaPath,
  globalContourRange,
} from '../utils/pitchContour'
import { labelColor } from './PitchContour'
import { ContourModal } from './ContourModal'

// ── Card chart dimensions ──────────────────────────────────────────
const CW     = 220   // chart SVG inner width
const CH     = 100   // chart SVG inner height
const PAD_L  = 30    // space for Y-axis labels
const PAD_R  = 6
const PAD_T  = 6
const PAD_B  = 6

// Circle of fifths order (semitones): C G D A E B F# C# Ab Eb Bb F
const COF_ORDER = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]

/** Build a 12-bin pitch-class histogram from beat_midi values.
 *  Pass currentBeat=null for the full-segment static view. */
function buildChromaHist(
  beatMidi: number[],
  currentBeat: number | null,
  windowSize = 8,
): number[] {
  const hist = new Array(12).fill(0)
  const beats = currentBeat === null
    ? beatMidi
    : (() => {
        const lo = Math.max(0, Math.floor(currentBeat) - Math.floor(windowSize / 2))
        const hi = Math.min(beatMidi.length, lo + windowSize)
        return beatMidi.slice(lo, hi)
      })()
  beats.forEach(m => {
    if (m > 0) hist[((Math.round(m) % 12) + 12) % 12]++
  })
  return hist
}

/** Mini chroma ring rendered as an SVG <g>, placed in card top-right. */
function MiniChromaRing({
  cx, cy, r, histogram, isDark, isLive,
}: {
  cx: number; cy: number; r: number
  histogram: number[]; isDark: boolean; isLive: boolean
}) {
  const maxVal = Math.max(...histogram, 1)
  const N = 12
  const innerR = r * 0.32

  return (
    <g>
      {/* Background disc */}
      <circle cx={cx} cy={cy} r={r}
        fill={isDark ? 'rgba(15,23,42,0.72)' : 'rgba(248,250,252,0.80)'}
        stroke={isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}
        strokeWidth={0.6}
      />

      {/* 12 wedge bars */}
      {COF_ORDER.map((pc, i) => {
        const angle = (i / N) * 2 * Math.PI - Math.PI / 2
        const val   = histogram[pc] / maxVal
        const outerR = innerR + val * (r - innerR - 1)
        const half  = Math.PI / N * 0.72
        const cos0  = Math.cos(angle - half), sin0 = Math.sin(angle - half)
        const cos1  = Math.cos(angle + half), sin1 = Math.sin(angle + half)
        const hue   = pc * 30
        const pts   = [
          `${cx + cos0 * innerR},${cy + sin0 * innerR}`,
          `${cx + cos1 * innerR},${cy + sin1 * innerR}`,
          `${cx + cos1 * outerR},${cy + sin1 * outerR}`,
          `${cx + cos0 * outerR},${cy + sin0 * outerR}`,
        ].join(' ')
        return (
          <polygon key={pc} points={pts}
            fill={`hsl(${hue},65%,54%)`}
            opacity={val > 0.01 ? 0.88 : 0.15}
          />
        )
      })}

      {/* Inner hole */}
      <circle cx={cx} cy={cy} r={innerR}
        fill={isDark ? 'rgba(15,23,42,0.85)' : 'rgba(248,250,252,0.90)'}
      />

      {/* Live pulse dot */}
      {isLive && (
        <circle cx={cx} cy={cy} r={2.5} fill="#10b981" opacity={0.9}/>
      )}
    </g>
  )
}

// Ticks shown at card size (subset of full set)
const CARD_TICKS: { st: number; label: string }[] = [
  { st: 24, label: '15va' },
  { st: 12, label: '8va'  },
  { st:  7, label: 'P5'   },
  { st:  0, label: 'T'    },   // replaced with tonicName when available
  { st: -5, label: '4↓'   },
]

// ── Single card ────────────────────────────────────────────────────
interface CardProps {
  segment: PieceData['segments'][number]
  range:   { min: number; max: number }
  theme:   ThemeTokens
  isDark:  boolean
  isPrimary:   boolean
  isSecondary: boolean
  onClick: () => void
  /** When true the chart SVG stretches to fill the card width */
  fillWidth?: boolean
}

export function ContourCard({ segment, range, theme, isDark, isPrimary, isSecondary, onClick, fillWidth }: CardProps) {
  const cd     = useMemo(() => getContourData(segment), [segment])
  const norm   = useMemo(() => normaliseContour(cd.values, range), [cd.values, range])
  const col    = labelColor(segment.index)

  // ── Static chroma ring ───────────────────────────────────────────
  const chromaHist: number[] = useMemo(() => {
    const ch = segment.features.chroma_chromatic
    return Array.isArray(ch) && ch.length === 12 ? ch : new Array(12).fill(0)
  }, [segment])

  // Ring placement: top-right corner of SVG
  const RING_R  = 22
  const RING_CX = CW - PAD_R - RING_R - 2
  const RING_CY = PAD_T + RING_R + 2

  const innerW = CW - PAD_L - PAD_R
  const innerH = CH - PAD_T - PAD_B

  const pathD  = useMemo(() => contourToPath(norm, CW, CH, PAD_L, PAD_T),  [norm])
  const areaD  = useMemo(() => contourToAreaPath(norm, CW, CH, PAD_L, PAD_T), [norm])

  const span   = range.max - range.min
  const normSt = (st: number) => 1 - Math.max(0, Math.min(1, (st - range.min) / span))

  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'

  // Tonic label (replace 'T' with actual note name when known)
  const tonicName = cd.tonicName

  const cardBorder = isPrimary
    ? `2px solid ${col}`
    : isSecondary
      ? `2px dashed ${col}`
      : theme.cardBorder

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'stretch',
        gap: 6, padding: '8px 8px 8px',
        borderRadius: 10,
        border: cardBorder,
        background: theme.cardBg,
        boxShadow: isPrimary ? `0 4px 16px ${col}33` : theme.cardShadow,
        cursor: 'pointer',
        transition: 'border 0.15s, box-shadow 0.15s',
        userSelect: 'none',
      }}
    >
      {/* Top row: segment label + key badge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontFamily: theme.fontFamily,
      }}>
        <span style={{
          fontSize: 12, fontWeight: 700, color: col, letterSpacing: '0.04em',
        }}>
          {segment.label}
        </span>
        {tonicName && cd.isMajor !== undefined && (
          <span style={{
            fontSize: 10, fontWeight: 600, padding: '1px 7px',
            borderRadius: 10,
            background: cd.isMajor
              ? (isDark ? 'rgba(231,111,81,0.18)' : 'rgba(231,111,81,0.10)')
              : (isDark ? 'rgba(72,149,239,0.18)'  : 'rgba(72,149,239,0.10)'),
            color: cd.isMajor ? '#E76F51' : '#4895EF',
          }}>
            {tonicName} {cd.isMajor ? 'maj' : 'min'}
          </span>
        )}
        {cd.source === 'chroma' && (
          <span style={{
            fontSize: 8, opacity: 0.4,
            color: theme.labelSecondaryColor, fontFamily: theme.fontFamily,
          }}>~chroma</span>
        )}

      </div>

      {/* Chart SVG */}
      <svg
        width={fillWidth ? '100%' : CW}
        height={CH}
        viewBox={`0 0 ${CW} ${CH}`}
        style={{ display: 'block', overflow: 'visible' }}
        preserveAspectRatio="none"
      >
        <defs>
          <clipPath id={`cc-clip-${segment.label}-${segment.index}`}>
            <rect x={PAD_L} y={PAD_T} width={innerW} height={innerH} />
          </clipPath>
        </defs>

        {/* Y-axis tick lines + labels */}
        {CARD_TICKS.map(({ st, label: rawLabel }) => {
          const yNorm  = normSt(st)
          if (yNorm < -0.02 || yNorm > 1.02) return null   // out of visible range
          const yPx    = PAD_T + yNorm * innerH
          const isTonic = st === 0
          const label   = isTonic ? (tonicName ?? 'T') : rawLabel
          return (
            <g key={st}>
              <line
                x1={PAD_L} x2={CW - PAD_R}
                y1={yPx} y2={yPx}
                stroke={isTonic ? `${col}88` : gridColor}
                strokeWidth={isTonic ? 1.5 : 0.8}
                strokeDasharray={isTonic ? undefined : '3 3'}
              />
              <text
                x={PAD_L - 4} y={yPx + 3.5}
                textAnchor="end" fontSize={isTonic ? 9.5 : 8}
                fill={isTonic ? col : theme.labelSecondaryColor}
                fontFamily={theme.fontFamily}
                fontWeight={isTonic ? 700 : 400}
                opacity={isTonic ? 0.95 : 0.55}
              >
                {label}
              </text>
            </g>
          )
        })}

        {/* Area fill */}
        {areaD && (
          <path
            d={areaD}
            fill={`${col}18`}
            clipPath={`url(#cc-clip-${segment.label}-${segment.index})`}
          />
        )}

        {/* Contour line */}
        {pathD && (
          <path
            d={pathD} fill="none"
            stroke={col} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round"
            clipPath={`url(#cc-clip-${segment.label}-${segment.index})`}
          />
        )}

        {/* Chroma ring — top-right corner */}
        <MiniChromaRing
          cx={RING_CX} cy={RING_CY} r={RING_R}
          histogram={chromaHist}
          isDark={isDark}
          isLive={false}
        />
      </svg>
    </div>
  )
}

// ── Legend strip ───────────────────────────────────────────────────
function ContourLegend({ theme, isDark }: { theme: ThemeTokens; isDark: boolean }) {
  const bg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: '4px 14px',
      padding: '7px 12px', borderRadius: 8,
      background: bg, border: theme.cardBorder,
      fontSize: 10, color: theme.labelSecondaryColor,
      fontFamily: theme.fontFamily,
    }}>
      <span style={{ fontWeight: 600, color: isDark ? '#e2e8f0' : '#334155', marginRight: 2 }}>
        Y axis:
      </span>
      {[
        { label: 'T', desc: 'tonic' },
        { label: 'P5', desc: 'perfect fifth (+7 st)' },
        { label: '8va', desc: 'octave (+12 st)' },
        { label: '15va', desc: 'two octaves (+24 st)' },
        { label: '4↓', desc: 'fourth below (−5 st)' },
      ].map(({ label, desc }) => (
        <span key={label}>
          <b style={{ color: isDark ? '#cbd5e1' : '#475569' }}>{label}</b> = {desc}
        </span>
      ))}
      <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
        点击卡片放大 · Click card to enlarge
      </span>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────

interface Props {
  data:         PieceData
  theme:        ThemeTokens
  isDark:       boolean
  lang:         Lang
  selectedSeg?: number | null
}

export function PitchContourPage({
  data, theme, isDark, lang,
  selectedSeg,
}: Props) {
  const { segments } = data

  const [primaryIdx,   setPrimaryIdx]   = useState<number | null>(null)
  const [secondaryIdx, setSecondaryIdx] = useState<number | null>(null)
  const [modalOpen,    setModalOpen]    = useState(false)

  const range = useMemo(() => globalContourRange(segments), [segments])

  const handleClick = (i: number) => {
    if (primaryIdx === null) {
      // Nothing selected → set as primary, open modal
      setPrimaryIdx(i)
      setSecondaryIdx(null)
      setModalOpen(true)
    } else if (i === primaryIdx) {
      // Click primary again → open/reopen modal
      setModalOpen(true)
    } else if (i === secondaryIdx) {
      // Click secondary → deselect it
      setSecondaryIdx(null)
    } else if (secondaryIdx === null) {
      // Have primary, click another → set secondary, open overlay
      setSecondaryIdx(i)
      setModalOpen(true)
    } else {
      // Have both → replace primary with clicked, clear secondary
      setPrimaryIdx(i)
      setSecondaryIdx(null)
      setModalOpen(true)
    }
  }

  const modalSegments = (() => {
    if (primaryIdx === null) return null
    const a = segments[primaryIdx]
    if (secondaryIdx !== null) return [a, segments[secondaryIdx]] as [typeof a, typeof a]
    return [a] as [typeof a]
  })()

  return (
    <div style={{ padding: '12px 10px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Legend */}
      <ContourLegend theme={theme} isDark={isDark} />

      {/* Card grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: 10,
      }}>
        {segments.map((seg, i) => (
          <div
            key={seg.label}
            style={{
              borderRadius: 10,
              boxShadow: selectedSeg === seg.index
                ? '0 0 0 3px #4361EE, 0 0 14px rgba(67,97,238,0.2)'
                : undefined,
            }}
          >
            <ContourCard
              segment={seg}
              range={range}
              theme={theme}
              isDark={isDark}
              isPrimary={i === primaryIdx}
              isSecondary={i === secondaryIdx}
              onClick={() => handleClick(i)}
            />
          </div>
        ))}
      </div>

      {/* Hint when nothing selected */}
      {primaryIdx === null && (
        <div style={{
          textAlign: 'center', fontSize: 10,
          color: theme.labelSecondaryColor, opacity: 0.6,
          fontFamily: theme.fontFamily,
        }}>
          {lang === 'zh'
            ? '点击卡片放大 · 再点另一张叠加对比'
            : 'Click a card to enlarge · click another to overlay'}
        </div>
      )}

      {/* Modal */}
      {modalOpen && modalSegments && (
        <ContourModal
          segments={modalSegments}
          range={range}
          theme={theme}
          lang={lang}
          onClose={() => {
            setModalOpen(false)
            setPrimaryIdx(null)
            setSecondaryIdx(null)
          }}
        />
      )}
    </div>
  )
}
