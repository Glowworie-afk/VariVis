/**
 * TimbrePCA
 * ─────────
 * PCA scatter plot of timbre features.
 *
 * Each segment is a point in 2D space derived from 5 audio features:
 *   • Brightness  — spectral centroid mean (Hz): how "treble-heavy" the sound is
 *   • Loudness    — RMS mean: overall amplitude
 *   • Roughness   — zero-crossing rate: noisiness / transient density
 *   • Tonality    — spectral flatness: tonal (low) vs noise-like (high)
 *   • Harmonics   — mean spectral contrast across 7 bands: harmonic richness
 *
 * PCA is computed entirely in the frontend (5×5 covariance, power iteration).
 * Data is always 15 × 5 — negligible compute cost.
 *
 * Biplot overlay: arrows show which features pull points in which direction.
 * Point proximity = timbre similarity.
 */

import { useMemo, useState } from 'react'
import type { PieceData } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'

// ── Feature definitions ───────────────────────────────────────────────

const FEATURES = [
  { label: 'Brightness',  short: 'Bright',  zh: '频谱质心 — 高频能量比例，值越高听感越亮',  en: 'Spectral centroid — higher = brighter sound',         color: '#E76F51' },
  { label: 'Loudness',    short: 'Loud',    zh: 'RMS 均值 — 整体响度',                    en: 'RMS mean — overall amplitude',                       color: '#4361EE' },
  { label: 'Roughness',   short: 'Rough',   zh: '过零率 — 瞬态密度与噪声感',               en: 'Zero-crossing rate — transient density / noisiness', color: '#2DC653' },
  { label: 'Tonality',    short: 'Tone',    zh: '频谱平坦度 — 调性感（低=调性强，高=噪声）', en: 'Spectral flatness — tonal (low) vs noise-like (high)', color: '#F4A261' },
  { label: 'Harmonics',   short: 'Harm',    zh: '谱对比度均值 — 谐波丰富程度',              en: 'Spectral contrast mean — harmonic richness',          color: '#4CC9F0' },
] as const

// ── PCA math (pure TypeScript, no dependencies) ───────────────────────

function dot(a: number[], b: number[]): number {
  return a.reduce((s, v, i) => s + v * b[i], 0)
}

function matvec(M: number[][], v: number[]): number[] {
  return M.map(row => dot(row, v))
}

function vecnorm(v: number[]): number {
  return Math.sqrt(dot(v, v))
}

function normalize(v: number[]): number[] {
  const n = vecnorm(v)
  return n < 1e-12 ? v.map(() => 0) : v.map(x => x / n)
}

/**
 * Power iteration to find the dominant eigenvector of a symmetric matrix.
 * Converges in ~100 iterations for a 5×5 matrix.
 */
function dominantEigenvector(M: number[][], numIter = 150): number[] {
  // Deterministic start: first basis vector slightly perturbed
  let v = M.map((_, i) => i === 0 ? 1.0 : 0.1 * (i + 1))
  v = normalize(v)
  for (let k = 0; k < numIter; k++) {
    v = normalize(matvec(M, v))
  }
  return v
}

interface PCAResult {
  scores:   [number, number][]  // 2D projection of each segment
  loadings: [number, number][]  // feature vectors in PC space
  varRatio: [number, number]    // fraction of variance explained by PC1, PC2
}

function computePCA(rawMatrix: number[][]): PCAResult | null {
  const N = rawMatrix.length
  const D = rawMatrix[0]?.length ?? 0
  if (N < 3 || D < 2) return null

  // ── 1. Z-score standardise each feature column ───────────────────
  const means = Array.from({ length: D }, (_, j) =>
    rawMatrix.reduce((s, r) => s + r[j], 0) / N
  )
  const stds = Array.from({ length: D }, (_, j) => {
    const m = means[j]
    return Math.sqrt(rawMatrix.reduce((s, r) => s + (r[j] - m) ** 2, 0) / (N - 1))
  })
  const X = rawMatrix.map(r =>
    r.map((v, j) => stds[j] > 1e-10 ? (v - means[j]) / stds[j] : 0)
  )

  // ── 2. Covariance matrix (D × D) ─────────────────────────────────
  const C: number[][] = Array.from({ length: D }, (_, i) =>
    Array.from({ length: D }, (_, j) =>
      X.reduce((s, r) => s + r[i] * r[j], 0) / (N - 1)
    )
  )

  // ── 3. PC1 via power iteration ────────────────────────────────────
  const pc1  = dominantEigenvector(C)
  const lam1 = dot(matvec(C, pc1), pc1)

  // ── 4. Deflate and find PC2 ───────────────────────────────────────
  // C2 = C − λ₁ · v₁ · v₁ᵀ
  const C2 = C.map((row, i) =>
    row.map((v, j) => v - lam1 * pc1[i] * pc1[j])
  )
  const pc2  = dominantEigenvector(C2)
  const lam2 = dot(matvec(C2, pc2), pc2)

  // ── 5. Project data onto PC1, PC2 ────────────────────────────────
  const scores: [number, number][] = X.map(r => [dot(r, pc1), dot(r, pc2)])

  // ── 6. Loadings and explained variance ───────────────────────────
  const loadings: [number, number][] = Array.from({ length: D }, (_, j) => [pc1[j], pc2[j]])
  const traceC = D  // trace of standardised covariance = D
  const varRatio: [number, number] = [lam1 / traceC, lam2 / traceC]

  return { scores, loadings, varRatio }
}

// ── Plot helpers ──────────────────────────────────────────────────────

const PLOT_W = 500
const PLOT_H = 400
const MAR    = { top: 24, right: 30, bottom: 44, left: 44 }
const IW     = PLOT_W - MAR.left - MAR.right
const IH     = PLOT_H - MAR.top  - MAR.bottom

/** Linear scale: maps domain [min(values)−pad, max+pad] to [outLo, outHi] */
function makeScale(values: number[], outLo: number, outHi: number, pad = 0.18) {
  const lo  = Math.min(...values)
  const hi  = Math.max(...values)
  const rng = (hi - lo) || 1
  const lo2 = lo - rng * pad
  const hi2 = hi + rng * pad
  return (v: number) => outLo + ((v - lo2) / (hi2 - lo2)) * (outHi - outLo)
}

/** HSL color cycling through 300° for variation segments */
function pointColor(label: string, idx: number, total: number): string {
  if (label === 'T') return '#999'
  if (label === 'C') return '#bbb'
  const hue = Math.round((idx / total) * 300)
  return `hsl(${hue},72%,46%)`
}

// ── Component ─────────────────────────────────────────────────────────

interface Props {
  data:   PieceData
  theme:  ThemeTokens
  isDark: boolean
  lang:   Lang
}

// ── Radar chart ──────────────────────────────────────────────────────

interface RadarProps {
  values:    number[]   // 5 normalised values [0,1]
  color:     string
  isDark:    boolean
  size?:     number
}

function RadarChart({ values, color, isDark, size = 130 }: RadarProps) {
  const cx = size / 2, cy = size / 2
  const R  = size / 2 - 18   // outer radius
  const N  = values.length

  // Angles: start from top (−90°), go clockwise
  const angle = (i: number) => (Math.PI * 2 * i) / N - Math.PI / 2

  // Grid circles at 25 %, 50 %, 75 %, 100 %
  const gridLevels = [0.25, 0.5, 0.75, 1.0]
  const gridColor  = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const axisColor  = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)'

  // Polygon points for a given radius fraction
  const polyPoints = (frac: number) =>
    values.map((_, i) => {
      const a = angle(i)
      return `${(cx + Math.cos(a) * R * frac).toFixed(1)},${(cy + Math.sin(a) * R * frac).toFixed(1)}`
    }).join(' ')

  // Data polygon
  const dataPoints = values.map((v, i) => {
    const a = angle(i)
    return `${(cx + Math.cos(a) * R * Math.max(0, Math.min(1, v))).toFixed(1)},${(cy + Math.sin(a) * R * Math.max(0, Math.min(1, v))).toFixed(1)}`
  }).join(' ')

  return (
    <svg width={size} height={size} style={{ display: 'block', overflow: 'visible' }}>
      {/* Grid circles */}
      {gridLevels.map(f => (
        <polygon
          key={f}
          points={polyPoints(f)}
          fill="none"
          stroke={gridColor}
          strokeWidth={f === 1 ? 1 : 0.5}
        />
      ))}
      {/* Axis lines from center to each vertex */}
      {values.map((_, i) => {
        const a = angle(i)
        return (
          <line key={i}
            x1={cx} y1={cy}
            x2={(cx + Math.cos(a) * R).toFixed(1)}
            y2={(cy + Math.sin(a) * R).toFixed(1)}
            stroke={axisColor} strokeWidth={0.8}
          />
        )
      })}
      {/* Data polygon */}
      <polygon
        points={dataPoints}
        fill={color}
        fillOpacity={0.18}
        stroke={color}
        strokeWidth={2}
        strokeOpacity={0.9}
      />
      {/* Data dots */}
      {values.map((v, i) => {
        const a  = angle(i)
        const r  = Math.max(0, Math.min(1, v))
        const px = cx + Math.cos(a) * R * r
        const py = cy + Math.sin(a) * R * r
        return (
          <circle key={i} cx={px.toFixed(1)} cy={py.toFixed(1)} r={3}
            fill={color} fillOpacity={0.9}
            stroke={isDark ? '#111' : '#fff'} strokeWidth={1} />
        )
      })}
      {/* Feature labels at each axis tip */}
      {FEATURES.map((f, i) => {
        const a    = angle(i)
        const lx   = cx + Math.cos(a) * (R + 11)
        const ly   = cy + Math.sin(a) * (R + 11)
        const anchor = Math.cos(a) > 0.3 ? 'start' : Math.cos(a) < -0.3 ? 'end' : 'middle'
        return (
          <text key={i}
            x={lx.toFixed(1)} y={ly.toFixed(1)}
            textAnchor={anchor}
            dominantBaseline="middle"
            fontSize={8.5} fontWeight={700}
            fill={f.color} fillOpacity={0.9}
            style={{ userSelect: 'none' }}
          >
            {f.short}
          </text>
        )
      })}
    </svg>
  )
}

// ── Percentile bar ────────────────────────────────────────────────────

interface PercBarProps {
  label:      string
  color:      string
  value:      number
  allValues:  number[]
  isDark:     boolean
  lang:       Lang
  zh:         string
  en:         string
}

function PercentileBar({ label, color, value, allValues, isDark, lang, zh, en }: PercBarProps) {
  const sorted = [...allValues].sort((a, b) => a - b)
  const rank   = sorted.filter(v => v < value).length          // how many are below
  const pct    = allValues.length > 1 ? rank / (allValues.length - 1) : 0.5
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color }}>{label}</span>
        <span style={{ fontSize: 9.5, color: 'rgba(128,128,128,0.8)' }}>
          {lang === 'zh' ? zh : en}
        </span>
      </div>
      <div style={{ position: 'relative', height: 8, background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', borderRadius: 4 }}>
        {/* Filled portion */}
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${pct * 100}%`,
          background: color, opacity: 0.35, borderRadius: 4,
        }} />
        {/* Marker */}
        <div style={{
          position: 'absolute', top: -3, bottom: -3,
          left: `calc(${pct * 100}% - 3px)`,
          width: 6, background: color, borderRadius: 3,
          boxShadow: `0 0 4px ${color}`,
        }} />
        {/* Min / Max labels */}
        <span style={{
          position: 'absolute', left: 0, top: 11,
          fontSize: 8, color: 'rgba(128,128,128,0.6)',
        }}>
          {lang === 'zh' ? '最低' : 'min'}
        </span>
        <span style={{
          position: 'absolute', right: 0, top: 11,
          fontSize: 8, color: 'rgba(128,128,128,0.6)',
        }}>
          {lang === 'zh' ? '最高' : 'max'}
        </span>
      </div>
      {/* Percentile label */}
      <div style={{ marginTop: 14, fontSize: 9, color: 'rgba(128,128,128,0.7)' }}>
        {lang === 'zh'
          ? `在所有变奏中排第 ${rank + 1} / ${allValues.length}`
          : `Ranked ${rank + 1} of ${allValues.length} segments`}
      </div>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────

export function TimbrePCA({ data, theme, isDark, lang }: Props) {
  const segments = data.segments
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)

  // Build N × 5 feature matrix
  const matrix = useMemo(() =>
    segments.map(s => {
      const f = s.features
      const contrastVals = f.spectral_contrast_mean ?? []
      const contrastMean = contrastVals.length > 0
        ? contrastVals.reduce((a, v) => a + v, 0) / contrastVals.length
        : 0
      return [
        f.spectral_centroid_mean ?? 0,  // Brightness
        f.rms_mean               ?? 0,  // Loudness
        f.zcr_mean               ?? 0,  // Roughness
        f.spectral_flatness_mean ?? 0,  // Tonality
        contrastMean,                    // Harmonics
      ]
    })
  , [segments])

  const pca = useMemo(() => computePCA(matrix), [matrix])

  if (!pca) {
    return (
      <div style={{ padding: 32, color: theme.labelSecondaryColor, fontSize: 12 }}>
        {lang === 'zh' ? '数据不足，无法计算 PCA。' : 'Insufficient data to compute PCA.'}
      </div>
    )
  }

  const { scores, loadings, varRatio } = pca

  // Axis scales — note yScale is inverted (SVG y grows downward)
  const xScale = makeScale(scores.map(s => s[0]), 0, IW)
  const yScale = makeScale(scores.map(s => s[1]), IH, 0)  // inverted

  // Origin in SVG coordinates (where PC1=0, PC2=0)
  const ox = xScale(0)
  const oy = yScale(0)

  // Loading arrow length: scale so the longest arrow fills ~22% of the plot width
  const maxLoadingLen = Math.max(...loadings.map(([lx, ly]) => Math.sqrt(lx * lx + ly * ly)))
  const ARROW_SCALE   = maxLoadingLen > 1e-6 ? (IW * 0.22) / maxLoadingLen : IW * 0.22

  const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)'
  const axisColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)'

  return (
    <div style={{
      padding: '12px 10px 20px',
      display: 'flex', flexDirection: 'column', gap: 14,
      fontFamily: theme.fontFamily,
    }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: theme.labelColor }}>
          {lang === 'zh' ? '音色 PCA 散点图' : 'Timbre PCA'}
        </span>
        <span style={{ fontSize: 11, color: theme.labelSecondaryColor }}>
          {lang === 'zh'
            ? '5 个音色特征降至 2D · 点距离近 = 音色相似 · 箭头 = 特征方向'
            : '5 timbre features projected to 2D · Proximity = timbral similarity · Arrows = feature directions'}
        </span>
      </div>

      {/* ── Plot ── */}
      <div style={{ overflowX: 'auto' }}>
        <svg
          width={PLOT_W}
          height={PLOT_H}
          style={{ display: 'block', fontFamily: theme.fontFamily, overflow: 'visible' }}
        >
          {/* Arrow marker defs — one per feature color */}
          <defs>
            {FEATURES.map((f, i) => (
              <marker
                key={i}
                id={`arr-${i}`}
                markerWidth="7" markerHeight="7"
                refX="6" refY="3.5" orient="auto"
              >
                <path d="M0,0 L0,7 L7,3.5 Z" fill={f.color} fillOpacity={0.6} />
              </marker>
            ))}
          </defs>

          <g transform={`translate(${MAR.left},${MAR.top})`}>

            {/* Grid */}
            {[0.25, 0.5, 0.75].map(t => (
              <g key={t}>
                <line x1={IW * t} y1={0} x2={IW * t} y2={IH}
                  stroke={gridColor} strokeWidth={1} strokeDasharray="3 3" />
                <line x1={0} y1={IH * t} x2={IW} y2={IH * t}
                  stroke={gridColor} strokeWidth={1} strokeDasharray="3 3" />
              </g>
            ))}

            {/* Zero axes */}
            <line x1={ox} y1={0} x2={ox} y2={IH} stroke={axisColor} strokeWidth={1} />
            <line x1={0} y1={oy} x2={IW} y2={oy} stroke={axisColor} strokeWidth={1} />

            {/* ── Feature loading arrows (biplot) ── */}
            {loadings.map(([lx, ly], fi) => {
              // PC2 axis is inverted in SVG, so negate ly for display
              const tipX = ox + lx * ARROW_SCALE
              const tipY = oy - ly * ARROW_SCALE
              const f    = FEATURES[fi]

              // Label offset: push away from origin
              const dx = tipX - ox
              const dy = tipY - oy
              const labelDist = 14
              const labelX = tipX + (dx > 0 ? labelDist : -labelDist)
              const labelY = tipY + (dy > 0 ? 10 : -4)
              const anchor  = dx > 0 ? 'start' : 'end'

              return (
                <g key={fi}>
                  <line
                    x1={ox} y1={oy} x2={tipX} y2={tipY}
                    stroke={f.color} strokeWidth={1.8} strokeOpacity={0.6}
                    markerEnd={`url(#arr-${fi})`}
                  />
                  <text
                    x={labelX} y={labelY}
                    textAnchor={anchor}
                    fontSize={9.5} fontWeight={600}
                    fill={f.color} fillOpacity={0.85}
                    style={{ userSelect: 'none' }}
                  >
                    {f.short}
                  </text>
                </g>
              )
            })}

            {/* ── Data points ── */}
            {scores.map(([sx, sy], i) => {
              const seg   = segments[i]
              const cx    = xScale(sx)
              const cy    = yScale(sy)
              const color = pointColor(seg.label, i, segments.length)
              const r     = seg.label === 'T' || seg.label === 'C' ? 6 : 10

              // Build tooltip text
              const f = seg.features
              const contrastVals = f.spectral_contrast_mean ?? []
              const contrastMean = contrastVals.length > 0
                ? contrastVals.reduce((a, v) => a + v, 0) / contrastVals.length : 0
              const tooltip = [
                seg.label,
                `Brightness:  ${(f.spectral_centroid_mean ?? 0).toFixed(0)} Hz`,
                `Loudness:    ${(f.rms_mean ?? 0).toFixed(4)}`,
                `Roughness:   ${(f.zcr_mean ?? 0).toFixed(4)}`,
                `Tonality:    ${(f.spectral_flatness_mean ?? 0).toExponential(2)}`,
                `Harmonics:   ${contrastMean.toFixed(2)} dB`,
                `──────────────`,
                `PC1: ${sx.toFixed(3)}   PC2: ${sy.toFixed(3)}`,
              ].join('\n')

              return (
                <g key={seg.label}>
                  {/* Glow ring for variation segments */}
                  {r > 6 && (
                    <circle cx={cx} cy={cy} r={r + 4}
                      fill={color} fillOpacity={0.12} />
                  )}
                  <circle
                    cx={cx} cy={cy} r={r}
                    fill={color} fillOpacity={0.88}
                    stroke={selectedIdx === i
                      ? 'white'
                      : isDark ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.9)'}
                    strokeWidth={selectedIdx === i ? 2.5 : 1.5}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedIdx(prev => prev === i ? null : i)}
                  >
                    <title>{tooltip}</title>
                  </circle>
                  <text
                    x={cx} y={cy + r + 10}
                    textAnchor="middle"
                    fontSize={9} fontWeight={700}
                    fill={isDark ? 'rgba(255,255,255,0.7)' : color}
                    style={{ userSelect: 'none' }}
                  >
                    {seg.label}
                  </text>
                </g>
              )
            })}

            {/* ── Axis labels ── */}
            <text
              x={IW / 2} y={IH + 34}
              textAnchor="middle" fontSize={10.5}
              fill={theme.labelSecondaryColor}
              style={{ userSelect: 'none' }}
            >
              PC1 — {(varRatio[0] * 100).toFixed(1)}% variance explained
            </text>
            <text
              x={-32} y={IH / 2}
              textAnchor="middle" fontSize={10.5}
              fill={theme.labelSecondaryColor}
              transform={`rotate(-90, -32, ${IH / 2})`}
              style={{ userSelect: 'none' }}
            >
              PC2 — {(varRatio[1] * 100).toFixed(1)}%
            </text>

          </g>
        </svg>
      </div>

      {/* ── Click hint ── */}
      <div style={{ fontSize: 10, color: theme.labelSecondaryColor, opacity: 0.7 }}>
        {lang === 'zh'
          ? '点击散点图中的任意变奏，查看该变奏的音色画像'
          : 'Click any point on the scatter plot to see that segment\'s timbre profile'}
      </div>

      {/* ── Detail panel: radar + percentile bars ── */}
      {selectedIdx !== null && (() => {
        const seg    = segments[selectedIdx]
        const row    = matrix[selectedIdx]
        const color  = pointColor(seg.label, selectedIdx, segments.length)

        // Normalise each feature to [0,1] across all segments
        const colMin = Array.from({ length: 5 }, (_, j) => Math.min(...matrix.map(r => r[j])))
        const colMax = Array.from({ length: 5 }, (_, j) => Math.max(...matrix.map(r => r[j])))
        const norm   = row.map((v, j) => {
          const span = colMax[j] - colMin[j]
          return span < 1e-10 ? 0.5 : (v - colMin[j]) / span
        })

        return (
          <div style={{
            padding: '14px 16px', borderRadius: 10,
            background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
            border: `1.5px solid ${color}44`,
          }}>
            {/* Panel header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: color }} />
              <span style={{ fontSize: 13, fontWeight: 800, color: theme.labelColor }}>
                {seg.label}
              </span>
              <span style={{ fontSize: 10, color: theme.labelSecondaryColor }}>
                {lang === 'zh' ? '音色画像' : 'Timbre profile'}
              </span>
              <button
                onClick={() => setSelectedIdx(null)}
                style={{
                  marginLeft: 'auto', background: 'none', border: 'none',
                  cursor: 'pointer', color: theme.labelSecondaryColor, fontSize: 14,
                }}
              >✕</button>
            </div>

            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              {/* Radar chart */}
              <div>
                <div style={{ fontSize: 10, color: theme.labelSecondaryColor, marginBottom: 6, textAlign: 'center' }}>
                  {lang === 'zh' ? '五维音色雷达图' : 'Timbral radar'}
                </div>
                <RadarChart values={norm} color={color} isDark={isDark} size={150} />
              </div>

              {/* Percentile bars */}
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 10, color: theme.labelSecondaryColor, marginBottom: 10 }}>
                  {lang === 'zh'
                    ? '在所有变奏中的百分位排名 →'
                    : 'Percentile rank across all segments →'}
                </div>
                {FEATURES.map((f, j) => (
                  <PercentileBar
                    key={j}
                    label={f.short}
                    color={f.color}
                    value={row[j]}
                    allValues={matrix.map(r => r[j])}
                    isDark={isDark}
                    lang={lang}
                    zh={f.zh}
                    en={f.en}
                  />
                ))}
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── Feature legend ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: '4px 16px',
        padding: '8px 12px', borderRadius: 8,
        background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        border: theme.cardBorder,
        fontSize: 10.5, color: theme.labelSecondaryColor, lineHeight: 1.6,
      }}>
        {FEATURES.map((f, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              display: 'inline-block', width: 22, height: 2.5,
              background: f.color, borderRadius: 2, flexShrink: 0,
            }} />
            <span>
              <span style={{ fontWeight: 700, color: theme.labelColor }}>{f.short}</span>
              {' '}— {lang === 'zh' ? f.zh : f.en}
            </span>
          </div>
        ))}
        <div style={{ gridColumn: '1 / -1', marginTop: 2, fontStyle: 'italic' }}>
          {lang === 'zh'
            ? '箭头越长 = 该特征对散点分布贡献越大；同向的点在该特征上数值相似'
            : 'Longer arrow = stronger contribution to the scatter; points in the arrow direction score high on that feature'}
        </div>
      </div>

    </div>
  )
}
