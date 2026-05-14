import { useState, useEffect, useRef, useMemo } from 'react'
import type { PieceData } from './types/features'
import { getTheme } from './theme'

export type Lang = 'zh' | 'en'
import { OverviewPage }           from './components/OverviewPage'
import { MentalLandscapePage }    from './components/MentalLandscapePage'
import { ScorePage }              from './components/ScorePage'
import { CorpusStyleView }        from './components/CorpusStyleView'
import SymbolicHeatmapPage        from './components/SymbolicHeatmapPage'
import { MusicVisPage }           from './components/MusicVisPage'
import { ExtractionPanel }        from './components/ExtractionPanel'
import { AudioPlayer }            from './components/AudioPlayer'
import { fetchPieces, fetchFeatures, NotExtractedError, API_BASE } from './api/pieceApi'
import type { PieceMeta }         from './api/pieceApi'
import UploadModal                from './components/UploadModal'
import type { UploadResult }      from './components/UploadModal'

// ── Helpers ─────────────────────────────────────────────────────────

/** Extract the performance version number from a file_name like "WAMozart_K265_3" → 3 */
function perfVersion(fileName: string): number | null {
  const m = fileName.match(/_(\d+)$/)
  return m ? parseInt(m[1], 10) : null
}

function shortName(meta: PieceMeta): string {
  const m = meta.music_name.match(/"(.+?)"/)
  const name = m ? m[1] : meta.music_name.slice(0, 45)
  const ver = perfVersion(meta.file_name)
  const verLabel = ver != null ? ` [v${ver}]` : ''
  return `${meta.composer.split(',')[0]} — "${name}"${verLabel}`
}


// ── Piece browser tree helpers ───────────────────────────────────────

const COMPOSER_GROUPS = [
  { key: 'LBeethoven', label: 'Beethoven', zh: '贝多芬' },
  { key: 'WAMozart',   label: 'Mozart',    zh: '莫扎特' },
  { key: 'JHaydn',     label: 'Haydn',     zh: '海顿'   },
] as const

/** 'WAMozart_K265_3' → 'WAMozart_K265' */
function pieceGroupId(fileName: string): string {
  const parts = fileName.split('_')
  return /^\d+$/.test(parts[parts.length - 1]) ? parts.slice(0, -1).join('_') : fileName
}

/** 'WAMozart_K265' → 'K.265', 'LBeethoven_OP34' → 'Op.34', etc. */
function catalogNum(pieceId: string): string {
  const suffix = pieceId.split('_').slice(1).join('_')
  if (/^K\d/.test(suffix))    return `K.${suffix.slice(1)}`
  if (/^OP\d/.test(suffix))   return `Op.${suffix.slice(2)}`
  if (/^WOO\d/.test(suffix))  return `WoO.${suffix.slice(3)}`
  if (/^XVII/.test(suffix))   return `Hob.XVII:${suffix.replace('XVII', '')}`
  return suffix
}

/** Extract a concise title from the verbose music_name field */
function pieceTitle(musicName: string): string {
  const q = musicName.match(/"([^"]+)"/)
  if (q) return q[1]
  const stripped = musicName.replace(/^[A-Z][a-zäöü\s]+(?:van\s|von\s)?[A-Z][a-z]+\s*[-–]\s*/u, '')
  const clean = stripped.replace(/,\s*(op|woo|k|hob)\.\s*[\d/]+.*/i, '').trim()
  return clean || musicName
}

/** Group a flat PieceMeta[] by pieceGroupId, sorted by version number */
function groupPieces(pieces: PieceMeta[], composerKey: string) {
  const map = new Map<string, PieceMeta[]>()
  for (const p of pieces) {
    if (!p.file_name.startsWith(composerKey + '_')) continue
    const gid = pieceGroupId(p.file_name)
    if (!map.has(gid)) map.set(gid, [])
    map.get(gid)!.push(p)
  }
  return Array.from(map.entries()).map(([id, versions]) => ({
    id,
    musicName: versions[0].music_name,
    versions: versions.sort((a, b) => (perfVersion(a.file_name) ?? 0) - (perfVersion(b.file_name) ?? 0)),
  }))
}

function durationLabel(data: PieceData): string {
  const s = data.metadata.total_duration_sec
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

// ── Piece color palette ──────────────────────────────────────────────

const PIECE_COLORS: Array<{ from: string; to: string }> = [
  { from: '#4361EE', to: '#7C3AED' },
  { from: '#06B6D4', to: '#10B981' },
  { from: '#F59E0B', to: '#EF4444' },
  { from: '#EC4899', to: '#8B5CF6' },
  { from: '#14B8A6', to: '#3B82F6' },
  { from: '#F97316', to: '#EAB308' },
]

function pieceColor(idx: number) {
  return PIECE_COLORS[idx % PIECE_COLORS.length]
}

// ── Tab definitions ──────────────────────────────────────────────────

type PieceTab =
  | 'corpus_view'
  | 'overview'
  | 'mentallandscape'
  | 'symbolic_heatmap'

// ── State types ──────────────────────────────────────────────────────

type PieceViewState = 'loading' | 'ready' | 'not-extracted' | 'error'

interface LoadedPiece {
  meta:      PieceMeta
  data:      PieceData | null
  viewState: PieceViewState
  error?:    string
}

// ── App ──────────────────────────────────────────────────────────────

export default function App() {
  const [lang, _setLang] = useState<Lang>('en')
  const theme = getTheme('scientific')

  const [pieces,           setPieces]          = useState<PieceMeta[]>([])
  const [loadedPieces,     setLoadedPieces]    = useState<LoadedPiece[]>([])
  const [listLoading,      setListLoading]     = useState(true)
  const [listError,        setListError]       = useState('')
  const [expandedComposers,setExpandedComposers] = useState<Set<string>>(new Set())
  const [expandedPieces,   setExpandedPieces]  = useState<Set<string>>(new Set())

  // Global active tab — shared across all piece cards
  const [activeTab,  setActiveTab]  = useState<PieceTab>('corpus_view')

  // Which piece is focused in the sidebar
  const [focusedFile, setFocusedFile] = useState<string | null>(null)

  // Score panel mode: PDF (IMSLP) or MusicXML (Harmonic Function)
  const [scoreMode,  setScoreMode]  = useState<'pdf' | 'musicxml'>('pdf')

  // Temporary uploaded piece (session-only, not in main list)
  const [uploadedPiece,  setUploadedPiece]  = useState<UploadResult | null>(null)
  const [uploadedData,   setUploadedData]   = useState<PieceData | null>(null)
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [uploadFocused,   setUploadFocused]   = useState(false)

  // Available MusicXML files (e.g. "WAMozart_K265.mxl")
  const [musicxmlFiles, setMusicxmlFiles] = useState<string[]>([])

  // ── Fetch MusicXML file list ──────────────────────────────────────
  useEffect(() => {
    fetch(`${API_BASE}/musicvis/list`)
      .then(r => r.json())
      .then(d => setMusicxmlFiles(d.files ?? []))
      .catch(() => {})
  }, [])

  // ── Derived: XML file for focused piece (or uploaded temp) ──────────
  const focusedXmlFile = useMemo(() => {
    // Uploaded piece with MXL takes priority when focused.
    // Use mxl_stem directly — the backend guarantees the file exists in MusicXML/.
    if (uploadFocused && uploadedPiece?.mxl_stem) {
      return uploadedPiece.mxl_stem
    }
    if (!focusedFile || musicxmlFiles.length === 0) return ''
    const stem = focusedFile.replace(/_\d+$/, '')
    return musicxmlFiles.find(f => f.replace(/\.[^.]+$/, '') === stem) ?? ''
  }, [focusedFile, musicxmlFiles, uploadFocused, uploadedPiece])

  // Auto-switch back to PDF when the active context has no MusicXML
  useEffect(() => {
    if (scoreMode !== 'musicxml') return
    if (uploadFocused) {
      // uploaded piece: revert if no MXL
      if (!uploadedPiece?.mxl_stem || focusedXmlFile === '') setScoreMode('pdf')
    } else if (focusedFile && focusedXmlFile === '') {
      setScoreMode('pdf')
    }
  }, [focusedXmlFile, focusedFile, scoreMode, uploadFocused, uploadedPiece])

  // ── Initial load ──────────────────────────────────────────────────

  useEffect(() => {
    fetchPieces()
      .then(list => {
        setPieces(list)
        setListLoading(false)
        const first = list.find(p => p.file_name === 'WAMozart_K265_1')
          ?? list.find(p => p.extracted)
          ?? list[0]
        if (first) { loadPiece(first); setFocusedFile(first.file_name) }
        // Auto-expand the first composer that has data
        const firstPrefix = first ? first.file_name.split('_')[0] + '_' : null
        if (firstPrefix) {
          const composerKey = COMPOSER_GROUPS.find(g => firstPrefix.startsWith(g.key + '_'))?.key
          if (composerKey) setExpandedComposers(new Set([composerKey]))
        }
        // Auto-load ALL extracted pieces so Corpus Map is populated on startup
        list.filter(p => p.extracted).forEach(p => loadPiece(p))
      })
      .catch(err => { setListError(String(err)); setListLoading(false) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load / remove ─────────────────────────────────────────────────

  function loadPiece(meta: PieceMeta) {
    setLoadedPieces(prev => {
      if (prev.find(p => p.meta.file_name === meta.file_name)) return prev
      return [...prev, { meta, data: null, viewState: 'loading' }]
    })
    fetchFeatures(meta.file_name)
      .then(data => {
        setLoadedPieces(prev => prev.map(p =>
          p.meta.file_name === meta.file_name ? { ...p, data, viewState: 'ready' } : p
        ))
      })
      .catch(err => {
        const vs: PieceViewState = err instanceof NotExtractedError ? 'not-extracted' : 'error'
        setLoadedPieces(prev => prev.map(p =>
          p.meta.file_name === meta.file_name
            ? { ...p, viewState: vs, error: String(err) } : p
        ))
      })
  }

  function removePiece(fileName: string) {
    setLoadedPieces(prev => prev.filter(p => p.meta.file_name !== fileName))
    if (focusedFile === fileName) {
      const remaining = loadedPieces.filter(p => p.meta.file_name !== fileName)
      setFocusedFile(remaining[0]?.meta.file_name ?? null)
    }
  }

  async function handleUploadSuccess(result: UploadResult) {
    setUploadedPiece(result)
    setShowUploadModal(false)
    setUploadFocused(true)
    // If MusicXML was included, switch the right panel immediately (focusedXmlFile now
    // resolves directly from mxl_stem, no list lookup needed). Also refresh the list
    // in the background so section pills and regular-piece matching stay up to date.
    if (result.mxl_stem) {
      setScoreMode('musicxml')   // synchronous — same batch as the state above
      fetch(`${API_BASE}/musicvis/list`)
        .then(r => r.json())
        .then(d => setMusicxmlFiles(d.files ?? []))
        .catch(() => {})
    }
    // Fetch the feature data that was just written by the backend
    try {
      const data = await fetchFeatures(result.temp_name)
      setUploadedData(data)
    } catch (e) {
      console.error('Failed to load uploaded feature data:', e)
    }
  }

  function removeUploadedPiece() {
    // Ask backend to delete temp files
    if (uploadedPiece) {
      fetch(`${API_BASE}/upload/temp/${uploadedPiece.temp_name}`, { method: 'DELETE' }).catch(() => {})
    }
    setUploadedPiece(null)
    setUploadedData(null)
    setUploadFocused(false)
    // Revert right panel to PDF if it was showing the now-removed MXL
    setScoreMode('pdf')
    // Refresh MXL list to remove the deleted temp entry
    fetch(`${API_BASE}/musicvis/list`)
      .then(r => r.json())
      .then(d => setMusicxmlFiles(d.files ?? []))
      .catch(() => {})
  }

  function onExtractionDone(fileName: string) {
    setLoadedPieces(prev => prev.map(p =>
      p.meta.file_name === fileName ? { ...p, viewState: 'loading', data: null } : p
    ))
    fetchFeatures(fileName)
      .then(data => {
        setLoadedPieces(prev => prev.map(p =>
          p.meta.file_name === fileName ? { ...p, data, viewState: 'ready' } : p
        ))
      })
      .catch(err => {
        setLoadedPieces(prev => prev.map(p =>
          p.meta.file_name === fileName
            ? { ...p, viewState: 'error', error: String(err) } : p
        ))
      })
    fetchPieces().then(setPieces).catch(() => {})
  }

  // ── Derived ───────────────────────────────────────────────────────

  const loadedFileNames = new Set(loadedPieces.map(p => p.meta.file_name))

  const focusedPiece = loadedPieces.find(p => p.meta.file_name === focusedFile)


  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="vv-app" style={scoreMode === 'musicxml' ? {
      gridTemplateColumns: `var(--vv-sidebar-w) 1fr`,
      gridTemplateAreas:   '"sidebar score"',
    } : {}}>

      {/* ════ SIDEBAR (left) — Piece browser + Feature Comparison Matrix ════ */}
      <aside className="vv-sidebar" style={{ display: 'flex', flexDirection: 'column' }}>

        {/* ── Piece browser (top quarter) ── */}
        <div style={{
          flex:         1,
          overflowY:    'auto',
          borderBottom: '1px solid var(--vv-border)',
          padding:      '8px 8px',
          display:      'flex',
          flexDirection:'column',
          gap:          4,
          minHeight:    0,
        }}>
          {listLoading && (
            <div style={{ fontSize: 11, color: 'var(--vv-text-3)', padding: '6px 4px' }}>
              {lang === 'zh' ? '连接中…' : 'Connecting…'}
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
              display: 'flex', alignItems: 'center', gap: 5,
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: 13 }}>⬆</span>
            {lang === 'zh' ? '上传乐曲' : 'Upload piece'}
          </button>

          {/* Temporary uploaded piece card */}
          {uploadedPiece && (
            <div
              onClick={() => { setUploadFocused(true); setFocusedFile(null) }}
              style={{
                borderRadius: 7,
                border: `1.5px solid ${uploadFocused ? '#6366f1' : '#e2e8f0'}`,
                background:   uploadFocused ? '#eef2ff' : '#f8fafc',
                padding:      '6px 9px',
                cursor:       'pointer',
                display:      'flex', alignItems: 'center', gap: 6,
                marginBottom: 4,
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
                  {lang === 'zh' ? '临时上传' : 'Temp upload'} · {uploadedPiece.n_segments} segs
                </div>
              </div>
              {uploadedData === null && (
                <span style={{ fontSize: 9, color: '#94a3b8' }}>…</span>
              )}
              <button
                onClick={e => { e.stopPropagation(); removeUploadedPiece() }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 13, color: '#94a3b8', padding: '0 2px', lineHeight: 1,
                }}
                title="Remove"
              >×</button>
            </div>
          )}

          {!listLoading && !listError && COMPOSER_GROUPS.map(({ key, label, zh }) => {
            const groups = groupPieces(pieces, key)
            if (groups.length === 0) return null
            const composerOpen = expandedComposers.has(key)
            return (
              <div key={key}>
                <div
                  className="vv-tree-composer"
                  onClick={() => setExpandedComposers(prev => {
                    const next = new Set(prev)
                    next.has(key) ? next.delete(key) : next.add(key)
                    return next
                  })}
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
                        onClick={() => setExpandedPieces(prev => {
                          const next = new Set(prev)
                          next.has(id) ? next.delete(id) : next.add(id)
                          return next
                        })}
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
                                  if (isLoaded) setFocusedFile(p.file_name)
                                  else { loadPiece(p); setFocusedFile(p.file_name) }
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

        {/* ── Feature Comparison Matrix (remaining space) ── */}
        <div style={{ flex: '0 0 auto', overflow: 'hidden', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--vv-border)' }}>
          {uploadFocused && uploadedPiece ? (
            uploadedPiece.available_views.includes('symbolic_heatmap') ? (
              <SymbolicHeatmapPage fileName={uploadedPiece.temp_name} musicName={uploadedPiece.music_name} />
            ) : (
              /* audio-only upload — no MXL data source */
              <div style={{ padding: '28px 20px', textAlign: 'center', fontSize: 11, color: 'var(--vv-text-3)', lineHeight: 1.7 }}>
                <div style={{ fontSize: 15, marginBottom: 6 }}>📊</div>
                <div style={{ fontWeight: 600, color: 'var(--vv-text-2)', marginBottom: 4 }}>No data source</div>
                <div>Feature Comparison Matrix requires a MusicXML file.</div>
              </div>
            )
          ) : focusedPiece?.viewState === 'ready' ? (
            <SymbolicHeatmapPage fileName={focusedPiece.meta.file_name} />
          ) : (
            <div style={{ padding: 40, fontSize: 11, color: 'var(--vv-text-3)', textAlign: 'center' }}>
              Select a piece to view the heatmap
            </div>
          )}
        </div>
      </aside>

      {/* ── Upload Modal ── */}
      {showUploadModal && (
        <UploadModal
          onClose={() => setShowUploadModal(false)}
          onSuccess={handleUploadSuccess}
        />
      )}

      {/* ════ MAIN ════ */}
      <main className="vv-main" style={scoreMode === 'musicxml' ? { display: 'none' } : {}}>
        {listError && (
          <div style={{ padding: '24px 20px' }}>
            <div style={{ fontWeight: 700, color: 'var(--vv-red)', marginBottom: 8, fontSize: 13 }}>
              Cannot connect to VariVis API server
            </div>
            <div style={{ fontSize: 11, color: 'var(--vv-text-2)', lineHeight: 1.7, marginBottom: 14 }}>
              {listError}
            </div>
            <div style={{
              padding: '10px 14px', borderRadius: 8,
              background: 'var(--vv-elevated)',
              fontSize: 11, fontFamily: 'monospace', lineHeight: 2,
              color: 'var(--vv-text)', border: '1px solid var(--vv-border)',
            }}>
              cd /Users/jiaxuan/Desktop/Music\ Project/VariVis/backend<br />
              source .venv/bin/activate<br />
              python -m uvicorn server:app --reload --port 8000
            </div>
          </div>
        )}


        {/* Uploaded piece view */}
        {uploadFocused && uploadedPiece && (
          <UploadedPieceView
            result={uploadedPiece}
            data={uploadedData}
            theme={theme}
            lang={lang}
            onRemove={removeUploadedPiece}
          />
        )}

        {/* Focus view (regular pieces) */}
        {!uploadFocused && activeTab === 'corpus_view' && focusedPiece?.viewState === 'ready' && focusedPiece.data && (
          <PieceSection
            key={focusedPiece.meta.file_name}
            loadedPiece={focusedPiece}
            colorIdx={loadedPieces.findIndex(p => p.meta.file_name === focusedPiece.meta.file_name)}
            theme={theme}
            lang={lang}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            onRemove={() => removePiece(focusedPiece.meta.file_name)}
            onExtractionDone={() => onExtractionDone(focusedPiece.meta.file_name)}
          />
        )}

        {/* Other tabs (regular pieces) */}
        {!uploadFocused && activeTab !== 'corpus_view' && focusedPiece && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <PieceSection
              key={focusedPiece.meta.file_name + activeTab}
              loadedPiece={focusedPiece}
              colorIdx={loadedPieces.findIndex(p => p.meta.file_name === focusedPiece.meta.file_name)}
              theme={theme}
              lang={lang}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              onRemove={() => removePiece(focusedPiece.meta.file_name)}
              onExtractionDone={() => onExtractionDone(focusedPiece.meta.file_name)}
            />
          </div>
        )}

        {listLoading && (
          <div className="vv-loading">
            {lang === 'zh' ? '正在连接服务器…' : 'Connecting to server…'}
          </div>
        )}
      </main>

      {/* ════ SCORE PANEL (right) ════ */}
      <div className="vv-score-panel" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Toggle bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 10px', borderBottom: '1px solid #e2e8f0',
            background: '#f8fafc', flexShrink: 0,
          }}>
            <button
              onClick={() => setScoreMode('pdf')}
              style={{
                fontSize: 11, padding: '3px 10px', borderRadius: 5, border: 'none',
                cursor: 'pointer', fontWeight: 600,
                background: scoreMode === 'pdf' ? '#6366f1' : '#e2e8f0',
                color:      scoreMode === 'pdf' ? '#fff'    : '#64748b',
              }}
            >
              Score
            </button>
            {focusedXmlFile && (
              <button
                onClick={() => setScoreMode('musicxml')}
                style={{
                  fontSize: 11, padding: '3px 10px', borderRadius: 5, border: 'none',
                  cursor: 'pointer', fontWeight: 600,
                  background: scoreMode === 'musicxml' ? '#6366f1' : '#e2e8f0',
                  color:      scoreMode === 'musicxml' ? '#fff'    : '#64748b',
                }}
              >
                Harmonic
              </button>
            )}
            <div style={{ flex: 1 }} />
            {!listLoading && !listError && (
              <div className="vv-online-dot" title="Server online" />
            )}
          </div>
          {/* Score content */}
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {uploadFocused && uploadedPiece ? (
              /* ── Uploaded piece: Score tab shows uploaded PDF or "no data source" ── */
              scoreMode === 'pdf' ? (
                uploadedPiece.pdf_stem ? (
                  <iframe
                    src={`${API_BASE}/upload/temp_pdf/${encodeURIComponent(uploadedPiece.pdf_stem)}#toolbar=1&navpanes=0`}
                    style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                    title="Uploaded PDF Score"
                  />
                ) : (
                  <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--vv-text-3)', fontSize: 11, lineHeight: 1.8 }}>
                    <div style={{ fontSize: 20, marginBottom: 8 }}>📄</div>
                    <div style={{ fontWeight: 600, color: 'var(--vv-text-2)', marginBottom: 4 }}>No data source</div>
                    <div>Upload a PDF score to view it here.</div>
                  </div>
                )
              ) : (
                /* MusicXML mode for uploaded piece */
                uploadedPiece.mxl_stem ? (
                  <MusicVisPage theme={theme} lang={lang} xmlFile={uploadedPiece.mxl_stem} />
                ) : (
                  <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--vv-text-3)', fontSize: 11, lineHeight: 1.8 }}>
                    <div style={{ fontSize: 20, marginBottom: 8 }}>🎵</div>
                    <div style={{ fontWeight: 600, color: 'var(--vv-text-2)', marginBottom: 4 }}>No data source</div>
                    <div>Score View requires a MusicXML file.</div>
                  </div>
                )
              )
            ) : scoreMode === 'pdf' ? (
              focusedPiece?.viewState === 'ready' && focusedPiece.data ? (
                <ScorePage
                  data={focusedPiece.data}
                  theme={theme}
                  isDark={false}
                  lang={lang}
                  fileName={focusedPiece.meta.file_name}
                  composer={focusedPiece.meta.composer}
                />
              ) : (
                <div className="vv-score-panel-empty">
                  <span>Score</span>
                </div>
              )
            ) : (
              <MusicVisPage theme={theme} lang={lang} xmlFile={focusedXmlFile} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── PieceSection ─────────────────────────────────────────────────────

interface PieceSectionProps {
  loadedPiece:      LoadedPiece
  colorIdx:         number
  theme:            ReturnType<typeof getTheme>
  lang:             Lang
  activeTab:        PieceTab
  setActiveTab:     (t: PieceTab) => void
  onRemove:         () => void
  onExtractionDone: () => void
}

function PieceSection({
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
      <div style={{ flexShrink: 0, width: 220 }}>
        <AudioPlayer
          src={audioSrc}
          theme={theme}
          onTimeUpdate={setAudioTime}
          seekToRef={seekToRef}
          pauseRef={pauseMainRef}
          playRef={playMainRef}
          onPlayingChange={setIsMainPlaying}
        />
      </div>
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

// ── UploadedPieceView ────────────────────────────────────────────────
// Shown in the main panel when an uploaded (temporary) piece is focused.
// Shows the SAME four tabs as a regular piece.
// Views with no matching data source show a "no data" notice instead of crashing.

interface UploadedPieceViewProps {
  result:   UploadResult
  data:     PieceData | null
  theme:    ReturnType<typeof getTheme>
  lang:     Lang
  onRemove: () => void
}

/** Placeholder shown when a view's required data source is absent. */

function UploadedPieceView({
  result, data, theme, lang, onRemove,
}: UploadedPieceViewProps) {
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
            <span>Temp upload</span>
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
          <CorpusStyleView
            data={data} theme={theme} isDark={false} lang={lang}
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

