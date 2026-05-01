/**
 * PianoRollPage.tsx
 * ─────────────────
 * MIDI Piano Roll – Two-layer melody skeleton view
 *
 * Two-Layer Mode (default ON):
 *   Skeleton notes  = highest-pitch note per beat-slot in each segment
 *                     → the melody / soprano line
 *                     Rendered: full-size rect, full opacity, connected by polyline
 *   Decoration notes = every other note (inner voices, accompaniment, ornaments)
 *                     Rendered: small rect (40% height), semi-transparent
 *
 * This lets listeners answer "why does the variation still sound like the theme?"
 * by seeing the same melodic contour (skeleton) in every variation.
 *
 * Motif Overlay (optional):
 *   Sliding-window interval-sequence cosine similarity against Theme skeleton →
 *   amber bands highlight where variation resembles the theme motif.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PieceData } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import { fetchMidiNotes, type MidiNote, type MidiSegBoundary, API_BASE } from '../api/pieceApi'

// ── Constants ─────────────────────────────────────────────────────────

const SEG_COLORS = [
  '#10b981', // Theme  – green
  '#6366f1', // Var.01 – indigo
  '#f59e0b', // Var.02 – amber
  '#ec4899', // Var.03 – pink
  '#3b82f6', // Var.04 – blue
  '#a855f7', // Var.05 – purple
  '#ef4444', // Var.06 – red
  '#84cc16', // Var.07 – lime
  '#06b6d4', // Var.08 – cyan
  '#f97316', // Var.09 – orange
  '#8b5cf6', // Var.10 – violet
  '#14b8a6', // Var.11 – teal
  '#e11d48', // Var.12 – rose
]

const ROLL_H       = 300   // px height of note area
const SEG_LABEL_H  = 22    // px height of segment label strip
const BEAT_BAR_H   = 16    // px height of beat ruler at bottom
const SCROLL_W     = 900   // inner SVG width before zoom
const PITCH_PAD    = 3     // semitones of padding above/below note range
const WIN_NOTES    = 8     // sliding-window note count for motif matching
const OVERLAY_ALPHA = 0.28
const SLOT_SIZE    = 0.5   // beat-quantisation slot for melody extraction (in beats)

// ── Two-layer: melody extraction ─────────────────────────────────────

interface IndexedNote extends MidiNote {
  globalIdx: number
}

interface MelodyPoint {
  beat:      number
  pitch:     number
  globalIdx: number
}

/**
 * Extract the melody (soprano line) from a set of notes:
 * quantise to SLOT_SIZE-beat grid, keep only the highest-pitch note per slot.
 * Returns points sorted by beat.
 */
function extractMelody(segNotes: IndexedNote[]): MelodyPoint[] {
  const slots = new Map<number, MelodyPoint>()
  for (const n of segNotes) {
    const slot = Math.round(n.beat / SLOT_SIZE) * SLOT_SIZE
    const cur  = slots.get(slot)
    if (!cur || n.pitch > cur.pitch) {
      slots.set(slot, { beat: slot, pitch: n.pitch, globalIdx: n.globalIdx })
    }
  }
  return Array.from(slots.values()).sort((a, b) => a.beat - b.beat)
}

// ── Motif similarity helpers ──────────────────────────────────────────

/** Pitch-interval sequence from sorted notes (transposition-invariant). */
function intervals(notes: MidiNote[]): number[] {
  return notes.slice(1).map((n, i) => n.pitch - notes[i].pitch)
}

/**
 * Cosine similarity of mean-centred interval sequences.
 * Mean-centring makes it invariant to both transposition and inversion.
 */
function intervalSim(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  if (len < 2) return 0
  const aa = a.slice(0, len), bb = b.slice(0, len)
  const ma = aa.reduce((s, v) => s + v, 0) / len
  const mb = bb.reduce((s, v) => s + v, 0) / len
  const ca = aa.map(v => v - ma), cb = bb.map(v => v - mb)
  const dot   = ca.reduce((s, v, i) => s + v * cb[i], 0)
  const normA = Math.sqrt(ca.reduce((s, v) => s + v * v, 0))
  const normB = Math.sqrt(cb.reduce((s, v) => s + v * v, 0))
  return normA * normB === 0 ? 0 : Math.max(0, dot / (normA * normB))
}

interface OverlayRegion {
  beatStart:  number
  beatEnd:    number
  similarity: number
}

/** Compute motif-match overlay bands for one segment's notes. */
function computeOverlay(
  themeNotes: MidiNote[],
  varNotes:   MidiNote[],
  threshold:  number,
): OverlayRegion[] {
  if (themeNotes.length < 3 || varNotes.length < WIN_NOTES) return []
  const themeIvs = intervals(themeNotes).slice(0, WIN_NOTES - 1)
  const regions: OverlayRegion[] = []

  for (let i = 0; i <= varNotes.length - WIN_NOTES; i++) {
    const window  = varNotes.slice(i, i + WIN_NOTES)
    const winIvs  = intervals(window)
    const sim     = intervalSim(themeIvs, winIvs)
    if (sim >= threshold) {
      const last = window[WIN_NOTES - 1]
      regions.push({
        beatStart:  window[0].beat,
        beatEnd:    last.beat + last.dur_beats,
        similarity: sim,
      })
    }
  }

  if (regions.length === 0) return []
  regions.sort((a, b) => a.beatStart - b.beatStart)
  const merged: OverlayRegion[] = [regions[0]]
  for (const r of regions.slice(1)) {
    const last = merged[merged.length - 1]
    if (r.beatStart <= last.beatEnd + 0.5) {
      last.beatEnd    = Math.max(last.beatEnd, r.beatEnd)
      last.similarity = Math.max(last.similarity, r.similarity)
    } else {
      merged.push({ ...r })
    }
  }
  return merged
}

// ── Component ─────────────────────────────────────────────────────────

interface Props {
  data:     PieceData
  theme:    ThemeTokens
  isDark:   boolean
  lang:     Lang
  fileName: string
}

export function PianoRollPage({ data, theme, isDark, lang, fileName }: Props) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en

  // ── State ──────────────────────────────────────────────────────────
  const [notes,       setNotes]       = useState<MidiNote[]>([])
  const [segments,    setSegments]    = useState<MidiSegBoundary[]>([])
  const [totalBeats,  setTotalBeats]  = useState(0)
  const [beatsPerBar, setBeatsPerBar] = useState(4)
  const [status,      setStatus]      = useState<'idle'|'loading'|'ready'|'error'>('idle')
  const [errMsg,      setErrMsg]      = useState('')
  const [showOverlay, setShowOverlay] = useState(false)
  const [twoLayer,    setTwoLayer]    = useState(true)
  const [threshold,   setThreshold]   = useState(0.62)
  const [zoom,        setZoom]        = useState(1.0)
  const [hovSeg,      setHovSeg]      = useState<number | null>(null)

  // Dijkstra skeleton highlights from /api/musicvis/skeleton/
  // maps str(abs_measure_idx) → [{beat, pc, midi}]
  // Three Schenkerian levels: foreground (fg), midground (mg), background (bg)
  const [dijkstraHL,   setDijkstraHL]   = useState<Record<string, {beat: number; pc: number; midi: number}[]>>({})
  const [midgroundHL,  setMidgroundHL]  = useState<Record<string, {beat: number; pc: number; midi: number}[]>>({})
  const [backgroundHL, setBackgroundHL] = useState<Record<string, {beat: number; pc: number; midi: number}[]>>({})

  const scrollRef = useRef<HTMLDivElement>(null)

  // ── Fetch MIDI notes ───────────────────────────────────────────────
  useEffect(() => {
    setStatus('loading')
    setNotes([]); setSegments([])
    fetchMidiNotes(fileName, data.metadata.variation_num)
      .then(d => {
        if (!d.matched) { setStatus('error'); setErrMsg(d.message ?? 'No MIDI'); return }
        setNotes(d.notes)
        setSegments(d.segments)
        setTotalBeats(d.total_beats)
        setBeatsPerBar(d.beats_per_bar)
        setStatus('ready')
      })
      .catch(e => { setStatus('error'); setErrMsg(String(e)) })
  }, [fileName])

  // ── Fetch Dijkstra skeleton highlights ─────────────────────────────
  // Uses /api/musicvis/skeleton/ which runs Wang et al. ISMIR 2025
  // graph-based reduction on the MusicXML source (not MIDI).
  // Returns three Schenkerian levels: foreground, midground, background.
  // Falls back silently to the highest-note heuristic if unavailable.
  useEffect(() => {
    setDijkstraHL({})
    setMidgroundHL({})
    setBackgroundHL({})
    fetch(`${API_BASE}/musicvis/skeleton/${encodeURIComponent(fileName)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return
        if (d.highlights)            setDijkstraHL(d.highlights)
        if (d.midground_highlights)  setMidgroundHL(d.midground_highlights)
        if (d.background_highlights) setBackgroundHL(d.background_highlights)
      })
      .catch(() => {})
  }, [fileName])

  // ── Pitch range ───────────────────────────────────────────────────
  const { pitchMin, pitchMax } = useMemo(() => {
    if (!notes.length) return { pitchMin: 48, pitchMax: 84 }
    const ps = notes.map(n => n.pitch)
    return {
      pitchMin: Math.max(0,   Math.min(...ps) - PITCH_PAD),
      pitchMax: Math.min(127, Math.max(...ps) + PITCH_PAD),
    }
  }, [notes])

  const pitchRange = pitchMax - pitchMin + 1

  // ── Layout scales ─────────────────────────────────────────────────
  const innerW  = SCROLL_W * zoom
  const beatPx  = totalBeats > 0 ? innerW / totalBeats : 4

  function beatToX(beat: number)   { return beat * beatPx }
  function pitchToY(pitch: number) {
    return ROLL_H - ((pitch - pitchMin) / pitchRange) * ROLL_H
  }
  const noteH = Math.max(2, ROLL_H / pitchRange - 0.5)

  // ── Two-layer skeleton computation ───────────────────────────────
  /**
   * Prefer Dijkstra highlights from /api/musicvis/skeleton/ (Wang et al. ISMIR 2025).
   * Falls back to highest-note-per-slot heuristic when highlights are unavailable.
   *
   * Dijkstra matching: for each MIDI note compute
   *   measureIdx    = floor(note.beat / beatsPerBar)
   *   beatInMeasure = note.beat - measureIdx * beatsPerBar
   *   pc            = note.pitch % 12
   * then check dijkstraHL[measureIdx] for a match within 0.25-beat tolerance.
   */
  /**
   * Match a highlights dict (abs_measure_idx → [{beat,pc,midi}]) against MIDI notes.
   * Returns a Set of globalIdx values.
   */
  function matchHLtoSet(
    indexedNotes: IndexedNote[],
    hl: Record<string, {beat: number; pc: number; midi: number}[]>,
    beatsPerBar: number,
  ): Set<number> {
    const s = new Set<number>()
    if (Object.keys(hl).length === 0) return s
    indexedNotes.forEach(n => {
      const measureIdx    = Math.floor(n.beat / beatsPerBar)
      const beatInMeasure = n.beat - measureIdx * beatsPerBar
      const pc            = n.pitch % 12
      const entries       = hl[String(measureIdx)] ?? []
      if (entries.some(h => Math.abs(h.beat - beatInMeasure) < 0.25 && h.pc === pc)) {
        s.add(n.globalIdx)
      }
    })
    return s
  }

  const { skeletonSet, midgroundSet, backgroundSet, melodyBySegment, midgroundBySegment, backgroundBySegment } = useMemo(() => {
    const empty = {
      skeletonSet:         new Set<number>(),
      midgroundSet:        new Set<number>(),
      backgroundSet:       new Set<number>(),
      melodyBySegment:     new Map<number, MelodyPoint[]>(),
      midgroundBySegment:  new Map<number, MelodyPoint[]>(),
      backgroundBySegment: new Map<number, MelodyPoint[]>(),
    }
    if (!twoLayer || !notes.length) return empty

    const indexedNotes: IndexedNote[] = notes.map((n, i) => ({ ...n, globalIdx: i }))
    const hasDijkstra = Object.keys(dijkstraHL).length > 0

    let skeletonSet   = new Set<number>()
    let midgroundSet  = new Set<number>()
    let backgroundSet = new Set<number>()

    const melodyBySegment     = new Map<number, MelodyPoint[]>()
    const midgroundBySegment  = new Map<number, MelodyPoint[]>()
    const backgroundBySegment = new Map<number, MelodyPoint[]>()

    if (hasDijkstra) {
      // ── Dijkstra path: match all three Schenkerian levels ────────────
      skeletonSet   = matchHLtoSet(indexedNotes, dijkstraHL,   beatsPerBar)
      midgroundSet  = matchHLtoSet(indexedNotes, midgroundHL,  beatsPerBar)
      backgroundSet = matchHLtoSet(indexedNotes, backgroundHL, beatsPerBar)

      // Build per-segment melody polylines for each level
      for (let segIdx = 0; segIdx < segments.length; segIdx++) {
        const segFg = indexedNotes
          .filter(n => n.seg === segIdx && skeletonSet.has(n.globalIdx))
          .sort((a, b) => a.beat - b.beat)
          .map(n => ({ beat: n.beat, pitch: n.pitch, globalIdx: n.globalIdx }))
        melodyBySegment.set(segIdx, segFg)

        const segMg = indexedNotes
          .filter(n => n.seg === segIdx && midgroundSet.has(n.globalIdx))
          .sort((a, b) => a.beat - b.beat)
          .map(n => ({ beat: n.beat, pitch: n.pitch, globalIdx: n.globalIdx }))
        midgroundBySegment.set(segIdx, segMg)

        const segBg = indexedNotes
          .filter(n => n.seg === segIdx && backgroundSet.has(n.globalIdx))
          .sort((a, b) => a.beat - b.beat)
          .map(n => ({ beat: n.beat, pitch: n.pitch, globalIdx: n.globalIdx }))
        backgroundBySegment.set(segIdx, segBg)
      }
    } else {
      // ── Fallback: highest note per 0.5-beat slot ─────────────────────
      for (let segIdx = 0; segIdx < segments.length; segIdx++) {
        const segNotes = indexedNotes
          .filter(n => n.seg === segIdx)
          .sort((a, b) => a.beat - b.beat)
        const melody = extractMelody(segNotes)
        melody.forEach(p => skeletonSet.add(p.globalIdx))
        melodyBySegment.set(segIdx, melody)
      }
    }

    return { skeletonSet, midgroundSet, backgroundSet, melodyBySegment, midgroundBySegment, backgroundBySegment }
  }, [notes, segments, twoLayer, beatsPerBar, dijkstraHL, midgroundHL, backgroundHL])

  // ── Motif overlay (per-segment, memoised) ─────────────────────────
  const themeNotes = useMemo(
    () => notes.filter(n => n.seg === 0).sort((a, b) => a.beat - b.beat),
    [notes]
  )

  const overlayMap = useMemo(() => {
    if (!showOverlay || themeNotes.length < 3) return new Map<number, OverlayRegion[]>()
    const map    = new Map<number, OverlayRegion[]>()
    const nSegs  = segments.length
    for (let i = 1; i < nSegs; i++) {
      const varNotes = notes
        .filter(n => n.seg === i)
        .sort((a, b) => a.beat - b.beat)
      map.set(i, computeOverlay(themeNotes, varNotes, threshold))
    }
    return map
  }, [notes, themeNotes, segments, showOverlay, threshold])

  // ── Bar line beats ────────────────────────────────────────────────
  const barBeats = useMemo(() => {
    const bars: number[] = []
    for (let b = 0; b <= totalBeats; b += beatsPerBar) bars.push(b)
    return bars
  }, [totalBeats, beatsPerBar])

  // ── Split notes into skeleton / decoration for render ─────────────
  // Decoration = notes that are NOT in any Schenkerian level
  const { decorNotes } = useMemo(() => {
    if (!twoLayer) return { decorNotes: [] as MidiNote[] }
    const de: MidiNote[] = []
    notes.forEach((n, i) => {
      if (!skeletonSet.has(i) && !midgroundSet.has(i) && !backgroundSet.has(i))
        de.push(n)
    })
    return { decorNotes: de }
  }, [notes, skeletonSet, midgroundSet, backgroundSet, twoLayer])

  // ── Render ────────────────────────────────────────────────────────
  const totalH = SEG_LABEL_H + ROLL_H + BEAT_BAR_H

  return (
    <div style={{ padding: '10px 14px', fontFamily: theme.fontFamily }}>

      {/* ── Header controls ── */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
        marginBottom: 10,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: theme.labelColor }}>
          {t(' MIDI 钢琴卷帘', ' MIDI Piano Roll')}
        </span>

        {/* Two-layer toggle */}
        <button
          onClick={() => setTwoLayer(v => !v)}
          style={{
            fontSize: 9, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
            border: `1px solid ${twoLayer ? '#6366f1' : (isDark ? '#44445a' : '#cbd5e1')}`,
            background: twoLayer
              ? (isDark ? 'rgba(99,102,241,0.15)' : '#eef2ff')
              : 'transparent',
            color: twoLayer ? '#6366f1' : theme.labelSecondaryColor,
            fontWeight: twoLayer ? 700 : 400,
          }}
        >
          {twoLayer
            ? t(' 骨架模式 ON', ' Skeleton Mode ON')
            : t('骨架模式 OFF', 'Skeleton Mode OFF')}
        </button>

        {/* Motif overlay toggle */}
        <button
          onClick={() => setShowOverlay(v => !v)}
          style={{
            fontSize: 9, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
            border: `1px solid ${showOverlay ? '#f59e0b' : (isDark ? '#44445a' : '#cbd5e1')}`,
            background: showOverlay
              ? (isDark ? 'rgba(245,158,11,0.15)' : '#fef3c7')
              : 'transparent',
            color: showOverlay ? '#f59e0b' : theme.labelSecondaryColor,
            fontWeight: showOverlay ? 700 : 400,
          }}
        >
          {showOverlay
            ? t(' 母题高亮 ON', ' Motif Overlay ON')
            : t('母题高亮 OFF', 'Motif Overlay OFF')}
        </button>

        {/* Threshold slider (only when overlay is on) */}
        {showOverlay && (
          <label style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 9, color: theme.labelSecondaryColor,
          }}>
            {t('灵敏度', 'Sensitivity')}
            <input type="range" min={0.4} max={0.9} step={0.01}
              value={threshold}
              onChange={e => setThreshold(+e.target.value)}
              style={{ width: 80, accentColor: '#f59e0b' }}
            />
            <span style={{ fontWeight: 700, color: '#f59e0b', minWidth: 28 }}>
              {(threshold * 100).toFixed(0)}%
            </span>
          </label>
        )}

        {/* Zoom */}
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 9, color: theme.labelSecondaryColor, marginLeft: 'auto',
        }}>
          {t('缩放', 'Zoom')}
          <input type="range" min={0.5} max={4} step={0.1}
            value={zoom}
            onChange={e => setZoom(+e.target.value)}
            style={{ width: 70, accentColor: '#6366f1' }}
          />
          <span style={{ fontWeight: 600, color: '#6366f1', minWidth: 28 }}>
            {zoom.toFixed(1)}×
          </span>
        </label>
      </div>

      {/* ── States ── */}
      {status === 'loading' && (
        <div style={{ padding: '32px 0', textAlign: 'center', fontSize: 11,
          color: theme.labelSecondaryColor }}>
          {t('正在加载 MIDI 音符…', 'Loading MIDI notes…')}
        </div>
      )}
      {status === 'error' && (
        <div style={{ padding: '20px 0', fontSize: 11, color: '#ef4444' }}>
          {t('无法加载 MIDI：', 'Could not load MIDI: ')}{errMsg}
        </div>
      )}

      {/* ── Piano Roll SVG ── */}
      {status === 'ready' && (
        <div
          ref={scrollRef}
          style={{
            overflowX: 'auto', overflowY: 'hidden',
            border: `1px solid ${isDark ? '#2d2d45' : '#e2e8f0'}`,
            borderRadius: 8,
          }}
        >
          <svg
            width={innerW}
            height={totalH}
            style={{ display: 'block', userSelect: 'none' }}
          >
            {/* ── Background ── */}
            <rect width={innerW} height={totalH}
              fill={isDark ? '#0f0e1a' : '#fafafa'} />

            {/* ── Octave lines (horizontal) ── */}
            {Array.from({ length: Math.ceil(pitchRange / 12) + 1 }, (_, i) => {
              const p = Math.floor(pitchMin / 12) * 12 + i * 12
              if (p < pitchMin || p > pitchMax) return null
              const y = SEG_LABEL_H + pitchToY(p)
              return (
                <line key={`oct-${i}`}
                  x1={0} y1={y} x2={innerW} y2={y}
                  stroke={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'}
                  strokeWidth={1}
                />
              )
            })}

            {/* ── Bar lines (vertical, light) ── */}
            {barBeats.map(b => (
              <line key={`bar-${b}`}
                x1={beatToX(b)} y1={SEG_LABEL_H}
                x2={beatToX(b)} y2={SEG_LABEL_H + ROLL_H}
                stroke={isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)'}
                strokeWidth={1}
              />
            ))}

            {/* ── Segment vertical dividers + labels ── */}
            {segments.map((seg, i) => {
              const x     = beatToX(seg.beat_start)
              const w     = beatToX(seg.beat_end) - x
              const color = SEG_COLORS[i % SEG_COLORS.length]
              const isHov = hovSeg === i
              return (
                <g key={`seg-${i}`}>
                  <rect
                    x={x} y={0} width={w} height={SEG_LABEL_H}
                    fill={color}
                    opacity={isHov ? 0.30 : 0.18}
                    onMouseEnter={() => setHovSeg(i)}
                    onMouseLeave={() => setHovSeg(null)}
                  />
                  <text
                    x={x + w / 2} y={SEG_LABEL_H / 2 + 4}
                    textAnchor="middle"
                    fontSize={Math.min(10, w / seg.label.length - 1)}
                    fontWeight={700}
                    fill={color}
                  >
                    {seg.label}
                  </text>
                  {i > 0 && (
                    <line
                      x1={x} y1={0} x2={x} y2={SEG_LABEL_H + ROLL_H}
                      stroke={color} strokeWidth={1.5} opacity={0.5}
                    />
                  )}
                </g>
              )
            })}

            {/* ── Motif overlay bands ── */}
            {showOverlay && segments.map((seg, i) => {
              if (i === 0) return null
              const regions = overlayMap.get(i) ?? []
              return regions.map((r, ri) => (
                <rect key={`ov-${i}-${ri}`}
                  x={beatToX(r.beatStart)}
                  y={SEG_LABEL_H}
                  width={Math.max(2, beatToX(r.beatEnd) - beatToX(r.beatStart))}
                  height={ROLL_H}
                  fill={`rgba(251,191,36,${OVERLAY_ALPHA + r.similarity * 0.15})`}
                  rx={3}
                  pointerEvents="none"
                />
              ))
            })}

            {/* ── DECORATION notes (background layer) ── */}
            {twoLayer && decorNotes.map((n, idx) => {
              const color = SEG_COLORS[n.seg % SEG_COLORS.length]
              const x = beatToX(n.beat)
              const y = SEG_LABEL_H + pitchToY(n.pitch) + noteH * 0.3
              const w = Math.max(1, beatToX(n.beat + n.dur_beats) - x - 0.5)
              const h = noteH * 0.4
              return (
                <rect key={`de-${idx}`}
                  x={x} y={y}
                  width={w} height={Math.max(1, h)}
                  fill={color}
                  opacity={0.22}
                  rx={0.5}
                />
              )
            })}

            {/* ── Non-two-layer: all notes flat ── */}
            {!twoLayer && notes.map((n, idx) => {
              const color = SEG_COLORS[n.seg % SEG_COLORS.length]
              const x = beatToX(n.beat)
              const y = SEG_LABEL_H + pitchToY(n.pitch)
              const w = Math.max(1.5, beatToX(n.beat + n.dur_beats) - x - 0.5)
              const opacity = 0.55 + (n.velocity / 127) * 0.45
              return (
                <rect key={`n-${idx}`}
                  x={x} y={y}
                  width={w} height={noteH}
                  fill={color}
                  opacity={opacity}
                  rx={1}
                />
              )
            })}

            {/* ── SCHENKERIAN SKELETON — three structural levels ── */}
            {/*
              Background  (coarsest): gold border, thick stroke, dashed polyline
              Midground   (medium):   orange border, medium stroke, dotted polyline
              Foreground  (finest):   white border, fine stroke, solid polyline
            */}
            {twoLayer && segments.map((_, segIdx) => {
              const color = SEG_COLORS[segIdx % SEG_COLORS.length]

              // ── helper: polyline points from melody ──────────────────
              const mkPoints = (melody: MelodyPoint[]) =>
                melody.map(p => {
                  const n = notes[p.globalIdx]
                  if (!n) return null
                  const cx = beatToX(n.beat) + Math.max(1.5, beatToX(n.beat + n.dur_beats) - beatToX(n.beat) - 0.5) / 2
                  const cy = SEG_LABEL_H + pitchToY(n.pitch) + noteH / 2
                  return `${cx.toFixed(1)},${cy.toFixed(1)}`
                }).filter(Boolean).join(' ')

              // ── Foreground (Dijkstra, finest level) ─────────────────
              const fgMelody = melodyBySegment.get(segIdx) ?? []
              const fgPts    = mkPoints(fgMelody)

              // ── Midground (strong-beat reduction) ───────────────────
              const mgMelody = midgroundBySegment.get(segIdx) ?? []
              const mgPts    = mkPoints(mgMelody)

              // ── Background (downbeat reduction) ─────────────────────
              const bgMelody = backgroundBySegment.get(segIdx) ?? []
              const bgPts    = mkPoints(bgMelody)

              if (fgMelody.length === 0 && mgMelody.length === 0 && bgMelody.length === 0) return null

              return (
                <g key={`sk-seg-${segIdx}`}>

                  {/* ── Foreground polyline ── */}
                  {fgPts && (
                    <polyline points={fgPts}
                      fill="none" stroke={color}
                      strokeWidth={1.5} strokeOpacity={0.5}
                      strokeLinejoin="round" strokeLinecap="round"
                      pointerEvents="none"
                    />
                  )}

                  {/* ── Midground polyline (orange tint, wider) ── */}
                  {mgPts && (
                    <polyline points={mgPts}
                      fill="none" stroke="#f97316"
                      strokeWidth={2.5} strokeOpacity={0.6}
                      strokeLinejoin="round" strokeLinecap="round"
                      strokeDasharray="6 3"
                      pointerEvents="none"
                    />
                  )}

                  {/* ── Background polyline (gold, widest) ── */}
                  {bgPts && (
                    <polyline points={bgPts}
                      fill="none" stroke="#f59e0b"
                      strokeWidth={3.5} strokeOpacity={0.55}
                      strokeLinejoin="round" strokeLinecap="round"
                      strokeDasharray="10 4"
                      pointerEvents="none"
                    />
                  )}

                  {/* ── Foreground note rects (finest, white border) ── */}
                  {fgMelody.map((p, pi) => {
                    const n = notes[p.globalIdx]
                    if (!n) return null
                    const x = beatToX(n.beat)
                    const y = SEG_LABEL_H + pitchToY(n.pitch)
                    const w = Math.max(2, beatToX(n.beat + n.dur_beats) - x - 0.5)
                    return (
                      <rect key={`fg-${segIdx}-${pi}`}
                        x={x} y={y} width={w} height={noteH}
                        fill={color} opacity={0.92} rx={1.5}
                        stroke={isDark ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.7)'}
                        strokeWidth={0.5}
                      />
                    )
                  })}

                  {/* ── Midground note rects (orange border, slightly taller) ── */}
                  {mgMelody.map((p, pi) => {
                    const n = notes[p.globalIdx]
                    if (!n) return null
                    const x = beatToX(n.beat) - 0.5
                    const y = SEG_LABEL_H + pitchToY(n.pitch) - 1
                    const w = Math.max(3, beatToX(n.beat + n.dur_beats) - beatToX(n.beat) + 0.5)
                    return (
                      <rect key={`mg-${segIdx}-${pi}`}
                        x={x} y={y} width={w} height={noteH + 2}
                        fill="none" rx={2}
                        stroke="#f97316" strokeWidth={1.5} strokeOpacity={0.85}
                        pointerEvents="none"
                      />
                    )
                  })}

                  {/* ── Background note rects (gold border, boldest) ── */}
                  {bgMelody.map((p, pi) => {
                    const n = notes[p.globalIdx]
                    if (!n) return null
                    const x = beatToX(n.beat) - 1.5
                    const y = SEG_LABEL_H + pitchToY(n.pitch) - 2
                    const w = Math.max(4, beatToX(n.beat + n.dur_beats) - beatToX(n.beat) + 2)
                    return (
                      <rect key={`bg-${segIdx}-${pi}`}
                        x={x} y={y} width={w} height={noteH + 4}
                        fill="none" rx={3}
                        stroke="#f59e0b" strokeWidth={2.5} strokeOpacity={0.9}
                        pointerEvents="none"
                      />
                    )
                  })}
                </g>
              )
            })}

            {/* ── Pitch labels (C notes) ── */}
            {Array.from({ length: Math.ceil(pitchRange / 12) + 1 }, (_, i) => {
              const p   = Math.floor(pitchMin / 12) * 12 + i * 12
              if (p < pitchMin || p > pitchMax) return null
              const oct = Math.floor(p / 12) - 1
              return (
                <text key={`pl-${i}`}
                  x={4} y={SEG_LABEL_H + pitchToY(p) - 2}
                  fontSize={8}
                  fill={isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'}
                >
                  C{oct}
                </text>
              )
            })}

            {/* ── Beat ruler ── */}
            {barBeats
              .filter((_, i) => i % Math.ceil(barBeats.length / 30) === 0)
              .map(b => (
                <text key={`bt-${b}`}
                  x={beatToX(b) + 2}
                  y={SEG_LABEL_H + ROLL_H + BEAT_BAR_H - 3}
                  fontSize={7}
                  fill={isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'}
                >
                  {b.toFixed(0)}
                </text>
              ))
            }
          </svg>
        </div>
      )}

      {/* ── Legend ── */}
      {status === 'ready' && (
        <div style={{
          marginTop: 10, display: 'flex', flexWrap: 'wrap',
          gap: '6px 14px', alignItems: 'center',
        }}>
          {segments.map((seg, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{
                width: 10, height: 10, borderRadius: 2,
                background: SEG_COLORS[i % SEG_COLORS.length],
              }} />
              <span style={{ fontSize: 9, color: theme.labelSecondaryColor }}>
                {seg.label}
              </span>
            </div>
          ))}
          {twoLayer && (
            <>
              {/* Foreground */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
                <div style={{
                  width: 14, height: 8, borderRadius: 2,
                  background: '#6366f1',
                  border: '1px solid rgba(255,255,255,0.35)',
                }} />
                <span style={{ fontSize: 9, color: '#6366f1', fontWeight: 600 }}>
                  {t('前景层（Dijkstra）', 'Foreground (Dijkstra)')}
                </span>
              </div>
              {/* Midground */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{
                  width: 14, height: 8, borderRadius: 2,
                  background: 'transparent',
                  border: '1.5px solid #f97316',
                }} />
                <span style={{ fontSize: 9, color: '#f97316', fontWeight: 600 }}>
                  {t('中景层（强拍）', 'Midground (strong beats)')}
                </span>
              </div>
              {/* Background */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{
                  width: 14, height: 8, borderRadius: 2,
                  background: 'transparent',
                  border: '2.5px solid #f59e0b',
                }} />
                <span style={{ fontSize: 9, color: '#f59e0b', fontWeight: 600 }}>
                  {t('背景层（申克主干）', 'Background (Ursatz)')}
                </span>
              </div>
              {/* Decoration */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{
                  width: 14, height: 4, borderRadius: 1,
                  background: 'rgba(99,102,241,0.22)',
                }} />
                <span style={{ fontSize: 9, color: theme.labelSecondaryColor }}>
                  {t('装饰音（填充）', 'Decoration')}
                </span>
              </div>
            </>
          )}
          {showOverlay && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: twoLayer ? 0 : 8 }}>
              <div style={{
                width: 14, height: 10, borderRadius: 2,
                background: 'rgba(251,191,36,0.45)',
                border: '1px solid #f59e0b',
              }} />
              <span style={{ fontSize: 9, color: '#f59e0b', fontWeight: 600 }}>
                {t('母题匹配区域', 'Motif match')}
              </span>
            </div>
          )}
        </div>
      )}

    </div>
  )
}
