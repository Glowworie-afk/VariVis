import { useState, useRef } from 'react'
import type { ThemeTokens } from '../theme'
import type { LoadedPiece, PieceTab, Lang } from '../types/app'
import { AudioPlayer }         from './AudioPlayer'
import { CorpusStyleView }     from './CorpusStyleView'
import { ExtractionPanel }     from './ExtractionPanel'
import { MentalLandscapePage } from './MentalLandscapePage'
import { OverviewPage }        from './OverviewPage'
import SymbolicHeatmapPage     from './SymbolicHeatmapPage'
import { API_BASE }            from '../api/pieceApi'
import { shortName, durationLabel } from '../utils/pieceHelpers'
import { pieceColor }          from '../constants/pieces'

interface PieceSectionProps {
  loadedPiece:      LoadedPiece
  colorIdx:         number
  theme:            ThemeTokens
  lang:             Lang
  activeTab:        PieceTab
  setActiveTab:     (t: PieceTab) => void
  onRemove:         () => void
  onExtractionDone: () => void
}

export function PieceSection({
  loadedPiece,
  colorIdx,
  theme,
  lang,
  activeTab,
  setActiveTab: _setActiveTab,
  onRemove,
  onExtractionDone,
}: PieceSectionProps) {
  const { meta, data, viewState } = loadedPiece
  const hasPyin = (data?.segments[0]?.features.pitch_contour?.midi_relative?.length ?? 0) > 0
  const color   = pieceColor(colorIdx)

  const [selectedSeg, setSelectedSeg] = useState<number | null>(null)
  function handleSegSelect(i: number) {
    setSelectedSeg(prev => prev === i ? null : i)
  }

  const [audioTime,     setAudioTime]     = useState(0)
  const [isMainPlaying, setIsMainPlaying] = useState(false)
  const seekToRef    = useRef<((sec: number) => void) | null>(null)
  const pauseMainRef = useRef<(() => void) | null>(null)
  const playMainRef  = useRef<(() => void) | null>(null)

  const audioSrc = `${API_BASE}/audio/${encodeURIComponent(meta.file_name)}?folder=${encodeURIComponent(meta.folder)}`

  function handleSeekToSegment(startSec: number) {
    seekToRef.current?.(startSec)
  }

  // ── Shared piece header ──────────────────────────────────────────

  const pieceHeaderBar = (
    <div style={{
      flexShrink:   0,
      display:      'flex',
      alignItems:   'center',
      gap:          8,
      padding:      '6px 14px',
      borderBottom: '1px solid var(--vv-border)',
      background:   'var(--vv-surface)',
    }}>
      <div className="vv-card-color-bar"
        style={{ background: `linear-gradient(180deg, ${color.from}, ${color.to})` }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="vv-card-title" style={{ fontSize: 12 }}>{shortName(meta)}</div>
        {data && viewState === 'ready' && (
          <div className="vv-card-meta" style={{ marginTop: 1 }}>
            <span className="vv-meta-tag" style={{ textTransform: 'capitalize' }}>
              {data.metadata.instrument}
            </span>
            <span className="vv-meta-sep">·</span>
            <span className="vv-meta-tag">{data.metadata.variation_num} var.</span>
            <span className="vv-meta-sep">·</span>
            <span className="vv-meta-tag">{durationLabel(data)}</span>
          </div>
        )}
      </div>
      {/* Hidden main AudioPlayer — kept mounted so playMainRef / pauseMainRef /
          seekToRef get assigned. Segment Overview triggers playback through
          these refs; the UI itself is hidden via display:none. */}
      {viewState === 'ready' && (
        <div style={{ display: 'none' }}>
          <AudioPlayer
            src={audioSrc}
            theme={theme}
            onTimeUpdate={setAudioTime}
            seekToRef={seekToRef}
            playRef={playMainRef}
            pauseRef={pauseMainRef}
            onPlayingChange={setIsMainPlaying}
          />
        </div>
      )}
      <button className="vv-remove-btn" onClick={onRemove} title="Remove this piece">×</button>
    </div>
  )

  // ── Corpus view ──────────────────────────────────────────────────

  if (activeTab === 'corpus_view') {
    return (
      <div style={{
        display:       'flex',
        flexDirection: 'column',
        height:        '100%',
        overflow:      'hidden',
        background:    'var(--vv-bg)',
      }}>
        {pieceHeaderBar}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {viewState === 'ready' && data && (
            <CorpusStyleView
              data={data} theme={theme} isDark={false} lang={lang}
              fileName={meta.file_name} hasMidi={meta.has_midi}
              onSeekMain={handleSeekToSegment}
              playMain={() => playMainRef.current?.()}
              pauseMain={() => pauseMainRef.current?.()}
              mainTime={audioTime}
              isMainPlaying={isMainPlaying}
            />
          )}
          {viewState === 'loading' && (
            <div className="vv-loading">
              {lang === 'zh' ? '加载特征中…' : 'Loading features…'}
            </div>
          )}
          {viewState === 'not-extracted' && (
            <div style={{ padding: 16 }}>
              <ExtractionPanel piece={meta} theme={theme} onDone={onExtractionDone} />
            </div>
          )}
          {viewState === 'error' && (
            <div style={{ padding: '16px 20px', fontSize: 11, color: 'var(--vv-red)', fontFamily: 'monospace' }}>
              {loadedPiece.error ?? 'Unknown error'}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Card wrapper for all other tabs ──────────────────────────────

  return (
    <div className="vv-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRadius: 0, border: 'none', boxShadow: 'none', margin: 0 }}>
      <div className="vv-card-header">
        <div
          className="vv-card-color-bar"
          style={{ background: `linear-gradient(180deg, ${color.from}, ${color.to})` }}
        />
        <div className="vv-card-header-info">
          <div className="vv-card-title">{shortName(meta)}</div>
          <div className="vv-card-meta">
            {data && viewState === 'ready' && (
              <>
                <span className="vv-meta-tag" style={{ textTransform: 'capitalize' }}>
                  {data.metadata.instrument}
                </span>
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
            {viewState === 'loading' && (
              <span style={{ fontSize: 11, color: 'var(--vv-text-3)', opacity: 0.8 }}>
                {lang === 'zh' ? '加载中…' : 'Loading…'}
              </span>
            )}
            {viewState === 'not-extracted' && (
              <span className="vv-badge vv-badge-amber">
                {lang === 'zh' ? '未提取' : 'Not extracted'}
              </span>
            )}
          </div>
        </div>
        <button className="vv-remove-btn" onClick={onRemove} title="Remove this piece">×</button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: viewState === 'ready' ? '12px 14px' : 0 }}>

        {viewState === 'ready' && data && activeTab === 'mentallandscape' && (
          <MentalLandscapePage
            data={data} theme={theme} isDark={false} lang={lang}
            selectedSeg={selectedSeg} onSegSelect={handleSegSelect}
          />
        )}
        {activeTab === 'symbolic_heatmap' && (
          <SymbolicHeatmapPage fileName={meta.file_name} />
        )}

        {viewState === 'ready' && data && activeTab === 'overview' && (
          <OverviewPage data={data} theme={theme} isDark={false} lang={lang} />
        )}

        {viewState === 'loading' && (
          <div className="vv-loading">
            {lang === 'zh' ? '加载特征中…' : 'Loading features…'}
          </div>
        )}
        {viewState === 'not-extracted' && (
          <ExtractionPanel piece={meta} theme={theme} onDone={onExtractionDone} />
        )}
        {viewState === 'error' && (
          <div style={{
            padding: '16px 20px', fontSize: 11,
            color: 'var(--vv-red)', fontFamily: 'monospace',
          }}>
            {loadedPiece.error ?? 'Unknown error'}
          </div>
        )}
      </div>
    </div>
  )
}
