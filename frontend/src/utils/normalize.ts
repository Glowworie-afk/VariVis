// VariVis — Feature normalization utilities
import type { Segment, SegmentFeatures } from '../types/features'

/** Clamp x into [lo, hi] */
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/** Min-max normalize across all values */
function minMaxNorm(values: number[]): number[] {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const range = hi - lo
  return range === 0 ? values.map(() => 0.5) : values.map(v => (v - lo) / range)
}

// ── Rhythm polygon axes ────────────────────────────────────────────
// 8 axes, each mapped to one feature from SegmentFeatures.
// Returns values in [0, 1] for each axis, across all segments.

export interface RhythmAxes {
  onsetDensity: number       // 0° top
  brightness: number         // 45°
  loudness: number           // 90° right
  dynamicRange: number       // 135°
  energyVariation: number    // 180° bottom (rms_std)
  harmonics: number          // 225° (spectral_contrast band 3)
  roughness: number          // 270° left (zcr)
  timbreVariation: number    // 315° (mfcc_std[0])
}

export const RHYTHM_AXIS_LABELS: (keyof RhythmAxes)[] = [
  'onsetDensity',
  'brightness',
  'loudness',
  'dynamicRange',
  'energyVariation',
  'harmonics',
  'roughness',
  'timbreVariation',
]

export const RHYTHM_AXIS_DISPLAY: Record<keyof RhythmAxes, string> = {
  onsetDensity:    'Onset',
  brightness:      'Bright',
  loudness:        'Loud',
  dynamicRange:    'Dyn.',
  energyVariation: 'Stab.',
  harmonics:       'Harm.',
  roughness:       'Rough',
  timbreVariation: 'Timbre',
}

function extractRaw(f: SegmentFeatures): RhythmAxes {
  return {
    onsetDensity:    f.onset_density,
    brightness:      f.spectral_centroid_mean,
    loudness:        f.rms_mean,
    dynamicRange:    f.dynamic_range_db,
    energyVariation: f.rms_std,
    harmonics:       f.spectral_contrast_mean[3] ?? 0,
    roughness:       f.zcr_mean,
    timbreVariation: f.mfcc_std[0] ?? 0,
  }
}

/** Compute normalized rhythm axes for all segments (min-max across piece) */
export function normalizeRhythmAxes(segments: Segment[]): RhythmAxes[] {
  const keys = RHYTHM_AXIS_LABELS
  const raws = segments.map(s => extractRaw(s.features))

  // Per-axis min-max across all segments
  const normalized = keys.reduce((acc, key) => {
    const vals = raws.map(r => r[key])
    acc[key] = minMaxNorm(vals)
    return acc
  }, {} as Record<keyof RhythmAxes, number[]>)

  return segments.map((_, i) =>
    Object.fromEntries(keys.map(k => [k, normalized[k][i]])) as unknown as RhythmAxes
  )
}

// ── Timbre hexagon (MFCC) ──────────────────────────────────────────
// 6 vertices from mfcc_mean[0..5], normalized per-dimension across piece.

export function normalizeTimbreHex(segments: Segment[]): number[][] {
  const N_MFCC = 6
  const allMfcc = segments.map(s => s.features.mfcc_mean.slice(0, N_MFCC))

  // Per-dimension min-max
  const result: number[][] = segments.map(() => [])
  for (let d = 0; d < N_MFCC; d++) {
    const vals = allMfcc.map(m => m[d])
    const normed = minMaxNorm(vals)
    normed.forEach((v, i) => result[i].push(clamp(v, 0.05, 1)))
  }
  return result
}

// ── Mode score ────────────────────────────────────────────────────
// COF order: C=0,G=1,D=2,A=3,E=4,B=5,F#=6,Db=7,Ab=8,Eb=9,Bb=10,F=11
// E natural = index 4, Eb = index 9
// Returns value in [-1, +1]: +1 = clearly major, -1 = clearly minor

export function modeScore(chromaCof: number[]): number {
  const eNat = chromaCof[4] ?? 0   // E natural
  const eFlat = chromaCof[9] ?? 0  // Eb
  const denom = eNat + eFlat
  if (denom < 1e-8) return 0
  return (eNat - eFlat) / denom
}

// ── Chroma arc outer radius ───────────────────────────────────────
// Fixed scale: a chroma value of 0.25 fills the full arc height.
// Consistent across all segments so glyphs are directly comparable.

export function chromaOuterRadius(
  value: number,
  innerRadius: number,
  maxArcHeight: number,
  referenceMax = 0.25,
): number {
  const height = clamp((value / referenceMax) * maxArcHeight, 1, maxArcHeight)
  return innerRadius + height
}
