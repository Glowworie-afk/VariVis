import type { ThemeTokens } from '../theme'
import type { PieceData } from '../types/features'
import type { UploadResult } from './UploadModal'
import { useT } from '../i18n/LangContext'
import { CorpusStyleView } from './CorpusStyleView'

interface UploadedPieceViewProps {
  result:   UploadResult
  data:     PieceData | null
  theme:    ThemeTokens
  onRemove: () => void
}

export function UploadedPieceView({ result, data, theme, onRemove }: UploadedPieceViewProps) {
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
          <CorpusStyleView
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
