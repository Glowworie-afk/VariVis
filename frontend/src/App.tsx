import { useState } from 'react'
import { theme } from './constants/theme'
import type { Lang } from './types/app'
import type { UploadResult } from './features/extraction/UploadModal'
import { COMPOSER_GROUPS } from './constants/pieces'
import { LangProvider } from './i18n/LangContext'

import { useMusicXmlFiles } from './hooks/useMusicXmlFiles'
import { useUpload }        from './hooks/useUpload'
import { useAppNav }        from './hooks/useAppNav'
import { useLoadedPieces }  from './hooks/useLoadedPieces'
import { usePieceList }     from './hooks/usePieceList'

import { PieceView }  from './pages/PieceView'
import { ScoreView }  from './pages/ScoreView'
import { CorpusView } from './pages/CorpusView'

function ConnectionError({ error }: { error: string }) {
  return (
    <div style={{ padding: '24px 20px' }}>
      <div style={{ fontWeight: 700, color: 'var(--vv-red)', marginBottom: 8, fontSize: 13 }}>
        Cannot connect to VariVis API server
      </div>
      <div style={{ fontSize: 11, color: 'var(--vv-text-2)', lineHeight: 1.7, marginBottom: 14 }}>
        {error}
      </div>
      <div style={{
        padding: '10px 14px', borderRadius: 8, background: 'var(--vv-elevated)',
        fontSize: 11, fontFamily: 'monospace', lineHeight: 2,
        color: 'var(--vv-text)', border: '1px solid var(--vv-border)',
      }}>
        cd /Users/jiaxuan/Desktop/Music\ Project/VariVis/backend<br />
        source .venv/bin/activate<br />
        python -m uvicorn server:app --reload --port 8000
      </div>
    </div>
  )
}

export default function App() {
  const [lang, setLang] = useState<Lang>('en')
  const xmlFiles  = useMusicXmlFiles()
  const upload    = useUpload(xmlFiles.refresh)
  const nav       = useAppNav(upload.uploadFocused, upload.uploadedPiece, xmlFiles.files)
  const loaded    = useLoadedPieces()
  const pieceList = usePieceList((list) => {
    const first = list.find(p => p.file_name === 'WAMozart_K265_1')
      ?? list.find(p => p.extracted)
      ?? list[0]
    if (first) { loaded.loadPiece(first); nav.setFocusedFile(first.file_name) }
    const composerKey = COMPOSER_GROUPS.find(g => first?.file_name.startsWith(g.key + '_'))?.key
    if (composerKey) nav.setExpandedComposers(new Set([composerKey]))
    list.filter(p => p.extracted).forEach(p => loaded.loadPiece(p))
  })

  const focusedPiece    = loaded.loadedPieces.find(p => p.meta.file_name === nav.focusedFile)
  const loadedFileNames = new Set(loaded.loadedPieces.map(p => p.meta.file_name))

  // ── Cross-hook actions ────────────────────────────────────────────

  function removePiece(fileName: string) {
    loaded.removeFromLoaded(fileName)
    if (nav.focusedFile === fileName) {
      const next = loaded.loadedPieces.filter(p => p.meta.file_name !== fileName)[0]
      nav.setFocusedFile(next?.meta.file_name ?? null)
    }
  }

  async function handleUploadSuccess(result: UploadResult) {
    if (result.mxl_stem) nav.setScoreMode('musicxml')
    await upload.handleUploadSuccess(result)
  }

  function onExtractionDone(fileName: string) {
    loaded.reload(fileName)
    pieceList.refresh()
  }

  // ── Layout ────────────────────────────────────────────────────────

  return (
    <LangProvider lang={lang}>
      <div className="vv-app" style={nav.scoreMode === 'musicxml' ? {
        gridTemplateColumns: `var(--vv-sidebar-w) 1fr`,
        gridTemplateAreas:   '"sidebar score"',
      } : {}}>

        <PieceView
          pieceList={pieceList} loaded={loaded} nav={nav}
          upload={{ ...upload, handleUploadSuccess }}
          loadedFileNames={loadedFileNames} focusedPiece={focusedPiece}
        />

        <main className="vv-main" style={nav.scoreMode === 'musicxml' ? { display: 'none' } : {}}>
          {pieceList.listError && <ConnectionError error={pieceList.listError} />}

          {upload.uploadFocused && upload.uploadedPiece && (
            <CorpusView
              uploadFocused={upload.uploadFocused}
              uploadedPiece={upload.uploadedPiece}
              uploadedData={upload.uploadedData}
              onRemoveUpload={upload.removeUploadedPiece}
              theme={theme}
            />
          )}

          {!upload.uploadFocused && focusedPiece && (
            <CorpusView
              key={focusedPiece.meta.file_name}
              uploadFocused={false}
              uploadedPiece={null}
              uploadedData={null}
              onRemoveUpload={() => {}}
              loadedPiece={focusedPiece}
              colorIdx={loaded.loadedPieces.findIndex(p => p.meta.file_name === focusedPiece.meta.file_name)}
              theme={theme}
              onRemove={() => removePiece(focusedPiece.meta.file_name)}
              onExtractionDone={() => onExtractionDone(focusedPiece.meta.file_name)}
            />
          )}

          {pieceList.listLoading && (
            <div className="vv-loading">Connecting to server…</div>
          )}
        </main>

        <ScoreView
          nav={nav} focusedPiece={focusedPiece} upload={upload}
          theme={theme} setLang={setLang}
          listLoading={pieceList.listLoading} listError={pieceList.listError}
        />
      </div>
    </LangProvider>
  )
}
