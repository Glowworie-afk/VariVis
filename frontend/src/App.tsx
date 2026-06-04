import { useState } from 'react'
import { getTheme } from './theme'
import type { Lang } from './types/app'
import type { UploadResult } from './components/UploadModal'
import { COMPOSER_GROUPS } from './constants/pieces'
import { LangProvider } from './i18n/LangContext'

import { useMusicXmlFiles } from './hooks/useMusicXmlFiles'
import { useUpload }        from './hooks/useUpload'
import { useAppNav }        from './hooks/useAppNav'
import { useLoadedPieces }  from './hooks/useLoadedPieces'
import { usePieceList }     from './hooks/usePieceList'

import { Sidebar }           from './components/Sidebar'
import { ScorePanel }        from './components/ScorePanel'
import { PieceSection }      from './components/PieceSection'
import { UploadedPieceView } from './components/UploadedPieceView'
import { ConnectionError }   from './components/ConnectionError'

const theme = getTheme('scientific')

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

        <Sidebar
          pieceList={pieceList} loaded={loaded} nav={nav}
          upload={{ ...upload, handleUploadSuccess }}
          loadedFileNames={loadedFileNames} focusedPiece={focusedPiece}
        />

        <main className="vv-main" style={nav.scoreMode === 'musicxml' ? { display: 'none' } : {}}>
          {pieceList.listError && <ConnectionError error={pieceList.listError} />}

          {upload.uploadFocused && upload.uploadedPiece && (
            <UploadedPieceView
              result={upload.uploadedPiece} data={upload.uploadedData}
              theme={theme} onRemove={upload.removeUploadedPiece}
            />
          )}

          {!upload.uploadFocused && focusedPiece && (
            <PieceSection
              key={focusedPiece.meta.file_name + nav.activeTab}
              loadedPiece={focusedPiece}
              colorIdx={loaded.loadedPieces.findIndex(p => p.meta.file_name === focusedPiece.meta.file_name)}
              theme={theme}
              activeTab={nav.activeTab} setActiveTab={nav.setActiveTab}
              onRemove={() => removePiece(focusedPiece.meta.file_name)}
              onExtractionDone={() => onExtractionDone(focusedPiece.meta.file_name)}
            />
          )}

          {pieceList.listLoading && (
            <div className="vv-loading">Connecting to server…</div>
          )}
        </main>

        <ScorePanel
          nav={nav} focusedPiece={focusedPiece} upload={upload}
          theme={theme} setLang={setLang}
          listLoading={pieceList.listLoading} listError={pieceList.listError}
        />
      </div>
    </LangProvider>
  )
}
