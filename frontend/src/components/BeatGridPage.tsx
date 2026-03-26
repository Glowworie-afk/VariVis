// BeatGridPage.tsx
// Beat Grid / Onset Scatter — one row per variation, horizontal = beat position,
// cell color encodes pitch height relative to tonic (blue = low, red = high).

import { useState } from 'react'
import type { PieceData } from '../types/features'
import type { getTheme } from '../theme'
import type { Lang } from '../App'

interface Props {
  data:   PieceData
  theme:  ReturnType<typeof getTheme>
  isDark: boolean
  lang:   Lang
}

// ── Color helpers ────────────────────────────────────────────────────

function lerpRgb(
  c1: [number, number, number],
  c2: [number, number, number],
  t: number,
): string {
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * t)
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * t)
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * t)
  return `rgb(${r},${g},${b})`
}

function pitchColor(rel: number, isDark: boolean): string {
  const clamped = Math.max(-24, Math.min(24, rel))
  // Neutral = near-tonic (0 semitones)
  const neutral: [number, number, number] = isDark ? [52, 52, 60] : [235, 235, 228]
  if (clamped >= 0) {
    // 0..+24 → neutral → red-orange (higher pitch)
    const t = clamped / 24
    return lerpRgb(neutral, [215, 48, 39], t)
  } else {
    // -24..0 → deep blue (lower pitch) → neutral
    const t = -clamped / 24
    return lerpRgb(neutral, [67, 147, 195], t)
  }
}

// ── Layout ───────────────────────────────────────────────────────────

const GRID_W  = 660   // width of the beat-cell area
const ROW_H   = 22    // height per variation row (px)
const ROW_GAP = 5     // gap between rows (px)
const LABEL_W = 42    // left label column width (px)
const RIGHT_W = 148   // right stats column width (px)
const PAD_TOP = 38    // space above first row (for x-axis)
const PAD_BOT = 20    // space below last row
const PAD_H   = 14    // horizontal outer padding

const SVG_W = PAD_H + LABEL_W + GRID_W + RIGHT_W + PAD_H

// Onset-density → circle radius for the density bar on the right
const MAX_DENSITY = 10  // notes/sec upper bound for scale

// ── Tooltip data shape ───────────────────────────────────────────────

interface TooltipInfo {
  segLabel:   string
  beatIdx:    number   // 1-indexed
  midiAbs:    number
  midiRel:    number
  svgX:       number
  svgY:       number
}

// ── Component ────────────────────────────────────────────────────────

export function BeatGridPage({ data, theme, isDark, lang }: Props) {
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null)

  const segments = data.segments

  const hasAnyPitch = segments.some(
    s => (s.features.pitch_contour?.beat_midi_relative?.length ?? 0) > 0,
  )

  if (!hasAnyPitch) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: 200, color: theme.labelSecondaryColor, fontSize: 12,
        padding: 24, textAlign: 'center',
      }}>
        {lang === 'zh'
          ? '节拍网格需要 pYIN 音高数据。请先运行 add_pitch_contour.py 生成 pitch_contour 字段。'
          : 'Beat Grid requires pYIN pitch data. Run add_pitch_contour.py to generate the pitch_contour field.'}
      </div>
    )
  }

  const numRows = segments.length
  const svgH    = PAD_TOP + numRows * (ROW_H + ROW_GAP) - ROW_GAP + PAD_BOT

  // Proportional x-axis tick positions (0%, 25%, 50%, 75%, 100%)
  const pctTicks = [0, 0.25, 0.5, 0.75, 1.0]

  // Extract tonic name from first segment with pitch_contour
  const tonicName = segments.find(s => s.features.pitch_contour?.tonic_name)
    ?.features.pitch_contour?.tonic_name ?? ''

  const tickLabel = (pct: number) => {
    if (pct === 0)   return lang === 'zh' ? '起' : 'Start'
    if (pct === 1.0) return lang === 'zh' ? '终' : 'End'
    return `${Math.round(pct * 100)}%`
  }

  return (
    <div style={{ position: 'relative', fontFamily: theme.fontFamily }}>

      {/* ── Title bar ── */}
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10,
        padding: '8px 14px 4px',
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: theme.labelColor }}>
          {lang === 'zh' ? '节拍网格 · Beat Grid' : 'Beat Grid'}
        </span>
        <span style={{ fontSize: 10, color: theme.labelSecondaryColor }}>
          {lang === 'zh'
            ? '每格 = 一拍 · 颜色 = 音高（蓝色低于主音，红色高于主音）· 格宽反映速度密度'
            : 'Each cell = one beat · Color = pitch (blue below tonic, red above) · Cell width reflects tempo density'}
        </span>
      </div>

      {/* ── Main SVG ── */}
      <svg
        width={SVG_W}
        height={svgH}
        style={{ display: 'block', overflow: 'visible' }}
        onMouseLeave={() => setTooltip(null)}
      >

        {/* ── X-axis percentage ticks ── */}
        {pctTicks.map(pct => {
          const x = PAD_H + LABEL_W + pct * GRID_W
          return (
            <g key={pct}>
              <line
                x1={x} y1={PAD_TOP - 5}
                x2={x} y2={PAD_TOP + numRows * (ROW_H + ROW_GAP) - ROW_GAP}
                stroke={theme.labelSecondaryColor}
                strokeWidth={0.5}
                strokeDasharray={pct === 0 || pct === 1.0 ? 'none' : '2,2'}
                opacity={0.25}
              />
              <text
                x={x} y={PAD_TOP - 8}
                textAnchor="middle" fontSize={8}
                fill={theme.labelSecondaryColor} opacity={0.75}
              >
                {tickLabel(pct)}
              </text>
            </g>
          )
        })}

        {/* ── Column headers (right side) ── */}
        <text
          x={PAD_H + LABEL_W + GRID_W + 8}
          y={PAD_TOP - 8}
          fontSize={8}
          fill={theme.labelSecondaryColor}
          opacity={0.7}
        >
          {lang === 'zh' ? '密度/速度' : 'Density/Tempo'}
        </text>

        {/* ── Rows ── */}
        {segments.map((seg, rowIdx) => {
          const pc        = seg.features.pitch_contour
          const beatRel   = pc?.beat_midi_relative ?? []
          const beatAbs   = pc?.beat_midi          ?? []
          const numBeats  = beatRel.length
          const cellW     = numBeats > 0 ? GRID_W / numBeats : 0

          const rowY      = PAD_TOP + rowIdx * (ROW_H + ROW_GAP)
          const isVar     = seg.label.startsWith('V')
          const labelClr  = isVar ? theme.labelColor : theme.labelSecondaryColor

          // Onset density gauge (0..MAX_DENSITY → bar width 0..60px)
          const densityW  = Math.min(seg.features.onset_density / MAX_DENSITY, 1) * 60
          const densityHue= Math.round(
            120 - (seg.features.onset_density / MAX_DENSITY) * 120,
          )  // green → yellow → red

          const beatCountLabel = numBeats > 0
            ? (lang === 'zh' ? ` · ${numBeats}拍` : ` · ${numBeats}b`)
            : ''

          return (
            <g key={seg.label}>

              {/* Row background */}
              <rect
                x={PAD_H + LABEL_W} y={rowY}
                width={GRID_W} height={ROW_H}
                fill={isDark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.018)'}
                rx={2}
              />

              {/* Variation label */}
              <text
                x={PAD_H + LABEL_W - 6}
                y={rowY + ROW_H / 2 + 4}
                textAnchor="end"
                fontSize={isVar ? 10 : 9}
                fontWeight={isVar ? 600 : 400}
                fill={labelClr}
              >
                {seg.label}
              </text>

              {/* Beat cells */}
              {numBeats > 0 && beatRel.map((rel, bi) => {
                if (rel === null || rel === undefined) return null
                const cx = PAD_H + LABEL_W + bi * cellW
                return (
                  <rect
                    key={bi}
                    x={cx} y={rowY}
                    width={Math.max(cellW - 0.4, 0.4)}
                    height={ROW_H}
                    fill={pitchColor(rel, isDark)}
                    rx={cellW > 4 ? 1 : 0}
                    onMouseEnter={e => {
                      const svg = (e.target as SVGElement).ownerSVGElement!
                      const br  = svg.getBoundingClientRect()
                      setTooltip({
                        segLabel: seg.label,
                        beatIdx:  bi + 1,
                        midiAbs:  Math.round(beatAbs[bi] ?? 0),
                        midiRel:  Math.round(rel * 10) / 10,
                        svgX:     e.clientX - br.left,
                        svgY:     e.clientY - br.top,
                      })
                    }}
                    onMouseLeave={() => setTooltip(null)}
                    style={{ cursor: 'crosshair' }}
                  />
                )
              })}

              {/* No pitch data */}
              {numBeats === 0 && (
                <text
                  x={PAD_H + LABEL_W + 8} y={rowY + ROW_H / 2 + 4}
                  fontSize={9} fill={theme.labelSecondaryColor} opacity={0.4}
                >
                  —
                </text>
              )}

              {/* Right: onset density mini-bar */}
              <rect
                x={PAD_H + LABEL_W + GRID_W + 8}
                y={rowY + ROW_H / 2 - 3}
                width={densityW}
                height={6}
                fill={`hsl(${densityHue},70%,55%)`}
                rx={3}
                opacity={0.85}
              />
              <text
                x={PAD_H + LABEL_W + GRID_W + 8 + 64}
                y={rowY + 10}
                fontSize={9} fontWeight={600}
                fill={theme.labelColor}
              >
                {seg.features.onset_density.toFixed(1)}/s
              </text>
              <text
                x={PAD_H + LABEL_W + GRID_W + 8 + 64}
                y={rowY + 20}
                fontSize={8}
                fill={theme.labelSecondaryColor}
              >
                {Math.round(seg.features.tempo)} bpm{beatCountLabel}
              </text>

            </g>
          )
        })}

        {/* ── Hover Tooltip ── */}
        {tooltip && (() => {
          const TW = 168, TH = 46
          const tx = Math.min(tooltip.svgX + 10, SVG_W - TW - 4)
          const ty = Math.max(tooltip.svgY - TH - 6, 4)

          let noteDir: string
          if (lang === 'zh') {
            noteDir = tooltip.midiRel > 0
              ? `↑ 高于主音 ${tooltip.midiRel} 半音`
              : tooltip.midiRel < 0
                ? `↓ 低于主音 ${Math.abs(tooltip.midiRel)} 半音`
                : `= 主音 (${tonicName})`
          } else {
            noteDir = tooltip.midiRel > 0
              ? `↑ ${tooltip.midiRel} st above tonic`
              : tooltip.midiRel < 0
                ? `↓ ${Math.abs(tooltip.midiRel)} st below tonic`
                : `= tonic (${tonicName})`
          }

          const beatLabel = lang === 'zh'
            ? `${tooltip.segLabel} · 第 ${tooltip.beatIdx} 拍`
            : `${tooltip.segLabel} · Beat ${tooltip.beatIdx}`

          return (
            <g style={{ pointerEvents: 'none' }}>
              <rect
                x={tx - 4} y={ty - 14}
                width={TW} height={TH}
                fill={isDark ? '#1c1c2a' : '#ffffff'}
                stroke={isDark ? '#44445a' : '#d0d0d0'}
                strokeWidth={0.8} rx={5} opacity={0.96}
              />
              <text x={tx} y={ty} fontSize={9} fontWeight={700} fill={theme.labelColor}>
                {beatLabel}
              </text>
              <text x={tx} y={ty + 13} fontSize={9} fill={theme.labelColor}>
                MIDI {tooltip.midiAbs}
              </text>
              <text x={tx} y={ty + 26} fontSize={9} fill={theme.labelSecondaryColor}>
                {noteDir}
              </text>
            </g>
          )
        })()}
      </svg>

      {/* ── Color legend ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 14px 10px',
        fontSize: 9, color: theme.labelSecondaryColor,
      }}>
        <span style={{ whiteSpace: 'nowrap' }}>
          {lang === 'zh' ? '低（−2 oct）' : 'Low (−2 oct)'}
        </span>
        <div style={{
          width: 140, height: 9, borderRadius: 4, flexShrink: 0,
          background: `linear-gradient(to right,
            ${pitchColor(-24, isDark)},
            ${pitchColor(-12, isDark)},
            ${pitchColor(0,   isDark)},
            ${pitchColor(12,  isDark)},
            ${pitchColor(24,  isDark)})`,
        }} />
        <span style={{ whiteSpace: 'nowrap' }}>
          {lang === 'zh' ? '高（+2 oct）' : 'High (+2 oct)'}
        </span>

        {/* Center marker */}
        <span style={{
          marginLeft: 6,
          padding: '1px 6px', borderRadius: 4,
          background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
        }}>
          {lang === 'zh'
            ? `中央 = 主音${tonicName ? ` (${tonicName})` : ''}`
            : `Center = tonic${tonicName ? ` (${tonicName})` : ''}`}
        </span>

        {/* Density legend */}
        <span style={{ marginLeft: 16, whiteSpace: 'nowrap' }}>
          {lang === 'zh' ? '密度条：' : 'Density:'}
        </span>
        <div style={{
          width: 60, height: 6, borderRadius: 3,
          background: 'linear-gradient(to right, hsl(120,70%,55%), hsl(60,70%,55%), hsl(0,70%,55%))',
        }} />
        <span style={{ whiteSpace: 'nowrap' }}>
          {lang === 'zh' ? '稀疏 → 密集' : 'Sparse → Dense'}
        </span>
      </div>

    </div>
  )
}
