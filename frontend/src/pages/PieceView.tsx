import type { LoadedPiece } from '../types/app'
import type { PieceListState } from '../hooks/usePieceList'
import type { LoadedPiecesState } from '../hooks/useLoadedPieces'
import type { AppNavState } from '../hooks/useAppNav'
import type { UploadState } from '../hooks/useUpload'
import { useLang, useT } from '../i18n/LangContext'
import { perfVersion, pieceTitle, catalogNum, groupPieces } from '../utils/pieceHelpers'
import { COMPOSER_GROUPS } from '../constants/pieces'
import { SymbolicHeatmap } from '../features/feature-overview/SymbolicHeatmap'
import UploadModal from '../features/extraction/UploadModal'

interface SidebarProps {
  pieceList:       PieceListState
  loaded:          LoadedPiecesState
  nav:             AppNavState
  upload:          UploadState
  loadedFileNames: Set<string>
  focusedPiece:    LoadedPiece | undefined
}

export function PieceView({ pieceList, loaded, nav, upload, loadedFileNames, focusedPiece }: SidebarProps) {
  const t    = useT()
  const lang = useLang()

  const { pieces, listLoading, listError } = pieceList
  const { loadPiece } = loaded
  const { focusedFile, setFocusedFile, expandedComposers, setExpandedComposers, expandedPieces, setExpandedPieces } = nav
  const { uploadedPiece, uploadedData, uploadFocused, setUploadFocused, showUploadModal, setShowUploadModal, removeUploadedPiece, handleUploadSuccess } = upload

  return (
    <aside className="vv-sidebar" style={{ display: 'flex', flexDirection: 'column' }}>

      {/* ── Piece browser ── */}
      <div style={{
        flex: 1, overflowY: 'auto', borderBottom: '1px solid var(--vv-border)',
        padding: '8px 8px', display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0,
      }}>
        {listLoading && (
          <div style={{ fontSize: 11, color: 'var(--vv-text-3)', padding: '6px 4px' }}>
            {t('sidebar.connecting')}
          </div>
        )}
        {listError && (
          <div style={{ fontSize: 11, color: 'var(--vv-red)', padding: '6px 4px' }}>{listError}</div>
        )}

        {/* Upload button */}
        <button
          onClick={() => setShowUploadModal(true)}
          style={{
            fontSize: 10, padding: '5px 10px', borderRadius: 7,
            border: '1.5px dashed #cbd5e1', background: 'transparent',
            color: '#64748b', cursor: 'pointer', fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 13 }}>⬆</span>
          {t('sidebar.upload')}
        </button>

        {/* Uploaded piece card */}
        {uploadedPiece && (
          <div
            onClick={() => { setUploadFocused(true); setFocusedFile(null) }}
            style={{
              borderRadius: 7, cursor: 'pointer', marginBottom: 4,
              border: `1.5px solid ${uploadFocused ? '#6366f1' : '#e2e8f0'}`,
              background: uploadFocused ? '#eef2ff' : '#f8fafc',
              padding: '6px 9px', display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{ fontSize: 11, color: '#6366f1' }}>⬡</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 10, fontWeight: 700, color: '#334155',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {uploadedPiece.music_name}
              </div>
              <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 1 }}>
                {t('sidebar.temp-upload')} · {uploadedPiece.n_segments} segs
              </div>
            </div>
            {uploadedData === null && <span style={{ fontSize: 9, color: '#94a3b8' }}>…</span>}
            <button
              onClick={e => { e.stopPropagation(); removeUploadedPiece() }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#94a3b8', padding: '0 2px', lineHeight: 1 }}
              title="Remove"
            >×</button>
          </div>
        )}

        {/* Composer tree */}
        {!listLoading && !listError && COMPOSER_GROUPS.map(({ key, label, zh }) => {
          const groups = groupPieces(pieces, key)
          if (groups.length === 0) return null
          const composerOpen = expandedComposers.has(key)
          return (
            <div key={key}>
              <div
                className="vv-tree-composer"
                onClick={() => {
                  const next = new Set(expandedComposers)
                  next.has(key) ? next.delete(key) : next.add(key)
                  setExpandedComposers(next)
                }}
              >
                <span className="vv-tree-caret">{composerOpen ? '▾' : '▸'}</span>
                <span style={{ flex: 1 }}>{lang === 'zh' ? zh : label}</span>
                <span className="vv-tree-badge">{groups.length}</span>
              </div>
              {composerOpen && groups.map(({ id, musicName, versions }) => {
                const pieceOpen = expandedPieces.has(id)
                const anyLoaded = versions.some(p => loadedFileNames.has(p.file_name))
                return (
                  <div key={id}>
                    <div
                      className={`vv-tree-piece${anyLoaded ? ' has-loaded' : ''}`}
                      onClick={() => {
                        const next = new Set(expandedPieces)
                        next.has(id) ? next.delete(id) : next.add(id)
                        setExpandedPieces(next)
                      }}
                    >
                      <span className="vv-tree-caret" style={{ fontSize: 9 }}>{pieceOpen ? '▾' : '▸'}</span>
                      <span className="vv-tree-piece-title">{pieceTitle(musicName)}</span>
                      <span className="vv-tree-catalog">{catalogNum(id)}</span>
                      <span className="vv-tree-badge">{versions.length}</span>
                    </div>
                    {pieceOpen && (
                      <div className="vv-tree-versions">
                        {versions.map(p => {
                          const ver = perfVersion(p.file_name)
                          const isLoaded  = loadedFileNames.has(p.file_name)
                          const isFocused = focusedFile === p.file_name
                          return (
                            <button
                              key={p.file_name}
                              className={`vv-tree-version${isFocused ? ' focused' : isLoaded ? ' loaded' : ''}`}
                              title={p.file_name + (p.has_midi ? ' · MIDI available' : '')}
                              onClick={() => {
                                setUploadFocused(false)
                                if (!isLoaded) loadPiece(p)
                                setFocusedFile(p.file_name)
                              }}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
                            >
                              v{ver}
                              {p.has_midi && (
                                <span style={{
                                  fontSize: 7, fontWeight: 700, letterSpacing: 0.2,
                                  background: '#10b981', color: '#fff',
                                  borderRadius: 3, padding: '0px 3px', lineHeight: '12px',
                                }}>M</span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* ── Feature Comparison Heatmap ── */}
      <div style={{ flex: '0 0 auto', overflow: 'hidden', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--vv-border)' }}>
        {uploadFocused && uploadedPiece ? (
          uploadedPiece.available_views.includes('symbolic_heatmap') ? (
            <SymbolicHeatmap fileName={uploadedPiece.temp_name} musicName={uploadedPiece.music_name} />
          ) : (
            <div style={{ padding: '28px 20px', textAlign: 'center', fontSize: 11, color: 'var(--vv-text-3)', lineHeight: 1.7 }}>
              <div style={{ fontSize: 15, marginBottom: 6 }}>📊</div>
              <div style={{ fontWeight: 600, color: 'var(--vv-text-2)', marginBottom: 4 }}>No data source</div>
              <div>Feature Comparison Heatmap requires a MusicXML file.</div>
            </div>
          )
        ) : focusedPiece?.viewState === 'ready' ? (
          <SymbolicHeatmap fileName={focusedPiece.meta.file_name} />
        ) : (
          <div style={{ padding: 40, fontSize: 11, color: 'var(--vv-text-3)', textAlign: 'center' }}>
            Select a piece to view the heatmap
          </div>
        )}
      </div>

      {showUploadModal && (
        <UploadModal onClose={() => setShowUploadModal(false)} onSuccess={handleUploadSuccess} />
      )}
    </aside>
  )
}
