/**
 * UploadModal.tsx
 * ───────────────
 * Upload modal for temporary pieces.
 */

import { useRef, useState } from 'react'
import { API_BASE } from '../../api/pieceApi'

// ── Types ──────────────────────────────────────────────────────────

export interface UploadResult {
  temp_id:         string
  temp_name:       string
  music_name:      string
  available_views: string[]
  mxl_stem:        string | null
  pdf_stem:        string | null
  n_segments:      number
  labels:          string[]
}

interface Props {
  onClose:   () => void
  onSuccess: (result: UploadResult) => void
}

// ── Helpers ────────────────────────────────────────────────────────

function FileDropZone({
  label,
  accept,
  file,
  onChange,
  disabled,
}: {
  label:    string
  accept:   string
  file:     File | null
  onChange: (f: File | null) => void
  disabled: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)

  return (
    <div
      onClick={() => !disabled && ref.current?.click()}
      style={{
        border:       `1.5px dashed ${file ? '#6366f1' : '#cbd5e1'}`,
        borderRadius: 8,
        padding:      '10px 14px',
        cursor:       disabled ? 'default' : 'pointer',
        background:   file ? '#eef2ff' : '#f8fafc',
        transition:   'background 0.15s',
        minHeight:    44,
        display:      'flex',
        alignItems:   'center',
        gap:          8,
      }}
    >
      <input
        ref={ref}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={e => onChange(e.target.files?.[0] ?? null)}
      />
      <span style={{ fontSize: 16 }}>{file ? '✓' : '📂'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#334155' }}>{label}</div>
        {file ? (
          <div style={{ fontSize: 10, color: '#6366f1', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.name}
          </div>
        ) : (
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>Click to choose file</div>
        )}
      </div>
      {file && (
        <button
          onClick={e => { e.stopPropagation(); onChange(null) }}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 14, color: '#94a3b8', padding: '0 2px',
          }}
          title="Remove"
        >×</button>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────

export default function UploadModal({ onClose, onSuccess }: Props) {
  const [pieceName,   setPieceName]   = useState('')
  const [boundaries,  setBoundaries]  = useState('')
  const [mxlFile,     setMxlFile]     = useState<File | null>(null)
  const [audioFile,   setAudioFile]   = useState<File | null>(null)
  const [pdfFile,     setPdfFile]     = useState<File | null>(null)
  const [processing,  setProcessing]  = useState(false)
  const [error,       setError]       = useState('')

  const boundariesRequired = audioFile !== null
  const canProcess = (mxlFile !== null || audioFile !== null) && pieceName.trim() !== '' &&
    (!boundariesRequired || boundaries.trim() !== '')

  async function handleProcess() {
    if (!canProcess) return
    setProcessing(true)
    setError('')

    const form = new FormData()
    form.append('piece_name', pieceName.trim())
    form.append('boundaries', boundaries.trim())
    if (mxlFile)   form.append('musicxml', mxlFile)
    if (audioFile) form.append('audio',    audioFile)
    if (pdfFile)   form.append('pdf',      pdfFile)

    try {
      const res = await fetch(`${API_BASE}/upload/process`, {
        method: 'POST',
        body:   form,
      })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt || `HTTP ${res.status}`)
      }
      const data: UploadResult = await res.json()
      onSuccess(data)
    } catch (e) {
      setError(String(e))
      setProcessing(false)
    }
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget && !processing) onClose()
  }

  return (
    <div
      onClick={handleBackdrop}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        background:   '#fff',
        borderRadius: 12,
        padding:      '22px 24px',
        width:        360,
        boxShadow:    '0 8px 40px rgba(0,0,0,0.18)',
        display:      'flex',
        flexDirection:'column',
        gap:          14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2 }}>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
            Upload Piece
          </div>
          <button
            onClick={onClose}
            disabled={processing}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 16, color: '#94a3b8', padding: '0 2px',
            }}
          >×</button>
        </div>

        <div>
          <label style={{ fontSize: 10, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>
            PIECE NAME *
          </label>
          <input
            value={pieceName}
            onChange={e => setPieceName(e.target.value)}
            disabled={processing}
            placeholder="e.g. Mozart — Variations on Ah vous dirai-je"
            style={{
              width: '100%', boxSizing: 'border-box',
              fontSize: 11, padding: '7px 10px',
              border: '1.5px solid #e2e8f0', borderRadius: 7,
              outline: 'none', color: '#1e293b',
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 10, fontWeight: 600, color: '#64748b' }}>FILES (at least one required)</label>
          <FileDropZone
            label="MusicXML / .mxl"
            accept=".xml,.mxl,.musicxml"
            file={mxlFile}
            onChange={setMxlFile}
            disabled={processing}
          />
          <FileDropZone
            label="Audio (.wav / .mp3 / .flac)"
            accept=".wav,.mp3,.flac,.ogg,.m4a"
            file={audioFile}
            onChange={setAudioFile}
            disabled={processing}
          />
          <FileDropZone
            label="PDF Score (optional)"
            accept=".pdf"
            file={pdfFile}
            onChange={setPdfFile}
            disabled={processing}
          />
        </div>

        <div>
          <label style={{ fontSize: 10, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>
            SEGMENT BOUNDARIES{boundariesRequired ? ' *' : ''}{' '}
            <span style={{ fontWeight: 400, color: '#94a3b8' }}>
              (MM.SS format, comma-separated{boundariesRequired ? '' : ' · optional for MXL-only'})
            </span>
          </label>
          <input
            value={boundaries}
            onChange={e => setBoundaries(e.target.value)}
            disabled={processing}
            placeholder="0.00, 1.00, 1.57, 2.50, 3.48"
            style={{
              width: '100%', boxSizing: 'border-box',
              fontSize: 11, padding: '7px 10px',
              border: '1.5px solid #e2e8f0', borderRadius: 7,
              outline: 'none', color: '#1e293b',
              fontFamily: 'monospace',
            }}
          />
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
            Labels auto-generated: T, V1, V2, … &nbsp;·&nbsp; 1.57 = 1 min 57 sec
          </div>
        </div>

        {(mxlFile !== null || audioFile !== null) && (
          <div style={{
            background: '#f8fafc', borderRadius: 7, padding: '8px 10px',
            fontSize: 10, color: '#64748b', lineHeight: 1.7,
          }}>
            <span style={{ fontWeight: 600, color: '#475569' }}>Views available: </span>
            {[
              mxlFile   ? 'Feature Comparison Heatmap' : null,
              mxlFile   ? 'Harmonic Function' : null,
              audioFile ? 'Overview' : null,
              audioFile ? 'Mental Landscape' : null,
              pdfFile   ? 'Score (PDF)' : null,
            ].filter(Boolean).join(' · ') || '—'}
          </div>
        )}

        {error && (
          <div style={{
            fontSize: 10, color: '#ef4444', background: '#fef2f2',
            borderRadius: 6, padding: '7px 10px', lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }}>
          <button
            onClick={onClose}
            disabled={processing}
            style={{
              fontSize: 11, padding: '7px 16px', borderRadius: 7,
              border: '1.5px solid #e2e8f0', background: '#f8fafc',
              color: '#475569', cursor: 'pointer', fontWeight: 600,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleProcess}
            disabled={!canProcess || processing}
            style={{
              fontSize: 11, padding: '7px 18px', borderRadius: 7,
              border: 'none',
              background: canProcess && !processing ? '#6366f1' : '#c7d2fe',
              color: '#fff', cursor: canProcess && !processing ? 'pointer' : 'default',
              fontWeight: 700, minWidth: 80,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            {processing ? (
              <>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  border: '2px solid rgba(255,255,255,0.4)',
                  borderTopColor: '#fff',
                  animation: 'spin 0.7s linear infinite',
                  display: 'inline-block',
                }} />
                Processing…
              </>
            ) : 'Process'}
          </button>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
