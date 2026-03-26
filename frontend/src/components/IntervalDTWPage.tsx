/**
 * IntervalDTWPage
 * ───────────────
 * Compares two segments using *interval sequences* — the semitone steps
 * between consecutive beat-aligned pitch values — rather than absolute pitch.
 *
 * Why intervals?
 * A melody transposed to a different key keeps identical interval steps.
 * So if V3 is the same theme as T but played a fifth higher, their interval
 * sequences will be nearly identical even though all absolute pitches differ.
 * This view is therefore transposition-invariant.
 *
 * Layout:
 *  1. Two bar charts showing each segment's interval sequence independently.
 *  2. A DTW-aligned overlay where B is warped onto A's time axis.
 *  3. Similarity score (0 % = identical intervals, 100 % = maximally different).
 */

import { useState, useMemo } from 'react'
import type { PieceData } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import { getContourData, dtwWarpOntoA } from '../utils/pitchContour'

// ── Colors ─────────────────────────────────────────────────────────────

const COLOR_A   = '#4CC9F0'   // cyan  — segment A
const COLOR_B   = '#F4A261'   // amber — segment B
const COLOR_UP  = '#2DC653'   // green — ascending interval
const COLOR_DN  = '#E05050'   // red   — descending interval

// ── Helpers ────────────────────────────────────────────────────────────

/** Downsample by averaging equal-width windows. */
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

/** Convert pitch array to semitone-delta array (length = original - 1). */
function toIntervals(arr: number[]): number[] {
  return arr.slice(1).map((v, i) => v - arr[i])
}

/** Compute normalised DTW distance (independent of sequence length). */
function normalisedDTW(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0
  const n = a.length, m = b.length
  const dp: number[][] = Array.from({ length: n }, () => new Array(m).fill(Infinity))
  dp[0][0] = Math.abs(a[0] - b[0])
  for (let i = 1; i < n; i++) dp[i][0] = dp[i - 1][0] + Math.abs(a[i] - b[0])
  for (let j = 1; j < m; j++) dp[0][j] = dp[0][j - 1] + Math.abs(a[0] - b[j])
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < m; j++) {
      dp[i][j] = Math.abs(a[i] - b[j]) + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[n - 1][m - 1] / (n + m)
}

// ── Sub-components ─────────────────────────────────────────────────────

interface BarChartProps {
  intervals: number[]
  width:     number
  height:    number
}

/** Bar chart for a single interval sequence. Green = up, red = down. */
function IntervalBarChart({ intervals, width, height }: BarChartProps) {
  if (!intervals.length) return (
    <svg width={width} height={height}>
      <text x={width / 2} y={height / 2} textAnchor="middle" fill="#888" fontSize={10}>no data</text>
    </svg>
  )

  const maxAbs = Math.max(1, ...intervals.map(v => Math.abs(v)))
  const barW   = width / intervals.length
  const midY   = height / 2

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {/* Zero line */}
      <line x1={0} y1={midY} x2={width} y2={midY} stroke="rgba(128,128,128,0.35)" strokeWidth={0.5} />

      {intervals.map((v, i) => {
        const barH = Math.abs(v) / maxAbs * (midY - 2)
        const y    = v >= 0 ? midY - barH : midY
        return (
          <rect
            key={i}
            x={i * barW + 0.5}
            y={y}
            width={Math.max(barW - 0.8, 0.8)}
            height={Math.max(barH, 0.5)}
            fill={v >= 0 ? COLOR_UP : COLOR_DN}
            opacity={0.80}
          />
        )
      })}
    </svg>
  )
}

interface OverlayProps {
  a:      number[]
  b:      number[]   // already DTW-warped onto a's time axis
  width:  number
  height: number
  isDark: boolean
}

/** Line-chart overlay of two interval sequences after DTW alignment. */
function AlignedOverlay({ a, b, width, height, isDark }: OverlayProps) {
  if (!a.length || !b.length) return null

  const allVals = [...a, ...b]
  const minV = Math.min(...allVals)
  const maxV = Math.max(...allVals)
  const span = Math.max(maxV - minV, 1)
  const pad  = 12

  const toX = (i: number) => pad + (i / (a.length - 1)) * (width - pad * 2)
  const toY = (v: number) => pad + (1 - (v - minV) / span) * (height - pad * 2)

  const lineFor = (arr: number[], start: string = 'M') => {
    if (arr.length < 2) return ''
    return arr
      .map((v, i) => `${i === 0 ? start : 'L'} ${toX(i).toFixed(1)} ${toY(v).toFixed(1)}`)
      .join(' ')
  }

  const zeroY = toY(0)

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {/* Zero line */}
      {zeroY >= pad && zeroY <= height - pad && (
        <line
          x1={pad} y1={zeroY} x2={width - pad} y2={zeroY}
          stroke={isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'}
          strokeWidth={0.5}
        />
      )}
      {/* B warped (dashed amber) */}
      <path
        d={lineFor(b)}
        fill="none"
        stroke={COLOR_B}
        strokeWidth={1.5}
        strokeDasharray="4 3"
        opacity={0.85}
      />
      {/* A (solid cyan) */}
      <path
        d={lineFor(a)}
        fill="none"
        stroke={COLOR_A}
        strokeWidth={2}
        opacity={0.95}
      />
    </svg>
  )
}

// ── Main component ─────────────────────────────────────────────────────

interface Props {
  data:   PieceData
  theme:  ThemeTokens
  isDark: boolean
  lang:   Lang
}

export function IntervalDTWPage({ data, theme, isDark, lang }: Props) {
  const segments = data.segments
  const [idxA, setIdxA] = useState(0)
  const [idxB, setIdxB] = useState(Math.min(1, segments.length - 1))

  const T = (zh: string, en: string) => lang === 'zh' ? zh : en

  const MAX_FR = 80

  // ── Compute everything ─────────────────────────────────────────────

  const result = useMemo(() => {
    const cdA  = getContourData(segments[idxA])
    const cdB  = getContourData(segments[idxB])
    const rawA = downsample(cdA.values, MAX_FR)
    const rawB = downsample(cdB.values, MAX_FR)
    const intA = toIntervals(rawA)
    const intB = toIntervals(rawB)

    // Warp B's interval sequence onto A's time axis
    const bWarped    = intB.length > 0 && intA.length > 0
      ? dtwWarpOntoA(intA, intB)
      : intA.map(() => 0)

    const intervalDist = normalisedDTW(intA, intB)
    const pitchDist    = normalisedDTW(rawA, rawB)   // for comparison badge

    // Convert interval distance to a 0–100% similarity score
    // Typical interval DTW scores for piano music: 0 = same, ~8 = very different
    const simPct = Math.max(0, Math.min(100, Math.round((1 - intervalDist / 6) * 100)))

    return { intA, intB, bWarped, intervalDist, pitchDist, simPct }
  }, [idxA, idxB, segments])

  const labA = segments[idxA].label
  const labB = segments[idxB].label

  // Badge color: green > 70 %, amber 40–70 %, red < 40 %
  const simColor = result.simPct >= 70 ? '#2DC653' : result.simPct >= 40 ? '#F4A261' : '#E05050'

  const W       = 420
  const BAR_H   = 68
  const OVL_H   = 110

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '8px 4px', fontFamily: theme.fontFamily }}>

      {/* ── Selector + badge row ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: COLOR_A, fontWeight: 700 }}>A:</span>
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
          <span style={{ fontSize: 11, color: COLOR_B, fontWeight: 700 }}>B:</span>
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

        {/* Similarity badge */}
        <div style={{
          marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center',
          padding: '4px 14px', borderRadius: 20,
          background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
          fontSize: 12,
        }}>
          <span style={{ color: theme.labelSecondaryColor }}>
            {T('旋律相似度', 'Melodic similarity')}
          </span>
          <span style={{ color: simColor, fontWeight: 800, fontSize: 14 }}>
            {result.simPct}%
          </span>
        </div>
      </div>

      {/* ── Two bar charts ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>

        {/* A */}
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 10, color: COLOR_A, fontWeight: 700, marginBottom: 3 }}>
            A: {labA}
            <span style={{ fontWeight: 400, color: theme.labelSecondaryColor, marginLeft: 6 }}>
              {T('音程序列', 'interval seq.')} ({result.intA.length})
            </span>
          </div>
          <div style={{
            borderRadius: 6, overflow: 'hidden',
            background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
          }}>
            <IntervalBarChart intervals={result.intA} width={W / 2} height={BAR_H} />
          </div>
        </div>

        {/* B */}
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 10, color: COLOR_B, fontWeight: 700, marginBottom: 3 }}>
            B: {labB}
            <span style={{ fontWeight: 400, color: theme.labelSecondaryColor, marginLeft: 6 }}>
              {T('音程序列', 'interval seq.')} ({result.intB.length})
            </span>
          </div>
          <div style={{
            borderRadius: 6, overflow: 'hidden',
            background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
          }}>
            <IntervalBarChart intervals={result.intB} width={W / 2} height={BAR_H} />
          </div>
        </div>
      </div>

      {/* Bar chart legend */}
      <div style={{ display: 'flex', gap: 14, fontSize: 10, color: theme.labelSecondaryColor, marginBottom: 12 }}>
        <span>
          <span style={{ color: COLOR_UP, fontWeight: 700 }}>■</span>
          {' '}{T('上行（音高升高）', 'ascending (pitch rises)')}
        </span>
        <span>
          <span style={{ color: COLOR_DN, fontWeight: 700 }}>■</span>
          {' '}{T('下行（音高下降）', 'descending (pitch falls)')}
        </span>
      </div>

      {/* ── DTW-aligned overlay ── */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: theme.labelSecondaryColor, marginBottom: 4 }}>
          {T(
            'DTW 对齐叠加 — B 已拉伸到 A 的时间轴',
            'DTW-aligned overlay — B warped onto A\'s time axis',
          )}
        </div>

        <div style={{
          borderRadius: 8, overflow: 'hidden',
          background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
        }}>
          <AlignedOverlay
            a={result.intA}
            b={result.bWarped}
            width={W}
            height={OVL_H}
            isDark={isDark}
          />
        </div>

        {/* Overlay legend */}
        <div style={{ display: 'flex', gap: 16, fontSize: 10, color: theme.labelSecondaryColor, marginTop: 4 }}>
          <span>
            <span style={{ color: COLOR_A, fontWeight: 700 }}>—— </span>
            A: {labA}
          </span>
          <span>
            <span style={{ color: COLOR_B, fontWeight: 700 }}>╌╌ </span>
            B: {labB}{T(' (DTW 对齐)', ' (DTW warped)')}
          </span>
        </div>
      </div>

      {/* ── Score comparison ── */}
      <div style={{
        marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap',
      }}>
        <div style={{
          flex: 1, padding: '8px 12px', borderRadius: 8,
          background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
          fontSize: 11, color: theme.labelSecondaryColor,
        }}>
          <span style={{ fontWeight: 700, color: theme.labelColor }}>
            {T('音程 DTW 距离', 'Interval DTW dist')}: {result.intervalDist.toFixed(2)}
          </span>
          <br />
          {T('基于音程序列（调性无关）', 'Interval-based (key-agnostic)')}
        </div>
        <div style={{
          flex: 1, padding: '8px 12px', borderRadius: 8,
          background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
          fontSize: 11, color: theme.labelSecondaryColor,
        }}>
          <span style={{ fontWeight: 700, color: theme.labelColor }}>
            {T('音高 DTW 距离', 'Pitch DTW dist')}: {result.pitchDist.toFixed(2)}
          </span>
          <br />
          {T('基于绝对音高（受移调影响）', 'Absolute pitch (affected by transposition)')}
        </div>
      </div>

      {/* ── Explanation ── */}
      <div style={{
        marginTop: 10, padding: '8px 12px', borderRadius: 8,
        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
        fontSize: 11, color: theme.labelSecondaryColor, lineHeight: 1.75,
      }}>
        {T(
          '音程序列 = 相邻拍点间的音高差（半音数）。' +
          '无论一段旋律移调到哪个调，它的音程序列保持不变，因此这种相似度不受变调变奏的影响。' +
          '两栏图相似 → 旋律骨架一样；叠加图中实线与虚线贴合 → DTW 对齐后音程走势高度相近。',

          'Interval sequence = semitone deltas between consecutive beat-aligned pitches. ' +
          'A melody keeps the same interval sequence regardless of transposition, ' +
          'so this similarity score is unaffected by key changes in variations. ' +
          'Similar bar patterns → same melodic skeleton; overlapping lines → closely matching contour shape.',
        )}
      </div>
    </div>
  )
}
