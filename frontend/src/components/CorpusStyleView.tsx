/**
 * CorpusStyleView.tsx  —  Layout D: Focus + Overview axis (corpus.musicvis style)
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  MINI GLYPH STRIP  (horizontal scroll)  ← click to select segment  │
 * ├─── TAB ROW ── [ Chroma] [ Pitch] [ Rhythm] [ Russell] ───────┤
 * │                                                                    │
 * │  FOCUS MODE (no tab) — 2 × 2 grid for the selected segment        │
 * │  ┌──────────────────┬──────────────────┐                          │
 * │  │  Chroma Ring   │  Pitch Contour  │                          │
 * │  ├──────────────────┼──────────────────┤                          │
 * │  │  Rhythm         │  Russell V/A   │                          │
 * │  └──────────────────┴──────────────────┘                          │
 * │   ↑ defaults to T (theme segment)                                  │
 * │                                                                    │
 * │  TAB MODE — full page view, all segments, selected highlighted     │
 * └────────────────────────────────────────────────────────────────────┘
 */

import { useState, useMemo, useEffect, useRef } from 'react'
import type { PieceData, Segment } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import { ChromaRingPage } from './ChromaRingPage'
import { PitchContourPage } from './PitchContourPage'
import { RhythmBubblePage } from './RhythmBubblePage'
import { MdaAnalysisPage } from './MdaAnalysisPage'
import { API_BASE } from '../api/pieceApi'
type DetailTab = 'pitch' | 'rhythm' | 'mda'

// ── Shared glyph geometry ─────────────────────────────────────────────

function cofHue(cofIndex: number): number { return (195 + cofIndex * 30) % 360 }

function radarPolyPts(cx: number, cy: number, chroma: number[], outerR: number, innerR: number): string {
  const localMax = Math.max(...chroma, 0.01)
  return chroma.map((val, pc) => {
    const angle = (pc / 12) * 2 * Math.PI - Math.PI / 2
    const r = innerR + (val / localMax) * (outerR - innerR)
    return `${(cx + Math.cos(angle) * r).toFixed(2)},${(cy + Math.sin(angle) * r).toFixed(2)}`
  }).join(' ')
}

function tonicInfo(seg: Segment): { cofIndex: number; isMajor: boolean; tonicName: string } {
  const pc = seg.features.pitch_contour
  if (pc && pc.tonic_semitone !== undefined && !pc.error)
    return { cofIndex: (pc.tonic_semitone * 7) % 12, isMajor: pc.is_major, tonicName: pc.tonic_name + (pc.is_major ? '' : 'm') }
  return { cofIndex: seg.features.dominant_pitch.cof_index, isMajor: true, tonicName: seg.features.dominant_pitch.name + '*' }
}

// ── Hevner ───────────────────────────────────────────────────────────

const HEVNER = [
  { label: 'Vigorous',    zh: '雄健',   emoji: '', hue: 20  },
  { label: 'Triumphant',  zh: '激昂',   emoji: '', hue: 40  },
  { label: 'Agitated',    zh: '激动',   emoji: '', hue: 0   },
  { label: 'Sprightly',   zh: '活泼',   emoji: '', hue: 55  },
  { label: 'Joyful',      zh: '欢快',   emoji: '', hue: 48  },
  { label: 'Serene',      zh: '宁静',   emoji: '', hue: 145 },
  { label: 'Lyrical',     zh: '抒情',   emoji: '', hue: 180 },
  { label: 'Melancholic', zh: '忧郁',   emoji: '', hue: 225 },
]

function pickHevnerIdx(arousal: number, valence: number, brightness: number, pNorm: number): number {
  if (arousal > 0.68) {
    if (valence > 0.62) return brightness > 0.48 ? 3 : 1
    if (valence > 0.40) return 0
    return 2
  } else if (arousal > 0.38) {
    if (valence > 0.65) return brightness > 0.50 ? 4 : 6
    if (valence > 0.42) return pNorm > 0.55 ? 1 : 0
    return brightness > 0.50 ? 2 : 7
  } else {
    if (valence > 0.65) return brightness > 0.48 ? 5 : 6
    if (valence > 0.42) return 6
    return 7
  }
}

// ── Per-segment computed data ─────────────────────────────────────────

interface SegGlyph {
  seg:       Segment
  i:         number
  hue:       number; sat: number; lit: number
  isMajor:   boolean; tonicName: string
  baseR:     number; innerR: number; nRings: number
  arousal:   number; valence: number; brightness: number
  hevnerIdx: number
}

function buildGlyphs(data: PieceData): SegGlyph[] {
  const segs = data.segments
  const allRms  = segs.map(s => s.features.rms_mean)
  const allOd   = segs.map(s => s.features.onset_density)
  const allCent = segs.map(s => s.features.spectral_centroid_mean)
  const allCons = segs.map(s => Math.max(...s.features.chroma_cof))
  const pitchVals = segs.map(s => {
    const mr = s.features.pitch_contour?.midi_relative
    return (mr && mr.length > 0) ? mr.reduce((a, b) => a + b, 0) / mr.length : null
  })

  const norm = (v: number, mn: number, mx: number) => mx === mn ? 0.5 : (v - mn) / (mx - mn)
  const minRms  = Math.min(...allRms),  maxRms  = Math.max(...allRms)
  const minOd   = Math.min(...allOd),   maxOd   = Math.max(...allOd)
  const minCent = Math.min(...allCent), maxCent = Math.max(...allCent)
  const minCons = Math.min(...allCons), maxCons = Math.max(...allCons)
  const validP  = pitchVals.filter((v): v is number => v !== null)
  const minP = validP.length > 0 ? Math.min(...validP) : 0
  const maxP = validP.length > 0 ? Math.max(...validP) : 1

  return segs.map((seg, i) => {
    const f = seg.features
    const { cofIndex, isMajor, tonicName } = tonicInfo(seg)
    const hue = cofHue(cofIndex), sat = isMajor ? 65 : 52, lit = isMajor ? 52 : 40
    const rNorm  = norm(f.rms_mean, minRms, maxRms)
    const oNorm  = norm(f.onset_density, minOd, maxOd)
    const cNorm  = norm(f.spectral_centroid_mean, minCent, maxCent)
    const consN  = norm(Math.max(...f.chroma_cof), minCons, maxCons)
    const pv     = pitchVals[i]
    const pNorm  = pv !== null ? norm(pv, minP, maxP) : 0.5

    const baseR = 14 + rNorm * 20, innerR = baseR * 0.28
    const nRings = 1 + Math.round(oNorm * 3)
    const rhythmReg = f.rhythm_regularity ?? 0.5

    // ── Arousal ───────────────────────────────────────────────────────────────
    // Feature priority follows Yang et al. (2008) RReliefF ranking (Table VI):
    // spectral shape (centroid/rolloff/flux) > RMS energy > tempo/onset > pitch.
    // Yang, H., Liu, C., Chen, H.-H. (2008). "A regression approach to music emotion
    // recognition." IEEE TASL 16(2), 448–457. DOI 10.1109/TASL.2007.911513
    const arousal = cNorm * 0.35   // spectral centroid  — top arousal predictor
                  + rNorm * 0.30   // RMS energy         — amplitude/loudness
                  + oNorm * 0.20   // onset density      — tempo surrogate
                  + pNorm * 0.15   // mean pitch height  — pitch-related feature

    // ── Valence ───────────────────────────────────────────────────────────────
    // Yang et al. (2008): valence is harder (R²≈0.28 vs 0.58 for arousal).
    // Top valence predictors: beat histogram features (rhythm regularity),
    // mode (major/minor) as strongest tonal indicator, then harmonic consonance.
    const valBase = isMajor ? 0.52 : 0.22   // mode = primary binary predictor
    const valence = Math.min(1.0,
        valBase
      + rhythmReg * 0.28    // beat regularity ↔ beat histogram features
      + consN     * 0.20    // chroma consonance — tonal clarity
    )

    return { seg, i, hue, sat, lit, isMajor, tonicName, baseR, innerR, nRings,
             arousal, valence, brightness: cNorm,
             hevnerIdx: pickHevnerIdx(arousal, valence, cNorm, pNorm) }
  })
}

// ── Mini glyph strip cell ─────────────────────────────────────────────

const MINI_W = 72, MINI_CX = 36, MINI_CY = 40, MINI_SVG_H = 84

function MiniGlyph({ g, isSelected, onClick, isDark, onPlay, isPlaying, showPlay }: {
  g: SegGlyph; isSelected: boolean; onClick: () => void; isDark: boolean
  onPlay: () => void; isPlaying: boolean; showPlay: boolean
}) {
  const { hue, sat, lit, baseR, innerR, nRings, hevnerIdx, seg, isMajor } = g
  const hv        = HEVNER[hevnerIdx]
  const tonicHsl  = `hsl(${hue},${sat}%,${lit}%)`
  const strokeHsl = `hsl(${hue},${Math.round(sat * 0.85)}%,${lit - 14}%)`
  const dotFill   = isMajor
    ? `hsl(${hue},${Math.round(sat * 0.55)}%,${lit + 24}%)`
    : `hsl(${hue},${Math.round(sat * 0.75)}%,${lit - 20}%)`

  return (
    <div onClick={onClick} title={`${seg.label} · ${g.tonicName} · ${hv.emoji} ${hv.label}`}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        width: MINI_W, flexShrink: 0, cursor: 'pointer', borderRadius: 8,
        border: '1.5px solid transparent',
        background: 'transparent',
        transition: 'all 0.14s', padding: '4px 0 4px',
      }}>
      <svg width={MINI_W} height={MINI_SVG_H} style={{ overflow: 'visible', display: 'block' }}>
        {Array.from({ length: nRings - 1 }, (_, ri) => (
          <circle key={ri} cx={MINI_CX} cy={MINI_CY} r={baseR + (ri + 1) * 5}
            fill="none" stroke={tonicHsl} strokeWidth={0.6} opacity={0.28 - ri * 0.06} />
        ))}
        <polygon points={radarPolyPts(MINI_CX, MINI_CY, seg.features.chroma_chromatic, baseR, innerR)}
          fill={tonicHsl} fillOpacity={isMajor ? 0.70 : 0.55} stroke={strokeHsl} strokeWidth={0.8} />
        <circle cx={MINI_CX} cy={MINI_CY} r={2.5} fill={dotFill} fillOpacity={0.92} />
        {isSelected && (
          <circle cx={MINI_CX} cy={MINI_CY} r={baseR + 8}
            fill="none" stroke="#4361EE" strokeWidth={2} opacity={0.85} />
        )}
        {isPlaying && (
          <circle cx={MINI_CX} cy={MINI_CY} r={baseR + 8}
            fill="none" stroke={tonicHsl} strokeWidth={1.5} opacity={0.6}
            strokeDasharray="4 3" />
        )}
      </svg>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: isSelected ? '#4361EE' : (isDark ? '#e2e8f0' : '#0F172A'), lineHeight: 1 }}>
        {seg.label}
      </div>
      {/* Play / pause button — only when MusicXML audio is available */}
      {showPlay && (
        <button
          onClick={e => { e.stopPropagation(); onPlay() }}
          title={isPlaying ? 'Stop' : `Play ${seg.label}`}
          style={{
            marginTop: 4,
            width: 20, height: 20,
            borderRadius: '50%',
            border: `1.5px solid ${isPlaying ? tonicHsl : (isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)')}`,
            background: isPlaying ? `hsl(${hue},${sat}%,${lit + 22}%)` : 'transparent',
            color: isPlaying ? tonicHsl : (isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.38)'),
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 7.5, padding: 0, flexShrink: 0,
            lineHeight: 1,
            transition: 'all 0.14s',
          }}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
      )}
    </div>
  )
}




// ── Russell V/A panel (all segments, selected highlighted) ────────────

const RC_W = 320, RC_H = 260, RC_PAD = 38
const RC_PW = RC_W - RC_PAD * 2, RC_PH = RC_H - RC_PAD * 2

const Q_ZONES = [
  { x: 0.73, y: 0.08, en: 'Energetic',  zh: '兴奋',  fill: '#fee2e2' },
  { x: 0.20, y: 0.08, en: 'Tense',      zh: '紧张',  fill: '#fef3c7' },
  { x: 0.73, y: 0.94, en: 'Calm',       zh: '平静',  fill: '#dcfce7' },
  { x: 0.20, y: 0.94, en: 'Depressed',  zh: '忧郁',  fill: '#dbeafe' },
]

function RussellPanel({
  glyphs, selectedSeg, isDark, theme, lang, onSelect,
  compact = false,
}: {
  glyphs: SegGlyph[]; selectedSeg: number
  isDark: boolean; theme: ThemeTokens; lang: Lang
  onSelect: (i: number) => void
  compact?: boolean
}) {
  const [hov, setHov] = useState<number | null>(null)
  const w = compact ? RC_W : RC_W + 80
  const h = compact ? RC_H : RC_H + 60
  const pw = w - RC_PAD * 2, ph = h - RC_PAD * 2

  const toX = (v: number) => RC_PAD + v * pw
  const toY = (a: number) => RC_PAD + (1 - a) * ph

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '4px 6px' }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', overflow: 'visible' }}>
        {/* Quadrant backgrounds */}
        <rect x={RC_PAD + pw/2} y={RC_PAD}      width={pw/2} height={ph/2} fill="#fee2e2" opacity={0.22} />
        <rect x={RC_PAD}        y={RC_PAD}      width={pw/2} height={ph/2} fill="#fef3c7" opacity={0.22} />
        <rect x={RC_PAD + pw/2} y={RC_PAD+ph/2} width={pw/2} height={ph/2} fill="#dcfce7" opacity={0.22} />
        <rect x={RC_PAD}        y={RC_PAD+ph/2} width={pw/2} height={ph/2} fill="#dbeafe" opacity={0.22} />

        {/* Axes */}
        <line x1={RC_PAD} y1={RC_PAD+ph/2} x2={RC_PAD+pw} y2={RC_PAD+ph/2}
          stroke={isDark ? '#44445a' : '#cbd5e1'} strokeWidth={0.9} />
        <line x1={RC_PAD+pw/2} y1={RC_PAD} x2={RC_PAD+pw/2} y2={RC_PAD+ph}
          stroke={isDark ? '#44445a' : '#cbd5e1'} strokeWidth={0.9} />

        {/* Axis labels */}
        <text x={RC_PAD+pw+2} y={RC_PAD+ph/2+3} fontSize={7.5} fill={isDark ? '#666' : '#94a3b8'}>
          {lang === 'zh' ? '效价→' : 'Valence→'}
        </text>
        <text x={RC_PAD+pw/2} y={RC_PAD+12} fontSize={7.5} fill={isDark ? '#666' : '#94a3b8'} textAnchor="middle">
          {lang === 'zh' ? '↑唤醒' : '↑Arousal'}
        </text>

        {/* Zone labels */}
        {Q_ZONES.map((q, qi) => (
          <text key={qi} x={toX(q.x)} y={toY(q.y) + (qi < 2 ? 0 : 0)} textAnchor="middle"
            fontSize={compact ? 7.5 : 9} fontWeight={600}
            fill={isDark ? '#5a5a7a' : '#9ca3af'}>
            {lang === 'zh' ? q.zh : q.en}
          </text>
        ))}

        {/* Trajectory polyline */}
        <polyline
          points={glyphs.map(g => `${toX(g.valence).toFixed(1)},${toY(g.arousal).toFixed(1)}`).join(' ')}
          fill="none" stroke={isDark ? '#44445a' : '#cbd5e1'} strokeWidth={1} strokeDasharray="3 3" />

        {/* Dots */}
        {glyphs.map((g, gi) => {
          const px = toX(g.valence), py = toY(g.arousal)
          const isSel = gi === selectedSeg
          const isHov = gi === hov
          const r = isSel ? 8 : isHov ? 6.5 : 5.5
          return (
            <g key={gi} style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHov(gi)}
              onMouseLeave={() => setHov(null)}
              onClick={() => onSelect(gi)}>
              {isSel && (
                <circle cx={px} cy={py} r={r + 5} fill={`hsl(${g.hue},60%,60%)`} opacity={0.18} />
              )}
              <circle cx={px} cy={py} r={r}
                fill={`hsl(${g.hue},${g.sat}%,${g.lit}%)`}
                stroke={isSel ? '#4361EE' : (isDark ? '#1b1b2d' : '#fff')}
                strokeWidth={isSel ? 2 : 1.2} opacity={isSel ? 1 : 0.70} />
              {/* Label */}
              <text x={px} y={py - r - 2} textAnchor="middle" fontSize={isSel ? 8 : 6.5}
                fontWeight={isSel ? 700 : 400}
                fill={isSel ? '#4361EE' : (isDark ? '#aaa' : '#64748b')}>
                {g.seg.label}
              </text>
              {/* Hevner emoji for selected */}
              {isSel && (
                <text x={px} y={py + r + 10} textAnchor="middle" fontSize={11}>
                  {HEVNER[g.hevnerIdx].emoji}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ── Tab definitions ───────────────────────────────────────────────────

const TABS: { id: DetailTab; en: string; zh: string; icon: string }[] = [
  { id: 'pitch',    en: 'Pitch',                     zh: '音高折线',  icon: '' },
  { id: 'rhythm',   en: 'Rhythm',                    zh: '节奏气泡',  icon: '' },
  { id: 'mda',      en: 'Derivation Tree',           zh: '派生关系树',icon: '' },
]


// ── Main component ────────────────────────────────────────────────────

interface Props {
  data:           PieceData
  theme:          ThemeTokens
  isDark:         boolean
  lang:           Lang
  fileName:       string
  hasMidi?:       boolean
  onSeekMain?:    (sec: number) => void
  playMain?:      () => void
  pauseMain?:     () => void
  mainTime?:      number
  isMainPlaying?: boolean
}

export function CorpusStyleView({
  data, theme, isDark, lang, fileName, hasMidi,
  onSeekMain, playMain, pauseMain,
  mainTime = 0, isMainPlaying = false,
}: Props) {
  const [selectedSeg, setSelectedSeg] = useState<number>(0)
  const [activeTab,   setActiveTab]   = useState<DetailTab>('pitch')

  const glyphs   = useMemo(() => buildGlyphs(data), [data])
  const segments = data.segments
  const selSeg   = segments[selectedSeg]
  const selG     = glyphs[selectedSeg]

  // ── MusicXML synthesis state ──────────────────────────────────────────
  type MxlNote = { pitch: number; start_sec: number; dur_sec: number; velocity: number }
  type MxlSeg  = { label: string; start_sec: number; end_sec: number }

  const [hasMxl,      setHasMxl]      = useState<boolean | null>(null) // null = loading
  const [synthIdx,    setSynthIdx]    = useState<number | null>(null)
  const mxlNotesRef   = useRef<MxlNote[]>([])
  const mxlSegsRef    = useRef<MxlSeg[]>([])
  const toneRef       = useRef<typeof import('tone') | null>(null)
  const synthRef      = useRef<any>(null)
  const partRef       = useRef<any>(null)
  const fetchedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!fileName || fetchedForRef.current === fileName) return
    fetchedForRef.current = fileName
    fetch(`${API_BASE}/score/mxl_notes/${encodeURIComponent(fileName)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d?.available) { setHasMxl(false); return }
        mxlNotesRef.current = d.notes    ?? []
        mxlSegsRef.current  = d.segments ?? []
        setHasMxl(true)
      })
      .catch(() => setHasMxl(false))
  }, [fileName])

  // Stop synth helper
  async function stopSynth() {
    partRef.current?.stop()
    partRef.current?.dispose()
    partRef.current = null
    synthRef.current?.releaseAll()
    synthRef.current?.dispose()
    synthRef.current = null
    if (toneRef.current) {
      toneRef.current.getTransport().stop()
      toneRef.current.getTransport().cancel()
    }
    setSynthIdx(null)
  }

  // Play a segment via Tone.js synthesis from MusicXML notes
  async function playSynth(segIdx: number) {
    if (!toneRef.current) toneRef.current = await import('tone')
    const Tone = toneRef.current

    await stopSynth()

    // Match data segment by index (MusicXML segments align with data segments by order)
    const mxlSeg = mxlSegsRef.current[segIdx] ?? mxlSegsRef.current[0]
    if (!mxlSeg) return

    const segNotes = mxlNotesRef.current.filter(
      n => n.start_sec >= mxlSeg.start_sec && n.start_sec < mxlSeg.end_sec
    )
    if (segNotes.length === 0) return

    await Tone.start()

    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope:   { attack: 0.02, decay: 0.1, sustain: 0.4, release: 0.6 },
      volume:     -12,
    }).toDestination()
    synthRef.current = synth

    const origin   = segNotes[0].start_sec
    const events   = segNotes.map(n => ({
      time: round2(n.start_sec - origin),
      note: Tone.Frequency(n.pitch, 'midi').toNote(),
      dur:  Math.max(0.05, n.dur_sec * 0.9),
      vel:  (n.velocity / 127) * 0.8,
    }))
    const totalDur = Math.max(...events.map(ev => ev.time + ev.dur)) + 0.5

    const transport = Tone.getTransport()
    transport.cancel()
    transport.stop()

    const part = new Tone.Part((time: number, ev: any) => {
      synth.triggerAttackRelease(ev.note, ev.dur, time, ev.vel)
    }, events.map(ev => [ev.time, ev]))
    part.start(0)
    partRef.current = part

    transport.scheduleOnce(() => {
      part.stop(); part.dispose(); partRef.current = null
      synth.releaseAll(); synth.dispose(); synthRef.current = null
      setSynthIdx(null)
    }, totalDur)

    transport.start()
    setSynthIdx(segIdx)
  }

  function round2(x: number) { return Math.round(x * 100) / 100 }

  // Cleanup on unmount
  useEffect(() => {
    return () => { stopSynth() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function isSegPlaying(i: number): boolean {
    if (isMainPlaying) {
      const seg = segments[i]
      if (mainTime >= seg.start_sec && mainTime < seg.end_sec) return true
    }
    return synthIdx === i
  }

  async function handleGlyphPlay(i: number) {
    // Only proceed if MusicXML is available
    if (!hasMxl) return
    if (synthIdx === i) { await stopSynth(); return }
    await playSynth(i)
  }

  function handleTabClick(tab: DetailTab) {
    setActiveTab(tab)
  }

  const STRIP_H = 136
  const BORDER  = isDark ? '#2d2d45' : '#e5e7eb'
  const SURFACE = isDark ? '#1a1a2e' : '#ffffff'

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
      fontFamily: theme.fontFamily, background: isDark ? '#12121e' : '#f8f9fc',
    }}>

      {/* ═══ MINI GLYPH STRIP ═════════════════════════════════════════ */}
      <div style={{
        flexShrink: 0, height: STRIP_H, borderBottom: `1px solid ${BORDER}`,
        background: SURFACE, display: 'flex', alignItems: 'center',
        overflowX: 'auto', overflowY: 'hidden', padding: '4px 12px',
        scrollbarWidth: 'thin', gap: 0,
      }}>
        <div style={{
          flexShrink: 0, width: 58, fontSize: 8.5, fontWeight: 700,
          color: theme.labelSecondaryColor, letterSpacing: '0.06em',
          textTransform: 'uppercase', paddingRight: 8,
          borderRight: `1px solid ${BORDER}`, marginRight: 8, lineHeight: 1.5,
        }}>
          {lang === 'zh' ? '变奏\n概览' : 'Segment\nOverview'}
        </div>
        {glyphs.map((g, i) => (
          <MiniGlyph key={i} g={g} isSelected={selectedSeg === i}
            onClick={() => setSelectedSeg(i)} isDark={isDark}
            onPlay={() => handleGlyphPlay(i)}
            isPlaying={isSegPlaying(i)}
            showPlay={hasMxl === true} />
        ))}
      </div>

      {/* ═══ GLYPH LEGEND ════════════════════════════════════════════ */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap',
        gap: '0 16px', padding: '3px 14px',
        background: isDark ? '#12121e' : '#f1f5f9',
        borderBottom: `1px solid ${BORDER}`,
        fontSize: 9, color: theme.labelSecondaryColor, lineHeight: 1.6,
      }}>
        {[
          { en: 'Hue = tonic (circle of fifths)',        zh: '色调 = 调性（五度圈）' },
          { en: 'Size = RMS loudness',                   zh: '大小 = RMS响度' },
          { en: 'Rings = onset density',                 zh: '同心环数 = 节奏密度' },
          { en: 'Shape = pitch-class distribution',      zh: '形状 = 音高类分布' },
          { en: 'Opacity = major (bright) / minor (dim)',zh: '透明度 = 大调（亮）/ 小调（暗）' },
        ].map(item => (
          <span key={item.en} style={{ whiteSpace: 'nowrap' }}>
            {lang === 'zh' ? item.zh : item.en}
          </span>
        ))}
      </div>

      {/* ═══ TAB ROW ══════════════════════════════════════════════════ */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'stretch',
        borderBottom: `1px solid ${BORDER}`, background: SURFACE,
      }}>
        {TABS.map(tab => {
          const isActive = activeTab === tab.id
          return (
            <button key={tab.id} onClick={() => handleTabClick(tab.id)}
              style={{
                padding: '7px 16px', border: 'none',
                borderBottom: `2px solid ${isActive ? '#4361EE' : 'transparent'}`,
                background: isActive ? 'rgba(67,97,238,0.05)' : 'transparent',
                color: isActive ? '#4361EE' : theme.labelSecondaryColor,
                fontSize: 10.5, fontWeight: isActive ? 700 : 400,
                cursor: 'pointer', transition: 'all 0.14s', whiteSpace: 'nowrap',
              }}>
              {tab.icon} {lang === 'zh' ? tab.zh : tab.en}
            </button>
          )
        })}

        {/* Selected segment badge */}
        <div style={{ marginLeft: 'auto', alignSelf: 'center', marginRight: 12 }}>
          <div style={{
            padding: '2px 10px', borderRadius: 12, background: '#4361EE',
            color: '#fff', fontSize: 9.5, fontWeight: 700,
          }}>
            {selSeg?.label ?? `#${selectedSeg}`}
            <span style={{ marginLeft: 4, opacity: 0.6, fontSize: 9 }}>
              {HEVNER[selG.hevnerIdx].emoji}
            </span>
          </div>
        </div>
      </div>

      {/* ═══ CONTENT ══════════════════════════════════════════════════ */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>

        {/* CHROMA TAB — all segments, selected highlighted */}
        {/* PITCH TAB — all segments, selected highlighted */}
        {activeTab === 'pitch' && (
          <div style={{ height: '100%', overflowY: 'auto' }}>
            <PitchContourPage key={selectedSeg} data={data} theme={theme} isDark={isDark} lang={lang}
              selectedSeg={selectedSeg}
              onSeekMain={onSeekMain} playMain={playMain} pauseMain={pauseMain}
              mainTime={mainTime} isMainPlaying={isMainPlaying} />
          </div>
        )}

        {/* RHYTHM TAB — all segments, selected highlighted */}
        {activeTab === 'rhythm' && (
          <div style={{ height: '100%', overflowY: 'auto' }}>
            <RhythmBubblePage key={selectedSeg} data={data} theme={theme} isDark={isDark} lang={lang}
              selectedSeg={selectedSeg} />
          </div>
        )}

        {/* MDA TAB */}
        {activeTab === 'mda' && (
          <div style={{ height: '100%', overflowY: 'auto' }}>
            <MdaAnalysisPage
              data={data} theme={theme} isDark={isDark} lang={lang}
            />
          </div>
        )}

      </div>
    </div>
  )
}
