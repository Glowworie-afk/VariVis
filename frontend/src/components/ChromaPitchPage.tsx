/**
 * ChromaPitchPage
 * ───────────────
 * Single-segment visualization that overlays the pitch contour onto
 * a chroma energy heatmap — linking the two data sources in one view.
 *
 * Background (heatmap)
 *   12 rows, one per pitch class (C at bottom, B at top).
 *   Color intensity = chroma energy at that pitch class × time frame.
 *   Data source: compressed.chroma_cof (12 × 64, COF order → reordered to chromatic).
 *
 * Foreground (contour)
 *   White line + colored dots tracking the beat-aligned melody.
 *   Each dot's Y position = which pitch class row the melody lands on.
 *   Data source: beat_midi_relative (relative semitones) → converted to pitch class.
 *
 * What to look for:
 *   • Dot on bright row  = melody note matches the harmony (consonant)
 *   • Dot on dark row    = melody note is a passing/ornamental tone
 *   • Bright row without dots = that pitch class is active in the harmony
 *     but the melody is elsewhere (inner voice, accompaniment figure)
 */

import { useState, useMemo } from 'react'
import type { PieceData } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import { getContourData } from '../utils/pitchContour'

// ── Pitch-class helpers ────────────────────────────────────────────────

// Chromatic semitone → COF index  (happens to be the same mapping)
const CHROMA_TO_COF = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// Note-name → chromatic index (handles sharps, flats, and enharmonics)
const NOTE_TO_CHROMA: Record<string, number> = {
  'C': 0, 'C#': 1, 'Db': 1,
  'D': 2, 'D#': 3, 'Eb': 3,
  'E': 4, 'Fb': 4,
  'F': 5, 'F#': 6, 'Gb': 6,
  'G': 7, 'G#': 8, 'Ab': 8,
  'A': 9, 'A#': 10, 'Bb': 10,
  'B': 11, 'Cb': 11,
}

// One color per pitch class (chromatic order)
const PC_COLORS = [
  '#FF6B6B', // C
  '#FF9A3C', // C#
  '#F4C430', // D
  '#9ACD32', // D#
  '#2DC653', // E
  '#06D6A0', // F
  '#4CC9F0', // F#
  '#4361EE', // G
  '#7209B7', // G#
  '#B5179E', // A
  '#F72585', // A#
  '#E63946', // B
]

// ── Harmonic function ───────────────────────────────────────────────────

type HarmonicFn = 'tonic' | 'subdominant' | 'dominant' | 'other'

// Triad templates in chromatic order: root, third, fifth
const MAJOR_TRIAD = [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]  // 0, +4, +7
const MINOR_TRIAD = [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]  // 0, +3, +7

function rotateTemplate(t: number[], root: number): number[] {
  return Array.from({ length: 12 }, (_, i) => t[(i - root + 12) % 12])
}

/** Find the best-matching major or minor triad for one chroma frame. */
function detectChord(frame: number[]): { root: number; isMajor: boolean } {
  let bestScore = -Infinity, bestRoot = 0, bestMajor = true
  for (let root = 0; root < 12; root++) {
    const mj = rotateTemplate(MAJOR_TRIAD, root).reduce((s, v, i) => s + v * (frame[i] ?? 0), 0)
    const mn = rotateTemplate(MINOR_TRIAD, root).reduce((s, v, i) => s + v * (frame[i] ?? 0), 0)
    if (mj > bestScore) { bestScore = mj; bestRoot = root; bestMajor = true }
    if (mn > bestScore) { bestScore = mn; bestRoot = root; bestMajor = false }
  }
  return { root: bestRoot, isMajor: bestMajor }
}

/** Map a detected chord to its harmonic function in the current key. */
function getHarmonicFn(
  chordRoot: number, chordMajor: boolean,
  tonicPc: number,  keyMajor: boolean,
): HarmonicFn {
  const iv = (chordRoot - tonicPc + 12) % 12   // interval from tonic
  if (keyMajor) {
    if (iv === 0 && chordMajor)  return 'tonic'        // I
    if (iv === 4 && !chordMajor) return 'tonic'        // iii
    if (iv === 9 && !chordMajor) return 'tonic'        // vi
    if (iv === 5 && chordMajor)  return 'subdominant'  // IV
    if (iv === 2 && !chordMajor) return 'subdominant'  // ii
    if (iv === 7 && chordMajor)  return 'dominant'     // V
    if (iv === 11)               return 'dominant'     // vii°
  } else {
    if (iv === 0 && !chordMajor) return 'tonic'        // i
    if (iv === 3 && chordMajor)  return 'tonic'        // III
    if (iv === 8 && chordMajor)  return 'tonic'        // VI
    if (iv === 5 && !chordMajor) return 'subdominant'  // iv
    if (iv === 2 && !chordMajor) return 'subdominant'  // ii°
    if (iv === 7 && chordMajor)  return 'dominant'     // V
    if (iv === 10 && chordMajor) return 'dominant'     // VII
  }
  return 'other'
}

const HARM_COLORS: Record<HarmonicFn, string> = {
  tonic:       '#4361EE',   // blue
  subdominant: '#2DC653',   // green
  dominant:    '#E76F51',   // orange-red
  other:       'rgba(160,160,160,0.35)',
}

const HARM_LABELS: Record<HarmonicFn, { zh: string; en: string; symbol: string }> = {
  tonic:       { zh: '主和弦 (T)',   en: 'Tonic (T)',       symbol: 'T' },
  subdominant: { zh: '下属和弦 (S)', en: 'Subdominant (S)', symbol: 'S' },
  dominant:    { zh: '属和弦 (D)',   en: 'Dominant (D)',    symbol: 'D' },
  other:       { zh: '其他',         en: 'Other',           symbol: '—' },
}

// ── Layout ─────────────────────────────────────────────────────────────

const PLOT_W      = 480
const ROW_H       = 20    // height per pitch-class row
const PLOT_H      = ROW_H * 12
const HARM_H      = 12    // harmonic function strip height
const HARM_GAP    = 6     // gap between grid bottom and strip
const PAD_L       = 38    // space for note-name labels
const PAD_R       = 10
const PAD_T       = 10
const PAD_B       = HARM_GAP + HARM_H + 6 + 16 + 6  // strip + gap + x-labels

// ── Heatmap colour ─────────────────────────────────────────────────────

// ── Component ──────────────────────────────────────────────────────────

interface Props {
  data:   PieceData
  theme:  ThemeTokens
  isDark: boolean
  lang:   Lang
}

export function ChromaPitchPage({ data, theme, isDark, lang }: Props) {
  const segments    = data.segments
  const [selIdx, setSelIdx]     = useState(0)
  const [showLine, setShowLine] = useState(true)

  const T = (zh: string, en: string) => lang === 'zh' ? zh : en

  // ── Derive heatmap + contour from selected segment ─────────────────

  const { contourDots, harmonicFns, tonicPc, tonicName, nFrames } = useMemo(() => {
    const seg = segments[selIdx]
    const cd  = getContourData(seg)

    // Tonic chromatic index
    const tonicName = cd.tonicName ?? ''
    const tonicPc   = NOTE_TO_CHROMA[tonicName] ?? 0
    const keyMajor  = seg.features.pitch_contour?.is_major ?? true

    // ── Chroma heatmap ──────────────────────────────────────────────
    const chromaCof = seg.features.compressed?.chroma_cof ?? []
    const nFrames   = Math.max(64, chromaCof[0]?.length ?? 64)

    // Reorder COF → chromatic:  raw[chromatic_pc][frame]
    const raw: number[][] = Array.from({ length: 12 }, (_, pc) => {
      const cofIdx = CHROMA_TO_COF[pc]
      return Array.from({ length: nFrames }, (_, f) => chromaCof[cofIdx]?.[f] ?? 0)
    })

    // Per-frame normalise: max energy → 1.0
    const heatmap: number[][] = Array.from({ length: 12 }, () => new Array(nFrames).fill(0))
    for (let f = 0; f < nFrames; f++) {
      let maxE = 0
      for (let pc = 0; pc < 12; pc++) maxE = Math.max(maxE, raw[pc][f])
      if (maxE > 1e-6) {
        for (let pc = 0; pc < 12; pc++) heatmap[pc][f] = raw[pc][f] / maxE
      }
    }

    // ── Harmonic function per frame ─────────────────────────────────
    const harmonicFns: HarmonicFn[] = Array.from({ length: nFrames }, (_, f) => {
      const frame = Array.from({ length: 12 }, (_, pc) => heatmap[pc][f])
      const { root, isMajor } = detectChord(frame)
      return getHarmonicFn(root, isMajor, tonicPc, keyMajor)
    })

    // ── Pitch contour: map values → pitch class ─────────────────────
    const contourDots = cd.values.map((v, i) => {
      const pc =
        cd.mode === 'relative'
          ? ((tonicPc + Math.round(v)) % 12 + 12) % 12
          : ((Math.round(v)) % 12 + 12) % 12
      const t = cd.values.length > 1 ? i / (cd.values.length - 1) : 0.5
      return { t, pc }
    })

    return { heatmap, contourDots, harmonicFns, tonicPc, tonicName, nFrames }
  }, [selIdx, segments])

  // ── SVG helpers ────────────────────────────────────────────────────

  // Chromatic pitch class 0 (C) → bottom row; 11 (B) → top row
  const pcToY   = (pc: number) => (11 - pc) * ROW_H + ROW_H / 2
  const tToX    = (t: number)  => t * PLOT_W
  const cellW   = PLOT_W / nFrames

  // Contour SVG path
  const pathD = contourDots.length >= 2
    ? contourDots
        .map(({ t, pc }, i) =>
          `${i === 0 ? 'M' : 'L'} ${tToX(t).toFixed(1)} ${pcToY(pc).toFixed(1)}`
        )
        .join(' ')
    : ''

  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)'
  const borderColor = isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)'

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '8px 4px', fontFamily: theme.fontFamily }}>

      {/* ── Selector row ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: theme.labelSecondaryColor }}>
          {T('选择变奏', 'Segment')}:
        </span>
        <select
          value={selIdx}
          onChange={e => setSelIdx(Number(e.target.value))}
          style={{
            padding: '4px 8px', borderRadius: 6, border: theme.cardBorder,
            background: theme.cardBg, color: theme.labelColor,
            fontFamily: theme.fontFamily, fontSize: 12, cursor: 'pointer',
          }}
        >
          {segments.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
        </select>

        {/* Tonic badge */}
        {tonicName && (
          <span style={{
            padding: '3px 10px', borderRadius: 12,
            background: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)',
            fontSize: 11, color: theme.labelSecondaryColor,
          }}>
            {T('主音', 'Tonic')}{': '}
            <strong style={{ color: PC_COLORS[tonicPc] }}>{tonicName}</strong>
          </span>
        )}

        {/* Legend + line toggle */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, fontSize: 10, color: theme.labelSecondaryColor, alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              display: 'inline-block', width: 22, height: 3,
              background: '#FFD166', borderRadius: 2,
              boxShadow: '0 0 4px rgba(255,209,102,0.6)',
              opacity: showLine ? 1 : 0.25,
            }} />
            {T('旋律', 'Melody')}
          </span>
          {/* Line toggle button */}
          <button
            onClick={() => setShowLine(v => !v)}
            style={{
              padding: '3px 10px', borderRadius: 12, fontSize: 10,
              border: `1px solid ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'}`,
              background: showLine
                ? (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)')
                : 'transparent',
              color: theme.labelSecondaryColor,
              cursor: 'pointer',
            }}
          >
            {showLine
              ? T('隐藏连线', 'Hide line')
              : T('显示连线', 'Show line')}
          </button>
        </div>
      </div>

      {/* ── Main SVG ── */}
      <div style={{ overflowX: 'auto' }}>
        <svg
          width={PAD_L + PLOT_W + PAD_R}
          height={PAD_T + PLOT_H + PAD_B}
          style={{ display: 'block', fontFamily: theme.fontFamily }}
        >
          <g transform={`translate(${PAD_L},${PAD_T})`}>

            {/* ── Rows: background + heatmap cells + label ── */}
            {Array.from({ length: 12 }, (_, pc) => {
              const y       = (11 - pc) * ROW_H
              const isTonic = pc === tonicPc

              return (
                <g key={pc}>
                  {/* Tonic row highlight */}
                  {isTonic && (
                    <rect
                      x={0} y={y} width={PLOT_W} height={ROW_H}
                      fill={isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'}
                    />
                  )}

                  {/* Row separator */}
                  <line
                    x1={0} y1={y} x2={PLOT_W} y2={y}
                    stroke={gridColor} strokeWidth={0.5}
                  />

                  {/* Note name label */}
                  <text
                    x={-6} y={y + ROW_H / 2}
                    textAnchor="end" dominantBaseline="middle"
                    fontSize={isTonic ? 9.5 : 8.5}
                    fontWeight={isTonic ? 800 : 400}
                    fill={isTonic
                      ? PC_COLORS[pc]
                      : (isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.38)')}
                    style={{ userSelect: 'none' }}
                  >
                    {PC_NAMES[pc]}{isTonic ? ' ★' : ''}
                  </text>
                </g>
              )
            })}

            {/* Outer border */}
            <rect
              x={0} y={0} width={PLOT_W} height={PLOT_H}
              fill="none" stroke={borderColor} strokeWidth={0.75}
            />

            {/* ── Melody contour line (toggleable) ── */}
            {showLine && pathD && (
              <path
                d={pathD}
                fill="none"
                stroke="rgba(255,209,102,0.85)"
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}

            {/* ── Melody contour dots (colored by pitch class) ── */}
            {contourDots.map(({ t, pc }, i) => (
              <circle
                key={i}
                cx={tToX(t).toFixed(1)}
                cy={pcToY(pc).toFixed(1)}
                r={3}
                fill={PC_COLORS[pc]}
                stroke="rgba(255,255,255,0.85)"
                strokeWidth={0.8}
              />
            ))}

            {/* ── Harmonic function strip ── */}
            <g transform={`translate(0, ${PLOT_H + HARM_GAP})`}>
              {/* Strip label */}
              <text
                x={-6} y={HARM_H / 2}
                textAnchor="end" dominantBaseline="middle"
                fontSize={7.5} fill={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'}
                style={{ userSelect: 'none' }}
              >
                {T('和声', 'Harm.')}
              </text>
              {/* Colored cells: run-length encoded for cleaner rendering */}
              {harmonicFns.map((fn, f) => (
                <rect
                  key={f}
                  x={f * cellW} y={0}
                  width={cellW + 0.5} height={HARM_H}
                  fill={HARM_COLORS[fn]}
                  rx={0}
                />
              ))}
              {/* Strip border */}
              <rect
                x={0} y={0} width={PLOT_W} height={HARM_H}
                fill="none"
                stroke={isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}
                strokeWidth={0.5}
              />
            </g>

            {/* ── X-axis time labels ── */}
            {[0, 0.25, 0.5, 0.75, 1].map(t => (
              <text
                key={t}
                x={tToX(t)} y={PLOT_H + HARM_GAP + HARM_H + 14}
                textAnchor="middle"
                fontSize={8.5}
                fill={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'}
                style={{ userSelect: 'none' }}
              >
                {Math.round(t * 100)}%
              </text>
            ))}

          </g>
        </svg>
      </div>

      {/* ── Pitch class color legend ── */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '4px 10px',
        marginTop: 8, padding: '6px 10px', borderRadius: 8,
        background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
      }}>
        {PC_NAMES.map((name, pc) => (
          <span key={pc} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
            <span style={{
              display: 'inline-block', width: 8, height: 8,
              borderRadius: '50%', background: PC_COLORS[pc],
              flexShrink: 0,
            }} />
            <span style={{
              color: pc === tonicPc ? PC_COLORS[pc] : theme.labelSecondaryColor,
              fontWeight: pc === tonicPc ? 800 : 400,
            }}>
              {name}{pc === tonicPc ? ' ★' : ''}
            </span>
          </span>
        ))}
      </div>

      {/* ── Harmonic function legend ── */}
      <div style={{
        display: 'flex', gap: 12, flexWrap: 'wrap',
        marginTop: 6, padding: '6px 10px', borderRadius: 8,
        background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
        fontSize: 10, color: theme.labelSecondaryColor, alignItems: 'center',
      }}>
        <span style={{ fontWeight: 700, color: theme.labelColor, marginRight: 4 }}>
          {T('和声功能', 'Harmonic function')}:
        </span>
        {(['tonic', 'subdominant', 'dominant', 'other'] as HarmonicFn[]).map(fn => (
          <span key={fn} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{
              display: 'inline-block', width: 20, height: 8,
              background: HARM_COLORS[fn], borderRadius: 2, flexShrink: 0,
            }} />
            {T(HARM_LABELS[fn].zh, HARM_LABELS[fn].en)}
          </span>
        ))}
      </div>

      {/* ── Explanation ── */}
      <div style={{
        marginTop: 10, padding: '8px 12px', borderRadius: 8,
        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
        fontSize: 11, color: theme.labelSecondaryColor, lineHeight: 1.75,
      }}>
        {T(
          '每一行代表一个音级（C 在最底部，B 在最顶部）。' +
          '彩色圆点是旋律每个拍点的落点；★ 标注主音所在行。' +
          '底部色条是和声功能：蓝 = 主功能（稳定），绿 = 下属功能（离开），橙 = 属功能（紧张）。' +
          '和声功能通过色度模板匹配（三和弦）从音频自动推断，精度受限于录音质量和和弦复杂度。',

          'Each row = one pitch class (C at bottom, B at top). ' +
          'Colored dots = melody beat positions; ★ marks the tonic row. ' +
          'Bottom strip = harmonic function: blue = Tonic (stable), green = Subdominant (departure), orange = Dominant (tension). ' +
          'Inferred automatically from chroma via triad template matching; accuracy depends on recording quality and harmonic complexity.',
        )}
      </div>
    </div>
  )
}
