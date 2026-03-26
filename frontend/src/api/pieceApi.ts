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
