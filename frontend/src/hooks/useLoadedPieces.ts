// useLoadedPieces — Manages the collection of pieces that have been opened by the user.
// Each entry holds the piece's metadata, its feature data (or null while loading),
// and a view-state machine: 'loading' | 'ready' | 'not-extracted' | 'error'.
// Exposes loadPiece (add + fetch), removeFromLoaded (discard), and reload (re-fetch after extraction).

import { useState } from 'react'
import { fetchFeatures, NotExtractedError } from '@/api/pieceApi'
import type { PieceMeta } from '@/api/pieceApi'
import type { LoadedPiece, PieceViewState } from '@/types/app'

export interface LoadedPiecesState {
  loadedPieces:   LoadedPiece[]
  loadPiece:      (meta: PieceMeta) => void
  removeFromLoaded: (fileName: string) => void
  reload:         (fileName: string) => void
}

export function useLoadedPieces(): LoadedPiecesState {
  const [loadedPieces, setLoadedPieces] = useState<LoadedPiece[]>([])

  function loadPiece(meta: PieceMeta) {
    setLoadedPieces(prev => {
      if (prev.find(p => p.meta.file_name === meta.file_name)) return prev
      return [...prev, { meta, data: null, viewState: 'loading' }]
    })
    fetchFeatures(meta.file_name)
      .then(data => setLoadedPieces(prev => prev.map(p =>
        p.meta.file_name === meta.file_name ? { ...p, data, viewState: 'ready' } : p
      )))
      .catch(err => {
        const vs: PieceViewState = err instanceof NotExtractedError ? 'not-extracted' : 'error'
        setLoadedPieces(prev => prev.map(p =>
          p.meta.file_name === meta.file_name ? { ...p, viewState: vs, error: String(err) } : p
        ))
      })
  }

  function removeFromLoaded(fileName: string) {
    setLoadedPieces(prev => prev.filter(p => p.meta.file_name !== fileName))
  }

  // Re-fetch features for a piece after extraction completes
  function reload(fileName: string) {
    setLoadedPieces(prev => prev.map(p =>
      p.meta.file_name === fileName ? { ...p, viewState: 'loading', data: null } : p
    ))
    fetchFeatures(fileName)
      .then(data => setLoadedPieces(prev => prev.map(p =>
        p.meta.file_name === fileName ? { ...p, data, viewState: 'ready' } : p
      )))
      .catch(err => setLoadedPieces(prev => prev.map(p =>
        p.meta.file_name === fileName ? { ...p, viewState: 'error', error: String(err) } : p
      )))
  }

  return { loadedPieces, loadPiece, removeFromLoaded, reload }
}
