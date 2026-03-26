/**
 * DTWPathPage
 * ───────────
 * DTW alignment path visualization.
 *
 * Select two segments A and B; shows the 2D accumulated-cost-matrix heatmap
 * with the optimal warping path overlaid.
 *
 * Reading the path:
 *  • Mostly diagonal  → A and B have similar pacing
 *  • Long horizontal  → A has a passage mapped to few B frames (A is "stretched")
 *  • Long vertical    → B has a passage mapped to few A frames (B is "stretched")
 *
 * Example: if T has 18 frames and V9 has 80 downsampled frames, a long vertical
 * run in the path reveals exactly where V9 expands a short T phrase into many bars.
 */

import { useState, useMemo, useRef, useEffect } from 'react'
import type { PieceData } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import { getContourData } from '../utils/pitchContour'

// ── Constants ──────────────────────────────────────────────────────────

const MAX_FRAMES = 80   // downsample long sequences to keep canvas snappy
const VIS_SIZE   = 340  // square canvas in pixels

// ── Helpers ────────────────────────────────────────────────────────────

function downsample(arr: number[], n: number): number[] {
  if (arr.length <= n) return arr
  const result: number[] = []
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * arr.length / n)
    const e = Math.floor((i + 1) * arr.length / n)
    let sum = 0
    for (let j = s; j < e; j++) sum += arr[j]
    result.push(sum / (e - s))
  }
  return result
}

/**
 * Viridis-inspired colormap.
 * t=0 → dark purple (high accumulated cost / different)
 * t=1 → bright yellow (low accumulated cost / similar)
 */
function viridis(t: number): string {
  // Key stops: dark purple → blue → teal → green → yellow
  const stops: [number, number, number][] = [
    [68,  1,  84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201,  98],
    [253, 231,  37],
  ]
  const pos = t * (stops.length - 1)
  const i   = Math.min(Math.floor(pos), stops.length - 2)
  const f   = pos - i
  const [r0, g0, b0] = stops[i]
  const [r1, g1, b1] = stops[i + 1]
  return `rgb(${Math.round(r0 + f * (r1 - r0))},${Math.round(g0 + f * (g1 - g0))},${Math.round(b0 + f * (b1 - b0))})`
}

/**
 * Compute full DTW accumulated-cost matrix + backtrack path.
 * Works on already-downsampled sequences (≤ MAX_FRAMES each).
 */
function computeDTW(a: number[], b: number[]): {
  dp:   number[][]           // accumulated cost matrix [n][m]
  path: [number, number][]   // optimal path from (0,0) to (n-1,m-1)
} {
  const n = a.length, m = b.length
  const dp: number[][] = Array.from({ length: n }, () => new Array(m).fill(Infinity))

  dp[0][0] = Math.abs(a[0] - b[0])
  for (let i = 1; i < n; i++) dp[i][0] = dp[i - 1][0] + Math.abs(a[i] - b[0])
  for (let j = 1; j < m; j++) dp[0][j] = dp[0][j - 1] + Math.abs(a[0] - b[j])
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < m; j++) {
      dp[i][j] = Math.abs(a[i] - b[j]) +
        Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Backtrack
  const path: [number, number][] = []
  let i = n - 1, j = m - 1
  path.push([i, j])
  while (i > 0 || j > 0) {
    if (i === 0)      { j-- }
    else if (j === 0) { i-- }
    else {
      const best = Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
      if      (best === dp[i - 1][j - 1]) { i--; j-- }
      else if (best === dp[i - 1][j])     { i-- }
      else                                 { j-- }
    }
    path.push([i, j])
  }
  path.reverse()
  return { dp, path }
}

// ── Component ──────────────────────────────────────────────────────────

interface Props {
  data:   PieceData
  theme:  ThemeTokens
  isDark: boolean
  lang:   Lang
}

export function DTWPathPage({ data, theme, isDark, lang }: Props) {
  const segments = data.segments
  const [idxA, setIdxA] = useState(0)
  const [idxB, setIdxB] = useState(Math.min(1, segments.length - 1))
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const T = (zh: string, en: string) => lang === 'zh' ? zh : en

  // ── Compute DTW ──────────────────────────────────────────────────────

  const { dp, path, seqA, seqB } = useMemo(() => {
    const cdA = getContourData(segments[idxA])
    const cdB = getContourData(segments[idxB])
    const seqA = downsample(cdA.values, MAX_FRAMES)
    const seqB = downsample(cdB.values, MAX_FRAMES)
    const { dp, path } = computeDTW(seqA, seqB)
    return { dp, path, seqA, seqB }
  }, [idxA, idxB, segments])

  const n = seqA.length
  const m = seqB.length

  // ── Normalise cost matrix for heatmap ────────────────────────────────

  const normMatrix = useMemo(() => {
    let maxV = 0
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        if (dp[i][j] < Infinity && dp[i][j] > maxV) maxV = dp[i][j]
      }
    }
    // Invert: low cost → high t (bright yellow), high cost → low t (dark purple)
    return dp.map(row => row.map(v => v === Infinity ? 0 : 1 - v / maxV))
  }, [dp, n, m])

  // ── Draw heatmap on canvas ───────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const ratio = window.devicePixelRatio || 1
    canvas.width  = VIS_SIZE * ratio
    canvas.height = VIS_SIZE * ratio
    ctx.scale(ratio, ratio)
    canvas.style.width  = `${VIS_SIZE}px`
    canvas.style.height = `${VIS_SIZE}px`

    const cellW = VIS_SIZE / n
    const cellH = VIS_SIZE / m

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        ctx.fillStyle = viridis(normMatrix[i][j])
        // Note: SVG y=0 is top; j=0 = B frame 0 should be at bottom of canvas
        ctx.fillRect(i * cellW, (m - 1 - j) * cellH, cellW + 0.5, cellH + 0.5)
      }
    }
  }, [normMatrix, n, m])

  // ── Path as SVG polyline ─────────────────────────────────────────────

  const cellW = VIS_SIZE / n
  const cellH = VIS_SIZE / m

  const pathPoints = path
    .map(([pi, pj]) => {
      const x = (pi + 0.5) * cellW
      const y = VIS_SIZE - (pj + 0.5) * cellH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  // Diagonal reference (from bottom-left to top-right)
  const diagStart = `0,${VIS_SIZE}`
  const diagEnd   = `${VIS_SIZE},0`

  // ── Normalised distance ──────────────────────────────────────────────

  const rawDist  = dp[n - 1][m - 1]
  const normDist = rawDist / (n + m)   // normalised by diagonal length

  const labA = segments[idxA].label
  const labB = segments[idxB].label

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '8px 4px', fontFamily: theme.fontFamily }}>

      {/* ── Selector row ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#4CC9F0', fontWeight: 700 }}>A:</span>
          <select
            value={idxA}
            onChange={e => setIdxA(Number(e.target.value))}
            style={{
              padding: '4px 8px', borderRadius: 6, border: theme.cardBorder,
              background: theme.cardBg, color: theme.labelColor,
              fontFamily: theme.fontFamily, fontSize: 12, cursor: 'pointer',
            }}
          >
            {segments.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#F4A261', fontWeight: 700 }}>B:</span>
          <select
            value={idxB}
            onChange={e => setIdxB(Number(e.target.value))}
            style={{
              padding: '4px 8px', borderRadius: 6, border: theme.cardBorder,
              background: theme.cardBg, color: theme.labelColor,
              fontFamily: theme.fontFamily, fontSize: 12, cursor: 'pointer',
            }}
          >
            {segments.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
          </select>
        </div>

        {/* DTW score badge */}
        <div style={{
          marginLeft: 'auto', padding: '4px 12px', borderRadius: 20,
          background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
          fontSize: 11, color: theme.labelSecondaryColor,
        }}>
          {T('对齐代价', 'DTW score')}: <strong style={{ color: theme.labelColor }}>{normDist.toFixed(2)}</strong>
          <span style={{ marginLeft: 6, opacity: 0.6 }}>({T('越小越相似', 'lower = more similar')})</span>
        </div>
      </div>

      {/* ── Main visualization ── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* Y-axis label: B */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: VIS_SIZE, width: 24, flexShrink: 0,
        }}>
          <span style={{
            fontSize: 10, color: '#F4A261', fontWeight: 700,
            writingMode: 'vertical-rl', transform: 'rotate(180deg)',
            whiteSpace: 'nowrap',
          }}>
            B: {labB}  ({m} {T('帧', 'fr')})
          </span>
        </div>

        {/* Canvas + SVG overlay (stacked) */}
        <div style={{ position: 'relative', width: VIS_SIZE, height: VIS_SIZE, flexShrink: 0 }}>
          <canvas
            ref={canvasRef}
            style={{ position: 'absolute', top: 0, left: 0, display: 'block' }}
          />
          <svg
            width={VIS_SIZE}
            height={VIS_SIZE}
            style={{ position: 'absolute', top: 0, left: 0 }}
          >
            {/* Diagonal reference (ideal case: same length + same pacing) */}
            <line
              x1={diagStart.split(',')[0]} y1={diagStart.split(',')[1]}
              x2={diagEnd.split(',')[0]}   y2={diagEnd.split(',')[1]}
              stroke="rgba(255,255,255,0.22)"
              strokeWidth={1}
              strokeDasharray="5 4"
            />
            {/* Optimal DTW path */}
            <polyline
              points={pathPoints}
              fill="none"
              stroke="white"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ filter: 'drop-shadow(0 0 3px rgba(255,255,255,0.9))' }}
            />
          </svg>
        </div>

        {/* Colorbar legend */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          height: VIS_SIZE, gap: 4, flexShrink: 0,
        }}>
          <span style={{ fontSize: 9, color: theme.labelSecondaryColor, textAlign: 'center', lineHeight: 1.3 }}>
            {T('差', 'diff')}
          </span>
          <div style={{
            flex: 1, width: 14, borderRadius: 7,
            background: `linear-gradient(to bottom,
              ${viridis(0)},
              ${viridis(0.25)},
              ${viridis(0.5)},
              ${viridis(0.75)},
              ${viridis(1)})`,
          }} />
          <span style={{ fontSize: 9, color: theme.labelSecondaryColor, textAlign: 'center', lineHeight: 1.3 }}>
            {T('同', 'same')}
          </span>
        </div>
      </div>

      {/* X-axis label: A */}
      <div style={{ textAlign: 'center', marginTop: 6, paddingLeft: 34 }}>
        <span style={{ fontSize: 10, color: '#4CC9F0', fontWeight: 700 }}>
          A: {labA}  ({n} {T('帧', 'fr')})
        </span>
      </div>

      {/* ── Explanation ── */}
      <div style={{
        marginTop: 12, padding: '8px 12px', borderRadius: 8,
        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
        fontSize: 11, color: theme.labelSecondaryColor, lineHeight: 1.75,
      }}>
        {T(
          '白线 = 最优对齐路径，虚线对角 = 完全等速的理想情况。' +
          '黄色区域 = 局部音高相近；紫色区域 = 局部差异大。' +
          '路径向右水平延伸 → A 在此处被拉伸（对应 B 的一小段）；' +
          '路径向上垂直延伸 → B 在此处被拉伸（对应 A 的一小段）。' +
          '可以看出变奏在哪里把主题的某一句"展开"了。',

          'White line = optimal alignment path; dashed diagonal = ideal same-length, same-tempo case. ' +
          'Yellow areas = locally similar pitch; purple = locally different. ' +
          'Horizontal run → A is stretched (maps to few B frames); ' +
          'vertical run → B is stretched (maps to few A frames). ' +
          'Use this to find exactly where a variation expands a short theme phrase into many bars.',
        )}
      </div>
    </div>
  )
}
