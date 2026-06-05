import { useState, useRef } from 'react'
import type { ThemeTokens } from '@/constants/theme'
import type { LoadedPiece } from '@/types/app'
import type { PieceMeta } from '@/api/pieceApi'
import type { PieceData } from '@/types/features'
import type { UploadResult } from '@/features/extraction/UploadModal'
import { AudioPlayer, type AudioPlayerHandle } from '@/features/structural/SegmentOverview/components/AudioPlayer'
import { SegmentOverview } from '@/features/structural/SegmentOverview/SegmentOverview'
import { ExtractionPanel } from '@/features/extraction/ExtractionPanel'
import { useT } from '@/i18n/LangContext'
import { API_BASE } from '@/api/pieceApi'
import { shortName, durationLabel } from '@/utils/pieceHelpers'
import { pieceColor } from '@/constants/pieces'

// ── PieceHeader ───────────────────────────────────────────────────────

interface PieceHeaderProps {
  meta:     PieceMeta
  data:     PieceData | null
  color:    { from: string; to: string }
  hasPyin:  boolean
  onRemove: () => void
}

function PieceHeader({ meta, data, color, hasPyin, onRemove }: PieceHeaderProps) {
  const gradient = `linear-gradient(180deg, ${color.from}, ${color.to})`
  const isReady  = data !== null

  // compact corpus_view bar
  return (
    <div style={{
      flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 14px', borderBottom: '1px solid var(--vv-border)', background: 'var(--vv-surface)',
    }}>
      <div className="vv-card-color-bar" style={{ background: gradient }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="vv-card-title" style={{ fontSize: 12 }}>{shortName(meta)}</div>
        {isReady && data && (
          <div className="vv-card-meta" style={{ marginTop: 1 }}>
            <span className="vv-meta-tag" style={{ textTransform: 'capitalize' }}>{data.metadata.instrument}</span>
            <span className="vv-meta-sep">·</span>
            <span className="vv-meta-tag">{data.metadata.variation_num} var.</span>
            <span className="vv-meta-sep">·</span>
            <span className="vv-meta-tag">{durationLabel(data)}</span>
            <span className={`vv-badge ${hasPyin ? 'vv-badge-cyan' : 'vv-badge-amber'}`}>
              {hasPyin ? 'pYIN' : 'chroma'}
            </span>
          </div>
        )}
      </div>
      <button className="vv-remove-btn" onClick={onRemove} title="Remove this piece">×</button>
    </div>
  )
}

// ── PieceStateMessage ─────────────────────────────────────────────────

function PieceStateMessage({ loadedPiece, theme, onExtractionDone }: {
  loadedPiece:      LoadedPiece
  theme:            ThemeTokens
  onExtractionDone: () => void
}) {
  const t = useT()
  const { meta, viewState } = loadedPiece
  if (viewState === 'loading') {
    return <div className="vv-loading">{t('piece.loading-features')}</div>
  }
  if (viewState === 'not-extracted') {
    return (
      <div style={{ padding: 16 }}>
        <ExtractionPanel piece={meta} theme={theme} onDone={onExtractionDone} />
      </div>
    )
  }
  if (viewState === 'error') {
    return (
      <div style={{ padding: '16px 20px', fontSize: 11, color: 'var(--vv-red)', fontFamily: 'monospace' }}>
        {loadedPiece.error ?? 'Unknown error'}
      </div>
    )
  }
  return null
}

// ── UploadedView (inlined from UploadedPieceView) ─────────────────────

function UploadedView({ result, data, theme, onRemove }: {
  result:   UploadResult
  data:     PieceData | null
  theme:    ThemeTokens
  onRemove: () => void
}) {
  const t = useT()
  const hasMxl   = result.mxl_stem !== null
  const hasAudio = data !== null && (data.segments[0]?.features?.rms_mean !== undefined)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--vv-bg)' }}>

      {/* ── Header ── */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 14px', borderBottom: '1px solid var(--vv-border)', background: 'var(--vv-surface)',
      }}>
        <div style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: 'linear-gradient(180deg,#6366f1,#8b5cf6)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--vv-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {result.music_name}
          </div>
          <div style={{ fontSize: 10, color: 'var(--vv-text-3)', marginTop: 1, display: 'flex', gap: 5, alignItems: 'center' }}>
            <span>{t('sidebar.temp-upload')}</span>
            <span>·</span>
            <span>{result.n_segments} segs</span>
            {hasMxl   && <span style={{ background: '#6366f1', color: '#fff', borderRadius: 3, padding: '0 4px', fontSize: 9, fontWeight: 700 }}>MXL</span>}
            {hasAudio && <span style={{ background: '#10b981', color: '#fff', borderRadius: 3, padding: '0 4px', fontSize: 9, fontWeight: 700 }}>AUDIO</span>}
          </div>
        </div>
        <button className="vv-remove-btn" onClick={onRemove} title="Remove upload">×</button>
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {data === null && (
          <div className="vv-loading">Processing…</div>
        )}

        {data !== null && !hasAudio && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center', color: 'var(--vv-text-3)', fontSize: 11, lineHeight: 1.8 }}>
              <div style={{ fontSize: 22, marginBottom: 8, opacity: 0.3 }}>⊘</div>
              <div style={{ fontWeight: 600, color: 'var(--vv-text-2)', marginBottom: 4 }}>No data source</div>
              <div>This view requires an audio file.</div>
            </div>
          </div>
        )}

        {data !== null && hasAudio && (
          <SegmentOverview
            data={data} theme={theme} isDark={false}
            fileName={result.temp_name} hasMidi={false}
            onSeekMain={() => {}}
            playMain={() => {}}
            pauseMain={() => {}}
            mainTime={0}
            isMainPlaying={false}
          />
        )}
      </div>
    </div>
  )
}

// ── CorpusView (main export) ──────────────────────────────────────────

interface CorpusViewProps {
  // For upload mode
  uploadFocused:    boolean
  uploadedPiece:    UploadResult | null
  uploadedData:     PieceData | null
  onRemoveUpload:   () => void
  // For piece mode
  loadedPiece?:     LoadedPiece
  colorIdx?:        number
  theme:            ThemeTokens
  onRemove?:        () => void
  onExtractionDone?: () => void
}

export function CorpusView({
  uploadFocused,
  uploadedPiece,
  uploadedData,
  onRemoveUpload,
  loadedPiece,
  colorIdx = 0,
  theme,
  onRemove,
  onExtractionDone,
}: CorpusViewProps) {
  // Hooks must be called before any early returns
  const [audioTime,     setAudioTime]     = useState(0)
  const [isMainPlaying, setIsMainPlaying] = useState(false)
  const playerRef = useRef<AudioPlayerHandle>(null)

  // Upload mode
  if (uploadFocused && uploadedPiece) {
    return (
      <UploadedView
        result={uploadedPiece}
        data={uploadedData}
        theme={theme}
        onRemove={onRemoveUpload}
      />
    )
  }

  // Piece mode
  if (!loadedPiece) return null

  const { meta, data, viewState } = loadedPiece
  const hasPyin = (data?.segments[0]?.features.pitch_contour?.midi_relative?.length ?? 0) > 0
  const color   = pieceColor(colorIdx)
  const isReady = viewState === 'ready'

  const audioSrc = `${API_BASE}/audio/${encodeURIComponent(meta.file_name)}?folder=${encodeURIComponent(meta.folder)}`

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      background: 'var(--vv-bg)',
    }}>
      {/* AudioPlayer — always hidden, kept mounted for playerRef */}
      {isReady && (
        <div style={{ display: 'none' }}>
          <AudioPlayer
            ref={playerRef}
            src={audioSrc}
            theme={theme}
            onTimeUpdate={setAudioTime}
            onPlayingChange={setIsMainPlaying}
          />
        </div>
      )}

      <PieceHeader
        meta={meta} data={isReady ? data : null}
        color={color}
        hasPyin={hasPyin}
        onRemove={onRemove ?? (() => {})}
      />

      <div style={{
        flex: 1,
        overflow: 'hidden',
        padding: 0,
      }}>
        {isReady && data && (
          <SegmentOverview
            data={data} theme={theme} isDark={false}
            fileName={meta.file_name} hasMidi={meta.has_midi}
            onSeekMain={sec => playerRef.current?.seekTo(sec)}
            playMain={() => playerRef.current?.play()}
            pauseMain={() => playerRef.current?.pause()}
            mainTime={audioTime}
            isMainPlaying={isMainPlaying}
          />
        )}

        {viewState !== 'ready' && onExtractionDone && (
          <PieceStateMessage
            loadedPiece={loadedPiece} theme={theme}
            onExtractionDone={onExtractionDone}
          />
        )}
      </div>
    </div>
  )
}
