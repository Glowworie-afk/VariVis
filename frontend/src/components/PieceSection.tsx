import { useState, useRef } from 'react'
import type { ThemeTokens } from '../theme'
import type { LoadedPiece, PieceTab } from '../types/app'
import type { PieceMeta } from '../api/pieceApi'
import type { PieceData } from '../types/features'
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer'
import { CorpusStyleView }     from './CorpusStyleView'
import { ExtractionPanel }     from './ExtractionPanel'
import { MentalLandscapePage } from './MentalLandscapePage'
import { OverviewPage }        from './OverviewPage'
import SymbolicHeatmapPage     from './SymbolicHeatmapPage'
import { useT }                from '../i18n/LangContext'
import { API_BASE }            from '../api/pieceApi'
import { shortName, durationLabel } from '../utils/pieceHelpers'
import { pieceColor }          from '../constants/pieces'

// ── PieceHeader ───────────────────────────────────────────────────────
//
// Two visual variants driven by the active tab:
//   'compact' — corpus_view: slim inline bar, basic meta only
//   'card'    — other tabs:  uses vv-card-header class, adds period + analysis badges

interface PieceHeaderProps {
  meta:     PieceMeta
  data:     PieceData | null
  color:    { from: string; to: string }
  variant:  'compact' | 'card'
  hasPyin:  boolean
  onRemove: () => void
}

function PieceHeader({ meta, data, color, variant, hasPyin, onRemove }: PieceHeaderProps) {
  const gradient = `linear-gradient(180deg, ${color.from}, ${color.to})`
  const isReady  = data !== null

  if (variant === 'card') {
    return (
      <div className="vv-card-header">
        <div className="vv-card-color-bar" style={{ background: gradient }} />
        <div className="vv-card-header-info">
          <div className="vv-card-title">{shortName(meta)}</div>
          <div className="vv-card-meta">
            {isReady && data && (
              <>
                <span className="vv-meta-tag" style={{ textTransform: 'capitalize' }}>{data.metadata.instrument}</span>
                <span className="vv-meta-sep">·</span>
                <span className="vv-meta-tag">{data.metadata.variation_num} var.</span>
                <span className="vv-meta-sep">·</span>
                <span className="vv-meta-tag">{durationLabel(data)}</span>
                <span className="vv-meta-sep">·</span>
                <span className="vv-meta-tag">{data.metadata.period}</span>
                <span className={`vv-badge ${hasPyin ? 'vv-badge-cyan' : 'vv-badge-amber'}`}>
                  {hasPyin ? 'pYIN' : 'chroma'}
                </span>
                <span className="vv-badge vv-badge-green">Extracted</span>
              </>
            )}
          </div>
        </div>
        <button className="vv-remove-btn" onClick={onRemove} title="Remove this piece">×</button>
      </div>
    )
  }

  // compact — corpus_view bar
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
          </div>
        )}
      </div>
      <button className="vv-remove-btn" onClick={onRemove} title="Remove this piece">×</button>
    </div>
  )
}

// ── PieceStateMessage ─────────────────────────────────────────────────
// Shared loading / error / not-extracted messages for the content area.

function PieceStateMessage({ loadedPiece, theme, onExtractionDone, padded }: {
  loadedPiece:      LoadedPiece
  theme:            ThemeTokens
  onExtractionDone: () => void
  padded:           boolean
}) {
  const t = useT()
  const { meta, viewState } = loadedPiece
  if (viewState === 'loading') {
    return <div className="vv-loading">{t('piece.loading-features')}</div>
  }
  if (viewState === 'not-extracted') {
    return (
      <div style={padded ? { padding: 16 } : undefined}>
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

// ── PieceSection ──────────────────────────────────────────────────────

interface PieceSectionProps {
  loadedPiece:      LoadedPiece
  colorIdx:         number
  theme:            ThemeTokens
  activeTab:        PieceTab
  setActiveTab:     (t: PieceTab) => void
  onRemove:         () => void
  onExtractionDone: () => void
}

export function PieceSection({
  loadedPiece,
  colorIdx,
  theme,
  activeTab,
  setActiveTab: _setActiveTab,
  onRemove,
  onExtractionDone,
}: PieceSectionProps) {
  const { meta, data, viewState } = loadedPiece
  const hasPyin = (data?.segments[0]?.features.pitch_contour?.midi_relative?.length ?? 0) > 0
  const color   = pieceColor(colorIdx)

  const [selectedSeg, setSelectedSeg] = useState<number | null>(null)
  const [audioTime,     setAudioTime]     = useState(0)
  const [isMainPlaying, setIsMainPlaying] = useState(false)
  const playerRef = useRef<AudioPlayerHandle>(null)

  const audioSrc  = `${API_BASE}/audio/${encodeURIComponent(meta.file_name)}?folder=${encodeURIComponent(meta.folder)}`
  const isCorpus  = activeTab === 'corpus_view'
  const isReady   = viewState === 'ready'

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      background: 'var(--vv-bg)',
    }}>
      {/* AudioPlayer — always hidden, kept mounted for playerRef.
          Only corpus_view uses it (via CorpusStyleView play/pause/seek). */}
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
        variant={isCorpus ? 'compact' : 'card'}
        hasPyin={hasPyin}
        onRemove={onRemove}
      />

      {/* Content area — corpus_view clips overflow (CorpusStyleView scrolls internally);
          other tabs scroll at this level with padding. */}
      <div style={{
        flex: 1,
        overflow:  isCorpus ? 'hidden' : 'auto',
        padding:   !isCorpus && isReady ? '12px 14px' : 0,
      }}>
        {isReady && data && isCorpus && (
          <CorpusStyleView
            data={data} theme={theme} isDark={false}
            fileName={meta.file_name} hasMidi={meta.has_midi}
            onSeekMain={sec => playerRef.current?.seekTo(sec)}
            playMain={() => playerRef.current?.play()}
            pauseMain={() => playerRef.current?.pause()}
            mainTime={audioTime}
            isMainPlaying={isMainPlaying}
          />
        )}
        {isReady && data && activeTab === 'mentallandscape' && (
          <MentalLandscapePage
            data={data} theme={theme} isDark={false}
            selectedSeg={selectedSeg}
            onSegSelect={i => setSelectedSeg(prev => prev === i ? null : i)}
          />
        )}
        {isReady && data && activeTab === 'overview' && (
          <OverviewPage data={data} theme={theme} isDark={false} />
        )}
        {activeTab === 'symbolic_heatmap' && (
          <SymbolicHeatmapPage fileName={meta.file_name} />
        )}

        {viewState !== 'ready' && (
          <PieceStateMessage
            loadedPiece={loadedPiece} theme={theme}
            onExtractionDone={onExtractionDone}
            padded={isCorpus}
          />
        )}
      </div>
    </div>
  )
}
