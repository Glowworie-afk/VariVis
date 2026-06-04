// useMusicXmlFiles — Fetches the list of available MusicXML files from the backend on mount.
// Used to determine whether the Harmonic (MusicXML) view is available for the focused piece.
// Exposes refresh() so callers can re-sync the list after an upload or deletion.

import { useState, useEffect } from 'react'
import { API_BASE } from '../api/pieceApi'

export interface MusicXmlFilesState {
  files:   string[]
  refresh: () => void
}

export function useMusicXmlFiles(): MusicXmlFilesState {
  const [files, setFiles] = useState<string[]>([])

  function refresh() {
    fetch(`${API_BASE}/musicvis/list`)
      .then(r => r.json())
      .then(d => setFiles(d.files ?? []))
      .catch(() => {})
  }

  useEffect(() => { refresh() }, [])

  return { files, refresh }
}
