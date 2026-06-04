import type { ThemeTokens } from '../theme'
import type { Lang, LoadedPiece } from '../types/app'
import type { AppNavState } from '../hooks/useAppNav'
import type { UploadState } from '../hooks/useUpload'
import { API_BASE } from '../api/pieceApi'
import { ScorePage }    from './ScorePage'
import { MusicVisPage } from './MusicVisPage'

interface ScorePanelProps {
  nav:          AppNavState
  focusedPiece: LoadedPiece | undefined
  upload:       UploadState
  theme:        ThemeTokens
  lang:         Lang
  listLoading:  boolean
  listError:    string
}

export function ScorePanel({ nav, focusedPiece, upload, theme, lang, listLoading, listError }: ScorePanelProps) {
  const { scoreMode, setScoreMode, focusedXmlFile } = nav
  const { uploadedPiece, uploadFocused } = upload

  return (
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
          >Score</button>
          {focusedXmlFile && (
            <button
              onClick={() => setScoreMode('musicxml')}
              style={{
                fontSize: 11, padding: '3px 10px', borderRadius: 5, border: 'none',
                cursor: 'pointer', fontWeight: 600,
                background: scoreMode === 'musicxml' ? '#6366f1' : '#e2e8f0',
                color:      scoreMode === 'musicxml' ? '#fff'    : '#64748b',
              }}
            >Harmonic</button>
          )}
          <div style={{ flex: 1 }} />
          {!listLoading && !listError && <div className="vv-online-dot" title="Server online" />}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {uploadFocused && uploadedPiece ? (
            scoreMode === 'pdf' ? (
              uploadedPiece.pdf_stem ? (
                <iframe
                  src={`${API_BASE}/upload/temp_pdf/${encodeURIComponent(uploadedPiece.pdf_stem)}#toolbar=1&navpanes=0`}
                  style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                  title="Uploaded PDF Score"
                />
              ) : (
                <EmptyState icon="📄" message="Upload a PDF score to view it here." />
              )
            ) : (
              uploadedPiece.mxl_stem
                ? <MusicVisPage theme={theme} lang={lang} xmlFile={uploadedPiece.mxl_stem} />
                : <EmptyState icon="🎵" message="Score View requires a MusicXML file." />
            )
          ) : scoreMode === 'pdf' ? (
            focusedPiece?.viewState === 'ready' && focusedPiece.data ? (
              <ScorePage
                data={focusedPiece.data} theme={theme} isDark={false} lang={lang}
                fileName={focusedPiece.meta.file_name} composer={focusedPiece.meta.composer}
              />
            ) : (
              <div className="vv-score-panel-empty"><span>Score</span></div>
            )
          ) : (
            <MusicVisPage theme={theme} lang={lang} xmlFile={focusedXmlFile} />
          )}
        </div>
      </div>
    </div>
  )
}

function EmptyState({ icon, message }: { icon: string; message: string }) {
  return (
    <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--vv-text-3)', fontSize: 11, lineHeight: 1.8 }}>
      <div style={{ fontSize: 20, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontWeight: 600, color: 'var(--vv-text-2)', marginBottom: 4 }}>No data source</div>
      <div>{message}</div>
    </div>
  )
}
