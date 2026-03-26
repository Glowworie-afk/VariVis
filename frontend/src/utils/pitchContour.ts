/**
 * pitchContour.ts
 * ───────────────
 * Pitch contour utilities: source selection, normalisation, SVG path generation.
 *
 * Data source priority (best → worst):
 *   1. beat_midi_relative  — beat-aligned, tonic-normalised (pYIN + KS)
 *   2. midi_relative       — uniform 64-frame, tonic-normalised (pYIN + KS)
 *   3. beat_midi           — beat-aligned absolute (pYIN, no key detection)
 *   4. midi                — uniform 64-frame absolute (pYIN only)
 *   5. chroma fallback     — derived from chroma argmax (no pYIN)
 *
 * Y-axis semantics:
 *   • Relative mode  → Y = semitones from tonic.  0 = tonic, 7 = fifth, 12 = octave.
 *                      Fixed display range: RELATIVE_RANGE (-5 to +24).
 *   • Absolute mode  → Y = MIDI note number.
 *                      Range computed from 5th–95th percentile of all data,
 *                      with a minimum span of 12 semitones (one octave).
 */

import type { Segment } from '../types/features'

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

// COF index → chromatic semitone (0–11)
const COF_TO_CHROMA = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]

/**
 * Fixed Y-axis range for relative (tonic-normalised) mode.
 *
 * -5  ≈ perfect fourth below tonic (covers minor-mode openings)
 * +24 = two octaves above tonic (covers almost all melody ranges)
 *
 * This range is fixed regardless of the piece so that ALL segments
 * across ALL pieces share the same visual scale.
 */
export const RELATIVE_RANGE = { min: -5, max: 24 }

// Interval names for Y-axis labels (relative semitones)
const INTERVAL_LABELS: Record<number, string> = {
  [-5]: '4↓', [-4]: '3↓', [-3]: 'm3↓', [-2]: 'M2↓', [-1]: 'm2↓',
  0: 'T',    // tonic
  2: 'M2', 3: 'm3', 4: 'M3', 5: 'P4', 7: 'P5',
  8: 'm6', 9: 'M6', 10: 'm7', 11: 'M7',
  12: '8va', 14: 'M9', 15: 'm10', 16: 'M10', 17: 'P11',
  19: 'P12', 21: 'M13', 24: '15va',
}

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type ContourMode = 'relative' | 'absolute'

export interface ContourData {
  values: number[]          // raw array, ready for normalisation
  mode: ContourMode
  source: 'beat_relative' | 'compressed_relative' | 'beat_abs' | 'compressed_abs' | 'chroma'
  tonicName?: string        // present in relative mode
  isMajor?: boolean
  ksCorrelation?: number
}

export interface ContourRange {
  min: number
  max: number
}

// ─────────────────────────────────────────────────────────────────
// Chroma fallback (when pYIN not available)
// ─────────────────────────────────────────────────────────────────

function smooth(arr: number[], passes = 2): number[] {
  let a = [...arr]
  for (let p = 0; p < passes; p++) {
    const out = [...a]
    for (let i = 1; i < a.length - 1; i++) {
      out[i] = a[i - 1] * 0.25 + a[i] * 0.5 + a[i + 1] * 0.25
    }
    a = out
  }
  return a
}

/**
 * Derive a rough melodic contour from the compressed chroma matrix.
 * Produces absolute semitone values (chromatic, with octave unwrapping).
 * Used only when pYIN data is unavailable.
 */
function contourFromChroma(chromaCof: number[][]): number[] {
  const nFrames = chromaCof[0]?.length ?? 64
  const raw: number[] = []

  for (let f = 0; f < nFrames; f++) {
    let maxE = -Infinity
    let bestCof = 0
    for (let p = 0; p < 12; p++) {
      const v = chromaCof[p]?.[f] ?? 0
      if (v > maxE) { maxE = v; bestCof = p }
    }
    raw.push(COF_TO_CHROMA[bestCof])
  }

  // Octave unwrap: start at C4 (60), pick the nearest octave for each step
  const unwrapped: number[] = []
  let prev = raw[0] + 60
  for (const pc of raw) {
    let best = pc; let bestDist = Infinity
    for (let oct = -1; oct <= 3; oct++) {
      const c = pc + oct * 12
      const d = Math.abs(c - prev)
      if (d < bestDist) { bestDist = d; best = c }
    }
    unwrapped.push(best)
    prev = best
  }

  return smooth(unwrapped, 3)
}

// ─────────────────────────────────────────────────────────────────
// Source selection
// ─────────────────────────────────────────────────────────────────

/**
 * Return the best available contour data for a segment.
 * Follows the priority chain documented at the top of this file.
 */
export function getContourData(segment: Segment): ContourData {
  const pc = segment.features.pitch_contour

  if (pc && !pc.error) {
    const meta = {
      tonicName:     pc.tonic_name,
      isMajor:       pc.is_major,
      // key_correlation is written by updated backend; fall back to ks_correlation for old JSON
      ksCorrelation: pc.key_correlation ?? pc.ks_correlation,
    }

    // 1. Beat-aligned relative (best)
    if (pc.beat_midi_relative?.length >= 4) {
      return { values: pc.beat_midi_relative, mode: 'relative', source: 'beat_relative', ...meta }
    }
    // 2. Compressed relative
    if (pc.midi_relative?.length >= 4) {
      return { values: pc.midi_relative, mode: 'relative', source: 'compressed_relative', ...meta }
    }
    // 3. Beat-aligned absolute
    if (pc.beat_midi?.length >= 4) {
      return { values: pc.beat_midi, mode: 'absolute', source: 'beat_abs' }
    }
    // 4. Compressed absolute
    if (pc.midi?.length >= 4) {
      return { values: pc.midi, mode: 'absolute', source: 'compressed_abs' }
    }
  }

  // 5. Chroma fallback
  return {
    values: contourFromChroma(segment.features.compressed.chroma_cof),
    mode: 'absolute',
    source: 'chroma',
  }
}

// ─────────────────────────────────────────────────────────────────
// Range computation
// ─────────────────────────────────────────────────────────────────

/**
 * Compute a shared Y-axis range for a set of segments.
 *
 * • If all segments have relative data → return the fixed RELATIVE_RANGE.
 *   This guarantees visual consistency across ALL pieces.
 *
 * • Otherwise (absolute MIDI or chroma) → percentile-based range,
 *   with a minimum span of 14 semitones (slightly more than one octave).
 */
export function globalContourRange(segments: Segment[]): ContourRange {
  const allData = segments.map(getContourData)
  const allRelative = allData.every(d => d.mode === 'relative')

  if (allRelative) return { ...RELATIVE_RANGE }

  const all: number[] = []
  for (const d of allData) all.push(...d.values)
  if (all.length === 0) return { min: 48, max: 84 }

  all.sort((a, b) => a - b)
  const lo = all[Math.floor(all.length * 0.05)]
  const hi = all[Math.ceil(all.length * 0.95) - 1]
  const span = Math.max(hi - lo, 14)
  const pad  = span * 0.1
  return { min: lo - pad, max: lo + span + pad }
}

// ─────────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────────

/**
 * Map raw contour values to [0, 1] using the given range.
 * Result is ready for SVG: 0 = top (high pitch), 1 = bottom (low pitch).
 */
export function normaliseContour(values: number[], range: ContourRange): number[] {
  const span = range.max - range.min
  if (span < 0.001) return values.map(() => 0.5)
  return values.map(v => 1 - Math.max(0, Math.min(1, (v - range.min) / span)))
}

// ─────────────────────────────────────────────────────────────────
// Y-axis tick labels
// ─────────────────────────────────────────────────────────────────

export interface YTick {
  y: number     // normalised [0,1]
  label: string
}

/**
 * Generate Y-axis tick marks for the given range and mode.
 *
 * Relative mode: ticks at musically meaningful intervals (T, M3, P5, 8va, …).
 * Absolute mode: ticks every 12 semitones (one octave), labelled as note names.
 */
export function yAxisTicks(range: ContourRange, mode: ContourMode, tonicName?: string): YTick[] {
  const span = range.max - range.min
  const ticks: YTick[] = []

  if (mode === 'relative') {
    // Show T, P5, 8va, 15va — and their inversions if in range
    const keyPoints = [-5, 0, 4, 7, 12, 19, 24]
    for (const v of keyPoints) {
      if (v < range.min || v > range.max) continue
      const label = v === 0
        ? (tonicName ?? 'T')
        : (INTERVAL_LABELS[v] ?? `+${v}`)
      ticks.push({ y: 1 - (v - range.min) / span, label })
    }
  } else {
    // Every C note in range
    const firstC = Math.ceil(range.min / 12) * 12
    for (let midi = firstC; midi <= range.max; midi += 12) {
      const octave = Math.floor(midi / 12) - 1
      ticks.push({
        y: 1 - (midi - range.min) / span,
        label: `C${octave}`,
      })
    }
  }
  return ticks
}

// ─────────────────────────────────────────────────────────────────
// Dynamic Time Warping
// ─────────────────────────────────────────────────────────────────

/**
 * Classic O(n·m) DTW cost matrix + backtrack.
 * Returns the optimal warping path as an ordered list of [i, j] index pairs,
 * where i indexes sequence a and j indexes sequence b.
 */
export function dtw(a: number[], b: number[]): [number, number][] {
  const n = a.length
  const m = b.length

  // Build accumulated cost matrix
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

  // Backtrack from (n-1, m-1) to (0, 0)
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
  return path
}

/**
 * Warp sequence b onto sequence a's time axis using DTW.
 * For each frame i in a, averages the b values that were aligned to it.
 * Returns an array with the same length as a — ready to normalise and draw.
 */
export function dtwWarpOntoA(a: number[], b: number[]): number[] {
  const path   = dtw(a, b)
  const result = new Array(a.length).fill(0)
  const counts = new Array(a.length).fill(0)
  for (const [pi, pj] of path) {
    result[pi] += b[pj]
    counts[pi]++
  }
  for (let k = 0; k < a.length; k++) {
    if (counts[k] > 0) result[k] /= counts[k]
  }
  return result
}

/**
 * Subtract the mean from a sequence so it's centred around 0.
 * Used to compare melodic contour (shape) rather than absolute pitch,
 * making the similarity score invariant to transposition.
 */
export function demean(arr: number[]): number[] {
  if (arr.length === 0) return []
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length
  return arr.map(v => v - mean)
}

/**
 * Compute DTW contour-similarity metrics between two sequences after alignment.
 * Both sequences are demeaned before comparison so that transposition is ignored —
 * only the melodic shape (rise/fall pattern) contributes to the score.
 *
 * a and bWarped must be the same length (b already warped onto a's time axis).
 *
 * Returns:
 *   meanDiff   — mean absolute contour difference (semitones) after demeaning
 *   similarity — 0–100 score: 100 = identical contour, 0 = ≥12 semitones avg shape diff
 */
export function dtwSimilarity(a: number[], bWarped: number[]): { meanDiff: number; similarity: number } {
  if (a.length === 0) return { meanDiff: 0, similarity: 100 }
  const ca = demean(a)
  const cb = demean(bWarped)
  const meanDiff = ca.reduce((sum, v, i) => sum + Math.abs(v - cb[i]), 0) / ca.length
  const similarity = Math.round(Math.max(0, 100 - (meanDiff / 12) * 100))
  return { meanDiff, similarity }
}

/** Convert MIDI note number to note name (e.g. 60 → "C4") */
export function midiToNoteName(midi: number): string {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
  const oct   = Math.floor(midi / 12) - 1
  return `${names[Math.round(midi) % 12]}${oct}`
}

// ─────────────────────────────────────────────────────────────────
// SVG path generation
// ─────────────────────────────────────────────────────────────────

/**
 * Cubic-bezier smooth path through normalised contour points.
 * padX / padY leave room for axis labels.
 */
export function contourToPath(
  normalised: number[],
  width: number,
  height: number,
  padX = 8,
  padY = 8,
): string {
  if (normalised.length < 2) return ''
  const w = width - padX * 2
  const h = height - padY * 2

  const pts = normalised.map((y, i) => ({
    x: padX + (i / (normalised.length - 1)) * w,
    y: padY + y * h,
  }))

  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]
    const curr = pts[i]
    const cpx  = (prev.x + curr.x) / 2
    d += ` C ${cpx.toFixed(1)} ${prev.y.toFixed(1)}, ${cpx.toFixed(1)} ${curr.y.toFixed(1)}, ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`
  }
  return d
}

/**
 * Closed area path (fill under the contour curve).
 */
export function contourToAreaPath(
  normalised: number[],
  width: number,
  height: number,
  padX = 8,
  padY = 8,
): string {
  const line = contourToPath(normalised, width, height, padX, padY)
  if (!line) return ''
  const w = width - padX * 2
  return (
    line +
    ` L ${(padX + w).toFixed(1)} ${(padY + (height - padY * 2)).toFixed(1)}` +
    ` L ${padX} ${(padY + (height - padY * 2)).toFixed(1)} Z`
  )
}
