import { useState } from 'react'
import { fetchFeatures } from '@/api/pieceApi'
import type { PieceMeta } from '@/api/pieceApi'
import type { LoadedPiece } from '@/types/app'

export interface LoadedPiecesState {
  loadedPieces:     LoadedPiece[]
  loadPiece:        (meta: PieceMeta) => void
  removeFromLoaded: (fileName: string) => void
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
      .catch(err => setLoadedPieces(prev => prev.map(p =>
        p.meta.file_name === meta.file_name ? { ...p, viewState: 'error', error: String(err) } : p
      )))
  }

  function removeFromLoaded(fileName: string) {
    setLoadedPieces(prev => prev.filter(p => p.meta.file_name !== fileName))
  }

  return { loadedPieces, loadPiece, removeFromLoaded }
}
