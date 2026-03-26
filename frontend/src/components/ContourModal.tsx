/**
 * ContourModal
 * ────────────
 * Enlarged pitch contour view — single or two-segment overlay.
 * Uses tonic-relative Y axis when pYIN + KS data is available.
 */

import { useEffect } from 'react'
import type { Segment } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import type { ContourRange } from '../utils/pitchContour'
import {
  getContourData,
  normaliseContour,
  contourToPath,
  contourToAreaPath,
  yAxisTicks,
  dtwWarpOntoA,
  dtwSimilarity,
} from '../utils/pitchContour'
import { labelColor } from './PitchContour'

interface Props {
  segments: [Segment] | [Segment, Segment]
  range: ContourRange
  theme: ThemeTokens
  lang?: Lang
  onClose: () => void
}

const W     = Math.min(820, (typeof window !== 'undefined' ? window.innerWidth : 900) - 48)
const H     = 300
const PAD_X = 52    // room for Y labels
const PAD_Y = 28

export function ContourModal({ segments, range, theme, lang = 'zh', onClose }: Props) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const isTwoMode = segments.length === 2
  const isDark    = theme.pageBg.startsWith('#0') || theme.pageBg.startsWith('#1') || theme.pageBg.includes('1a')
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'

  // Pre-compute DTW warp + similarity at component level so footer can access it
  const cdA       = getContourData(segments[0])
  const cdB       = isTwoMode ? getContourData(segments[1]) : null
  const warpedB   = cdB ? dtwWarpOntoA(cdA.values, cdB.values) : null
  const sim       = warpedB ? dtwSimilarity(cdA.values, warpedB) : null

  // Use the mode of the first segment to drive axis labels
  const firstContour = cdA
  const ticks = yAxisTicks(range, firstContour.mode, firstContour.tonicName)

  const innerW = W - PAD_X * 2
  const innerH = H - PAD_Y * 2

  const tonicNorm = firstContour.mode === 'relative'
    ? normaliseContour([0], range)[0]
    : null

  // x-ticks at 0, 25, 50, 75, 100%
  const xTicks = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: theme.cardBg,
          borderRadius: 16,
          padding: '20px 24px 22px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
          border: theme.cardBorder,
          minWidth: W + 24,
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'flex-start', marginBottom: 14,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
              {segments.map((seg, i) => {
                const cd  = getContourData(seg)
                const col = labelColor(seg.index)
                return (
                  <span key={seg.label} style={{
                    fontSize: 13, fontWeight: 700,
                    fontFamily: theme.fontFamily, color: col,
                  }}>
                    {isTwoMode ? (i === 0 ? '● ' : '◌ ') : ''}{seg.label}
                    {cd.tonicName
                      ? ` — ${cd.tonicName}${cd.isMajor ? ' maj' : ' min'} (r=${cd.ksCorrelation?.toFixed(2)})`
                      : ''}
                  </span>
                )
              })}
            </div>
            <div style={{
              fontSize: 10, color: theme.labelSecondaryColor,
              fontFamily: theme.fontFamily, opacity: 0.7,
            }}>
              {firstContour.mode === 'relative'
                ? 'Y axis: semitones from tonic  ·  T = tonic  ·  P5 = fifth  ·  8va = octave above'
                : 'Y axis: absolute MIDI pitch  ·  labels = C notes (octave boundaries)'}
              {firstContour.source === 'chroma' ? '  ·  ⚠ chroma fallback — run add_pitch_contour.py for real pYIN' : ''}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none',
              fontSize: 20, cursor: 'pointer',
              color: theme.labelSecondaryColor, lineHeight: 1, padding: '0 4px',
            }}
          >×</button>
        </div>

        {/* SVG */}
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
          <defs>
            <clipPath id="modal-clip">
              <rect x={PAD_X} y={PAD_Y} width={innerW} height={innerH} />
            </clipPath>
          </defs>

          {/* Y grid + labels */}
          {ticks.map(({ y: yNorm, label }) => {
            const yPx    = PAD_Y + yNorm * innerH
            const isTonic = label === (firstContour.tonicName ?? 'T') || label === 'T'
            return (
              <g key={label}>
                <line
                  x1={PAD_X} x2={W - PAD_X}
                  y1={yPx} y2={yPx}
                  stroke={isTonic ? 'rgba(255,255,255,0.2)' : gridColor}
                  strokeWidth={isTonic ? 1.5 : 1}
                  strokeDasharray={isTonic ? undefined : '4 4'}
                />
                <text
                  x={PAD_X - 5} y={yPx + 4}
                  textAnchor="end" fontSize={10}
                  fill={isTonic ? labelColor(segments[0].index) : theme.labelSecondaryColor}
                  fontFamily={theme.fontFamily}
                  fontWeight={isTonic ? 700 : 400}
                  opacity={isTonic ? 0.9 : 0.65}
                >
                  {label}
                </text>
              </g>
            )
          })}

          {/* X ticks */}
          {xTicks.map(t => {
            const xPx = PAD_X + t * innerW
            return (
              <g key={t}>
                <line
                  x1={xPx} x2={xPx}
                  y1={PAD_Y} y2={PAD_Y + innerH + 6}
                  stroke={gridColor} strokeWidth={1}
                />
                <text
                  x={xPx} y={PAD_Y + innerH + 16}
                  textAnchor="middle" fontSize={9}
                  fill={theme.labelSecondaryColor}
                  fontFamily={theme.fontFamily} opacity={0.6}
                >
                  {Math.round(t * 100)}%
                </text>
              </g>
            )
          })}

          {/* Tonic reference line */}
          {tonicNorm !== null && (
            <line
              x1={PAD_X} x2={W - PAD_X}
              y1={PAD_Y + tonicNorm * innerH}
              y2={PAD_Y + tonicNorm * innerH}
              stroke={`${labelColor(segments[0].index)}66`}
              strokeWidth={2}
            />
          )}

          {/* Border */}
          <rect
            x={PAD_X} y={PAD_Y} width={innerW} height={innerH}
            fill="none" stroke={gridColor} strokeWidth={1}
          />

          {/* Contours — in two-mode, B is DTW-warped onto A's time axis */}
          {(() => {
            return segments.map((seg, i) => {
              const rawVals = i === 0 ? cdA.values : warpedB!
              const norm   = normaliseContour(rawVals, range)
              const line   = contourToPath(norm, W, H, PAD_X, PAD_Y)
              const area   = contourToAreaPath(norm, W, H, PAD_X, PAD_Y)
              const col    = labelColor(seg.index)
              const alpha  = isTwoMode ? (i === 0 ? '18' : '10') : '20'
              const sw     = isTwoMode ? 2.5 : 3

              // Label at start of line
              const startY = PAD_Y + norm[0] * innerH
              const labelSuffix = isTwoMode
                ? (i === 0 ? ` (A)` : ` (B · DTW)`)
                : ''

              return (
                <g key={seg.label}>
                  {area && (
                    <path d={area} fill={`${col}${alpha}`} clipPath="url(#modal-clip)" />
                  )}
                  {line && (
                    <path
                      d={line} fill="none"
                      stroke={col} strokeWidth={sw}
                      strokeLinejoin="round" strokeLinecap="round"
                      clipPath="url(#modal-clip)"
                    />
                  )}
                  <text
                    x={PAD_X + 8} y={startY - 7}
                    fontSize={11} fontWeight={700}
                    fontFamily={theme.fontFamily} fill={col}
                  >
                    {seg.label}{labelSuffix}
                  </text>
                </g>
              )
            })
          })()}
        </svg>

        {/* Footer */}
        <div style={{
          marginTop: 10, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          {isTwoMode && sim ? (() => {
            const color = sim.similarity >= 75 ? '#2DC653'
                        : sim.similarity >= 45 ? '#F4A261'
                        : '#E76F51'
            return (
              <>
                {/* Similarity badge */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: `${color}18`, border: `1px solid ${color}55`,
                  borderRadius: 8, padding: '3px 10px',
                }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: theme.fontFamily }}>
                    {lang === 'zh' ? '旋律轮廓相似度' : 'Contour similarity'}
                  </span>
                  <span style={{ fontSize: 15, fontWeight: 800, color, fontFamily: theme.fontFamily }}>
                    {sim.similarity}%
                  </span>
                </div>
                {/* Mean diff */}
                <span style={{
                  fontSize: 10, color: theme.labelSecondaryColor,
                  fontFamily: theme.fontFamily, opacity: 0.75,
                }}>
                  {lang === 'zh'
                    ? `去调高后旋律轮廓差 ${sim.meanDiff.toFixed(1)} 半音（变调不影响得分）`
                    : `Contour diff after DTW: ${sim.meanDiff.toFixed(1)} st (transposition ignored)`}
                </span>
              </>
            )
          })() : (
            <span style={{
              fontSize: 10, color: theme.labelSecondaryColor,
              fontFamily: theme.fontFamily, opacity: 0.6,
            }}>
              {lang === 'zh' ? '点击背景或按 Esc 关闭' : 'Click backdrop or press Esc to close.'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
