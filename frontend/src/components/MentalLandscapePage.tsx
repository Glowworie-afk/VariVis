// MentalLandscapePage.tsx
// 心理图景 + 心理语义注释 — Mental Landscape + Semantic Annotation
//
// Visual dimensions (per glyph):
//   Shape         → pitch-class radar: 12 vertices (chromatic order), vertex radius = pitch-class energy
//   Stroke        → fixed thin border
//   Opacity       → fixed per mode (major=0.70, minor=0.55) — no channel wasted on rhythm
//   Size          → RMS energy (loudness, single channel — no dual encoding)
//   Blur Halo     → spectral centroid brightness (tier 0=Piercing strong glow, 1=Bright soft glow, 2-4=none)
//   Concentric Rings → onset density (rhythm: 1 ring=sparse, 4 rings=dense)
//   Y position    → avg midi_relative (melodic register)
//
// Semantic annotation (per variation):
//   Arousal  = normOnset × 0.55 + normRms × 0.45
//   Valence  = major: 0.55 + normConsonance × 0.42
//              minor: 0.38 - normConsonance × 0.28
//   Labels follow Hevner (1936) adjective circle (8 groups)
//   + mapped to GEMS (Geneva Emotional Music Scale) 9 categories

import { useState } from 'react'
import type { PieceData, Segment } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../types/app'

interface Props {
  data:        PieceData
  theme:       ThemeTokens
  isDark:      boolean
  lang:        Lang
  selectedSeg?: number | null
  onSegSelect?: (i: number) => void
}

// ── Russell circumplex constants ──────────────────────────────────────
const RC_W    = 380   // plot area width  (px)
const RC_H    = 330   // plot area height (px) — extra 12px top room for Arousal label
const RC_PAD  = 52    // axis label padding — increased so ↑ Arousal label is not clipped
const RC_PW   = RC_W - RC_PAD * 2   // inner plot width
const RC_PH   = RC_H - RC_PAD * 2   // inner plot height

// ── Layout constants ──────────────────────────────────────────────────

const CELL_W     = 90
const GLYPH_R    = 30

const SVG_H      = 400        // increased for emoji+semantic rows
const PAD_X      = 40
const PAD_TOP    = 70
const PAD_BOT    = 116        // increased
const INNER_H    = SVG_H - PAD_TOP - PAD_BOT
const CENTER_Y   = PAD_TOP + INNER_H / 2
const Y_RANGE    = 52
const LABEL_Y    = SVG_H - PAD_BOT + 14
const KEY_Y      = SVG_H - PAD_BOT + 27
const EMOJI_Y    = SVG_H - PAD_BOT + 46
const SEMANTIC_Y = SVG_H - PAD_BOT + 60

// ── Hevner adjective circle (8 groups) ───────────────────────────────

interface HevnerEntry {
  group:    number
  label:    string    // primary English adjective
  labelZh:  string    // Chinese
  emoji:    string
  gems:     string    // GEMS category (en)
  gemsZh:   string
  hue:      number    // badge background hue (HSL)
}

const HEVNER: HevnerEntry[] = [
  { group: 1, label: 'Vigorous',    labelZh: '雄健',   emoji: '', gems: 'Power',             gemsZh: '力量感',  hue: 20  },
  { group: 2, label: 'Triumphant',  labelZh: '激昂',   emoji: '', gems: 'Power',             gemsZh: '力量感',  hue: 40  },
  { group: 3, label: 'Agitated',    labelZh: '激动',   emoji: '', gems: 'Tension',           gemsZh: '紧张',   hue: 0   },
  { group: 4, label: 'Sprightly',   labelZh: '活泼',   emoji: '', gems: 'Joyful Activation', gemsZh: '欢快激活', hue: 55  },
  { group: 5, label: 'Joyful',      labelZh: '欢快',   emoji: '', gems: 'Joyful Activation', gemsZh: '欢快激活', hue: 48  },
  { group: 6, label: 'Serene',      labelZh: '宁静',   emoji: '', gems: 'Peacefulness',      gemsZh: '平和',   hue: 145 },
  { group: 7, label: 'Lyrical',     labelZh: '抒情',   emoji: '', gems: 'Tenderness',        gemsZh: '温柔',   hue: 180 },
  { group: 8, label: 'Melancholic', labelZh: '忧郁',   emoji: '', gems: 'Sadness',           gemsZh: '哀愁',   hue: 225 },
]

// ── Semantic computation ──────────────────────────────────────────────

/** Pick Hevner entry from arousal × valence × brightness × pitchNorm */
function pickHevner(
  arousal:    number,   // 0–1
  valence:    number,   // 0–1
  brightness: number,   // 0–1 (normalised spectral centroid)
  pitchNorm:  number,   // 0–1
): HevnerEntry {
  if (arousal > 0.68) {
    if      (valence > 0.62) return brightness > 0.48 ? HEVNER[3] : HEVNER[1]  // Sprightly | Triumphant
    else if (valence > 0.40) return HEVNER[0]                                    // Vigorous
    else                     return HEVNER[2]                                    // Agitated
  } else if (arousal > 0.38) {
    if      (valence > 0.65) return brightness > 0.50 ? HEVNER[4] : HEVNER[6]  // Joyful | Lyrical
    else if (valence > 0.42) return pitchNorm > 0.55 ? HEVNER[1] : HEVNER[0]   // Triumphant | Vigorous
    else                     return brightness > 0.50 ? HEVNER[2] : HEVNER[7]  // Agitated | Melancholic
  } else {
    if      (valence > 0.65) return brightness > 0.48 ? HEVNER[5] : HEVNER[6]  // Serene | Lyrical
    else if (valence > 0.42) return HEVNER[6]                                   // Lyrical (tender/pensive)
    else                     return HEVNER[7]                                   // Melancholic
  }
}

// ── Dimension semantic labels ─────────────────────────────────────────

interface DimLabel { text: string; textZh: string; bg: string; fg: string }

function valenceTag(valence: number, isMajor: boolean, lang: Lang): DimLabel {
  // Thresholds adjusted for new formula range: major [0.48, 0.80], minor [0.10, 0.40]
  if (!isMajor && valence < 0.30)  return { text: 'Minor · Dark',      textZh: '小调·深沉',  bg: '#c7d2fe', fg: '#1e1b4b' }
  if (!isMajor)                    return { text: 'Minor · Negative',  textZh: '小调·消沉',  bg: '#dbeafe', fg: '#1d4ed8' }
  if (valence > 0.72)              return { text: 'Major · Bright',    textZh: '大调·明朗',  bg: '#fef9c3', fg: '#92400e' }
  if (valence > 0.58)              return { text: 'Major · Positive',  textZh: '大调·积极',  bg: '#fef08a', fg: '#78350f' }
  return                            { text: 'Major · Neutral',         textZh: '大调·中性',  bg: '#f3f4f6', fg: '#374151' }
  void lang
}

function arousalTag(arousal: number, od: number, lang: Lang): DimLabel {
  // Label shows onset density (dominant factor); arousal also weighs pitch+timbre
  if (arousal > 0.68) return { text: `${od.toFixed(1)}/s · High Arousal`, textZh: `${od.toFixed(1)}/s · 高唤醒`, bg: '#fee2e2', fg: '#991b1b' }
  if (arousal > 0.38) return { text: `${od.toFixed(1)}/s · Mid Arousal`,  textZh: `${od.toFixed(1)}/s · 中唤醒`, bg: '#ffedd5', fg: '#92400e' }
  return               { text: `${od.toFixed(1)}/s · Low Arousal`,        textZh: `${od.toFixed(1)}/s · 低唤醒`, bg: '#d1fae5', fg: '#065f46' }
  void lang
}

function powerTag(rmsNorm: number, lang: Lang): DimLabel {
  if (rmsNorm > 0.68) return { text: 'Loud · Powerful',    textZh: '强·有力',  bg: '#fee2e2', fg: '#991b1b' }
  if (rmsNorm > 0.38) return { text: 'Medium · Steady',    textZh: '中·稳健',  bg: '#ffedd5', fg: '#92400e' }
  return               { text: 'Soft · Delicate',          textZh: '弱·轻盈',  bg: '#f0fdf4', fg: '#166534' }
  void lang
}

function timbreTag(brightNorm: number, hz: number, lang: Lang): DimLabel {
  if (brightNorm > 0.80) return { text: `${Math.round(hz)}Hz · Piercing`,  textZh: `${Math.round(hz)}Hz 尖锐·刺激`, bg: '#fca5a5', fg: '#7f1d1d' }
  if (brightNorm > 0.60) return { text: `${Math.round(hz)}Hz · Bright`,    textZh: `${Math.round(hz)}Hz 明亮·清脆`, bg: '#fef9c3', fg: '#78350f' }
  if (brightNorm > 0.40) return { text: `${Math.round(hz)}Hz · Balanced`,  textZh: `${Math.round(hz)}Hz 均衡·温润`, bg: '#f3f4f6', fg: '#374151' }
  if (brightNorm > 0.20) return { text: `${Math.round(hz)}Hz · Mellow`,    textZh: `${Math.round(hz)}Hz 柔和·温暖`, bg: '#d1fae5', fg: '#065f46' }
  return                  { text: `${Math.round(hz)}Hz · Dark`,             textZh: `${Math.round(hz)}Hz 暗沉·厚重`, bg: '#e0e7ff', fg: '#3730a3' }
  void lang
}

/**
 * Map normalised spectral centroid → texture tier (0–4).
 * 0 = Piercing (dense vertical lines)
 * 1 = Bright   (dense dots)
 * 2 = Balanced (solid, no texture)
 * 3 = Mellow   (sparse diagonal lines)
 * 4 = Dark     (coarse grid)
 */
function textureTier(brightNorm: number): 0 | 1 | 2 | 3 | 4 {
  if (brightNorm > 0.80) return 0
  if (brightNorm > 0.60) return 1
  if (brightNorm > 0.40) return 2
  if (brightNorm > 0.20) return 3
  return 4
}

function pitchTag(pitchNorm: number | null, avgSt: number | null, lang: Lang): DimLabel {
  if (pitchNorm === null || avgSt === null)
    return { text: 'No pYIN data', textZh: '无音高数据', bg: '#f3f4f6', fg: '#9ca3af' }
  if (pitchNorm > 0.65) return { text: `+${avgSt.toFixed(1)}st · High/Floating`, textZh: `+${avgSt.toFixed(1)}半音 高音·飘逸`, bg: '#ede9fe', fg: '#5b21b6' }
  if (pitchNorm > 0.35) return { text: `${avgSt.toFixed(1)}st · Mid/Balanced`,   textZh: `${avgSt.toFixed(1)}半音 中音·平稳`, bg: '#f3f4f6', fg: '#374151' }
  return                 { text: `${avgSt.toFixed(1)}st · Low/Grounded`,          textZh: `${avgSt.toFixed(1)}半音 低音·沉稳`, bg: '#f1f5f9', fg: '#475569' }
  void lang
}

// ── Color wheel (Figure 3) ────────────────────────────────────────────

function cofHue(cofIndex: number): number {
  return (195 + cofIndex * 30) % 360
}

// ── Other helpers ─────────────────────────────────────────────────────

function avgMidiRelative(seg: Segment): number | null {
  const mr = seg.features.pitch_contour?.midi_relative
  if (!mr || mr.length === 0) return null
  return mr.reduce((a, b) => a + b, 0) / mr.length
}

function tonicCofIndex(seg: Segment): { cofIndex: number; isMajor: boolean; fromPYIN: boolean } {
  const pc = seg.features.pitch_contour
  if (pc && pc.tonic_semitone !== undefined && !pc.error)
    return { cofIndex: (pc.tonic_semitone * 7) % 12, isMajor: pc.is_major ?? true, fromPYIN: true }
  return { cofIndex: seg.features.dominant_pitch.cof_index, isMajor: true, fromPYIN: false }
}


/**
 * Build SVG polygon points string for a 12-vertex pitch-class radar.
 * Vertices are arranged clockwise from 12 o'clock, one per semitone (C, C#, …, B).
 * Each vertex's radial distance is interpolated between innerR (value=0) and outerR (value=peak).
 * Normalisation: per-segment peak → the dominant note always reaches outerR,
 * so the polygon shape shows the relative harmonic profile.
 * The overall outerR is controlled by RMS so louder segments appear larger.
 */
function radarPolyPts(
  cx: number, cy: number,
  chroma: number[],   // 12 values, chromatic (semitone) order
  outerR: number,     // max vertex radius  (= baseR, driven by RMS)
  innerR: number,     // min vertex radius  (= baseR * 0.28, small inner hole)
): string {
  const localMax = Math.max(...chroma, 0.01)
  return chroma.map((val, pc) => {
    const angle = (pc / 12) * 2 * Math.PI - Math.PI / 2   // 12 o'clock start, clockwise
    const r     = innerR + (val / localMax) * (outerR - innerR)
    return `${(cx + Math.cos(angle) * r).toFixed(2)},${(cy + Math.sin(angle) * r).toFixed(2)}`
  }).join(' ')
}

// ── Component ─────────────────────────────────────────────────────────

export function MentalLandscapePage({ data, theme, isDark, lang, selectedSeg, onSegSelect }: Props) {
  const [tooltip,        setTooltip      ] = useState<{ seg: Segment; svgX: number; svgY: number } | null>(null)
  const [showSemantic,   setShowSemantic ] = useState(true)
  const [showRussell,    setShowRussell  ] = useState(true)
  const [hoveredDot,     setHoveredDot   ] = useState<number | null>(null)
  const segments = data.segments
  const N        = segments.length
  const SVG_W    = PAD_X * 2 + N * CELL_W

  // ── Global normalisation ──────────────────────────────────────────

  const allRms    = segments.map(s => s.features.rms_mean)
  const minRms = Math.min(...allRms), maxRms = Math.max(...allRms)
  const normRms   = (v: number) => maxRms === minRms ? 0.5 : (v - minRms) / (maxRms - minRms)

  const allOnset  = segments.map(s => s.features.onset_density)
  const minOd = Math.min(...allOnset), maxOd = Math.max(...allOnset)
  const normOnset = (v: number) => maxOd === minOd ? 0.5 : (v - minOd) / (maxOd - minOd)

  const allCent   = segments.map(s => s.features.spectral_centroid_mean)
  const minCent = Math.min(...allCent), maxCent = Math.max(...allCent)
  const normCent  = (v: number) => maxCent === minCent ? 0 : (v - minCent) / (maxCent - minCent)

  const allCons   = segments.map(s => Math.max(...s.features.chroma_cof))
  const minCons = Math.min(...allCons), maxCons = Math.max(...allCons)
  const normCons  = (v: number) => maxCons === minCons ? 0.5 : (v - minCons) / (maxCons - minCons)

  // Fixed geometry for Theme ghost polygon
  const themeChromaFixed = segments[0].features.chroma_chromatic

  const pitchVals    = segments.map(avgMidiRelative)
  const hasPitch     = pitchVals.some(v => v !== null)
  const validPitches = pitchVals.filter((v): v is number => v !== null)
  const minPitch     = hasPitch ? Math.min(...validPitches) : 0
  const maxPitch     = hasPitch ? Math.max(...validPitches) : 1
  const normPitch    = (v: number | null): number => {
    if (v === null || maxPitch === minPitch) return 0.5
    return (v - minPitch) / (maxPitch - minPitch)
  }

  // ── Per-glyph data ────────────────────────────────────────────────

  const glyphs = segments.map((seg, i) => {
    const f = seg.features
    const { cofIndex, isMajor, fromPYIN } = tonicCofIndex(seg)

    const hue     = cofHue(cofIndex)
    const sat     = isMajor ? 65 : 52
    const lit     = isMajor ? 52 : 40

    const rNorm   = normRms(f.rms_mean)
    const oNorm   = normOnset(f.onset_density)
    const cNorm   = normCent(f.spectral_centroid_mean)
    const consN   = normCons(Math.max(...f.chroma_cof))
    const pVal    = pitchVals[i]
    const pNorm   = normPitch(pVal)

    // Size → RMS (single loudness channel)
    const baseR   = 14 + rNorm * (GLYPH_R - 14)   // outer vertex radius (14–30px)
    const innerR  = baseR * 0.28

    // fillOpacity: fixed per mode (no channel wasted on rhythm)
    const opacity = isMajor ? 0.70 : 0.55

    // Timbre tier → Blur Halo intensity (0=Piercing strongest, 4=Dark no halo)
    const tier    = textureTier(cNorm)

    // Onset density → concentric ring count (1 = none beyond guide, up to 4)
    const nRings  = 1 + Math.round(oNorm * 3)       // 1–4

    // 12-vertex pitch-class radar polygon (chromatic/semitone order)
    const polyPts = radarPolyPts(0, 0, f.chroma_chromatic, baseR, innerR)

    const cx = PAD_X + i * CELL_W + CELL_W / 2
    const cy = CENTER_Y + (0.5 - pNorm) * Y_RANGE

    // ── Semantic scores ──────────────────────────────────────────
    // Arousal: tempo(onset) + loudness + pitch height + timbre brightness
    // Weights per Yang & Chen (2012) §3 / Gabrielsson & Lindström (2001)
    const arousal = oNorm * 0.40 + rNorm * 0.30 + pNorm * 0.15 + cNorm * 0.15

    // Valence: mode + harmony consonance + rhythm regularity (fluency)
    // flowing/fluent rhythm → positive valence  [Yang & Chen 2012 §3.3]
    // rhythm_regularity falls back to 0.5 when absent (old JSON files)
    const rhythmReg = f.rhythm_regularity ?? 0.5
    const valence = isMajor
      ? 0.48 + consN * 0.32 + rhythmReg * 0.20
      : 0.30 - consN * 0.20 + rhythmReg * 0.10
    const brightness = cNorm

    const hevner = pickHevner(arousal, valence, brightness, pNorm)

    // Dimension tags
    const tagValence = valenceTag(valence, isMajor, lang)
    const tagArousal = arousalTag(arousal, f.onset_density, lang)
    const tagPower   = powerTag(rNorm, lang)
    const tagTimbre  = timbreTag(cNorm, f.spectral_centroid_mean, lang)
    const tagPitch   = pitchTag(pNorm, pVal, lang)

    return {
      seg, i, hue, sat, lit,
      baseR, innerR, polyPts,
      opacity, tier, nRings,
      cx, cy, isMajor, fromPYIN, cofIndex,
      arousal, valence, brightness, pNorm,
      hevner,
      tagValence, tagArousal, tagPower, tagTimbre, tagPitch,
    }
  })

  // ── Helpers ───────────────────────────────────────────────────────

  function Chip({ text, bg, fg, size = 9 }: { text: string; bg: string; fg: string; size?: number }) {
    return (
      <span style={{
        display: 'inline-block',
        padding: '2px 6px',
        borderRadius: 4,
        background: bg,
        color: fg,
        fontSize: size,
        fontWeight: 500,
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      }}>
        {text}
      </span>
    )
  }

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div style={{ fontFamily: theme.fontFamily }}>

      {/* Title */}
      <div style={{
        display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8,
        padding: '8px 14px 4px',
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: theme.labelColor }}>
          {lang === 'zh' ? '心理图景 · Mental Landscape' : 'Mental Landscape'}
        </span>
        <span style={{ fontSize: 10, color: theme.labelSecondaryColor }}>
          {lang === 'zh'
            ? '多边形=音级雷达 · 同心环=节奏密度 · 大小=响度 · 光晕=音色亮度 · 纵位=旋律高度 · 虚线=主题基准'
            : 'Polygon=pitch-class radar · Rings=rhythm density · Size=loudness · Halo=timbre brightness · Y=pitch · Dashed=Theme ref'}
        </span>
      </div>

      {/* SVG */}
      <div style={{ overflowX: 'auto' }}>
        <svg
          width={SVG_W} height={SVG_H}
          style={{ display: 'block', overflow: 'visible' }}
          onMouseLeave={() => setTooltip(null)}
        >
          {/* Pitch baseline */}
          <line x1={PAD_X} y1={CENTER_Y} x2={SVG_W - PAD_X} y2={CENTER_Y}
            stroke={theme.labelSecondaryColor} strokeWidth={0.5} strokeDasharray="3,5" opacity={0.18} />
          {hasPitch && (
            <text x={PAD_X - 6} y={CENTER_Y + 3.5} textAnchor="end" fontSize={7.5}
              fill={theme.labelSecondaryColor} opacity={0.38}>
              {lang === 'zh' ? '中音' : 'mid'}
            </text>
          )}
          {hasPitch && (
            <g opacity={0.22}>
              <text x={PAD_X - 6} y={CENTER_Y - Y_RANGE / 2 + 4} textAnchor="end" fontSize={7}
                fill={theme.labelSecondaryColor}>↑</text>
              <text x={PAD_X - 6} y={CENTER_Y + Y_RANGE / 2 + 4} textAnchor="end" fontSize={7}
                fill={theme.labelSecondaryColor}>↓</text>
            </g>
          )}

          {/* Blur filter defs — shared by all glyphs; tier 0=strongest, 1=medium, 2-4=none */}
          <defs>
            <filter id="halo-0" x="-70%" y="-70%" width="240%" height="240%">
              <feGaussianBlur stdDeviation="7"/>
            </filter>
            <filter id="halo-1" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4"/>
            </filter>
          </defs>

          {/* Glyphs */}
          {glyphs.map(g => {
            const { seg, hue, sat, lit, baseR, innerR, opacity, tier, nRings, cx, cy, isMajor, fromPYIN, hevner } = g
            const tonicHsl  = `hsl(${hue},${sat}%,${lit}%)`
            const strokeHsl = `hsl(${hue},${Math.round(sat * 0.85)}%,${lit - 14}%)`
            const dotFill   = isMajor
              ? `hsl(${hue},${Math.round(sat * 0.55)}%,${lit + 24}%)`
              : `hsl(${hue},${Math.round(sat * 0.75)}%,${lit - 20}%)`
            const badgeBg   = `hsl(${hevner.hue},60%,93%)`
            const badgeFg   = `hsl(${hevner.hue},55%,30%)`
            const isTheme  = seg.label === 'T'
            const ghostPts = radarPolyPts(cx, cy, themeChromaFixed, baseR, innerR)

            return (
              <g key={seg.label}
                onMouseEnter={e => {
                  const svgEl = (e.target as SVGElement).closest('svg')!
                  const br = svgEl.getBoundingClientRect()
                  setTooltip({ seg, svgX: e.clientX - br.left, svgY: e.clientY - br.top })
                }}
                onMouseLeave={() => setTooltip(null)}
                onClick={() => onSegSelect?.(g.i)}
                style={{
                  cursor: 'pointer',
                  opacity: selectedSeg !== null && selectedSeg !== g.i ? 0.20 : 1,
                  transition: 'opacity 0.18s',
                }}
              >
                {/* ── Blur Halo (timbre brightness, tier 0–1 only) ──────── */}
                {tier <= 1 && (
                  <polygon
                    points={radarPolyPts(cx, cy, seg.features.chroma_chromatic, baseR, innerR)}
                    fill={tonicHsl}
                    fillOpacity={tier === 0 ? 0.52 : 0.36}
                    stroke="none"
                    filter={`url(#halo-${tier})`}
                  />
                )}

                {/* ── Theme ghost silhouette ────────────────────────── */}
                {!isTheme && (
                  <polygon points={ghostPts}
                    fill="rgba(148,163,184,0.14)"
                    stroke={isDark ? 'rgba(148,163,184,0.35)' : 'rgba(100,116,139,0.30)'}
                    strokeWidth={0.7}
                    strokeDasharray="2 1.5"
                  />
                )}

                {/* ── Pitch-class radar polygon ─────────────────────── */}
                <polygon
                  points={radarPolyPts(cx, cy, seg.features.chroma_chromatic, baseR, innerR)}
                  fill={tonicHsl}
                  fillOpacity={opacity}
                  stroke={strokeHsl}
                  strokeWidth={0.9}
                />

                {/* ── Concentric rings (onset density / rhythm) ─────── */}
                {Array.from({ length: nRings - 1 }, (_, ri) => (
                  <circle key={ri}
                    cx={cx} cy={cy}
                    r={baseR + (ri + 1) * 7}
                    fill="none"
                    stroke={tonicHsl}
                    strokeWidth={0.8 - ri * 0.15}
                    opacity={0.32 - ri * 0.07}
                  />
                ))}

                {/* Outer guide circle (always present, dashed) */}
                <circle cx={cx} cy={cy} r={baseR}
                  fill="none"
                  stroke={isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)'}
                  strokeWidth={0.6} strokeDasharray="2 3"
                />

                {/* Selection ring */}
                {selectedSeg === g.i && (
                  <circle cx={cx} cy={cy} r={baseR + 9}
                    fill="none" stroke="#4361EE" strokeWidth={2.5} opacity={0.9}
                  />
                )}

                {/* Mode dot */}
                <circle cx={cx} cy={cy} r={2.8} fill={dotFill} fillOpacity={0.92} />

                {/* Segment label */}
                <text x={cx} y={LABEL_Y} textAnchor="middle"
                  fontSize={seg.label.startsWith('V') ? 10 : 9}
                  fontWeight={seg.label.startsWith('V') ? 600 : 400}
                  fill={theme.labelColor}>
                  {seg.label}
                </text>

                {/* Key */}
                <text x={cx} y={KEY_Y} textAnchor="middle" fontSize={8}
                  fill={theme.labelSecondaryColor}>
                  {fromPYIN
                    ? `${seg.features.pitch_contour!.tonic_name}${isMajor ? '' : 'm'}`
                    : `${seg.features.dominant_pitch.name}*`}
                </text>

                {/* Semantic emoji */}
                <text x={cx} y={EMOJI_Y} textAnchor="middle" fontSize={12}
                  style={{ userSelect: 'none' }}>
                  {hevner.emoji}
                </text>

                {/* Hevner label — pill background */}
                <rect
                  x={cx - 22} y={SEMANTIC_Y - 9}
                  width={44} height={12} rx={4}
                  fill={badgeBg} opacity={0.92}
                />
                <text x={cx} y={SEMANTIC_Y} textAnchor="middle" fontSize={7.5}
                  fontWeight={600} fill={badgeFg}
                  style={{ userSelect: 'none' }}>
                  {lang === 'zh' ? hevner.labelZh : hevner.label}
                </text>
              </g>
            )
          })}

          {/* Tooltip */}
          {tooltip && (() => {
            const { seg, svgX, svgY } = tooltip
            const f = seg.features
            const g = glyphs.find(x => x.seg === seg)!
            const { isMajor, fromPYIN } = tonicCofIndex(seg)
            const tonicName = fromPYIN ? f.pitch_contour!.tonic_name : f.dominant_pitch.name
            const mr = f.pitch_contour?.midi_relative
            const avgPitch = mr && mr.length > 0 ? mr.reduce((a, b) => a + b, 0) / mr.length : null

            const TW = 240, TH = 122
            const tx = Math.min(svgX + 14, SVG_W - TW - 8)
            const ty = Math.max(svgY - TH - 10, 4)
            const modeStr = isMajor ? (lang === 'zh' ? ' 大调' : ' major') : (lang === 'zh' ? ' 小调' : ' minor')

            // ── Top-3 CoF peak overlap with Theme ────────────────────
            const top3 = (cof: number[]) =>
              cof.map((v, i) => ({ v, i }))
                 .sort((a, b) => b.v - a.v)
                 .slice(0, 3)
                 .map(x => x.i)
            const themeTop3  = new Set(top3(segments[0].features.chroma_cof))
            const segTop3    = top3(f.chroma_cof)
            const sharedKeys = segTop3.filter(k => themeTop3.has(k))
            const skelSim    = sharedKeys.length   // 0, 1, 2, or 3
            const skelLabel  = [' 0/3', ' 1/3', ' 2/3', ' 3/3'][skelSim]
            const skelNote   =
              skelSim === 3 ? (lang === 'zh' ? '结构完全保留' : 'Full skeleton retained')  :
              skelSim === 2 ? (lang === 'zh' ? '骨架基本稳固' : 'Skeleton mostly intact')  :
              skelSim === 1 ? (lang === 'zh' ? '部分结构偏移' : 'Partial skeleton shift')  :
                              (lang === 'zh' ? '骨架已完全离调' : 'Skeleton fully departed')

            const lines = [
              { k: lang === 'zh' ? '调性'   : 'Key',      v: `${tonicName}${modeStr}${fromPYIN ? ' (KS)' : ' (chroma)'}`, bold: true },
              { k: lang === 'zh' ? '节奏密度': 'Onset',    v: `${f.onset_density.toFixed(2)} /s` },
              { k: lang === 'zh' ? '响度 RMS': 'Loudness', v: f.rms_mean.toFixed(4) },
              { k: lang === 'zh' ? '频谱质心': 'Centroid', v: `${Math.round(f.spectral_centroid_mean)} Hz` },
              { k: lang === 'zh' ? '协和度峰值': 'Consonance', v: Math.max(...f.chroma_cof).toFixed(3) },
              ...(avgPitch !== null ? [{ k: lang === 'zh' ? '旋律高度' : 'Melody ht.', v: `${avgPitch.toFixed(1)} st` }] : []),
              { k: lang === 'zh' ? '主题骨架相似度' : 'Theme skeleton sim.',
                v: `${skelLabel}  ${skelNote}`, bold: skelSim === 3 },
              { k: '─────', v: '' },
              { k: lang === 'zh' ? '唤醒度' : 'Arousal',  v: `${(g.arousal * 100).toFixed(0)}%` },
              { k: lang === 'zh' ? '情感效价': 'Valence',  v: `${(g.valence * 100).toFixed(0)}%` },
              { k: lang === 'zh' ? '综合标签': 'Label',    v: `${g.hevner.emoji} ${lang === 'zh' ? g.hevner.labelZh : g.hevner.label} [Hevner ${g.hevner.group}]`, bold: true },
              { k: 'GEMS',  v: lang === 'zh' ? g.hevner.gemsZh : g.hevner.gems },
            ]
            const actualH = 14 + lines.length * 12 + 6

            return (
              <g style={{ pointerEvents: 'none' }}>
                <rect x={tx - 8} y={ty - 14} width={TW} height={actualH}
                  fill={isDark ? '#1b1b2d' : '#ffffff'}
                  stroke={isDark ? '#44445a' : '#d0d0d8'}
                  strokeWidth={0.8} rx={6} opacity={0.97} />
                {lines.map((row, ri) => (
                  <g key={ri}>
                    <text x={tx} y={ty + ri * 12} fontSize={8.2} fill={theme.labelSecondaryColor}>{row.k}{row.v ? ':' : ''}</text>
                    <text x={tx + 110} y={ty + ri * 12} fontSize={8.2}
                      fontWeight={row.bold ? 700 : 400} fill={theme.labelColor}>{row.v}</text>
                  </g>
                ))}
              </g>
            )
          })()}
        </svg>
      </div>

      {/* Legend */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16,
        padding: '0 16px 10px', fontSize: 9, color: theme.labelSecondaryColor,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={108} height={28}>
            {Array.from({ length: 12 }, (_, i) => (
              <rect key={i} x={i * 9} y={0} width={9.5} height={14} fill={`hsl(${(195 + i * 30) % 360},65%,52%)`} />
            ))}
            {[0,3,6,9].map(i => {
              const names = ['C','G','D','A','E','B','F#','Db','Ab','Eb','Bb','F']
              return <text key={i} x={i*9+4.5} y={26} textAnchor="middle" fontSize={7} fill="#888">{names[i]}</text>
            })}
          </svg>
          <span style={{ marginTop: 8 }}>{lang === 'zh' ? '色相=调性（五度圈）' : 'Hue=key (CoF)'}</span>
        </div>
        {/* Radar polygon legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={48} height={28} style={{ overflow: 'visible' }}>
            {/* Two polygons: ghost theme + coloured variation */}
            <polygon
              points={radarPolyPts(12, 14, [0.9,0.1,0.6,0.1,0.8,0.1,0.3,0.1,0.5,0.1,0.7,0.1], 11, 3)}
              fill="rgba(148,163,184,0.20)" stroke="rgba(100,116,139,0.45)" strokeWidth={0.7} strokeDasharray="2 1.5"
            />
            <polygon
              points={radarPolyPts(12, 14, [0.6,0.1,0.9,0.1,0.4,0.1,0.7,0.1,0.3,0.1,0.8,0.1], 11, 3)}
              fill="hsl(210,65%,52%)" fillOpacity={0.45} stroke="hsl(210,55%,38%)" strokeWidth={0.9}
            />
            <polygon
              points={radarPolyPts(36, 14, [0.9,0.1,0.6,0.1,0.8,0.1,0.3,0.1,0.5,0.1,0.7,0.1], 11, 3)}
              fill="rgba(148,163,184,0.20)" stroke="rgba(100,116,139,0.45)" strokeWidth={0.7} strokeDasharray="2 1.5"
            />
            <polygon
              points={radarPolyPts(36, 14, [0.3,0.1,0.7,0.1,0.9,0.1,0.2,0.1,0.6,0.1,0.4,0.1], 11, 3)}
              fill="hsl(30,65%,52%)" fillOpacity={0.45} stroke="hsl(30,55%,38%)" strokeWidth={0.9}
            />
          </svg>
          <span style={{ lineHeight: 1.3 }}>
            {lang === 'zh'
              ? <span>多边形=音级雷达图<br/><span style={{ opacity: 0.65 }}>虚线轮廓=主题基准</span></span>
              : <span>Polygon=pitch-class radar<br/><span style={{ opacity: 0.65 }}>Dashed=Theme reference</span></span>}
          </span>
        </div>
        {/* Concentric rings legend — onset/rhythm density */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={86} height={26} style={{ overflow: 'visible' }}>
            {([1, 2, 3, 4] as const).map((nr, i) => {
              const cx = [9, 28, 52, 76][i], cy = 13, baseR = 7
              return (
                <g key={i}>
                  <circle cx={cx} cy={cy} r={baseR}
                    fill="rgba(100,100,180,0.55)" stroke="rgba(70,70,140,0.4)" strokeWidth={0.7}/>
                  {Array.from({ length: nr - 1 }, (_, ri) => (
                    <circle key={ri} cx={cx} cy={cy} r={baseR + (ri + 1) * 5}
                      fill="none" stroke="rgba(70,70,140,0.55)"
                      strokeWidth={0.7 - ri * 0.12} opacity={0.35 - ri * 0.07}/>
                  ))}
                </g>
              )
            })}
          </svg>
          <span>{lang === 'zh' ? '同心环=节奏密度 (稀疏→致密)' : 'Rings=onset density (sparse→dense)'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={62} height={24} style={{ overflow: 'visible' }}>
            {([5, 9, 14, 20] as number[]).map((r, i) => (
              <circle key={i} cx={[5,16,31,52][i]} cy={12} r={r}
                fill="rgba(100,100,120,0.62)"
                stroke="rgba(100,100,120,0.35)" strokeWidth={0.7}/>
            ))}
          </svg>
          <span>{lang === 'zh' ? '大小=响度 (单通道)' : 'Size=loudness (single channel)'}</span>
        </div>
        {/* Blur halo legend — timbre brightness */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={115} height={28} style={{ overflow: 'visible' }}>
            <defs>
              <filter id="leg-halo-0" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="6"/>
              </filter>
              <filter id="leg-halo-1" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="3.5"/>
              </filter>
            </defs>
            {([
              { label: 'Piercing', hue: 0,   filterId: 'leg-halo-0', haloOp: 0.50 },
              { label: 'Bright',   hue: 45,  filterId: 'leg-halo-1', haloOp: 0.36 },
              { label: 'Balanced', hue: 145, filterId: null,          haloOp: 0    },
              { label: 'Mellow',   hue: 180, filterId: null,          haloOp: 0    },
              { label: 'Dark',     hue: 225, filterId: null,          haloOp: 0    },
            ] as const).map(({ hue, filterId, haloOp }, i) => {
              const cx = 10 + i * 23, cy = 14, r = 7
              const fill = `hsl(${hue},60%,52%)`
              return (
                <g key={i}>
                  {filterId && (
                    <circle cx={cx} cy={cy} r={r} fill={fill} fillOpacity={haloOp}
                      stroke="none" filter={`url(#${filterId})`}/>
                  )}
                  <circle cx={cx} cy={cy} r={r} fill={fill} fillOpacity={0.70}
                    stroke={`hsl(${hue},50%,38%)`} strokeWidth={0.7}/>
                </g>
              )
            })}
          </svg>
          <span>{lang === 'zh' ? '光晕=音色 (尖锐→厚重)' : 'Halo=timbre (Piercing→Dark)'}</span>
        </div>
        {hasPitch && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <svg width={22} height={26} style={{ overflow: 'visible' }}>
              <line x1={11} y1={2} x2={11} y2={24} stroke={theme.labelSecondaryColor} strokeWidth={1} strokeDasharray="2,2" opacity={0.4}/>
              <circle cx={11} cy={5}  r={4.5} fill="hsl(195,65%,52%)" fillOpacity={0.85}/>
              <circle cx={11} cy={21} r={4.5} fill="hsl(255,65%,44%)" fillOpacity={0.85}/>
            </svg>
            <span>{lang === 'zh' ? '纵位=旋律音高' : 'Y=melodic pitch'}</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={34} height={16}>
            <circle cx={7}  cy={8} r={4.5} fill="hsl(195,40%,82%)"/>
            <circle cx={26} cy={8} r={4.5} fill="hsl(195,50%,22%)"/>
          </svg>
          <span>{lang === 'zh' ? '中心点:亮=大调 暗=小调' : 'Dot:bright=major·dark=minor'}</span>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          RUSSELL CIRCUMPLEX PANEL
          Russell (1980) 情感平面 — 唤醒度 × 情感效价轨迹
      ══════════════════════════════════════════════════════════════ */}
      <div style={{
        margin: '0 14px 10px',
        border: `1px solid ${isDark ? '#2d2d45' : '#e5e7eb'}`,
        borderRadius: 8, fontSize: 9,
      }}>
        {/* Panel header */}
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '7px 12px',
            background: isDark ? '#1a1a2e' : '#f8fafc',
            borderBottom: showRussell ? `1px solid ${isDark ? '#2d2d45' : '#e5e7eb'}` : 'none',
            cursor: 'pointer',
          }}
          onClick={() => setShowRussell(s => !s)}
        >
          <span style={{ fontWeight: 700, fontSize: 10, color: theme.labelColor }}>
            {lang === 'zh'
              ? ' 情感轨迹 · Russell (1980) 唤醒 × 效价平面'
              : ' Emotion Trajectory · Russell (1980) Arousal × Valence Plane'}
          </span>
          <span style={{ fontSize: 10, color: theme.labelSecondaryColor }}>
            {showRussell ? '▲' : '▼'}
          </span>
        </div>

        {showRussell && (() => {
          // Map arousal/valence [0,1] to SVG inner coords
          const toX = (v: number) => RC_PAD + v * RC_PW
          const toY = (a: number) => RC_PAD + (1 - a) * RC_PH

          // Quadrant descriptors for Russell (1980) circumplex
          // X = Valence (→ right = positive), Y = Arousal (↑ = high)
          const qZones = [
            {
              // Top-right: High Arousal + Positive Valence
              x: RC_PAD + RC_PW * 0.73, y: RC_PAD + RC_PH * 0.10,
              en: 'Energetic / Excited',   zh: '兴奋活力',
              subEn: 'Alert · Active · Elated', subZh: '警觉·活跃·激昂',
              fill: '#fee2e2',
            },
            {
              // Top-left: High Arousal + Negative Valence
              x: RC_PAD + RC_PW * 0.20, y: RC_PAD + RC_PH * 0.10,
              en: 'Tense / Distressed',     zh: '紧张焦虑',
              subEn: 'Anxious · Angry · Afraid', subZh: '焦虑·愤怒·恐惧',
              fill: '#fef3c7',
            },
            {
              // Bottom-right: Low Arousal + Positive Valence
              x: RC_PAD + RC_PW * 0.73, y: RC_PAD + RC_PH * 0.94,
              en: 'Calm / Relaxed',         zh: '平静放松',
              subEn: 'Serene · Content · Happy', subZh: '宁静·满足·愉快',
              fill: '#dcfce7',
            },
            {
              // Bottom-left: Low Arousal + Negative Valence
              x: RC_PAD + RC_PW * 0.20, y: RC_PAD + RC_PH * 0.94,
              en: 'Depressed / Sad',        zh: '忧郁低落',
              subEn: 'Melancholic · Bored · Tired', subZh: '忧郁·沉闷·疲倦',
              fill: '#dbeafe',
            },
          ]

          return (
            <div style={{
              display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16,
              padding: '12px 16px 14px',
              background: isDark ? '#161626' : '#ffffff',
            }}>
              {/* SVG plot + Y-axis label */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                {/* Arousal label — pure HTML, no SVG clipping issues */}
                <div style={{
                  writingMode: 'vertical-rl',
                  transform: 'rotate(180deg)',
                  fontSize: 8.5,
                  color: isDark ? '#666' : '#94a3b8',
                  height: RC_H,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  userSelect: 'none',
                }}>
                  {lang === 'zh' ? '唤醒度 ↑' : 'Arousal ↑'}
                </div>
              <svg width={RC_W} height={RC_H} style={{ flexShrink: 0, overflow: 'visible' }}>
                <defs>
                  {/* Halo filters for mini glyph in hover tooltip */}
                  <filter id="rc-halo-0" x="-80%" y="-80%" width="260%" height="260%">
                    <feGaussianBlur stdDeviation="5"/>
                  </filter>
                  <filter id="rc-halo-1" x="-60%" y="-60%" width="220%" height="220%">
                    <feGaussianBlur stdDeviation="3"/>
                  </filter>
                </defs>

                {/* Background quadrant tints */}
                <rect x={RC_PAD + RC_PW/2} y={RC_PAD}            width={RC_PW/2} height={RC_PH/2} fill="#fee2e2" opacity={0.25} />
                <rect x={RC_PAD}           y={RC_PAD}            width={RC_PW/2} height={RC_PH/2} fill="#fef3c7" opacity={0.25} />
                <rect x={RC_PAD + RC_PW/2} y={RC_PAD + RC_PH/2} width={RC_PW/2} height={RC_PH/2} fill="#dcfce7" opacity={0.25} />
                <rect x={RC_PAD}           y={RC_PAD + RC_PH/2} width={RC_PW/2} height={RC_PH/2} fill="#dbeafe" opacity={0.25} />

                {/* Axes */}
                <line x1={RC_PAD} y1={RC_PAD + RC_PH/2} x2={RC_PAD + RC_PW} y2={RC_PAD + RC_PH/2}
                  stroke={isDark ? '#44445a' : '#cbd5e1'} strokeWidth={1.0} />
                <line x1={RC_PAD + RC_PW/2} y1={RC_PAD} x2={RC_PAD + RC_PW/2} y2={RC_PAD + RC_PH}
                  stroke={isDark ? '#44445a' : '#cbd5e1'} strokeWidth={1.0} />

                {/* Axis labels */}
                <text x={RC_PAD + RC_PW + 4} y={RC_PAD + RC_PH/2 + 4} fontSize={8.5} fill={isDark ? '#666' : '#94a3b8'}>
                  {lang === 'zh' ? '效价 →' : 'Valence →'}
                </text>
                {/* Axis end markers */}
                <text x={RC_PAD + 3} y={RC_PAD + RC_PH/2 - 5} fontSize={7} fill={isDark ? '#484860' : '#b0bec5'}>
                  {lang === 'zh' ? '负效价' : '− Valence'}
                </text>
                <text x={RC_PAD + RC_PW - 3} y={RC_PAD + RC_PH/2 - 5} fontSize={7} fill={isDark ? '#484860' : '#b0bec5'} textAnchor="end">
                  {lang === 'zh' ? '正效价' : '+ Valence'}
                </text>
                <text x={RC_PAD + RC_PW/2 + 5} y={RC_PAD + 10} fontSize={7} fill={isDark ? '#484860' : '#b0bec5'}>
                  {lang === 'zh' ? '高唤醒' : 'High'}
                </text>
                <text x={RC_PAD + RC_PW/2 + 5} y={RC_PAD + RC_PH - 3} fontSize={7} fill={isDark ? '#484860' : '#b0bec5'}>
                  {lang === 'zh' ? '低唤醒' : 'Low'}
                </text>

                {/* Quadrant zone labels with descriptions */}
                {qZones.map((q, qi) => (
                  <g key={qi}>
                    <text x={q.x} y={q.y} fontSize={9} textAnchor="middle"
                      fontWeight={600} fill={isDark ? '#5a5a7a' : '#6b7280'}>
                      {lang === 'zh' ? q.zh : q.en}
                    </text>
                    <text x={q.x} y={q.y + 13} fontSize={7} textAnchor="middle"
                      fill={isDark ? '#40405a' : '#94a3b8'} fontStyle="italic">
                      {lang === 'zh' ? q.subZh : q.subEn}
                    </text>
                  </g>
                ))}

                {/* Trajectory polyline */}
                <polyline
                  points={glyphs.map(g => `${toX(g.valence).toFixed(1)},${toY(g.arousal).toFixed(1)}`).join(' ')}
                  fill="none"
                  stroke={isDark ? '#44445a' : '#cbd5e1'}
                  strokeWidth={1.2}
                  strokeDasharray="3,3"
                />

                {/* Dots */}
                {glyphs.map((g, gi) => {
                  const px = toX(g.valence)
                  const py = toY(g.arousal)
                  const isHov = hoveredDot === gi
                  const r = isHov ? 7.5 : 6

                  // ── Mini glyph params for hover tooltip ──────────────
                  const tipW = 168, tipH = 110
                  const tipX = Math.max(4, px > RC_W * 0.55 ? px - tipW - 10 : px + r + 10)
                  const tipY = Math.max(4, Math.min(py - tipH / 2, RC_H - tipH - 4))
                  const miniR      = 24
                  const miniInnerR = miniR * 0.28
                  const miniCx     = tipX + 32
                  const miniCy     = tipY + tipH / 2
                  const miniPolyPts = radarPolyPts(miniCx, miniCy, g.seg.features.chroma_chromatic, miniR, miniInnerR)
                  const tonicHsl   = `hsl(${g.hue},${g.sat}%,${g.lit}%)`
                  const strokeHsl  = `hsl(${g.hue},${Math.round(g.sat * 0.85)}%,${g.lit - 14}%)`
                  const dotFill    = g.isMajor
                    ? `hsl(${g.hue},${Math.round(g.sat * 0.55)}%,${g.lit + 24}%)`
                    : `hsl(${g.hue},${Math.round(g.sat * 0.75)}%,${g.lit - 20}%)`

                  return (
                    <g key={gi}
                      onMouseEnter={() => setHoveredDot(gi)}
                      onMouseLeave={() => setHoveredDot(null)}
                      onClick={() => onSegSelect?.(gi)}
                      style={{ cursor: 'pointer' }}
                    >
                      <circle cx={px} cy={py} r={r + 3} fill={`hsl(${g.hue},60%,60%)`} opacity={0.15} />
                      <circle cx={px} cy={py} r={r}
                        fill={`hsl(${g.hue},${g.sat}%,${g.lit}%)`}
                        stroke={isDark ? '#1b1b2d' : '#fff'}
                        strokeWidth={isHov ? 1.8 : 1.3}
                        opacity={0.92}
                      />
                      {/* Segment label above dot */}
                      <text x={px} y={py - r - 2} textAnchor="middle" fontSize={7}
                        fill={isDark ? '#aaa' : '#64748b'} fontWeight={600}>
                        {g.seg.label}
                      </text>

                      {/* ── Hover tooltip with mini glyph ───────────── */}
                      {isHov && (
                        <g style={{ pointerEvents: 'none' }}>
                          {/* Tooltip background */}
                          <rect x={tipX} y={tipY} width={tipW} height={tipH} rx={6}
                            fill={isDark ? '#1b1b2d' : '#ffffff'}
                            stroke={isDark ? '#44445a' : '#d0d0d8'} strokeWidth={0.9} opacity={0.97} />

                          {/* Divider */}
                          <line x1={tipX + 64} y1={tipY + 6} x2={tipX + 64} y2={tipY + tipH - 6}
                            stroke={isDark ? '#2d2d45' : '#e5e7eb'} strokeWidth={0.7} />

                          {/* ── Mini glyph rendering ── */}
                          {/* Halo (timbre brightness tier) */}
                          {g.tier <= 1 && (
                            <polygon points={miniPolyPts}
                              fill={tonicHsl}
                              fillOpacity={g.tier === 0 ? 0.46 : 0.30}
                              stroke="none"
                              filter={`url(#rc-halo-${g.tier})`} />
                          )}
                          {/* Concentric rings (onset density) */}
                          {Array.from({ length: g.nRings - 1 }, (_, ri) => (
                            <circle key={ri} cx={miniCx} cy={miniCy}
                              r={miniR + (ri + 1) * 5}
                              fill="none" stroke={tonicHsl}
                              strokeWidth={0.55} opacity={0.26 - ri * 0.05} />
                          ))}
                          {/* Pitch-class radar polygon */}
                          <polygon points={miniPolyPts}
                            fill={tonicHsl} fillOpacity={g.opacity}
                            stroke={strokeHsl} strokeWidth={0.8} />
                          {/* Mode dot */}
                          <circle cx={miniCx} cy={miniCy} r={2.5} fill={dotFill} fillOpacity={0.92} />
                          {/* Segment label below mini glyph */}
                          <text x={miniCx} y={tipY + tipH - 9} textAnchor="middle"
                            fontSize={7.5} fontWeight={700} fill={theme.labelColor}>
                            {g.seg.label}
                          </text>

                          {/* ── Text info (right of divider) ── */}
                          <text x={tipX + 72} y={tipY + 20} fontSize={10} fontWeight={700}
                            fill={theme.labelColor}>
                            {g.hevner.emoji} {lang === 'zh' ? g.hevner.labelZh : g.hevner.label}
                          </text>
                          <text x={tipX + 72} y={tipY + 36} fontSize={8} fill={theme.labelSecondaryColor}>
                            {lang === 'zh' ? g.hevner.gemsZh : g.hevner.gems}
                          </text>
                          <text x={tipX + 72} y={tipY + 52} fontSize={8} fill={theme.labelSecondaryColor}>
                            {lang === 'zh'
                              ? `唤醒 ${(g.arousal * 100).toFixed(0)}%`
                              : `Arousal ${(g.arousal * 100).toFixed(0)}%`}
                          </text>
                          <text x={tipX + 72} y={tipY + 66} fontSize={8} fill={theme.labelSecondaryColor}>
                            {lang === 'zh'
                              ? `效价 ${(g.valence * 100).toFixed(0)}%`
                              : `Valence ${(g.valence * 100).toFixed(0)}%`}
                          </text>
                          <text x={tipX + 72} y={tipY + 81} fontSize={7.5} fill={theme.labelSecondaryColor}>
                            {(() => {
                              const { fromPYIN, isMajor } = g
                              const name = fromPYIN
                                ? g.seg.features.pitch_contour!.tonic_name
                                : g.seg.features.dominant_pitch.name
                              return `${name}${isMajor ? '' : 'm'}${fromPYIN ? '' : '*'}`
                            })()}
                          </text>
                          <text x={tipX + 72} y={tipY + 96} fontSize={7} fill={theme.labelSecondaryColor}>
                            Hevner {g.hevner.group}
                          </text>
                        </g>
                      )}
                    </g>
                  )
                })}
              </svg>
              </div>{/* end SVG + Arousal label wrapper */}

              {/* Legend / segment index */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 8.5, minWidth: 160 }}>
                <div style={{ fontWeight: 700, fontSize: 9.5, color: theme.labelColor, marginBottom: 2 }}>
                  {lang === 'zh' ? '各段情感坐标' : 'Segment emotions'}
                </div>
                {glyphs.map((g, gi) => (
                  <div key={gi}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      opacity: hoveredDot === null || hoveredDot === gi ? 1 : 0.35,
                      transition: 'opacity 0.15s',
                      cursor: 'default',
                    }}
                    onMouseEnter={() => setHoveredDot(gi)}
                    onMouseLeave={() => setHoveredDot(null)}
                  >
                    <svg width={12} height={12}>
                      <circle cx={6} cy={6} r={5.5}
                        fill={`hsl(${g.hue},${g.sat}%,${g.lit}%)`} opacity={0.9} />
                    </svg>
                    <span style={{ color: theme.labelColor, fontWeight: g.seg.label.startsWith('V') ? 700 : 400, minWidth: 22 }}>
                      {g.seg.label}
                    </span>
                    <span style={{ color: theme.labelSecondaryColor }}>
                      {g.hevner.emoji} {lang === 'zh' ? g.hevner.labelZh : g.hevner.label}
                    </span>
                    <span style={{ color: theme.labelSecondaryColor, marginLeft: 'auto', paddingLeft: 4, whiteSpace: 'nowrap' }}>
                      [{(g.valence * 100).toFixed(0)}, {(g.arousal * 100).toFixed(0)}]
                    </span>
                  </div>
                ))}
                <div style={{
                  marginTop: 8, paddingTop: 8,
                  borderTop: `1px solid ${isDark ? '#2d2d45' : '#e5e7eb'}`,
                  color: theme.labelSecondaryColor, fontSize: 7.5, lineHeight: 1.8,
                }}>
                  {lang === 'zh' ? (
                    <>虚线 = 时间顺序轨迹<br/>圆点颜色 = 五度圈调性<br/>Hover 圆点查看图形</>
                  ) : (
                    <>Dashed line = temporal order<br/>Dot color = CoF key<br/>Hover dot to view glyph</>
                  )}
                </div>
              </div>
            </div>
          )
        })()}
      </div>

      {/* ═══════════════ SEMANTIC ANNOTATION PANEL ═══════════════ */}
      <div style={{
        margin: '4px 14px 14px',
        border: `1px solid ${isDark ? '#2d2d45' : '#e5e7eb'}`,
        borderRadius: 8,
        overflow: 'hidden',
        fontSize: 9,
      }}>
        {/* Panel header */}
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '7px 12px',
            background: isDark ? '#1a1a2e' : '#f8fafc',
            borderBottom: `1px solid ${isDark ? '#2d2d45' : '#e5e7eb'}`,
            cursor: 'pointer',
          }}
          onClick={() => setShowSemantic(s => !s)}
        >
          <span style={{ fontWeight: 700, fontSize: 10, color: theme.labelColor }}>
            {lang === 'zh'
              ? ' 心理语义注释 · 基于 Hevner 形容词圆环 × GEMS 情绪量表'
              : ' Semantic Annotation · Hevner Adjective Circle × GEMS Emotion Scale'}
          </span>
          <span style={{ fontSize: 10, color: theme.labelSecondaryColor }}>
            {showSemantic ? '▲' : '▼'}
          </span>
        </div>

        {showSemantic && (
          <>
            {/* Column headers */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '36px 1fr 1.4fr 1fr 1fr 1fr 1fr',
              gap: '0 6px',
              padding: '5px 12px',
              background: isDark ? '#151525' : '#f1f5f9',
              borderBottom: `1px solid ${isDark ? '#2d2d45' : '#e2e8f0'}`,
              fontWeight: 700, color: theme.labelSecondaryColor, fontSize: 8.5,
            }}>
              <span>{lang === 'zh' ? '变奏' : 'Seg'}</span>
              <span>{lang === 'zh' ? ' 调性→情感效价' : ' Key → Valence'}</span>
              <span>{lang === 'zh' ? '⭐ 同心环→节奏密度' : '⭐ Rings → Rhythm density'}</span>
              <span>{lang === 'zh' ? ' 响度→力量感' : ' Loudness → Power'}</span>
              <span>{lang === 'zh' ? ' 音色→光晕 (5档)' : ' Timbre → Halo (5 tiers)'}</span>
              <span>{lang === 'zh' ? '↕ 旋律→音域' : '↕ Melody → Register'}</span>
              <span>{lang === 'zh' ? '综合标签' : 'Overall Label'}</span>
            </div>

            {/* Data rows */}
            {glyphs.map((g, rowIdx) => {
              const isVar = g.seg.label.startsWith('V')
              const rowBg = (rowIndex: number) => rowIndex % 2 === 0
                ? (isDark ? '#161626' : '#ffffff')
                : (isDark ? '#191930' : '#f8fafc')

              return (
                <div
                  key={g.seg.label}
                  onClick={() => onSegSelect?.(rowIdx)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '36px 1fr 1.4fr 1fr 1fr 1fr 1fr',
                    gap: '0 6px',
                    padding: '5px 12px',
                    alignItems: 'center',
                    background: selectedSeg === rowIdx
                      ? (isDark ? '#1e2a4a' : '#eff3ff')
                      : rowBg(rowIdx),
                    transition: 'background 0.15s',
                    cursor: 'pointer',
                    borderBottom: `1px solid ${isDark ? '#232340' : '#f1f5f9'}`,
                  }}
                >
                  {/* Segment label */}
                  <span style={{
                    fontWeight: isVar ? 700 : 400,
                    fontSize: isVar ? 10 : 9,
                    color: theme.labelColor,
                  }}>
                    {g.seg.label}
                  </span>

                  {/* Tonality → valence */}
                  <Chip
                    text={lang === 'zh' ? g.tagValence.textZh : g.tagValence.text}
                    bg={g.tagValence.bg} fg={g.tagValence.fg}
                  />

                  {/* Rhythm → arousal */}
                  <Chip
                    text={lang === 'zh' ? g.tagArousal.textZh : g.tagArousal.text}
                    bg={g.tagArousal.bg} fg={g.tagArousal.fg}
                  />

                  {/* Loudness → power */}
                  <Chip
                    text={lang === 'zh' ? g.tagPower.textZh : g.tagPower.text}
                    bg={g.tagPower.bg} fg={g.tagPower.fg}
                  />

                  {/* Timbre → texture tier */}
                  <Chip
                    text={lang === 'zh' ? g.tagTimbre.textZh : g.tagTimbre.text}
                    bg={g.tagTimbre.bg} fg={g.tagTimbre.fg}
                  />

                  {/* Melody height → register */}
                  <Chip
                    text={lang === 'zh' ? g.tagPitch.textZh : g.tagPitch.text}
                    bg={g.tagPitch.bg} fg={g.tagPitch.fg}
                  />

                  {/* Overall semantic label */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{
                      fontWeight: 700, fontSize: 9.5,
                      color: `hsl(${g.hevner.hue},55%,${isDark ? 70 : 30}%)`,
                    }}>
                      {g.hevner.emoji} {lang === 'zh' ? g.hevner.labelZh : g.hevner.label}
                    </span>
                    <span style={{ fontSize: 7.5, color: theme.labelSecondaryColor }}>
                      Hevner {g.hevner.group} · {lang === 'zh' ? g.hevner.gemsZh : g.hevner.gems}
                    </span>
                    <span style={{ fontSize: 7.5, color: theme.labelSecondaryColor }}>
                      {lang === 'zh'
                        ? `↑${(g.arousal*100).toFixed(0)}% ${(g.valence*100).toFixed(0)}%`
                        : `↑${(g.arousal*100).toFixed(0)}% ${(g.valence*100).toFixed(0)}%`}
                    </span>
                  </div>
                </div>
              )
            })}

            {/* Footer note */}
            <div style={{
              padding: '6px 12px',
              background: isDark ? '#151525' : '#f8fafc',
              color: theme.labelSecondaryColor, fontSize: 8,
              lineHeight: 1.6,
            }}>
              {lang === 'zh'
                ? '↑ 唤醒度 = onset×0.40 + RMS×0.30 + 音高×0.15 + 音色×0.15　 效价 = 大调: 0.48 + 协和×0.32 + 节奏流畅×0.20 / 小调: 0.30 − 协和×0.20 + 节奏流畅×0.10　· [Yang & Chen 2012]　· 标签依据 Hevner (1936)'
                : '↑ Arousal = onset×0.40 + RMS×0.30 + pitch×0.15 + timbre×0.15　 Valence = major: 0.48 + cons×0.32 + rhythm×0.20 / minor: 0.30 − cons×0.20 + rhythm×0.10　· [Yang & Chen 2012]　· Hevner (1936)'}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
