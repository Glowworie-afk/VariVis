// usePieceList — Fetches the catalogue of available pieces from the backend on mount.
// Exposes the list, loading/error state, and a refresh() for re-fetching after mutations.
// Accepts an optional onLoaded callback that runs once after the first successful fetch,
// allowing the caller to bootstrap derived state (e.g. select the first piece).

import { useState, useEffect, useRef } from 'react'
import { fetchPieces } from '../api/pieceApi'
import type { PieceMeta } from '../api/pieceApi'

export interface PieceListState {
  pieces:      PieceMeta[]
  listLoading: boolean
  listError:   string
  refresh:     () => void
}

export function usePieceList(onLoaded?: (list: PieceMeta[]) => void): PieceListState {
  const [pieces,      setPieces]      = useState<PieceMeta[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError,   setListError]   = useState('')

  // Keep a stable ref so the async callback always sees the latest onLoaded
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded

  useEffect(() => {
    fetchPieces()
      .then(list => {
        setPieces(list)
        setListLoading(false)
        onLoadedRef.current?.(list)
      })
      .catch(err => { setListError(String(err)); setListLoading(false) })
  }, [])

  function refresh() {
    fetchPieces().then(setPieces).catch(() => {})
  }

  return { pieces, listLoading, listError, refresh }
}
