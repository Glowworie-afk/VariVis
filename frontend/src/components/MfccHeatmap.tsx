/**
 * MfccHeatmap
 * ───────────
 * Heatmap: rows = segments, cols = MFCC[0]–[12]
 *
 * Color encoding:
 *   Each column is independently min-max normalized (0→1) across all segments.
 *   0 = cool blue (lowest in this piece), 1 = warm orange (highest in this piece).
 *   This reveals RELATIVE differences between variations per coefficient.
 *
 * Toggle: switch between mfcc_mean and mfcc_std views.
 *
 * MFCC column semantics:
 *   [0] Energy    — log RMS loudness; less-negative = louder
 *   [1] Brightness — spectral tilt; higher = more high-freq energy (brighter)
 *   [2] Mid-band  — whether energy peaks in mid frequencies
 *   [3–12]        — progressively finer spectral texture (less interpretable)
 */

import { useState, useMemo } from 'react'
import type { PieceData } from '../types/features'
import type { ThemeTokens } from '../theme'

// ── Column metadata ───────────────────────────────────────────────────

const N_MFCC = 13

const COL_LABEL: string[] = [
  'Energy', 'Bright', 'Mid',
  '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
]

const COL_DESC: string[] = [
  'MFCC[0] — 对数能量（log energy），反映响度：值越高（越不负）= 越响',
  'MFCC[1] — 频谱倾斜（spectral tilt），高频能量比例：值越高 = 音色越亮',
  'MFCC[2] — 中频平衡，中段是否凸出：正值 = 中频突出',
  'MFCC[3] — 共鸣纹理 1（较难直接解读）',
  'MFCC[4] — 共鸣纹理 2',
  'MFCC[5] — 共鸣纹理 3',
  'MFCC[6] — 精细音色纹理 1',
  'MFCC[7] — 精细音色纹理 2',
  'MFCC[8] — 精细音色纹理 3',
  'MFCC[9] — 精细音色纹理 4',
  'MFCC[10] — 精细音色纹理 5',
  'MFCC[11] — 精细音色纹理 6',
  'MFCC[12] — 最细音色纹理',
]

// ── Color scale ───────────────────────────────────────────────────────
// Diverging: blue (low) → light (mid) → orange-red (high)

function heatColor(t: number): string {
  const c = Math.max(0, Math.min(1, t))
  if (c <= 0.5) {
    const s = c * 2                                   // 0→1: blue→light
    const r = Math.round(72  + s * (248 - 72))
    const g = Math.round(149 + s * (248 - 149))
    const b = Math.round(239 + s * (248 - 239))
    return `rgb(${r},${g},${b})`
  } else {
    const s = (c - 0.5) * 2                           // 0→1: light→orange-red
    const r = Math.round(248 + s * (220 - 248))
    const g = Math.round(248 + s * (80  - 248))
    const b = Math.round(248 + s * (60  - 248))
    return `rgb(${r},${g},${b})`
  }
}

/** Text color that stays readable on both cool and warm backgrounds */
function cellTextColor(t: number): string {
  // Near the extremes use white/dark; near middle use dark
  if (t < 0.2 || t > 0.85) return 'rgba(255,255,255,0.92)'
  return 'rgba(0,0,0,0.75)'
}

// ── Normalization ─────────────────────────────────────────────────────

/**
 * Returns normalizedByCol[colIdx][rowIdx] = 0..1
 * Each column independently min-max normalized across all segments.
 */
function normalizePerColumn(matrix: number[][]): number[][] {
  return Array.from({ length: N_MFCC }, (_, c) => {
    const col = matrix.map(row => row[c])
    const lo  = Math.min(...col)
    const hi  = Math.max(...col)
    const rng = hi - lo
    return rng < 1e-9 ? col.map(() => 0.5) : col.map(v => (v - lo) / rng)
  })
}

// ── Sub-components ────────────────────────────────────────────────────

function ColorLegend() {
  const steps = 40
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'rgba(0,0,0,0.5)' }}>
      <span>低 Low</span>
      <div style={{
        display: 'flex', width: 120, height: 10, borderRadius: 3, overflow: 'hidden',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.08)',
      }}>
        {Array.from({ length: steps }, (_, i) => (
          <div key={i} style={{ flex: 1, background: heatColor(i / (steps - 1)) }} />
        ))}
      </div>
      <span>高 High</span>
      <span style={{ marginLeft: 8, color: 'rgba(0,0,0,0.35)' }}>
        · 每列独立归一化 (per-column min-max)
      </span>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────

type DisplayMode = 'mean' | 'std'

interface Props {
  data:   PieceData
  theme:  ThemeTokens
  isDark: boolean
}

export function MfccHeatmap({ data, theme, isDark }: Props) {
  const [mode, setMode] = useState<DisplayMode>('mean')

  const segments = data.segments

  // Extract raw matrix [segIdx][coefIdx]
  const meanMatrix = useMemo(() =>
    segments.map(s => s.features.mfcc_mean.slice(0, N_MFCC))
  , [segments])

  const stdMatrix = useMemo(() =>
    segments.map(s => s.features.mfcc_std.slice(0, N_MFCC))
  , [segments])

  const matrix      = mode === 'mean' ? meanMatrix : stdMatrix
  const normByCol   = useMemo(() => normalizePerColumn(matrix), [matrix])

  // Cell dimensions
  const CELL_W = 62
  const CELL_H = 30
  const LABEL_W = 36

  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)'
  const headerBg    = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'

  return (
    <div style={{
      padding: '12px 10px 20px',
      display: 'flex', flexDirection: 'column', gap: 12,
      fontFamily: theme.fontFamily,
    }}>

      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>

        <span style={{ fontSize: 12, fontWeight: 700, color: theme.labelColor }}>
          MFCC 热力图
        </span>

        {/* Mode toggle */}
        <div style={{
          display: 'flex', borderRadius: 8, overflow: 'hidden',
          border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.15)'}`,
        }}>
          {(['mean', 'std'] as DisplayMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: '4px 12px', border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: mode === m ? 700 : 400,
                background: mode === m
                  ? (isDark ? '#4361EE' : '#4361EE')
                  : (isDark ? 'rgba(255,255,255,0.05)' : '#fff'),
                color: mode === m ? '#fff' : theme.labelSecondaryColor,
                transition: 'background 0.15s',
              }}
            >
              {m === 'mean' ? '均值 Mean' : '标准差 Std'}
            </button>
          ))}
        </div>

        <span style={{ fontSize: 11, color: theme.labelSecondaryColor }}>
          {mode === 'mean'
            ? '各系数在整段的时间均值'
            : '各系数随时间的波动幅度 — 越大说明这个变奏在该维度上变化越剧烈'}
        </span>
      </div>

      {/* ── Heatmap grid ── */}
      <div style={{ overflowX: 'auto', overflowY: 'visible' }}>
        <table style={{
          borderCollapse: 'separate', borderSpacing: 0,
          fontSize: 10.5, tableLayout: 'fixed',
          minWidth: LABEL_W + N_MFCC * CELL_W,
        }}>

          {/* Column headers */}
          <thead>
            <tr>
              {/* Empty corner */}
              <th style={{
                width: LABEL_W, minWidth: LABEL_W,
                background: headerBg,
                border: `1px solid ${borderColor}`,
                borderRadius: '6px 0 0 0',
                padding: 0,
              }} />

              {Array.from({ length: N_MFCC }, (_, c) => (
                <th
                  key={c}
                  title={COL_DESC[c]}
                  style={{
                    width: CELL_W, minWidth: CELL_W,
                    height: CELL_H + 4,
                    background: headerBg,
                    border: `1px solid ${borderColor}`,
                    borderLeft: 'none',
                    textAlign: 'center',
                    fontWeight: c <= 1 ? 700 : 500,
                    color: c <= 1 ? theme.labelColor : theme.labelSecondaryColor,
                    letterSpacing: '0.02em',
                    cursor: 'help',
                    padding: '0 2px',
                    verticalAlign: 'middle',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    borderRadius: c === N_MFCC - 1 ? '0 6px 0 0' : 0,
                  }}
                >
                  {/* Index badge + label */}
                  <span style={{
                    display: 'inline-block',
                    fontSize: 9, color: 'rgba(150,150,150,0.8)',
                    marginRight: 2, fontWeight: 400,
                  }}>
                    [{c}]
                  </span>
                  {COL_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>

          {/* Data rows */}
          <tbody>
            {segments.map((seg, rowIdx) => (
              <tr key={seg.label}>
                {/* Segment label */}
                <td style={{
                  width: LABEL_W, minWidth: LABEL_W,
                  height: CELL_H,
                  background: headerBg,
                  border: `1px solid ${borderColor}`,
                  borderTop: 'none',
                  textAlign: 'center',
                  fontWeight: 700,
                  fontSize: 11,
                  color: theme.labelColor,
                  verticalAlign: 'middle',
                  padding: 0,
                  borderRadius: rowIdx === segments.length - 1 ? '0 0 0 6px' : 0,
                }}>
                  {seg.label}
                </td>

                {/* MFCC cells */}
                {Array.from({ length: N_MFCC }, (_, colIdx) => {
                  const raw    = matrix[rowIdx][colIdx]
                  const norm   = normByCol[colIdx][rowIdx]
                  const bg     = heatColor(norm)
                  const txtClr = cellTextColor(norm)

                  return (
                    <td
                      key={colIdx}
                      title={`${seg.label} · ${COL_LABEL[colIdx]} (MFCC[${colIdx}])\n原始值: ${raw.toFixed(2)}\n归一化: ${(norm * 100).toFixed(0)}%\n\n${COL_DESC[colIdx]}`}
                      style={{
                        width:  CELL_W,
                        height: CELL_H,
                        background: bg,
                        border: `1px solid ${borderColor}`,
                        borderTop:  'none',
                        borderLeft: 'none',
                        textAlign:  'center',
                        verticalAlign: 'middle',
                        padding: '0 2px',
                        cursor: 'default',
                        transition: 'filter 0.1s',
                        borderRadius:
                          rowIdx === segments.length - 1 && colIdx === N_MFCC - 1
                            ? '0 0 6px 0' : 0,
                      }}
                    >
                      <span style={{
                        fontSize: 9.5,
                        fontWeight: 600,
                        color: txtClr,
                        fontVariantNumeric: 'tabular-nums',
                        letterSpacing: '-0.02em',
                      }}>
                        {raw.toFixed(1)}
                      </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Color legend ── */}
      <ColorLegend />

      {/* ── Column guide ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: '4px 20px',
        padding: '8px 12px',
        borderRadius: 8,
        background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        border: theme.cardBorder,
        fontSize: 10.5,
        color: theme.labelSecondaryColor,
        lineHeight: 1.6,
      }}>
        {COL_DESC.slice(0, 6).map((desc, i) => (
          <div key={i}>
            <span style={{ fontWeight: 700, color: theme.labelColor, marginRight: 4 }}>
              [{i}]
            </span>
            {desc.replace(/^MFCC\[\d+\] — /, '')}
          </div>
        ))}
        <div style={{ color: theme.labelSecondaryColor, fontStyle: 'italic' }}>
          [3–12] 系数依次捕捉频谱更精细的纹理细节，数字越大越难直接解读
        </div>
      </div>
    </div>
  )
}
