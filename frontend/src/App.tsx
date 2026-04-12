import { useState, useEffect, useRef } from 'react'
import type { PieceData } from './types/features'
import { getTheme } from './theme'

export type Lang = 'zh' | 'en'
import { PitchContourPage }       from './components/PitchContourPage'
import { ChromaRingPage }         from './components/ChromaRingPage'
import { TimbrePCA }              from './components/TimbrePCA'
import { RhythmBubblePage }       from './components/RhythmBubblePage'
import { HarmonicFingerprintPage} from './components/HarmonicFingerprintPage'
import { OverviewPage }           from './components/OverviewPage'
import { MentalLandscapePage }    from './components/MentalLandscapePage'
import MIDIAnalysisPage            from './components/MIDIAnalysisPage'
import { ExtractionPanel }        from './components/ExtractionPanel'
import { AudioPlayer }            from './components/AudioPlayer'
import { fetchPieces, fetchFeatures, NotExtractedError, API_BASE } from './api/pieceApi'
import type { PieceMeta }         from './api/pieceApi'

// ── Helpers ─────────────────────────────────────────────────────────

function shortName(meta: PieceMeta): string {
  const m = meta.music_name.match(/"(.+?)"/)
  const name = m ? m[1] : meta.music_name.slice(0, 45)
  return `${meta.composer.split(',')[0]} — "${name}"`
}

function shortNameBrief(meta: PieceMeta): string {
  const m = meta.music_name.match(/"(.+?)"/)
  const name = m ? m[1] : meta.music_name.slice(0, 28)
  const composer = meta.composer.split(',')[0].split(' ').pop() ?? ''
  return `${composer} — "${name}"`
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
  | 'variations' | 'chroma' | 'mfcc' | 'rhythm'
  | 'harmonic' | 'overview' | 'midianalysis' | 'mentallandscape'

const AUDIO_TABS: PieceTab[] = [
  'midianalysis', 'variations', 'chroma', 'mfcc', 'rhythm', 'harmonic', 'overview', 'mentallandscape',
]

const TAB_LABELS: Record<PieceTab, { zh: string; en: string; icon: string }> = {
  midianalysis:    { zh: 'MIDI 分析',  en: 'MIDI Analysis',      icon: '🎼' },
  variations:      { zh: '音高折线图', en: 'Pitch Contour',      icon: '📈' },
  chroma:          { zh: '色度环',     en: 'Chroma',             icon: '🎨' },
  mfcc:            { zh: '音色 PCA',  en: 'Timbre PCA',         icon: '🔬' },
  rhythm:          { zh: '节奏气泡',  en: 'Rhythm',             icon: '🔵' },
  harmonic:        { zh: '和声功能',  en: 'Harmonic Function',  icon: '🎹' },
  overview:        { zh: '综合视图',  en: 'Overview',           icon: '📊' },
  mentallandscape: { zh: '心理图景',  en: 'Mental Landscape',   icon: '🌌' },
}

// ── State types ──────────────────────────────────────────────────────

type PieceViewState = 'loading' | 'ready' | 'not-extracted' | 'error'

interface LoadedPiece {
  meta:      PieceMeta
  data:      PieceData | null
  viewState: PieceViewState
  error?:    string
  collapsed: boolean
}

// ── App ──────────────────────────────────────────────────────────────

export default function App() {
  const [lang, setLang] = useState<Lang>('en')
  const theme = getTheme('scientific')

  const [pieces,                setPieces]               = useState<PieceMeta[]>([])
  const [loadedPieces,          setLoadedPieces]         = useState<LoadedPiece[]>([])
  const [listLoading,           setListLoading]          = useState(true)
  const [listError,             setListError]            = useState('')
  const [addDropdown,           setAddDropdown]          = useState<string>('')
  const [addExtractedDropdown,  setAddExtractedDropdown] = useState<string>('')

  // Global active tab — shared across all piece cards
  const [activeTab, setActiveTab] = useState<PieceTab>('midianalysis')

  // Which piece is focused in the sidebar
  const [focusedFile, setFocusedFile] = useState<string | null>(null)

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
        const rest = list.filter(p => p.file_name !== (first?.file_name ?? ''))
        if (rest.length > 0) setAddDropdown(rest[0].file_name)
        const firstExtracted = rest.find(p => p.extracted)
        if (firstExtracted) setAddExtractedDropdown(firstExtracted.file_name)
      })
      .catch(err => { setListError(String(err)); setListLoading(false) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load / remove / collapse ──────────────────────────────────────

  function loadPiece(meta: PieceMeta) {
    setLoadedPieces(prev => {
      if (prev.find(p => p.meta.file_name === meta.file_name)) return prev
      return [...prev, { meta, data: null, viewState: 'loading', collapsed: false }]
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
    setAddDropdown(prev => prev || fileName)
    if (focusedFile === fileName) {
      const remaining = loadedPieces.filter(p => p.meta.file_name !== fileName)
      setFocusedFile(remaining[0]?.meta.file_name ?? null)
    }
  }

  function toggleCollapse(fileName: string) {
    setLoadedPieces(prev => prev.map(p =>
      p.meta.file_name === fileName ? { ...p, collapsed: !p.collapsed } : p
    ))
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

  // ── Add handlers ──────────────────────────────────────────────────

  function handleAddPiece() {
    const meta = pieces.find(p => p.file_name === addDropdown)
    if (!meta) return
    loadPiece(meta)
    setFocusedFile(meta.file_name)
    const loadedSet = new Set([...loadedPieces.map(p => p.meta.file_name), meta.file_name])
    const next = pieces.find(p => !loadedSet.has(p.file_name))
    setAddDropdown(next?.file_name ?? '')
  }

  function handleAddExtracted() {
    const meta = pieces.find(p => p.file_name === addExtractedDropdown)
    if (!meta) return
    loadPiece(meta)
    setFocusedFile(meta.file_name)
    const loadedSet = new Set([...loadedPieces.map(p => p.meta.file_name), meta.file_name])
    const next = pieces.find(p => p.extracted && !loadedSet.has(p.file_name))
    setAddExtractedDropdown(next?.file_name ?? '')
  }

  // ── Derived ───────────────────────────────────────────────────────

  const loadedFileNames  = new Set(loadedPieces.map(p => p.meta.file_name))
  const ALLOWED_COMPOSERS = ['Mozart', 'Beethoven', 'Haydn']
  const seenNames         = new Set<string>()
  const availableToAdd    = pieces.filter(p => {
    if (loadedFileNames.has(p.file_name)) return false
    if (!ALLOWED_COMPOSERS.some(n => p.composer.includes(n))) return false
    if (seenNames.has(p.music_name)) return false
    seenNames.add(p.music_name)
    return true
  })
  const extractedAvailable = availableToAdd.filter(p => p.extracted)

  // Show audio nav items only when focused piece has extracted features
  const focusedPiece = loadedPieces.find(p => p.meta.file_name === focusedFile)
  const showAudioNav = focusedPiece?.viewState === 'ready'

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="vv-app">

      {/* ════ HEADER ════ */}
      <header className="vv-header">

        {/* Logo */}
        <div className="vv-logo">
          <div className="vv-logo-icon">♫</div>
          <span className="vv-logo-text">VariVis</span>
        </div>

        <div className="vv-header-sep" />

        {/* Piece selector controls */}
        <div className="vv-header-controls">
          {listLoading && (
            <span style={{ fontSize: 11, color: 'var(--vv-text-3)' }}>
              {lang === 'zh' ? '连接中…' : 'Connecting…'}
            </span>
          )}

          {!listLoading && !listError && availableToAdd.length > 0 && (
            <>
              <span className="vv-select-label">
                {lang === 'zh' ? '添加曲目' : 'Add piece'}
              </span>
              <div className="vv-select-wrap">
                <select
                  className="vv-select"
                  value={addDropdown}
                  onChange={e => setAddDropdown(e.target.value)}
                >
                  {availableToAdd.map(p => (
                    <option key={p.file_name} value={p.file_name}>
                      {p.extracted ? '✓ ' : '○ '}{shortName(p)}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="vv-btn vv-btn-primary"
                onClick={handleAddPiece}
                disabled={!addDropdown}
              >
                + {lang === 'zh' ? '添加' : 'Add'}
              </button>
            </>
          )}

          {!listLoading && !listError && extractedAvailable.length > 0 && (
            <>
              <div className="vv-header-sep" style={{ opacity: 0.5 }} />
              <span className="vv-select-label">
                {lang === 'zh' ? '已提取' : 'Extracted'}
              </span>
              <div className="vv-select-wrap">
                <select
                  className="vv-select vv-select-extracted"
                  value={addExtractedDropdown}
                  onChange={e => setAddExtractedDropdown(e.target.value)}
                >
                  {extractedAvailable.map(p => (
                    <option key={p.file_name} value={p.file_name}>
                      {shortName(p)}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="vv-btn vv-btn-green"
                onClick={handleAddExtracted}
                disabled={!addExtractedDropdown}
              >
                + {lang === 'zh' ? '添加' : 'Add'}
              </button>
            </>
          )}

          {!listLoading && !listError && availableToAdd.length === 0 && loadedPieces.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--vv-text-3)' }}>
              {lang === 'zh' ? '✓ 全部已加载' : '✓ All pieces loaded'}
            </span>
          )}
        </div>

        {/* Right slot */}
        <div className="vv-header-right">
          {!listLoading && !listError && (
            <>
              <div className="vv-online-dot" title="Server connected" />
              <span style={{ fontSize: 11, color: 'var(--vv-text-3)' }}>
                {lang === 'zh' ? '服务在线' : 'Server online'}
              </span>
            </>
          )}
          <button className="vv-lang-btn" onClick={() => setLang(l => l === 'zh' ? 'en' : 'zh')}>
            {lang === 'zh' ? 'EN' : '中文'}
          </button>
        </div>
      </header>

      {/* ════ SIDEBAR ════ */}
      <aside className="vv-sidebar">

        {/* Loaded pieces */}
        {loadedPieces.length > 0 && (
          <>
            <div className="vv-sidebar-section">
              {lang === 'zh' ? '已加载曲目' : 'Loaded Pieces'}
            </div>
            {loadedPieces.map((lp, idx) => {
              const color = pieceColor(idx)
              return (
                <div
                  key={lp.meta.file_name}
                  className={`vv-piece-chip${focusedFile === lp.meta.file_name ? ' active' : ''}`}
                  onClick={() => setFocusedFile(lp.meta.file_name)}
                >
                  <div
                    className="vv-chip-bar"
                    style={{ background: `linear-gradient(180deg, ${color.from}, ${color.to})` }}
                  />
                  <div className="vv-chip-info">
                    <div className="vv-chip-name">{shortNameBrief(lp.meta)}</div>
                    <div className="vv-chip-meta">
                      {lp.viewState === 'loading'       ? (lang === 'zh' ? '加载中…' : 'Loading…') :
                       lp.viewState === 'not-extracted' ? (lang === 'zh' ? '未提取'  : 'Not extracted') :
                       lp.viewState === 'error'         ? (lang === 'zh' ? '错误'    : 'Error') :
                       lp.data ? `${lp.data.metadata.variation_num} var · ${durationLabel(lp.data)}` : ''}
                    </div>
                  </div>
                  <button
                    className="vv-chip-remove"
                    onClick={e => { e.stopPropagation(); removePiece(lp.meta.file_name) }}
                    title="Remove"
                  >✕</button>
                </div>
              )
            })}
          </>
        )}

        {/* Navigation */}
        <div className="vv-sidebar-section" style={{ marginTop: 8 }}>
          {lang === 'zh' ? '导航' : 'Views'}
        </div>

        {/* Audio-feature nav items */}
        {showAudioNav && AUDIO_TABS.map(tab => (
          <div
            key={tab}
            className={`vv-nav-item${activeTab === tab ? ' active' : ''}`}
            onClick={() => handleNavClick(tab)}
          >
            <span className="vv-nav-icon">{TAB_LABELS[tab].icon}</span>
            {TAB_LABELS[tab][lang]}
          </div>
        ))}

        {!showAudioNav && loadedPieces.length > 0 && (
          <div style={{ padding: '6px 8px', fontSize: 11, color: 'var(--vv-text-3)', lineHeight: 1.5 }}>
            {lang === 'zh'
              ? '提取音频特征后可启用更多视图'
              : 'Extract audio features to unlock more views'}
          </div>
        )}
      </aside>

      {/* ════ MAIN ════ */}
      <main className="vv-main">
        {listError && (
          <div className="vv-error-box">
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

        {loadedPieces.map((lp, idx) => (
          <PieceSection
            key={lp.meta.file_name}
            loadedPiece={lp}
            colorIdx={idx}
            theme={theme}
            lang={lang}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            onRemove={() => removePiece(lp.meta.file_name)}
            onToggleCollapse={() => toggleCollapse(lp.meta.file_name)}
            onExtractionDone={() => onExtractionDone(lp.meta.file_name)}
            onFocus={() => setFocusedFile(lp.meta.file_name)}
          />
        ))}

        {listLoading && (
          <div className="vv-loading">
            <span style={{ opacity: 0.5 }}>♫</span>
            {lang === 'zh' ? '正在连接服务器…' : 'Connecting to server…'}
          </div>
        )}
      </main>
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
  onToggleCollapse: () => void
  onExtractionDone: () => void
  onFocus:          () => void
}

function PieceSection({
  loadedPiece,
  colorIdx,
  theme,
  lang,
  activeTab,
  setActiveTab,
  onRemove,
  onToggleCollapse,
  onExtractionDone,
  onFocus,
}: PieceSectionProps) {
  const { meta, data, viewState, collapsed } = loadedPiece
  const hasPyin = (data?.segments[0]?.features.pitch_contour?.midi_relative?.length ?? 0) > 0
  const color   = pieceColor(colorIdx)

  const [, setAudioTime] = useState(0)
  const seekToRef = useRef<((sec: number) => void) | null>(null)

  const audioSrc = `${API_BASE}/audio/${encodeURIComponent(meta.file_name)}?folder=${encodeURIComponent(meta.folder)}`

  function handleSeekToSegment(startSec: number) {
    seekToRef.current?.(startSec)
  }

  return (
    <div className="vv-card" onClick={onFocus}>

      {/* ── Card header ── */}
      <div className="vv-card-header" onClick={onToggleCollapse}>
        {/* Color bar */}
        <div
          className="vv-card-color-bar"
          style={{ background: `linear-gradient(180deg, ${color.from}, ${color.to})` }}
        />

        <div className="vv-card-header-info">
          <div className="vv-card-title">{shortName(meta)}</div>
          <div className="vv-card-meta" onClick={e => e.stopPropagation()}>
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
                <span
                  className={`vv-badge ${hasPyin ? 'vv-badge-cyan' : 'vv-badge-amber'}`}
                >
                  {hasPyin ? '● pYIN' : '○ chroma'}
                </span>
                <span className="vv-badge vv-badge-green">✓ Extracted</span>
              </>
            )}
            {viewState === 'loading' && (
              <span style={{ fontSize: 11, color: 'var(--vv-text-3)', opacity: 0.8 }}>
                {lang === 'zh' ? '加载中…' : 'Loading…'}
              </span>
            )}
            {viewState === 'not-extracted' && (
              <span className="vv-badge vv-badge-amber">
                {lang === 'zh' ? '⚠ 未提取' : '⚠ Not extracted'}
              </span>
            )}
          </div>
        </div>

        <button
          className="vv-collapse-btn"
          onClick={e => { e.stopPropagation(); onToggleCollapse() }}
        >
          {collapsed ? '▶' : '▼'}
        </button>

        <button
          className="vv-remove-btn"
          onClick={e => { e.stopPropagation(); onRemove() }}
          title="Remove this piece"
        >
          ✕
        </button>
      </div>

      {/* ── Audio player ── */}
      {!collapsed && (
        <div className="vv-audio-row" onClick={e => e.stopPropagation()}>
          <AudioPlayer
            src={audioSrc}
            theme={theme}
            onTimeUpdate={setAudioTime}
            seekToRef={seekToRef}
          />
        </div>
      )}

      {/* ── Tab bar ── */}
      {!collapsed && viewState === 'ready' && data && (
        <div className="vv-tab-bar" onClick={e => e.stopPropagation()}>
          {AUDIO_TABS.map(tab => (
            <button
              key={tab}
              className={`vv-tab-btn${activeTab === tab ? ' active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {TAB_LABELS[tab][lang]}
            </button>
          ))}
        </div>
      )}

      {/* ── Card body ── */}
      {!collapsed && (
        <div style={{ padding: viewState === 'ready' ? '14px 14px 6px' : 0 }}>
          {viewState === 'ready' && data && activeTab === 'midianalysis' && (
            <MIDIAnalysisPage data={data} theme={theme} isDark={false} lang={lang} />
          )}
          {viewState === 'ready' && data && activeTab === 'variations' && (
            <PitchContourPage
              data={data} theme={theme} isDark={false} lang={lang}
              onSeekMain={handleSeekToSegment}
            />
          )}
          {viewState === 'ready' && data && activeTab === 'chroma' && (
            <ChromaRingPage data={data} theme={theme} isDark={false} lang={lang} />
          )}
          {viewState === 'ready' && data && activeTab === 'mfcc' && (
            <TimbrePCA data={data} theme={theme} isDark={false} lang={lang} />
          )}
          {viewState === 'ready' && data && activeTab === 'rhythm' && (
            <RhythmBubblePage data={data} theme={theme} isDark={false} lang={lang} />
          )}
          {viewState === 'ready' && data && activeTab === 'harmonic' && (
            <HarmonicFingerprintPage data={data} theme={theme} isDark={false} lang={lang} />
          )}
          {viewState === 'ready' && data && activeTab === 'overview' && (
            <OverviewPage data={data} theme={theme} isDark={false} lang={lang} />
          )}
          {viewState === 'ready' && data && activeTab === 'mentallandscape' && (
            <MentalLandscapePage data={data} theme={theme} isDark={false} lang={lang} />
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
      )}
    </div>
  )
}
