// useUpload — Manages the lifecycle of a single temporary uploaded piece.
// Handles the upload modal visibility, the UploadResult metadata, and the
// async fetch of the uploaded piece's feature data once the backend processes it.
// Accepts refreshXmlFiles so it can trigger an MusicXML list sync after upload/removal.
// Note: setScoreMode('musicxml') on successful upload is handled in App.tsx,
// since scoreMode lives in useAppNav (cross-hook coordination).

import { useState } from 'react'
import { fetchFeatures, API_BASE } from '@/api/pieceApi'
import type { PieceData } from '@/types/features'
import type { UploadResult } from '@/features/extraction/UploadModal'

export interface UploadState {
  uploadedPiece:       UploadResult | null
  uploadedData:        PieceData | null
  showUploadModal:     boolean
  uploadFocused:       boolean
  setShowUploadModal:  (v: boolean) => void
  setUploadFocused:    (v: boolean) => void
  handleUploadSuccess: (result: UploadResult) => Promise<void>
  removeUploadedPiece: () => void
}

export function useUpload(refreshXmlFiles: () => void): UploadState {
  const [uploadedPiece,    setUploadedPiece]    = useState<UploadResult | null>(null)
  const [uploadedData,     setUploadedData]     = useState<PieceData | null>(null)
  const [showUploadModal,  setShowUploadModal]  = useState(false)
  const [uploadFocused,    setUploadFocused]    = useState(false)

  async function handleUploadSuccess(result: UploadResult) {
    setUploadedPiece(result)
    setShowUploadModal(false)
    setUploadFocused(true)
    if (result.mxl_stem) refreshXmlFiles()
    try {
      const data = await fetchFeatures(result.temp_name)
      setUploadedData(data)
    } catch (e) {
      console.error('Failed to load uploaded feature data:', e)
    }
  }

  function removeUploadedPiece() {
    if (uploadedPiece) {
      fetch(`${API_BASE}/upload/temp/${uploadedPiece.temp_name}`, { method: 'DELETE' }).catch(() => {})
    }
    setUploadedPiece(null)
    setUploadedData(null)
    setUploadFocused(false)
    refreshXmlFiles()
  }

  return {
    uploadedPiece, uploadedData, showUploadModal, uploadFocused,
    setShowUploadModal, setUploadFocused,
    handleUploadSuccess, removeUploadedPiece,
  }
}
