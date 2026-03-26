// RhythmBubblePage.tsx
// Bubble timeline — one row per variation, 32 time windows.
//
// Encoding:
//   CIRCLE SIZE    = local RMS energy mean      (loud → big)
//   CIRCLE OPACITY = local onset density /s     (fast → opaque)
//   TEXT IN CIRCLE = onset density value (x.x)  (shown when circle large enough)
//
// Opacity uses per-window onset density (onsets/sec) when onset_count is available
// after re-extraction, otherwise falls back to segment-level average (uniform per row).

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

// ── Layout ───────────────────────────────────────────────────────────

const TIMELINE_W = 700
const RIGHT_W    = 130
const ROW_H      = 74
const ROW_GAP    = 8
const LABEL_W    = 42
const PAD_TOP    = 36
const PAD_BOT    = 20
const PAD_H      = 14

const MAX_R      = 26
const N_BUBBLES  = 32
const N_FRAMES   = 64

const SVG_W = PAD_H + LABEL_W + TIMELINE_W + RIGHT_W + PAD_H

// ── Data helpers ─────────────────────────────────────────────────────

interface BubbleData {
  meanRms:      number
  onsetDensity: number   // onsets/sec for this window (primary opacity driver)
  deltaRms:     number   // fallback when onset_count absent
}

function computeBubbles(
  rms: number[],
  onsetCount?: number[],
  windowDurSec = 1,
): BubbleData[] {
  const framesPerBin = N_FRAMES / N_BUBBLES
  return Array.from({ length: N_BUBBLES }, (_, i) => {
    const start = Math.floor(i * framesPerBin)
    const end   = Math.floor((i + 1) * framesPerBin)
    const slice = rms.slice(start, end)
    const mean  = slice.reduce((a, b) => a + b, 0) / (slice.length || 1)
    const delta = Math.abs(rms[end - 1] - rms[start])
    const oc    = onsetCount
      ? onsetCount.slice(start, end).reduce((a, b) => a + b, 0)
      : 0
    const od    = windowDurSec > 0 && onsetCount ? oc / windowDurSec : 0
    return { meanRms: mean, deltaRms: delta, onsetDensity: od }
  })
}

// ── Color helpers ────────────────────────────────────────────────────

function rowHue(label: string, rowIdx: number, numRows: number): number | null {
  if (!label.startsWith('V')) return null
  return Math.round((rowIdx / numRows) * 300)
}

// ── Tooltip ──────────────────────────────────────────────────────────

interface TooltipInfo {
  segLabel:        string
  binIdx:          number
  meanRms:         number
  onsetDensityWin: number
  windowDurSec:    number
  onsetDensity:    number
  timePct:         number
  hasOnsetData:    boolean
  svgX:            number
  svgY:            number
}

// ── Component ────────────────────────────────────────────────────────

export function RhythmBubblePage({ data, theme, isDark, lang }: Props) {
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null)

  const segments    = data.segments
  const numRows     = segments.length
  const svgH        = PAD_TOP + numRows * (ROW_H + ROW_GAP) - ROW_GAP + PAD_BOT

  const hasOnsetData = segments.some(
    s => (s.features.compressed.onset_count?.length ?? 0) > 0
  )

  const allBubbles = segments.map(s => {
    const segDur = s.duration_sec ?? 0
    const winDur = segDur > 0 ? segDur / N_BUBBLES : 1
    return computeBubbles(s.features.compressed.rms, s.features.compressed.onset_count, winDur)
  })

  // Size: global max RMS
  const globalMaxRms = Math.max(
    ...allBubbles.flatMap(bb => bb.map(b => b.meanRms)), 0.001,
  )

  // Opacity uses an absolute scale anchored at 10 onsets/sec:
  //   <1/s  → nearly invisible (~0.04–0.10)
  //   5/s   → mid  (~0.50)
  //   ≥10/s → nearly opaque (capped at 0.92)
  // This gives large visual contrast across the 1–8/s range present in the data.
  const densityToOpacity = (d: number) => Math.min(0.92, Math.max(0.04, d / 10))

  // For the |ΔRMS| fallback, keep relative normalisation since |ΔRMS| has no
  // intuitive absolute unit — just map it to the same [0.04, 0.92] range.
  const globalMaxDelta = hasOnsetData
    ? 1   // unused
    : Math.max(...allBubbles.flatMap(bb => bb.map(b => b.deltaRms)), 0.001)
  const deltaToOpacity = (d: number) =>
    Math.min(0.92, Math.max(0.04, (d / globalMaxDelta) * 0.88))

  // Right-side density bar
  const allDensities = segments.map(s => s.features.onset_density)
  const minDensity   = Math.min(...allDensities)
  const maxDensity   = Math.max(...allDensities)
  const normDensity  = (d: number) =>
    maxDensity === minDensity ? 0.5 : (d - minDensity) / (maxDensity - minDensity)

  const timeTicks = [0, 0.25, 0.5, 0.75, 1.0]
  const tickLabel = (pct: number) => {
    if (pct === 0)   return lang === 'zh' ? '起' : 'S'
    if (pct === 1.0) return lang === 'zh' ? '终' : 'E'
    return `${Math.round(pct * 100)}%`
  }

  return (
    <div style={{ fontFamily: theme.fontFamily }}>

      {/* ── Title ── */}
      <div style={{
        display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8,
        padding: '8px 14px 4px',
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: theme.labelColor }}>
          {lang === 'zh' ? '节奏气泡 · Rhythm Bubbles' : 'Rhythm Bubbles'}
        </span>
        <span style={{ fontSize: 10, color: theme.labelSecondaryColor }}>
          {lang === 'zh'
            ? `大小 = 局部响度（RMS） · 透明度 = 局部起音密度（次/秒）${hasOnsetData ? ' · 数字 = 该窗口密度值' : ''}`
            : `Size = local RMS · Opacity = local onset density${hasOnsetData ? ' · Number = window density' : ''}`}
        </span>
      </div>

      {/* ── Re-extract banner ── */}
      {!hasOnsetData && (
        <div style={{
          margin: '0 14px 6px',
          padding: '4px 10px', borderRadius: 6,
          background: isDark ? 'rgba(255,200,0,0.10)' : 'rgba(200,150,0,0.10)',
          border: '1px solid rgba(200,150,0,0.25)',
          fontSize: 9.5, color: isDark ? '#f0c040' : '#886000',
        }}>
          {lang === 'zh'
            ? 'ⓘ 当前透明度使用 |ΔRMS| 代理，圆内数字不可用。点击「提取」重新提取后显示精确起音密度。'
            : 'ⓘ Opacity uses |ΔRMS| proxy; in-circle numbers unavailable. Re-extract to show exact onset density.'}
        </div>
      )}

      {/* ── SVG ── */}
      <svg
        width={SVG_W}
        height={svgH}
        style={{ display: 'block', overflow: 'visible' }}
        onMouseLeave={() => setTooltip(null)}
      >

        {/* X-axis guides */}
        {timeTicks.map(pct => {
          const x      = PAD_H + LABEL_W + pct * TIMELINE_W
          const bottom = PAD_TOP + numRows * (ROW_H + ROW_GAP) - ROW_GAP
          return (
            <g key={pct}>
              <line
                x1={x} y1={PAD_TOP - 6} x2={x} y2={bottom}
                stroke={theme.labelSecondaryColor}
                strokeWidth={0.5}
                strokeDasharray={pct === 0 || pct === 1.0 ? 'none' : '2,3'}
                opacity={0.18}
              />
              <text x={x} y={PAD_TOP - 9} textAnchor="middle" fontSize={8}
                fill={theme.labelSecondaryColor} opacity={0.75}>
                {tickLabel(pct)}
              </text>
            </g>
          )
        })}

        {/* Right column header */}
        <text
          x={PAD_H + LABEL_W + TIMELINE_W + 8} y={PAD_TOP - 9}
          fontSize={8} fill={theme.labelSecondaryColor} opacity={0.7}
        >
          {lang === 'zh' ? '段均密度' : 'Avg density'}
        </text>

        {/* ── Rows ── */}
        {segments.map((seg, rowIdx) => {
          const bubbles  = allBubbles[rowIdx]
          const hue      = rowHue(seg.label, rowIdx, numRows)
          const isVar    = seg.label.startsWith('V')
          const rowCY    = PAD_TOP + rowIdx * (ROW_H + ROW_GAP) + ROW_H / 2
          const density  = seg.features.onset_density
          const dnorm    = normDensity(density)
          const segDur   = seg.duration_sec ?? 0
          const winDur   = segDur > 0 ? segDur / N_BUBBLES : 1

          const fillColor   = hue !== null ? `hsl(${hue},68%,56%)` : 'rgb(140,140,152)'
          const strokeColor = hue !== null
            ? `hsla(${hue},68%,${isDark ? 70 : 34}%,0.35)`
            : `rgba(${isDark ? '200,200,210' : '90,90,104'},0.35)`
          // Text color: light on dark bubble, dark on light bubble
          const textColor = isDark
            ? 'rgba(255,255,255,0.92)'
            : (hue !== null ? `hsl(${hue},70%,18%)` : 'rgba(0,0,0,0.75)')

          // Without onset_count: opacity is uniform per row (segment average)
          const segOpacity = hasOnsetData
            ? null   // per-bubble: computed below
            : densityToOpacity(density)   // fallback: uniform per row using segment avg

          return (
            <g key={seg.label}>

              {/* Center axis */}
              <line
                x1={PAD_H + LABEL_W} y1={rowCY}
                x2={PAD_H + LABEL_W + TIMELINE_W} y2={rowCY}
                stroke={isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)'}
                strokeWidth={1}
              />

              {/* Row label */}
              <text
                x={PAD_H + LABEL_W - 6} y={rowCY + 4}
                textAnchor="end"
                fontSize={isVar ? 10 : 9}
                fontWeight={isVar ? 600 : 400}
                fill={isVar ? theme.labelColor : theme.labelSecondaryColor}
              >
                {seg.label}
              </text>

              {/* Bubbles */}
              {bubbles.map((b, bi) => {
                const r = Math.sqrt(b.meanRms / globalMaxRms) * MAX_R
                if (r < 1.2) return null

                const cx = PAD_H + LABEL_W + ((bi + 0.5) / N_BUBBLES) * TIMELINE_W

                const opacity = segOpacity !== null
                  ? segOpacity
                  : hasOnsetData
                    ? densityToOpacity(b.onsetDensity)
                    : deltaToOpacity(b.deltaRms)

                // Density label inside circle — only when circle is large enough
                const labelVal  = hasOnsetData ? b.onsetDensity : null
                const showLabel = labelVal !== null && r >= 9
                const labelStr  = labelVal !== null
                  ? (labelVal < 10 ? labelVal.toFixed(1) : Math.round(labelVal).toString())
                  : ''
                const labelSize = Math.max(6, Math.min(10, r * 0.52))

                return (
                  <g
                    key={bi}
                    onMouseEnter={e => {
                      const svg = (e.target as SVGElement).closest('svg')!
                      const br  = svg.getBoundingClientRect()
                      setTooltip({
                        segLabel:        seg.label,
                        binIdx:          bi + 1,
                        meanRms:         Math.round(b.meanRms * 10000) / 10000,
                        onsetDensityWin: Math.round(b.onsetDensity * 10) / 10,
                        windowDurSec:    Math.round(winDur * 100) / 100,
                        onsetDensity:    Math.round(density * 100) / 100,
                        timePct:         Math.round((bi / N_BUBBLES) * 100),
                        hasOnsetData,
                        svgX: e.clientX - br.left,
                        svgY: e.clientY - br.top,
                      })
                    }}
                    onMouseLeave={() => setTooltip(null)}
                    style={{ cursor: 'crosshair' }}
                  >
                    <circle
                      cx={cx} cy={rowCY} r={r}
                      fill={fillColor}
                      fillOpacity={opacity}
                      stroke={strokeColor}
                      strokeWidth={0.7}
                    />

                    {showLabel && (
                      <text
                        x={cx} y={rowCY + labelSize * 0.36}
                        textAnchor="middle"
                        fontSize={labelSize}
                        fontWeight={600}
                        fill={textColor}
                        fillOpacity={Math.min(1, opacity + 0.3)}
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                      >
                        {labelStr}
                      </text>
                    )}
                  </g>
                )
              })}

              {/* Right: segment avg density bar */}
              <rect
                x={PAD_H + LABEL_W + TIMELINE_W + 8} y={rowCY - 3}
                width={80} height={6}
                fill={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}
                rx={3}
              />
              <rect
                x={PAD_H + LABEL_W + TIMELINE_W + 8} y={rowCY - 3}
                width={dnorm * 80} height={6}
                fill={hue !== null ? `hsla(${hue},68%,56%,0.80)` : 'rgba(140,140,152,0.80)'}
                rx={3}
              />
              <text
                x={PAD_H + LABEL_W + TIMELINE_W + 8 + 84} y={rowCY + 4}
                fontSize={9} fontWeight={600} fill={theme.labelColor}
              >
                {density.toFixed(1)}/s
              </text>

            </g>
          )
        })}

        {/* ── Tooltip ── */}
        {tooltip && (() => {
          const TW = 220, TH = tooltip.hasOnsetData ? 56 : 44
          const tx = Math.min(tooltip.svgX + 12, SVG_W - TW - 4)
          const ty = Math.max(tooltip.svgY - TH - 8, 4)

          const l1 = lang === 'zh'
            ? `${tooltip.segLabel} · 窗口 ${tooltip.binIdx}/${N_BUBBLES}（~${tooltip.timePct}%）`
            : `${tooltip.segLabel} · Window ${tooltip.binIdx}/${N_BUBBLES} (~${tooltip.timePct}%)`
          const l2 = lang === 'zh'
            ? `响度（RMS均值）= ${tooltip.meanRms}`
            : `Loudness (RMS mean) = ${tooltip.meanRms}`
          const l3 = tooltip.hasOnsetData
            ? (lang === 'zh'
                ? `局部起音密度 = ${tooltip.onsetDensityWin} 次/秒（窗口 ${tooltip.windowDurSec}s）`
                : `Local onset density = ${tooltip.onsetDensityWin}/s (window ${tooltip.windowDurSec}s)`)
            : null
          const l4 = lang === 'zh'
            ? `段均起音密度 = ${tooltip.onsetDensity}/s`
            : `Segment avg density = ${tooltip.onsetDensity}/s`

          return (
            <g style={{ pointerEvents: 'none' }}>
              <rect
                x={tx - 4} y={ty - 14} width={TW} height={TH}
                fill={isDark ? '#1c1c2a' : '#ffffff'}
                stroke={isDark ? '#44445a' : '#d0d0d0'}
                strokeWidth={0.8} rx={5} opacity={0.97}
              />
              <text x={tx} y={ty}      fontSize={9} fontWeight={700} fill={theme.labelColor}>{l1}</text>
              <text x={tx} y={ty + 14} fontSize={9} fill={theme.labelColor}>{l2}</text>
              {l3 && <text x={tx} y={ty + 27} fontSize={9} fill={theme.labelColor}>{l3}</text>}
              <text x={tx} y={l3 ? ty + 40 : ty + 27} fontSize={9} fill={theme.labelSecondaryColor}>{l4}</text>
            </g>
          )
        })()}

      </svg>

      {/* ── Legend ── */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 20,
        padding: '6px 16px 14px',
        fontSize: 9, color: theme.labelSecondaryColor,
      }}>

        {/* Size */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width={86} height={24} style={{ overflow: 'visible' }}>
            {([5, 10, 16, 23] as number[]).map((r, i) => (
              <circle key={i}
                cx={[5,16,30,52][i]} cy={12} r={r}
                fill="rgba(120,120,135,0.55)"
                stroke="rgba(120,120,135,0.4)" strokeWidth={0.7}
              />
            ))}
          </svg>
          <span>{lang === 'zh' ? '大小 = 响度（RMS）' : 'Size = loudness (RMS)'}</span>
        </div>

        {/* Opacity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width={100} height={24} style={{ overflow: 'visible' }}>
            {([0.18, 0.38, 0.60, 0.86] as number[]).map((op, i) => (
              <circle key={i}
                cx={[10, 36, 64, 92][i]} cy={12} r={11}
                fill={`rgba(67,97,238,${op})`}
                stroke={`rgba(67,97,238,0.35)`} strokeWidth={0.7}
              />
            ))}
          </svg>
          <span>
            {hasOnsetData
              ? (lang === 'zh' ? '透明度 = 局部起音密度（次/秒）' : 'Opacity = local onset density')
              : (lang === 'zh' ? '透明度 = 段均起音密度（|ΔRMS| 代理）' : 'Opacity = segment avg density (|ΔRMS| proxy)')}
          </span>
        </div>

        {/* Reading guide */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 2,
          padding: '2px 8px', borderRadius: 4,
          background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
          fontSize: 8, lineHeight: 1.6,
        }}>
          {lang === 'zh' ? (
            <>
              <span>大圆 + 深色 = 响且快</span>
              <span>大圆 + 浅色 = 响但慢（长音）</span>
              <span>小圆 + 深色 = 轻但快</span>
            </>
          ) : (
            <>
              <span>Large + opaque = loud &amp; fast</span>
              <span>Large + faded = loud but slow (sustained)</span>
              <span>Small + opaque = soft but fast</span>
            </>
          )}
        </div>

      </div>
    </div>
  )
}
