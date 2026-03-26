/**
 * HarmonicFunctionPage
 * ────────────────────
 * Compares the harmonic function distribution across all segments.
 * Each segment is rendered as a single stacked horizontal bar divided
 * into four regions:
 *
 *   Tonic (T)       — blue   — stable, "home" function
 *   Subdominant (S) — green  — departing, preparatory
 *   Dominant (D)    — orange — tension, leading back to tonic
 *   Other           — gray   — chromatic / ambiguous
 *
 * Detection pipeline (per compressed frame):
 *   1. compressed.chroma_cof [12][64]  → one chroma vector per frame
 *   2. COF order → chromatic order reindex
 *   3. Dot-product against 24 major/minor triad templates → best chord
 *   4. Chord root + key → harmonic function label
 *
 * Unlike the Chroma Ring (which shows WHAT notes are present),
 * this shows HOW those notes function harmonically — and how that
 * differs across theme and variations.
 */

import { useMemo } from 'react'
import type { PieceData, Segment } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'

// ── Chord detection (mirrors ChromaPitchPage logic) ──────────────────────────

// COF index → chromatic semitone
const COF_TO_CHROMA = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]

const MAJOR_TRIAD = [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]
const MINOR_TRIAD = [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]

function rotateTemplate(t: number[], root: number): number[] {
  return Array.from({ length: 12 }, (_, i) => t[(i - root + 12) % 12])
}

function detectChord(frame: number[]): { root: number; isMajor: boolean } {
  let best = -Infinity, root = 0, major = true
  for (let r = 0; r < 12; r++) {
    const mj = rotateTemplate(MAJOR_TRIAD, r).reduce((s, v, i) => s + v * (frame[i] ?? 0), 0)
    const mn = rotateTemplate(MINOR_TRIAD, r).reduce((s, v, i) => s + v * (frame[i] ?? 0), 0)
    if (mj > best) { best = mj; root = r; major = true }
    if (mn > best) { best = mn; root = r; major = false }
  }
  return { root, isMajor: major }
}

type HFn = 'tonic' | 'subdominant' | 'dominant' | 'other'

function getHarmonicFn(
  chordRoot: number, chordMajor: boolean,
  tonicPc: number, keyMajor: boolean,
): HFn {
  const iv = (chordRoot - tonicPc + 12) % 12
  if (keyMajor) {
    if (iv === 0  && chordMajor)  return 'tonic'
    if (iv === 4  && !chordMajor) return 'tonic'
    if (iv === 9  && !chordMajor) return 'tonic'
    if (iv === 5  && chordMajor)  return 'subdominant'
    if (iv === 2  && !chordMajor) return 'subdominant'
    if (iv === 7  && chordMajor)  return 'dominant'
    if (iv === 11)                return 'dominant'
  } else {
    if (iv === 0  && !chordMajor) return 'tonic'
    if (iv === 3  && chordMajor)  return 'tonic'
    if (iv === 8  && chordMajor)  return 'tonic'
    if (iv === 5  && !chordMajor) return 'subdominant'
    if (iv === 2  && chordMajor)  return 'subdominant'   // VII
    if (iv === 7  && !chordMajor) return 'dominant'
    if (iv === 11 && chordMajor)  return 'dominant'      // VII
  }
  return 'other'
}

// ── Colour palette ───────────────────────────────────────────────────────────

const HFN_COLORS: Record<HFn, string> = {
  tonic:       '#4361EE',
  subdominant: '#2DC653',
  dominant:    '#E76F51',
  other:       '#94A3B8',
}

const HFN_ORDER: HFn[] = ['tonic', 'subdominant', 'dominant', 'other']

// ── Per-segment computation ───────────────────────────────────────────────────

interface FnCounts { tonic: number; subdominant: number; dominant: number; other: number; total: number }

function computeFnCounts(seg: Segment): FnCounts {
  const cc      = seg.features.compressed?.chroma_cof  // [12][64]
  const pc      = seg.features.pitch_contour
  const tonicPc = pc?.tonic_semitone ?? 0
  const isMajor = pc?.is_major ?? true

  const counts: FnCounts = { tonic: 0, subdominant: 0, dominant: 0, other: 0, total: 0 }
  if (!cc || cc.length < 12) return counts

  const nFrames = cc[0].length
  for (let f = 0; f < nFrames; f++) {
    // Build chromatic-order chroma vector for this frame
    const chromatic = new Array<number>(12).fill(0)
    for (let cofIdx = 0; cofIdx < 12; cofIdx++) {
      chromatic[COF_TO_CHROMA[cofIdx]] = cc[cofIdx][f]
    }
    const { root, isMajor: chordMaj } = detectChord(chromatic)
    const fn = getHarmonicFn(root, chordMaj, tonicPc, isMajor)
    counts[fn]++
    counts.total++
  }
  return counts
}

// ── Stacked bar row ───────────────────────────────────────────────────────────

interface BarRowProps {
  seg:    Segment
  counts: FnCounts
  theme:  ThemeTokens
  lang:   Lang
  isRef:  boolean    // highlight the theme row
  maxLabelW: number  // for label column alignment
}

const ROW_H       = 36   // total row height including label
const BAR_H       = 22   // the bar itself
const BAR_MAX_W   = 560  // maximum bar width in px

function BarRow({ seg, counts, theme, lang, isRef, maxLabelW }: BarRowProps) {
  const { total } = counts
  if (total === 0) return null

  const tonic   = seg.features.pitch_contour?.tonic_name ?? seg.features.dominant_pitch?.name ?? '?'
  const isMajor = seg.features.pitch_contour?.is_major
  const keyStr  = isMajor != null
    ? `${tonic}${isMajor ? (lang === 'zh' ? '大' : 'M') : (lang === 'zh' ? '小' : 'm')}`
    : tonic

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      height: ROW_H,
      fontFamily: theme.fontFamily,
    }}>
      {/* Segment label */}
      <div style={{
        width: maxLabelW,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        justifyContent: 'flex-end',
      }}>
        <span style={{
          fontSize: 12,
          color: isRef ? HFN_COLORS.tonic : theme.labelSecondaryColor,
          fontWeight: isRef ? 700 : 500,
        }}>
          {keyStr}
        </span>
        <span style={{
          fontSize: 13,
          fontWeight: isRef ? 700 : 600,
          color: isRef ? HFN_COLORS.tonic : theme.labelColor,
          minWidth: 24,
          textAlign: 'right',
        }}>
          {seg.label}
        </span>
      </div>

      {/* Stacked bar */}
      <div style={{
        display: 'flex',
        height: BAR_H,
        width: BAR_MAX_W,
        borderRadius: 4,
        overflow: 'hidden',
        flexShrink: 0,
        boxShadow: isRef ? `0 0 0 1.5px ${HFN_COLORS.tonic}` : 'none',
      }}>
        {HFN_ORDER.map(fn => {
          const pct = counts[fn] / total
          if (pct < 0.001) return null
          const w = pct * BAR_MAX_W

          return (
            <div
              key={fn}
              title={`${fn}: ${Math.round(pct * 100)}%`}
              style={{
                width: w,
                height: '100%',
                background: HFN_COLORS[fn],
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {/* Percentage label — only if section wide enough */}
              {w > 28 && (
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.92)',
                  pointerEvents: 'none',
                  letterSpacing: '0.02em',
                }}>
                  {Math.round(pct * 100)}%
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* % text summary on right */}
      <div style={{
        fontSize: 11,
        color: theme.labelSecondaryColor,
        whiteSpace: 'nowrap',
        display: 'flex',
        gap: 8,
      }}>
        {HFN_ORDER.filter(fn => counts[fn] / total >= 0.05).map(fn => (
          <span key={fn} style={{ color: HFN_COLORS[fn], fontWeight: 600 }}>
            {Math.round(counts[fn] / total * 100)}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface Props {
  data:   PieceData
  theme:  ThemeTokens
  isDark: boolean
  lang:   Lang
}

export function HarmonicFingerprintPage({ data, theme, isDark: _isDark, lang }: Props) {
  const segments = data.segments
  const zh = lang === 'zh'

  const allCounts = useMemo(
    () => segments.map(seg => computeFnCounts(seg)),
    [segments],
  )

  // Find longest label to align bars
  const maxLabelW = 72

  return (
    <div style={{
      padding: '24px 20px',
      color: theme.labelColor,
      fontFamily: theme.fontFamily,
    }}>

      {/* ── Header ── */}
      <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700 }}>
        {zh ? '和声功能分布' : 'Harmonic Function Distribution'}
      </h2>
      <p style={{ margin: '0 0 24px', fontSize: 13, color: theme.labelSecondaryColor }}>
        {zh
          ? '每段变奏的主功能（T）、下属功能（S）、属功能（D）各占多少帧。可以看出哪段变奏更稳定，哪段更有张力。'
          : 'What fraction of each segment sits in tonic (T), subdominant (S), dominant (D), or other function — reveals the harmonic "mood" of each variation.'}
      </p>

      {/* ── Bars ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {segments.map((seg, i) => (
          <BarRow
            key={i}
            seg={seg}
            counts={allCounts[i]}
            theme={theme}
            lang={lang}
            isRef={seg.label === 'T'}
            maxLabelW={maxLabelW}
          />
        ))}
      </div>

      {/* ── Legend ── */}
      <div style={{
        display: 'flex',
        gap: 20,
        marginTop: 28,
        paddingTop: 18,
        borderTop: theme.cardBorder,
        flexWrap: 'wrap',
        alignItems: 'flex-start',
      }}>

        {/* Colour legend */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {HFN_ORDER.map(fn => (
            <div key={fn} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 28, height: 12, borderRadius: 3,
                background: HFN_COLORS[fn],
              }} />
              <span style={{ fontSize: 12, color: theme.labelColor }}>
                {fn === 'tonic'       && (zh ? 'T 主功能'    : 'T Tonic')}
                {fn === 'subdominant' && (zh ? 'S 下属功能'  : 'S Subdominant')}
                {fn === 'dominant'    && (zh ? 'D 属功能'    : 'D Dominant')}
                {fn === 'other'       && (zh ? '其他'        : 'Other')}
              </span>
            </div>
          ))}
        </div>

        {/* Reading guide */}
        <div style={{
          fontSize: 12, color: theme.labelSecondaryColor,
          lineHeight: 1.75, maxWidth: 500, marginLeft: 'auto',
        }}>
          {zh ? (
            <>
              <strong style={{ color: theme.labelColor }}>如何阅读：</strong>
              蓝色（T）越多 = 这段变奏停留在"稳定"状态的时间越长。
              橙色（D）越多 = 属功能出现频繁，和声紧张感更强，常见于技巧性变奏。
              右侧数字 = 各功能占比（%），只显示 ≥5% 的项。
            </>
          ) : (
            <>
              <strong style={{ color: theme.labelColor }}>How to read: </strong>
              More blue (T) = segment stays in stable tonic territory.
              More orange (D) = frequent dominant function, more harmonic tension —
              common in virtuosic or developmental variations.
              Numbers on the right = percentage of frames per function (≥ 5% shown).
            </>
          )}
        </div>
      </div>
    </div>
  )
}
