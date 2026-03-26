/**
 * PitchContour
 * ────────────
 * Single-segment melodic contour rendered as a smooth SVG curve.
 *
 * Y-axis:
 *   • relative mode  → fixed range [-5, +24 semitones from tonic]
 *                      Tick labels: T (tonic), P5, 8va, …
 *   • absolute mode  → percentile-based range
 *                      Tick labels: C4, C5, …
 */

import type { Segment } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { ContourRange } from '../utils/pitchContour'
import {
  getContourData,
  normaliseContour,
  contourToPath,
  contourToAreaPath,
  yAxisTicks,
} from '../utils/pitchContour'

interface Props {
  segment: Segment
  range: ContourRange           // pass globalContourRange result
  width?: number
  height?: number
  theme: ThemeTokens
  color?: string
  showGrid?: boolean
  showLabel?: boolean           // draw segment label inside
  showYAxis?: boolean           // draw Y-axis tick labels
  dimmed?: boolean              // reduce opacity (overlay non-focus)
}

// Distinct colours per segment index
const LABEL_COLORS = [
  '#4CC9F0', '#F72585', '#7209B7', '#3A0CA3',
  '#4361EE', '#06D6A0', '#F77F00', '#2EC4B6',
  '#E9C46A', '#E76F51', '#264653', '#A8DADC',
  '#457B9D', '#1D3557',
]

export function labelColor(index: number): string {
  return LABEL_COLORS[index % LABEL_COLORS.length]
}

export function PitchContour({
  segment,
  range,
  width  = 200,
  height = 80,
  theme,
  color,
  showGrid  = true,
  showLabel = true,
  showYAxis = false,
  dimmed    = false,
}: Props) {
  const contour   = getContourData(segment)
  const norm      = normaliseContour(contour.values, range)
  const pathD     = contourToPath(norm, width, height)
  const areaD     = contourToAreaPath(norm, width, height)
  const ticks     = yAxisTicks(range, contour.mode, contour.tonicName)

  const stroke    = color ?? labelColor(segment.index)
  const isDark    = theme.pageBg.startsWith('#0') || theme.pageBg.startsWith('#1') || theme.pageBg.includes('0a') || theme.pageBg.includes('1a')
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'
  const yAxisW    = showYAxis ? 34 : 0
  const padX      = 8
  const padY      = 8
  const innerW    = width - yAxisW - padX * 2
  const innerH    = height - padY * 2

  // Tonic reference line (relative mode, v=0 → normalised tonic position)
  const tonicNorm = contour.mode === 'relative'
    ? normaliseContour([0], range)[0]
    : null

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ opacity: dimmed ? 0.35 : 1, display: 'block', overflow: 'visible' }}
    >
      <defs>
        <clipPath id={`clip-${segment.label}-${segment.index}`}>
          <rect x={padX + yAxisW} y={padY} width={innerW} height={innerH} />
        </clipPath>
      </defs>

      {/* ── Y-axis tick lines + labels ── */}
      {showGrid && ticks.map(({ y: yNorm, label }) => {
        const yPx = padY + yNorm * innerH
        const isTonic = label === (contour.tonicName ?? 'T') || label === 'T'
        return (
          <g key={label}>
            <line
              x1={padX + yAxisW} x2={width - padX}
              y1={yPx} y2={yPx}
              stroke={isTonic ? `${stroke}55` : gridColor}
              strokeWidth={isTonic ? 1.5 : 1}
              strokeDasharray={isTonic ? undefined : '3 3'}
            />
            {showYAxis && (
              <text
                x={padX + yAxisW - 4}
                y={yPx + 4}
                textAnchor="end"
                fontSize={9}
                fill={isTonic ? stroke : theme.labelSecondaryColor}
                fontFamily={theme.fontFamily}
                fontWeight={isTonic ? 700 : 400}
                opacity={isTonic ? 0.9 : 0.6}
              >
                {label}
              </text>
            )}
          </g>
        )
      })}

      {/* ── Tonic reference line (bold, relative mode only) ── */}
      {tonicNorm !== null && !showGrid && (
        <line
          x1={padX + yAxisW} x2={width - padX}
          y1={padY + tonicNorm * innerH}
          y2={padY + tonicNorm * innerH}
          stroke={`${stroke}44`}
          strokeWidth={1.5}
        />
      )}

      {/* ── Area fill ── */}
      {areaD && (
        <path
          d={areaD}
          fill={`${stroke}18`}
          clipPath={`url(#clip-${segment.label}-${segment.index})`}
        />
      )}

      {/* ── Contour line ── */}
      {pathD && (
        <path
          d={pathD}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          clipPath={`url(#clip-${segment.label}-${segment.index})`}
        />
      )}

      {/* ── Segment label ── */}
      {showLabel && (
        <text
          x={padX + yAxisW + 5}
          y={padY + 13}
          fontSize={11}
          fontWeight={700}
          fontFamily={theme.fontFamily}
          fill={stroke}
          opacity={0.9}
        >
          {segment.label}
        </text>
      )}

      {/* ── Source badge ── */}
      {contour.source === 'chroma' && (
        <text
          x={width - padX - 2}
          y={padY + 11}
          textAnchor="end"
          fontSize={8}
          fontFamily={theme.fontFamily}
          fill={theme.labelSecondaryColor}
          opacity={0.5}
        >
          ~chroma
        </text>
      )}
    </svg>
  )
}
