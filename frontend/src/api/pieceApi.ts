/**
 * pieceApi.ts
 * ───────────
 * Client for the VariVis FastAPI backend.
 * All requests go to /api/* which Vite proxies to localhost:8000.
 */

import type { PieceData } from '../types/features'

// ── Types ──────────────────────────────────────────────────────────

export interface PieceMeta {
  file_name:  string
  music_name: string
  composer:   string
  instrument: string
  period:     string
  folder:     string
  extracted:  boolean   // true = JSON already exists in backend/features/
  has_midi:   boolean   // true = matching .mid found in TV_MIDI/ via K-number
}

export type ExtractionStep = 'extract' | 'pyin'

export interface ExtractionEvent {
  type: 'step'  | 'log' | 'done' | 'error'
  step?: ExtractionStep
  line?: string
  error?: string
}

// ── API base ───────────────────────────────────────────────────────
// In production (Vercel), set VITE_API_BASE to the Render backend URL.
// In local dev, falls back to '/api' (proxied by Vite to localhost:8000).

export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '/api'

const BASE = API_BASE

// ── List all pieces ────────────────────────────────────────────────

export async function fetchPieces(): Promise<PieceMeta[]> {
  const res = await fetch(`${BASE}/pieces`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── Load features JSON ─────────────────────────────────────────────

export async function fetchFeatures(fileName: string): Promise<PieceData> {
  const res = await fetch(`${BASE}/features/${encodeURIComponent(fileName)}`)
  if (res.status === 404) throw new NotExtractedError(fileName)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export class NotExtractedError extends Error {
  fileName: string
  constructor(fileName: string) {
    super(`Features not extracted for "${fileName}"`)
    this.name = 'NotExtractedError'
    this.fileName = fileName
  }
}

// ── Stream extraction progress ─────────────────────────────────────

/**
 * Open an SSE connection to /api/extract/{fileName}.
 * Calls `onEvent` for each parsed event.
 * Returns a cancel function.
 */
export function streamExtraction(
  fileName: string,
  onEvent: (e: ExtractionEvent) => void,
): () => void {
  const es = new EventSource(`${BASE}/extract/${encodeURIComponent(fileName)}`)

  es.onmessage = (e) => {
    const raw = e.data as string

    if (raw === 'DONE') {
      onEvent({ type: 'done' })
      es.close()
      return
    }
    if (raw.startsWith('ERROR:')) {
      onEvent({ type: 'error', error: raw.slice(6) })
      es.close()
      return
    }
    if (raw.startsWith('STEP:')) {
      onEvent({ type: 'step', step: raw.slice(5) as ExtractionStep })
      return
    }
    if (raw.trim()) {
      onEvent({ type: 'log', line: raw })
    }
  }

  es.onerror = () => {
    onEvent({ type: 'error', error: 'Connection to server lost.' })
    es.close()
  }

  return () => es.close()
}

// ── MIDI Analysis ──────────────────────────────────────────────────

export interface MidiAnalysisData {
  matched:       boolean
  file_name:     string
  midi_file?:    string
  message?:      string
  total_bars?:   number
  beats_per_bar?: number
  seg_method?:   string   // "annotation" | "fallback"
  chroma?:       number[][]  // [seg][pc 0-11], normalised 0-1
  key_root?:     number[]    // 0-11, detected tonic per segment
  key_mode?:     string[]    // "major" | "minor" per segment
  var_labels?:   string[]
  var_starts?:   number[]
  var_ends?:     number[]
  mel_mean?:     number[]
  mel_lo?:       number[]
  mel_hi?:       number[]
  stp_r?:        number[]
  lp_r?:         number[]
  mean_iv?:      number[]
  harm_t?:       number[]
  harm_d?:       number[]
  harm_s?:       number[]
  vel_mean?:     number[]
  vel_std?:      number[]
  rhy_quarter?:  number[]
  rhy_8th?:      number[]
  rhy_16th?:     number[]
  rhy_32nd?:     number[]
}

// ── MIDI Notes (piano roll) ────────────────────────────────────────────

export interface MidiNote {
  pitch:     number   // MIDI 0-127
  beat:      number   // start beat
  dur_beats: number   // duration in beats
  velocity:  number   // 0-127
  seg:       number   // segment index
}

export interface MidiSegBoundary {
  idx:        number
  label:      string
  beat_start: number
  beat_end:   number
}

export interface MidiNotesData {
  matched:       boolean
  message?:      string
  file_name:     string
  beats_per_bar: number
  total_beats:   number
  total_bars:    number
  segments:      MidiSegBoundary[]
  notes:         MidiNote[]
}

export async function fetchMidiNotes(
  fileName: string,
  nVariations?: number,
): Promise<MidiNotesData> {
  const qs  = nVariations != null ? `?n_variations=${nVariations}` : ''
  const res = await fetch(`${BASE}/midi/notes/${encodeURIComponent(fileName)}${qs}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function fetchMidiAnalysis(
  fileName: string,
  nVariations?: number,   // pass data.metadata.variation_num to override MIDI segmentation
): Promise<MidiAnalysisData> {
  const qs  = nVariations != null ? `?n_variations=${nVariations}` : ''
  const res = await fetch(`${BASE}/midi/${encodeURIComponent(fileName)}${qs}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}
