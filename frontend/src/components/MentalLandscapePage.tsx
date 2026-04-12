// MentalLandscapePage.tsx
// 心理图景 + 心理语义注释 — Mental Landscape + Semantic Annotation
//
// Visual dimensions (per glyph):
//   Shape       → pitch-class radar: 12 vertices (chromatic order), vertex radius = pitch-class energy
//   Stroke W    → chroma consonance (how sharply the ring peaks)
//   Ticks       → onset density  (arousal proxy, radial tick marks outside ring)
//   Size/Opacity→ RMS energy     (power proxy, scales the whole ring)
//   Corona      → spectral centroid brightness (timbre, outer glow)
//   Y position  → avg midi_relative (melodic register)
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
import type { Lang } from '../App'

interface Props {
  data:   PieceData
  theme:  ThemeTokens
  isDark: boolean
  lang:   Lang
}

// ── Russell circumplex constants ──────────────────────────────────────
const RC_W    = 200   // plot area width  (px)
const RC_H    = 180   // plot area height (px)
const RC_PAD  = 28    // axis label padding
const RC_PW   = RC_W - RC_PAD * 2   // inner plot width
const RC_PH   = RC_H - RC_PAD * 2   // inner plot height

// ── Layout constants ──────────────────────────────────────────────────

const CELL_W     = 90
const GLYPH_R    = 30
const CORONA_MAX = 18
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
  { group: 1, label: 'Vigorous',    labelZh: '雄健',   emoji: '💪', gems: 'Power',             gemsZh: '力量感',  hue: 20  },
  { group: 2, label: 'Triumphant',  labelZh: '激昂',   emoji: '⚡', gems: 'Power',             gemsZh: '力量感',  hue: 40  },
  { group: 3, label: 'Agitated',    labelZh: '激动',   emoji: '🌪️', gems: 'Tension',           gemsZh: '紧张',   hue: 0   },
  { group: 4, label: 'Sprightly',   labelZh: '活泼',   emoji: '🌟', gems: 'Joyful Activation', gemsZh: '欢快激活', hue: 55  },
  { group: 5, label: 'Joyful',      labelZh: '欢快',   emoji: '☀️', gems: 'Joyful Activation', gemsZh: '欢快激活', hue: 48  },
  { group: 6, label: 'Serene',      labelZh: '宁静',   emoji: '🌿', gems: 'Peacefulness',      gemsZh: '平和',   hue: 145 },
  { group: 7, label: 'Lyrical',     labelZh: '抒情',   emoji: '🎶', gems: 'Tenderness',        gemsZh: '温柔',   hue: 180 },
  { group: 8, label: 'Melancholic', labelZh: '忧郁',   emoji: '🌙', gems: 'Sadness',           gemsZh: '哀愁',   hue: 225 },
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
  if (brightNorm > 0.65) return { text: `${Math.round(hz)}Hz · Bright/Crisp`, textZh: `${Math.round(hz)}Hz 明亮·清脆`, bg: '#fef9c3', fg: '#78350f' }
  if (brightNorm > 0.35) return { text: `${Math.round(hz)}Hz · Balanced`,     textZh: `${Math.round(hz)}Hz 均衡·温润`, bg: '#f3f4f6', fg: '#374151' }
  return                  { text: `${Math.round(hz)}Hz · Dark/Heavy`,          textZh: `${Math.round(hz)}Hz 暗沉·厚重`, bg: '#e0e7ff', fg: '#3730a3' }
  void lang
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
    return { cofIndex: (pc.tonic_semitone * 7) % 12, isMajor: pc.is_major, fromPYIN: true }
  return { cofIndex: seg.features.dominant_pitch.cof_index, isMajor: true, fromPYIN: false }
}

function consonanceStrokeW(chromaCof: number[]): number {
  const peak = Math.max(...chromaCof)
  return 0.5 + Math.max(0, Math.min(1, (peak - 0.10) / 0.13)) * 3.3
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

export function MentalLandscapePage({ data, theme, isDark, lang }: Props) {
  const [tooltip,       setTooltip      ] = useState<{ seg: Segment; svgX: number; svgY: number } | null>(null)
  const [showSemantic,  setShowSemantic ] = useState(true)
  const [showRussell,   setShowRussell  ] = useState(true)
  const [hoveredDot,    setHoveredDot   ] = useState<number | null>(null)

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

  // Fixed geometry for Theme ghost polygon — always uses Theme segment's own RMS scale
  const themeRNorm  = normRms(segments[0].features.rms_mean)
  const themeBaseR  = 14 + themeRNorm * (GLYPH_R - 14)
  const themeInnerR = themeBaseR * 0.28
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
    const strokeW = consonanceStrokeW(f.chroma_cof)

    const rNorm   = normRms(f.rms_mean)
    const oNorm   = normOnset(f.onset_density)
    const cNorm   = normCent(f.spectral_centroid_mean)
    const consN   = normCons(Math.max(...f.chroma_cof))
    const pVal    = pitchVals[i]
    const pNorm   = normPitch(pVal)

    // Radar geometry — overall size driven by RMS
    const baseR   = 14 + rNorm * (GLYPH_R - 14)   // outer vertex radius (14–30px)
    const innerR  = baseR * 0.28                   // inner hole (small, keeps hollow centre)
    const opacity = 0.50 + rNorm * 0.42
    const coronaR = cNorm * CORONA_MAX

    // 12-vertex pitch-class radar polygon (chromatic/semitone order)
    const polyPts = radarPolyPts(0, 0, f.chroma_chromatic, baseR, innerR)

    // Onset density → radial tick marks outside the ring
    const nTicks  = Math.round(4 + oNorm * 12)       // 4–16 ticks
    const tickLen = 3 + oNorm * 5                     // 3–8 px

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
      seg, i, hue, sat, lit, strokeW,
      baseR, innerR, polyPts, nTicks, tickLen,
      opacity, coronaR,
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
            ? '多边形=音级雷达 · 刻度线=节奏密度 · 描边=协和度 · 大小=响度 · 外晕=音色 · 纵位=旋律高度 · 虚线=主题基准'
            : 'Polygon=pitch-class radar · Ticks=onset · Stroke=consonance · Size=loudness · Corona=timbre · Y=pitch · Dashed=Theme ref'}
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

          {/* Glyphs */}
          {glyphs.map(g => {
            const { seg, hue, sat, lit, strokeW, baseR, innerR, polyPts, nTicks, tickLen, opacity, coronaR, cx, cy, isMajor, fromPYIN, hevner } = g
            const tonicHsl  = `hsl(${hue},${sat}%,${lit}%)`
            const strokeHsl = `hsl(${hue},${Math.round(sat * 0.85)}%,${lit - 14}%)`
            const tickHsl   = `hsl(${hue},${Math.round(sat * 0.7)}%,${lit - 8}%)`
            const dotFill   = isMajor
              ? `hsl(${hue},${Math.round(sat * 0.55)}%,${lit + 24}%)`
              : `hsl(${hue},${Math.round(sat * 0.75)}%,${lit - 20}%)`
            const badgeBg   = `hsl(${hevner.hue},60%,93%)`
            const badgeFg   = `hsl(${hevner.hue},55%,30%)`
            const isTheme  = seg.label === 'T'
            // Theme ghost: use current variation's baseR/innerR so the ghost scales with the glyph
            const ghostPts = radarPolyPts(cx, cy, themeChromaFixed, baseR, innerR)

            return (
              <g key={seg.label}
                onMouseEnter={e => {
                  const svgEl = (e.target as SVGElement).closest('svg')!
                  const br = svgEl.getBoundingClientRect()
                  setTooltip({ seg, svgX: e.clientX - br.left, svgY: e.clientY - br.top })
                }}
                onMouseLeave={() => setTooltip(null)}
                style={{ cursor: 'crosshair' }}
              >
                {/* Corona (spectral centroid outer glow) */}
                {coronaR > 1.5 && (
                  <>
                    <circle cx={cx} cy={cy} r={baseR + coronaR}        fill={tonicHsl} fillOpacity={0.13} stroke="none" />
                    <circle cx={cx} cy={cy} r={baseR + coronaR * 0.62} fill={tonicHsl} fillOpacity={0.24} stroke="none" />
                    <circle cx={cx} cy={cy} r={baseR + coronaR * 0.32} fill={tonicHsl} fillOpacity={0.38} stroke="none" />
                  </>
                )}

                {/* Onset density: radial tick marks outside the ring */}
                {Array.from({ length: nTicks }, (_, ti) => {
                  const a  = (ti / nTicks) * 2 * Math.PI - Math.PI / 2
                  const r0 = baseR + 3
                  const r1 = r0 + tickLen
                  return (
                    <line key={ti}
                      x1={(cx + r0 * Math.cos(a)).toFixed(2)} y1={(cy + r0 * Math.sin(a)).toFixed(2)}
                      x2={(cx + r1 * Math.cos(a)).toFixed(2)} y2={(cy + r1 * Math.sin(a)).toFixed(2)}
                      stroke={tickHsl} strokeWidth={1.2} strokeLinecap="round" opacity={0.75}
                    />
                  )
                })}

                {/* Outer guide circle */}
                <circle cx={cx} cy={cy} r={baseR}
                  fill="none"
                  stroke={isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)'}
                  strokeWidth={0.6} strokeDasharray="2 3"
                />

                {/* Theme ghost silhouette (shown on all non-theme glyphs) */}
                {!isTheme && (
                  <polygon points={ghostPts}
                    fill="rgba(148,163,184,0.14)"
                    stroke={isDark ? 'rgba(148,163,184,0.35)' : 'rgba(100,116,139,0.30)'}
                    strokeWidth={0.7}
                    strokeDasharray="2 1.5"
                  />
                )}

                {/* Pitch-class radar polygon */}
                <polygon
                  points={radarPolyPts(cx, cy, seg.features.chroma_chromatic, baseR, innerR)}
                  fill={tonicHsl}
                  fillOpacity={opacity * (isMajor ? 0.55 : 0.45)}
                  stroke={strokeHsl}
                  strokeWidth={strokeW * 0.55}
                />

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

            const lines = [
              { k: lang === 'zh' ? '调性'   : 'Key',      v: `${tonicName}${modeStr}${fromPYIN ? ' (KS)' : ' (chroma)'}`, bold: true },
              { k: lang === 'zh' ? '节奏密度': 'Onset',    v: `${f.onset_density.toFixed(2)} /s` },
              { k: lang === 'zh' ? '响度 RMS': 'Loudness', v: f.rms_mean.toFixed(4) },
              { k: lang === 'zh' ? '频谱质心': 'Centroid', v: `${Math.round(f.spectral_centroid_mean)} Hz` },
              { k: lang === 'zh' ? '协和度峰值': 'Consonance', v: `${Math.max(...f.chroma_cof).toFixed(3)} → ${consonanceStrokeW(f.chroma_cof).toFixed(1)}px` },
              ...(avgPitch !== null ? [{ k: lang === 'zh' ? '旋律高度' : 'Melody ht.', v: `${avgPitch.toFixed(1)} st` }] : []),
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={72} height={22} style={{ overflow: 'visible' }}>
            {([0.5,1.4,2.5,3.8] as number[]).map((sw,i)=>(
              <circle key={i} cx={[10,26,46,64][i]} cy={11} r={9}
                fill="rgba(100,100,120,0.42)" stroke="rgba(50,50,70,0.85)" strokeWidth={sw}/>
            ))}
          </svg>
          <span>{lang === 'zh' ? '描边=协和度' : 'Stroke=consonance'}</span>
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
        {/* Tick marks legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={76} height={22} style={{ overflow: 'visible' }}>
            {([0.1, 0.35, 0.65, 0.9] as number[]).map((oN, i) => {
              const n = Math.round(4 + oN * 12)
              const cx = [10, 25, 44, 65][i]
              return Array.from({ length: n }, (_, ti) => {
                const a = (ti / n) * 2 * Math.PI - Math.PI / 2
                const r0 = 8, r1 = r0 + 3 + oN * 4
                return <line key={ti}
                  x1={(cx + r0 * Math.cos(a)).toFixed(1)} y1={(11 + r0 * Math.sin(a)).toFixed(1)}
                  x2={(cx + r1 * Math.cos(a)).toFixed(1)} y2={(11 + r1 * Math.sin(a)).toFixed(1)}
                  stroke="rgba(100,100,140,0.7)" strokeWidth={1.1} strokeLinecap="round" />
              })
            })}
          </svg>
          <span>{lang === 'zh' ? '刻度线=节奏密度' : 'Ticks=onset density'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={62} height={24} style={{ overflow: 'visible' }}>
            {([5,9,14,20] as number[]).map((r,i)=>(
              <circle key={i} cx={[5,16,31,52][i]} cy={12} r={r}
                fill={`rgba(100,100,120,${[0.28,0.42,0.60,0.85][i]})`}
                stroke="rgba(100,100,120,0.35)" strokeWidth={0.7}/>
            ))}
          </svg>
          <span>{lang === 'zh' ? '大小+透明度=响度' : 'Size+opacity=loudness'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={56} height={28} style={{ overflow: 'visible' }}>
            <circle cx={12} cy={14} r={9} fill="hsl(195,65%,52%)" fillOpacity={0.82} stroke="hsl(195,55%,36%)" strokeWidth={1}/>
            <circle cx={44} cy={14} r={18} fill="hsl(195,65%,52%)" fillOpacity={0.13} stroke="none"/>
            <circle cx={44} cy={14} r={14} fill="hsl(195,65%,52%)" fillOpacity={0.22} stroke="none"/>
            <circle cx={44} cy={14} r={10} fill="hsl(195,65%,52%)" fillOpacity={0.36} stroke="none"/>
            <circle cx={44} cy={14} r={9}  fill="hsl(195,65%,52%)" fillOpacity={0.82} stroke="hsl(195,55%,36%)" strokeWidth={1}/>
          </svg>
          <span>{lang === 'zh' ? '外晕=音色亮度' : 'Corona=timbre brightness'}</span>
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
        borderRadius: 8, overflow: 'hidden', fontSize: 9,
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
              ? '🔮 情感轨迹 · Russell (1980) 唤醒 × 效价平面'
              : '🔮 Emotion Trajectory · Russell (1980) Arousal × Valence Plane'}
          </span>
          <span style={{ fontSize: 10, color: theme.labelSecondaryColor }}>
            {showRussell ? '▲' : '▼'}
          </span>
        </div>

        {showRussell && (() => {
          // Map arousal/valence [0,1] to SVG inner coords
          const toX = (v: number) => RC_PAD + v * RC_PW
          const toY = (a: number) => RC_PAD + (1 - a) * RC_PH

          // Quadrant labels
          const qLabels = [
            { x: RC_PAD + RC_PW * 0.75, y: RC_PAD + RC_PH * 0.15, en: 'Energetic', zh: '高能' },
            { x: RC_PAD + RC_PW * 0.15, y: RC_PAD + RC_PH * 0.15, en: 'Tense',     zh: '紧张' },
            { x: RC_PAD + RC_PW * 0.75, y: RC_PAD + RC_PH * 0.90, en: 'Joyful',    zh: '欢快' },
            { x: RC_PAD + RC_PW * 0.15, y: RC_PAD + RC_PH * 0.90, en: 'Calm',      zh: '平静' },
          ]

          return (
            <div style={{
              display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12,
              padding: '10px 16px 12px',
              background: isDark ? '#161626' : '#ffffff',
            }}>
              {/* SVG plot */}
              <svg width={RC_W} height={RC_H} style={{ flexShrink: 0 }}>
                {/* Background quadrant tints */}
                <rect x={RC_PAD + RC_PW/2} y={RC_PAD}            width={RC_PW/2} height={RC_PH/2} fill="#fee2e2" opacity={0.22} />
                <rect x={RC_PAD}           y={RC_PAD}            width={RC_PW/2} height={RC_PH/2} fill="#fef3c7" opacity={0.22} />
                <rect x={RC_PAD + RC_PW/2} y={RC_PAD + RC_PH/2} width={RC_PW/2} height={RC_PH/2} fill="#dcfce7" opacity={0.22} />
                <rect x={RC_PAD}           y={RC_PAD + RC_PH/2} width={RC_PW/2} height={RC_PH/2} fill="#dbeafe" opacity={0.22} />

                {/* Axes */}
                <line x1={RC_PAD} y1={RC_PAD + RC_PH/2} x2={RC_PAD + RC_PW} y2={RC_PAD + RC_PH/2}
                  stroke={isDark ? '#44445a' : '#cbd5e1'} strokeWidth={0.8} />
                <line x1={RC_PAD + RC_PW/2} y1={RC_PAD} x2={RC_PAD + RC_PW/2} y2={RC_PAD + RC_PH}
                  stroke={isDark ? '#44445a' : '#cbd5e1'} strokeWidth={0.8} />

                {/* Axis tick labels */}
                <text x={RC_PAD + RC_PW + 2} y={RC_PAD + RC_PH/2 + 3} fontSize={7} fill={isDark ? '#666' : '#94a3b8'}>
                  {lang === 'zh' ? '效价 →' : 'Valence →'}
                </text>
                <text x={RC_PAD - 4} y={RC_PAD - 4} fontSize={7} fill={isDark ? '#666' : '#94a3b8'} textAnchor="middle">
                  {lang === 'zh' ? '↑唤醒' : '↑Arousal'}
                </text>

                {/* Quadrant labels */}
                {qLabels.map((q, qi) => (
                  <text key={qi} x={q.x} y={q.y} fontSize={7} textAnchor="middle"
                    fill={isDark ? '#555' : '#94a3b8'} fontStyle="italic">
                    {lang === 'zh' ? q.zh : q.en}
                  </text>
                ))}

                {/* Trajectory polyline */}
                <polyline
                  points={glyphs.map(g => `${toX(g.valence).toFixed(1)},${toY(g.arousal).toFixed(1)}`).join(' ')}
                  fill="none"
                  stroke={isDark ? '#44445a' : '#cbd5e1'}
                  strokeWidth={1.0}
                  strokeDasharray="2,2"
                />

                {/* Dots */}
                {glyphs.map((g, gi) => {
                  const px = toX(g.valence)
                  const py = toY(g.arousal)
                  const isHov = hoveredDot === gi
                  const r = isHov ? 6.5 : 5
                  return (
                    <g key={gi}
                      onMouseEnter={() => setHoveredDot(gi)}
                      onMouseLeave={() => setHoveredDot(null)}
                      style={{ cursor: 'default' }}
                    >
                      <circle cx={px} cy={py} r={r + 2} fill={`hsl(${g.hue},60%,60%)`} opacity={0.18} />
                      <circle cx={px} cy={py} r={r}
                        fill={`hsl(${g.hue},${g.sat}%,${g.lit}%)`}
                        stroke={isDark ? '#1b1b2d' : '#fff'}
                        strokeWidth={1.2}
                        opacity={0.90}
                      />
                      {/* Segment label inside or above dot */}
                      <text x={px} y={py - r - 1.5} textAnchor="middle" fontSize={6}
                        fill={isDark ? '#aaa' : '#64748b'} fontWeight={500}>
                        {g.seg.label}
                      </text>
                      {/* Hover tooltip */}
                      {isHov && (
                        <g style={{ pointerEvents: 'none' }}>
                          <rect x={px + 7} y={py - 20} width={72} height={32} rx={3}
                            fill={isDark ? '#1b1b2d' : '#fff'}
                            stroke={isDark ? '#44445a' : '#d0d0d8'} strokeWidth={0.7} opacity={0.97} />
                          <text x={px + 11} y={py - 10} fontSize={7.5} fontWeight={700}
                            fill={theme.labelColor}>
                            {g.hevner.emoji} {lang === 'zh' ? g.hevner.labelZh : g.hevner.label}
                          </text>
                          <text x={px + 11} y={py + 0} fontSize={7} fill={theme.labelSecondaryColor}>
                            {lang === 'zh' ? `↑${(g.arousal*100).toFixed(0)}% ♥${(g.valence*100).toFixed(0)}%`
                                           : `A:${(g.arousal*100).toFixed(0)}% V:${(g.valence*100).toFixed(0)}%`}
                          </text>
                          <text x={px + 11} y={py + 10} fontSize={7} fill={theme.labelSecondaryColor}>
                            {lang === 'zh' ? g.hevner.gemsZh : g.hevner.gems}
                          </text>
                        </g>
                      )}
                    </g>
                  )
                })}
              </svg>

              {/* Legend / segment index */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 8.5 }}>
                <div style={{ fontWeight: 700, fontSize: 9, color: theme.labelColor, marginBottom: 2 }}>
                  {lang === 'zh' ? '各段情感坐标' : 'Segment emotions'}
                </div>
                {glyphs.map((g, gi) => (
                  <div key={gi}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      opacity: hoveredDot === null || hoveredDot === gi ? 1 : 0.38,
                      transition: 'opacity 0.15s',
                    }}
                    onMouseEnter={() => setHoveredDot(gi)}
                    onMouseLeave={() => setHoveredDot(null)}
                  >
                    <svg width={10} height={10}>
                      <circle cx={5} cy={5} r={4.5}
                        fill={`hsl(${g.hue},${g.sat}%,${g.lit}%)`} opacity={0.9} />
                    </svg>
                    <span style={{ color: theme.labelColor, fontWeight: g.seg.label.startsWith('V') ? 700 : 400 }}>
                      {g.seg.label}
                    </span>
                    <span style={{ color: theme.labelSecondaryColor }}>
                      {g.hevner.emoji} {lang === 'zh' ? g.hevner.labelZh : g.hevner.label}
                    </span>
                    <span style={{ color: theme.labelSecondaryColor, marginLeft: 2 }}>
                      [{(g.valence*100).toFixed(0)},{(g.arousal*100).toFixed(0)}]
                    </span>
                  </div>
                ))}
                <div style={{
                  marginTop: 6, paddingTop: 6,
                  borderTop: `1px solid ${isDark ? '#2d2d45' : '#e5e7eb'}`,
                  color: theme.labelSecondaryColor, fontSize: 7.5, lineHeight: 1.6,
                }}>
                  {lang === 'zh'
                    ? '虚线=时间顺序轨迹\n圆点颜色=五度圈调性'
                    : 'Dashed = temporal order\nDot color = CoF key'}
                </div>
              </div>
            </div>
          )
        })()}
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          SEMANTIC ANNOTATION PANEL
          心理语义注释 — 基于 Hevner 形容词圆环 × GEMS 情绪量表
      ══════════════════════════════════════════════════════════════ */}
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
              ? '🧠 心理语义注释 · 基于 Hevner 形容词圆环 × GEMS 情绪量表'
              : '🧠 Semantic Annotation · Hevner Adjective Circle × GEMS Emotion Scale'}
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
              <span>{lang === 'zh' ? '🎨 调性→情感效价' : '🎨 Key → Valence'}</span>
              <span>{lang === 'zh' ? '⭐ 刻度线→唤醒度' : '⭐ Ticks → Arousal'}</span>
              <span>{lang === 'zh' ? '🔊 响度→力量感' : '🔊 Loudness → Power'}</span>
              <span>{lang === 'zh' ? '✨ 音色→明暗感' : '✨ Timbre → Brightness'}</span>
              <span>{lang === 'zh' ? '↕ 旋律→音域' : '↕ Melody → Register'}</span>
              <span>{lang === 'zh' ? '综合标签' : 'Overall Label'}</span>
            </div>

            {/* Data rows */}
            {glyphs.map((g, rowIdx) => {
              const isVar = g.seg.label.startsWith('V')
              const rowBg = rowIndex => rowIndex % 2 === 0
                ? (isDark ? '#161626' : '#ffffff')
                : (isDark ? '#191930' : '#f8fafc')

              return (
                <div
                  key={g.seg.label}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '36px 1fr 1.4fr 1fr 1fr 1fr 1fr',
                    gap: '0 6px',
                    padding: '5px 12px',
                    alignItems: 'center',
                    background: rowBg(rowIdx),
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

                  {/* Timbre → brightness */}
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
                        ? `↑${(g.arousal*100).toFixed(0)}% ♥${(g.valence*100).toFixed(0)}%`
                        : `↑${(g.arousal*100).toFixed(0)}% ♥${(g.valence*100).toFixed(0)}%`}
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
                ? '↑ 唤醒度 = onset×0.40 + RMS×0.30 + 音高×0.15 + 音色×0.15　♥ 效价 = 大调: 0.48 + 协和×0.32 + 节奏流畅×0.20 / 小调: 0.30 − 协和×0.20 + 节奏流畅×0.10　· [Yang & Chen 2012]　· 标签依据 Hevner (1936)'
                : '↑ Arousal = onset×0.40 + RMS×0.30 + pitch×0.15 + timbre×0.15　♥ Valence = major: 0.48 + cons×0.32 + rhythm×0.20 / minor: 0.30 − cons×0.20 + rhythm×0.10　· [Yang & Chen 2012]　· Hevner (1936)'}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
