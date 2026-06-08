/**
 * pieceApi.ts
 * ───────────
 * Client for the VariVis FastAPI backend.
 * All requests go to /api/* which Vite proxies to localhost:8000.
 */

import type { PieceData } from '@/types/features'

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
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

