import { useState, useEffect, useRef } from 'react'
import type { PieceData } from './types/features'
import { getTheme } from './theme'

export type Lang = 'zh' | 'en'
import { PitchContourPage } from './components/PitchContourPage'
import { ChromaRingPage } from './components/ChromaRingPage'
import { TimbrePCA } from './components/TimbrePCA'
import { BeatGridPage } from './components/BeatGridPage'
import { RhythmBubblePage } from './components/RhythmBubblePage'
import { DTWPathPage } from './components/DTWPathPage'
import { IntervalDTWPage } from './components/IntervalDTWPage'
import { ChromaPitchPage } from './components/ChromaPitchPage'
import { HarmonicFingerprintPage } from './components/HarmonicFingerprintPage'
import { OverviewPage } from './components/OverviewPage'
import { ExtractionPanel } from './components/ExtractionPanel'
import { AudioPlayer } from './components/AudioPlayer'
import { fetchPieces, fetchFeatures, NotExtractedError, API_BASE } from './api/pieceApi'
import type { PieceMeta } from './api/pieceApi'

// ── Helpers ─────────────────────────────────────────────────────────

function shortName(meta: PieceMeta): string {
  const m = meta.music_name.match(/"(.+?)"/)
  const name = m ? m[1] : meta.music_name.slice(0, 45)
  return `${meta.composer.split(',')[0]} — "${name}"`
}

function durationLabel(data: PieceData): string {
  const s = data.metadata.total_duration_sec
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
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

  const [pieces,       setPieces]       = useState<PieceMeta[]>([])
  const [loadedPieces, setLoadedPieces] = useState<LoadedPiece[]>([])
  const [listLoading,  setListLoading]  = useState(true)
  const [listError,    setListError]    = useState('')
  const [addDropdown,         setAddDropdown]         = useState<string>('')  // file_name to add
  const [addExtractedDropdown, setAddExtractedDropdown] = useState<string>('')  // extracted-only dropdown

  // ── Initial load ──────────────────────────────────────────────────

  useEffect(() => {
    fetchPieces()
      .then(list => {
        setPieces(list)
        setListLoading(false)
        const first = list.find(p => p.file_name === 'WAMozart_K265_1')
          ?? list.find(p => p.extracted)
          ?? list[0]
        if (first) loadPiece(first)
        // Pre-select first available piece in the Add dropdowns
        const rest = list.filter(p => p.file_name !== (first?.file_name ?? ''))
        if (rest.length > 0) setAddDropdown(rest[0].file_name)
        const firstExtracted = rest.find(p => p.extracted)
        if (firstExtracted) setAddExtractedDropdown(firstExtracted.file_name)
      })
      .catch(err => {
        setListError(String(err))
        setListLoading(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load a piece ──────────────────────────────────────────────────

  function loadPiece(meta: PieceMeta) {
    // Guard: don't load if already present
    setLoadedPieces(prev => {
      if (prev.find(p => p.meta.file_name === meta.file_name)) return prev
      return [...prev, { meta, data: null, viewState: 'loading', collapsed: false }]
    })

    fetchFeatures(meta.file_name)
      .then(data => {
        setLoadedPieces(prev => prev.map(p =>
          p.meta.file_name === meta.file_name
            ? { ...p, data, viewState: 'ready' }
            : p
        ))
      })
      .catch(err => {
        const vs: PieceViewState = err instanceof NotExtractedError ? 'not-extracted' : 'error'
        setLoadedPieces(prev => prev.map(p =>
          p.meta.file_name === meta.file_name
            ? { ...p, viewState: vs, error: String(err) }
            : p
        ))
      })
  }

  // ── Remove / collapse ─────────────────────────────────────────────

  function removePiece(fileName: string) {
    setLoadedPieces(prev => prev.filter(p => p.meta.file_name !== fileName))
    // Make it available again in the Add dropdown if nothing is currently selected
    setAddDropdown(prev => prev || fileName)
  }

  function toggleCollapse(fileName: string) {
    setLoadedPieces(prev => prev.map(p =>
      p.meta.file_name === fileName ? { ...p, collapsed: !p.collapsed } : p
    ))
  }

  // ── After extraction completes, reload features ───────────────────

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
            ? { ...p, viewState: 'error', error: String(err) }
            : p
        ))
      })
    fetchPieces().then(setPieces).catch(() => {})
  }

  // ── Add from header dropdown ──────────────────────────────────────

  function handleAddPiece() {
    const meta = pieces.find(p => p.file_name === addDropdown)
    if (!meta) return
    loadPiece(meta)
    const loadedSet = new Set([...loadedPieces.map(p => p.meta.file_name), meta.file_name])
    const next = pieces.find(p => !loadedSet.has(p.file_name))
    setAddDropdown(next?.file_name ?? '')
  }

  function handleAddExtracted() {
    const meta = pieces.find(p => p.file_name === addExtractedDropdown)
    if (!meta) return
    loadPiece(meta)
    const loadedSet = new Set([...loadedPieces.map(p => p.meta.file_name), meta.file_name])
    const next = pieces.find(p => p.extracted && !loadedSet.has(p.file_name))
    setAddExtractedDropdown(next?.file_name ?? '')
  }

  // ── Derived ───────────────────────────────────────────────────────

  const loadedFileNames = new Set(loadedPieces.map(p => p.meta.file_name))
  const ALLOWED_COMPOSERS = ['Mozart', 'Beethoven', 'Haydn']
  const seenNames = new Set<string>()
  const availableToAdd  = pieces.filter(p => {
    if (loadedFileNames.has(p.file_name)) return false
    if (!ALLOWED_COMPOSERS.some(name => p.composer.includes(name))) return false
    if (seenNames.has(p.music_name)) return false
    seenNames.add(p.music_name)
    return true
  })
  const extractedAvailable = availableToAdd.filter(p => p.extracted)
  const isDark = theme.pageBg.startsWith('#0') || theme.pageBg.startsWith('#1')

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div style={{
      minHeight: '100vh',
      background: theme.pageBg,
      fontFamily: theme.fontFamily,
      transition: 'background 0.3s ease',
    }}>

      {/* ── Header ── */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 20px', borderBottom: theme.cardBorder,
        background: theme.cardBg, boxShadow: theme.cardShadow,
        position: 'sticky', top: 0, zIndex: 10, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: theme.labelColor, flexShrink: 0 }}>
          VariVis
        </span>

        {listLoading && (
          <span style={{ fontSize: 11, color: theme.labelSecondaryColor }}>
            {lang === 'zh' ? '连接中…' : 'Connecting…'}
          </span>
        )}

        {!listLoading && !listError && availableToAdd.length > 0 && (
          <>
            <select
              value={addDropdown}
              onChange={e => setAddDropdown(e.target.value)}
              style={{
                padding: '5px 10px', borderRadius: 8, border: theme.cardBorder,
                background: theme.cardBg, color: theme.labelColor,
                fontFamily: theme.fontFamily, fontSize: 12, fontWeight: 500,
                cursor: 'pointer', outline: 'none', maxWidth: 400,
              }}
            >
              {availableToAdd.map(p => (
                <option
                  key={p.file_name}
                  value={p.file_name}
                  style={p.extracted ? { background: '#d1fae5', color: '#065f46' } : undefined}
                >
                  {p.extracted ? '✓ ' : '○ '}{shortName(p)}
                </option>
              ))}
            </select>
            <button
              onClick={handleAddPiece}
              disabled={!addDropdown}
              style={{
                padding: '5px 14px', borderRadius: 8, border: 'none',
                background: addDropdown ? '#4361EE' : (isDark ? '#333' : '#ccc'),
                color: '#fff',
                fontFamily: theme.fontFamily, fontSize: 12, fontWeight: 600,
                cursor: addDropdown ? 'pointer' : 'default', flexShrink: 0,
              }}
            >
              {lang === 'zh' ? '+ 添加' : '+ Add'}
            </button>
          </>
        )}

        {!listLoading && !listError && extractedAvailable.length > 0 && (
          <>
            <span style={{
              fontSize: 11, color: theme.labelSecondaryColor,
              padding: '0 4px', flexShrink: 0,
            }}>
              {lang === 'zh' ? '已提取：' : 'Extracted:'}
            </span>
            <select
              value={addExtractedDropdown}
              onChange={e => setAddExtractedDropdown(e.target.value)}
              style={{
                padding: '5px 10px', borderRadius: 8,
                border: '1.5px solid #10b981',
                background: isDark ? '#052e16' : '#f0fdf4',
                color: isDark ? '#6ee7b7' : '#065f46',
                fontFamily: theme.fontFamily, fontSize: 12, fontWeight: 500,
                cursor: 'pointer', outline: 'none', maxWidth: 360,
              }}
            >
              {extractedAvailable.map(p => (
                <option key={p.file_name} value={p.file_name}>
                  {shortName(p)}
                </option>
              ))}
            </select>
            <button
              onClick={handleAddExtracted}
              disabled={!addExtractedDropdown}
              style={{
                padding: '5px 14px', borderRadius: 8, border: 'none',
                background: addExtractedDropdown ? '#10b981' : (isDark ? '#333' : '#ccc'),
                color: '#fff',
                fontFamily: theme.fontFamily, fontSize: 12, fontWeight: 600,
                cursor: addExtractedDropdown ? 'pointer' : 'default', flexShrink: 0,
              }}
            >
              {lang === 'zh' ? '+ 添加' : '+ Add'}
            </button>
          </>
        )}

        {!listLoading && !listError && availableToAdd.length === 0 && loadedPieces.length > 0 && (
          <span style={{ fontSize: 11, color: theme.labelSecondaryColor }}>
            {lang === 'zh' ? '✓ 全部已加载' : '✓ All pieces loaded'}
          </span>
        )}

        <div style={{ marginLeft: 'auto' }}>
          <button
            onClick={() => setLang(l => l === 'zh' ? 'en' : 'zh')}
            style={{
              padding: '6px 16px', borderRadius: 20, border: theme.cardBorder,
              background: 'transparent', color: theme.labelColor,
              fontFamily: theme.fontFamily, fontSize: 12, fontWeight: 600,
              cursor: 'pointer', letterSpacing: '0.06em',
            }}
          >
            {lang === 'zh' ? 'EN' : '中'}
          </button>
        </div>
      </header>

      {/* ── Connection error ── */}
      {listError && (
        <main style={{ padding: 24 }}>
          <div style={{
            maxWidth: 560, margin: '40px auto', padding: 24, borderRadius: 12,
            background: isDark ? '#2a1010' : '#fff5f5',
            border: '1px solid #e05', fontFamily: theme.fontFamily,
          }}>
            <div style={{ fontWeight: 700, color: '#e05', marginBottom: 8 }}>
              Cannot connect to VariVis API server
            </div>
            <div style={{ fontSize: 11, color: theme.labelSecondaryColor, lineHeight: 1.7, marginBottom: 14 }}>
              {listError}
            </div>
            <div style={{
              padding: '10px 14px', borderRadius: 8,
              background: isDark ? '#1a1a1a' : '#f5f5f5',
              fontSize: 11, fontFamily: 'monospace', lineHeight: 2, color: theme.labelColor,
            }}>
              cd /Users/jiaxuan/Desktop/Music\ Project/VariVis/backend<br />
              source .venv/bin/activate<br />
              python -m uvicorn server:app --reload --port 8000
            </div>
          </div>
        </main>
      )}

      {/* ── Piece sections ── */}
      <main style={{ padding: '12px 16px 60px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loadedPieces.map(lp => (
          <PieceSection
            key={lp.meta.file_name}
            loadedPiece={lp}
            theme={theme}
            isDark={isDark}
            lang={lang}
            onRemove={() => removePiece(lp.meta.file_name)}
            onToggleCollapse={() => toggleCollapse(lp.meta.file_name)}
            onExtractionDone={() => onExtractionDone(lp.meta.file_name)}
          />
        ))}

        {listLoading && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: 200, color: theme.labelSecondaryColor, fontSize: 13,
          }}>
            Connecting to server…
          </div>
        )}
      </main>
    </div>
  )
}

// ── PieceSection ─────────────────────────────────────────────────────

interface PieceSectionProps {
  loadedPiece:      LoadedPiece
  theme:            ReturnType<typeof getTheme>
  isDark:           boolean
  lang:             Lang
  onRemove:         () => void
  onToggleCollapse: () => void
  onExtractionDone: () => void
}

type PieceTab = 'variations' | 'chroma' | 'mfcc' | 'beatgrid' | 'rhythm' | 'dtwpath' | 'intervaldtw' | 'chromapitch' | 'harmonic' | 'overview'

function PieceSection({
  loadedPiece,
  theme,
  isDark,
  lang,
  onRemove,
  onToggleCollapse,
  onExtractionDone,
}: PieceSectionProps) {
  const { meta, data, viewState, collapsed } = loadedPiece
  const hasPyin = (data?.segments[0]?.features.pitch_contour?.midi_relative?.length ?? 0) > 0

  // Tab state — local to this section
  const [activeTab, setActiveTab] = useState<PieceTab>('variations')

  // Audio state — local to this section
  const [, setAudioTime] = useState(0)
  const seekToRef = useRef<((sec: number) => void) | null>(null)

  const audioSrc = `${API_BASE}/audio/${encodeURIComponent(meta.file_name)}?folder=${encodeURIComponent(meta.folder)}`

  function handleSeekToSegment(startSec: number) {
    seekToRef.current?.(startSec)
  }

  return (
    <div style={{
      borderRadius: 12,
      border: theme.cardBorder,
      background: theme.cardBg,
      boxShadow: theme.cardShadow,
      overflow: 'hidden',
    }}>
      {/* Section header — click to collapse */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 14px',
        borderBottom: collapsed ? 'none' : theme.cardBorder,
        background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        cursor: 'pointer',
        flexWrap: 'wrap',
      }}
        onClick={onToggleCollapse}
      >
        {/* Collapse toggle */}
        <span style={{
          fontSize: 11, color: theme.labelSecondaryColor,
          userSelect: 'none', flexShrink: 0, width: 14,
        }}>
          {collapsed ? '▶' : '▼'}
        </span>

        {/* Piece name */}
        <span style={{ fontWeight: 600, fontSize: 13, color: theme.labelColor, flex: 1, minWidth: 0 }}>
          {shortName(meta)}
        </span>

        {/* Meta tags */}
        {data && viewState === 'ready' && (
          <div style={{
            display: 'flex', gap: 8, fontSize: 11,
            color: theme.labelSecondaryColor, flexWrap: 'wrap', alignItems: 'center',
          }}
            onClick={e => e.stopPropagation()}
          >
            <span style={{ textTransform: 'capitalize' }}>{data.metadata.instrument}</span>
            <span>·</span>
            <span>{data.metadata.variation_num} var.</span>
            <span>·</span>
            <span>{durationLabel(data)}</span>
            <span>·</span>
            <span>{data.metadata.period}</span>
            <span>·</span>
            <span style={{ color: hasPyin ? '#4CC9F0' : theme.labelSecondaryColor }}>
              {hasPyin ? '● pYIN' : '○ chroma'}
            </span>
          </div>
        )}

        {viewState === 'loading' && (
          <span style={{ fontSize: 11, color: theme.labelSecondaryColor, opacity: 0.7 }}>
            {lang === 'zh' ? '加载中…' : 'Loading…'}
          </span>
        )}

        {viewState === 'not-extracted' && (
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 10,
            background: isDark ? 'rgba(255,200,0,0.15)' : 'rgba(200,150,0,0.12)',
            color: isDark ? '#f0c040' : '#886000',
          }}>
            {lang === 'zh' ? '未提取' : 'Not extracted'}
          </span>
        )}

        {/* Remove button */}
        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
          title="Remove this piece"
          style={{
            marginLeft: 4, padding: '2px 7px', borderRadius: 6,
            border: theme.cardBorder, background: 'transparent',
            color: theme.labelSecondaryColor, fontSize: 12,
            cursor: 'pointer', lineHeight: 1, flexShrink: 0,
          }}
        >
          ✕
        </button>
      </div>

      {/* Audio player bar — always visible when expanded */}
      {!collapsed && (
        <div style={{
          padding: '4px 14px',
          borderBottom: theme.cardBorder,
          background: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.01)',
        }}>
          <AudioPlayer
            src={audioSrc}
            theme={theme}
            onTimeUpdate={setAudioTime}
            seekToRef={seekToRef}
          />
        </div>
      )}

      {/* Tab bar — only when ready */}
      {!collapsed && viewState === 'ready' && data && (
        <div style={{
          display: 'flex', gap: 2, padding: '6px 14px 0',
          borderBottom: theme.cardBorder,
          background: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.01)',
        }}>
          {(['variations', 'chroma', 'mfcc', 'beatgrid', 'rhythm', 'dtwpath', 'intervaldtw', 'chromapitch', 'harmonic', 'overview'] as PieceTab[]).map(tab => {
            const labels: Record<PieceTab, { zh: string; en: string }> = {
              variations:  { zh: '音高折线图',   en: 'Pitch Contour' },
              chroma:      { zh: '色度环',      en: 'Chroma' },
              mfcc:        { zh: '音色 PCA',   en: 'Timbre PCA' },
              beatgrid:    { zh: '节拍格',      en: 'Beat Grid' },
              rhythm:      { zh: '节奏气泡',   en: 'Rhythm' },
              dtwpath:     { zh: 'DTW 路径',   en: 'DTW Path' },
              intervaldtw: { zh: '音程相似度', en: 'Interval DTW' },
              chromapitch: { zh: '色度热图',    en: 'Chroma Heatmap' },
              harmonic:    { zh: '和声功能',   en: 'Harmonic Function' },
              overview:    { zh: '综合视图',   en: 'Overview' },
            }
            const active = tab === activeTab
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '5px 14px 6px',
                  border: 'none',
                  borderBottom: active ? '2px solid #4361EE' : '2px solid transparent',
                  background: 'transparent',
                  color: active ? '#4361EE' : theme.labelSecondaryColor,
                  fontFamily: theme.fontFamily,
                  fontSize: 12, fontWeight: active ? 700 : 500,
                  cursor: 'pointer',
                  borderRadius: '4px 4px 0 0',
                  transition: 'color 0.15s',
                }}
              >
                {labels[tab][lang]}
              </button>
            )
          })}
        </div>
      )}

      {/* Section body */}
      {!collapsed && (
        <div style={{ padding: viewState === 'ready' ? '10px 10px 4px' : 0 }}>
          {viewState === 'ready' && data && activeTab === 'variations' && (
            <PitchContourPage
              data={data}
              theme={theme}
              isDark={isDark}
              lang={lang}
              onSeekMain={handleSeekToSegment}
            />
          )}

          {viewState === 'ready' && data && activeTab === 'chroma' && (
            <ChromaRingPage
              data={data}
              theme={theme}
              isDark={isDark}
              lang={lang}
            />
          )}

          {viewState === 'ready' && data && activeTab === 'mfcc' && (
            <TimbrePCA
              data={data}
              theme={theme}
              isDark={isDark}
              lang={lang}
            />
          )}

          {viewState === 'ready' && data && activeTab === 'beatgrid' && (
            <BeatGridPage
              data={data}
              theme={theme}
              isDark={isDark}
              lang={lang}
            />
          )}

          {viewState === 'ready' && data && activeTab === 'rhythm' && (
            <RhythmBubblePage
              data={data}
              theme={theme}
              isDark={isDark}
              lang={lang}
            />
          )}

          {viewState === 'ready' && data && activeTab === 'dtwpath' && (
            <DTWPathPage
              data={data}
              theme={theme}
              isDark={isDark}
              lang={lang}
            />
          )}

          {viewState === 'ready' && data && activeTab === 'intervaldtw' && (
            <IntervalDTWPage
              data={data}
              theme={theme}
              isDark={isDark}
              lang={lang}
            />
          )}

          {viewState === 'ready' && data && activeTab === 'chromapitch' && (
            <ChromaPitchPage
              data={data}
              theme={theme}
              isDark={isDark}
              lang={lang}
            />
          )}

          {viewState === 'ready' && data && activeTab === 'harmonic' && (
            <HarmonicFingerprintPage
              data={data}
              theme={theme}
              isDark={isDark}
              lang={lang}
            />
          )}

          {viewState === 'ready' && data && activeTab === 'overview' && (
            <OverviewPage
              data={data}
              theme={theme}
              isDark={isDark}
              lang={lang}
            />
          )}

          {viewState === 'loading' && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: 120, color: theme.labelSecondaryColor, fontSize: 12,
            }}>
              {lang === 'zh' ? '加载特征中…' : 'Loading features…'}
            </div>
          )}

          {viewState === 'not-extracted' && (
            <ExtractionPanel
              piece={meta}
              theme={theme}
              onDone={onExtractionDone}
            />
          )}

          {viewState === 'error' && (
            <div style={{
              padding: '16px 20px', fontSize: 11,
              color: '#e05', fontFamily: 'monospace',
            }}>
              {loadedPiece.error ?? 'Unknown error'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
