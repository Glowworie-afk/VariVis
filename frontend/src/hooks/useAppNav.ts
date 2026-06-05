// useAppNav — Owns all navigation and view-mode state for the three-panel layout:
//   focusedFile      which piece is active in the main panel
//   scoreMode        right panel mode: PDF score vs MusicXML harmonic view
//   expandedComposers/Pieces  sidebar tree open/close state
//   focusedXmlFile   derived: resolves the MusicXML filename for the focused context
// Also contains the effect that auto-reverts scoreMode to 'pdf' when the focused
// context loses its MusicXML source (e.g. switching to a piece with no .mxl file).

import { useState, useMemo, useEffect } from 'react'
import type { UploadResult } from '@/features/extraction/UploadModal'

export interface AppNavState {
  focusedFile:          string | null
  setFocusedFile:       (f: string | null) => void
  scoreMode:            'pdf' | 'musicxml'
  setScoreMode:         (m: 'pdf' | 'musicxml') => void
  expandedComposers:    Set<string>
  setExpandedComposers: (s: Set<string>) => void
  expandedPieces:       Set<string>
  setExpandedPieces:    (s: Set<string>) => void
  focusedXmlFile:       string
}

export function useAppNav(
  uploadFocused:  boolean,
  uploadedPiece:  UploadResult | null,
  musicxmlFiles:  string[],
): AppNavState {
  const [focusedFile,       setFocusedFile]       = useState<string | null>(null)
  const [scoreMode,         setScoreMode]         = useState<'pdf' | 'musicxml'>('pdf')
  const [expandedComposers, setExpandedComposers] = useState<Set<string>>(new Set())
  const [expandedPieces,    setExpandedPieces]    = useState<Set<string>>(new Set())

  const focusedXmlFile = useMemo(() => {
    if (uploadFocused && uploadedPiece?.mxl_stem) return uploadedPiece.mxl_stem
    if (!focusedFile || musicxmlFiles.length === 0) return ''
    const stem = focusedFile.replace(/_\d+$/, '')
    return musicxmlFiles.find(f => f.replace(/\.[^.]+$/, '') === stem) ?? ''
  }, [focusedFile, musicxmlFiles, uploadFocused, uploadedPiece])

  // Auto-revert to PDF when the focused context loses its MusicXML source
  useEffect(() => {
    if (scoreMode !== 'musicxml') return

    const shouldRevert = uploadFocused
      ? !uploadedPiece?.mxl_stem || focusedXmlFile === ''
      : focusedFile && focusedXmlFile === ''

    if (shouldRevert) {
      // Use queueMicrotask to avoid setState during render
      queueMicrotask(() => setScoreMode('pdf'))
    }
  }, [focusedXmlFile, focusedFile, scoreMode, uploadFocused, uploadedPiece])

  return {
    focusedFile, setFocusedFile,
    scoreMode, setScoreMode,
    expandedComposers, setExpandedComposers,
    expandedPieces, setExpandedPieces,
    focusedXmlFile,
  }
}
