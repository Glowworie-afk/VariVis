// ScorePage.tsx
//  Sheet Music View — serves matched IMSLP PDF via iframe
// Backend fuzzy-matches file_name → IMSLP/*.pdf by catalog number (K/KV, WoO, Op, Hob)

import { useEffect, useState, type ReactNode } from 'react'
import type { PieceData } from '../types/features'
import type { ThemeTokens } from '../theme'
import { useLang } from '../i18n/LangContext'
import { API_BASE } from '../api/pieceApi'

interface Props {
  data:     PieceData
  theme:    ThemeTokens
  isDark:   boolean
  fileName: string
  composer?: string   // passed from PieceMeta for richer not-found hints
}

type Status = 'idle' | 'loading' | 'ready' | 'not_found' | 'error'

const API = API_BASE.replace(/\/api$/, '')

export function ScorePage({ data, theme, isDark, fileName, composer }: Props) {
  const lang = useLang()
  const [status,    setStatus]    = useState<Status>('idle')
  const [pdfUrl,    setPdfUrl]    = useState('')
  const [matchedFile, setMatchedFile] = useState('')
  const [available, setAvailable] = useState<string[]>([])

  const t = (zh: ReactNode, en: ReactNode): ReactNode => lang === 'zh' ? zh : en

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setPdfUrl('')
    setMatchedFile('')
    setAvailable([])

    // First do a dry-run match to get metadata, then build the pdf URL
    fetch(`${API}/api/score/match?file_name=${encodeURIComponent(fileName)}&music_name=${encodeURIComponent(data.metadata.music_name ?? '')}`)
      .then(r => r.json())
      .then(json => {
        if (cancelled) return
        setAvailable(json.available ?? [])
        if (!json.matched || json.score < 0.3) {
          setStatus('not_found')
          return
        }
        setMatchedFile(json.pdf_name ?? '')
        // Build direct PDF URL — browser will render inline
        const url = `${API}/api/score/pdf/${encodeURIComponent(fileName)}`
        setPdfUrl(url)
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })

    return () => { cancelled = true }
  }, [fileName])

  return (
    <div style={{ fontFamily: theme.fontFamily, color: theme.labelColor, display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Title bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 8,
        padding: '10px 14px 8px',
        borderBottom: `1px solid ${isDark ? '#2d2d45' : '#f1f5f9'}`,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>
            {t(' 乐谱视图', ' Score View')}
          </span>
          {matchedFile && status === 'ready' && (
            <span style={{ fontSize: 9, color: theme.labelSecondaryColor }}>
              {matchedFile}
            </span>
          )}
        </div>
        {status === 'ready' && (
          <a
            href={pdfUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 9, padding: '3px 10px', borderRadius: 4,
              border: `1px solid ${isDark ? '#44445a' : '#cbd5e1'}`,
              background: isDark ? '#1e1b2e' : '#f8fafc',
              color: theme.labelColor, textDecoration: 'none',
              cursor: 'pointer',
            }}
          >
            {t('新窗口打开 ↗', 'Open in new tab ↗')}
          </a>
        )}
      </div>

      {/* ── Loading ── */}
      {status === 'loading' && (
        <CenterBox>
          <Spinner />
          <span style={{ fontSize: 11, color: theme.labelSecondaryColor, marginTop: 10 }}>
            {t('正在匹配乐谱…', 'Matching score…')}
          </span>
        </CenterBox>
      )}

      {/* ── Not found ── */}
      {status === 'not_found' && (
        <CenterBox>
          <span style={{ fontSize: 26, marginBottom: 8 }}></span>
          <span style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            {t('暂无匹配乐谱', 'No matching score found')}
          </span>

          {/* Composer-specific hint */}
          {composer && (
            <span style={{
              fontSize: 11, fontWeight: 600, marginBottom: 4,
              color: isDark ? '#f59e0b' : '#b45309',
            }}>
              {t(
                `当前 IMSLP/ 目录中没有「${composer}」的乐谱`,
                `No score by "${composer}" found in IMSLP/`
              )}
            </span>
          )}

          <span style={{
            fontSize: 10, color: theme.labelSecondaryColor,
            textAlign: 'center', maxWidth: 400, lineHeight: 1.7,
          }}>
            {t(
              <>
                请从{' '}
                <a href="https://imslp.org" target="_blank" rel="noreferrer"
                   style={{ color: isDark ? '#818cf8' : '#6366f1' }}>
                  IMSLP.org
                </a>
                {' '}下载对应作品的 PDF 乐谱，放入项目根目录下的 <code>IMSLP/</code> 文件夹。
                文件名无需修改，系统会按作品编号（K/KV、WoO、Op、Hob）自动匹配。
              </>,
              <>
                Download the PDF score from{' '}
                <a href="https://imslp.org" target="_blank" rel="noreferrer"
                   style={{ color: isDark ? '#818cf8' : '#6366f1' }}>
                  IMSLP.org
                </a>
                {' '}and place it in the <code>IMSLP/</code> folder at the project root.
                No renaming needed — the system auto-matches by catalog number (K/KV, WoO, Op, Hob).
              </>
            )}
          </span>

          {/* Show what's currently in IMSLP/ */}
          {available.length > 0 && (
            <div style={{ marginTop: 14, fontSize: 9, color: theme.labelSecondaryColor, maxWidth: 440 }}>
              <div style={{ marginBottom: 4, fontWeight: 600 }}>
                {t('目录中现有的乐谱：', 'Scores currently in IMSLP/:')}
              </div>
              <div style={{
                maxHeight: 120, overflowY: 'auto',
                display: 'flex', flexDirection: 'column', gap: 3,
              }}>
                {available.filter(f => f.toLowerCase().endsWith('.pdf')).map(f => (
                  <div key={f} style={{
                    fontFamily: 'monospace',
                    color: isDark ? '#818cf8' : '#6366f1',
                    background: isDark ? '#1e1b2e' : '#eef2ff',
                    padding: '3px 8px', borderRadius: 3,
                  }}>
                    {f}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CenterBox>
      )}

      {/* ── Error ── */}
      {status === 'error' && (
        <CenterBox>
          <span style={{ fontSize: 22, marginBottom: 6 }}></span>
          <span style={{ fontSize: 11, color: theme.labelSecondaryColor }}>
            {t('无法连接后端服务', 'Could not connect to backend')}
          </span>
        </CenterBox>
      )}

      {/* ── PDF iframe ── */}
      {status === 'ready' && pdfUrl && (
        <iframe
          src={`${pdfUrl}#toolbar=1&navpanes=0`}
          title="Score PDF"
          style={{
            flex: 1,
            width: '100%',
            minHeight: 600,
            border: 'none',
            background: isDark ? '#1a1a2e' : '#f8f8f8',
          }}
        />
      )}

    </div>
  )
}

// ── Small helpers ─────────────────────────────────────────────────────

function CenterBox({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '48px 24px', gap: 4,
    }}>
      {children}
    </div>
  )
}

function Spinner() {
  return (
    <div style={{
      width: 24, height: 24, borderRadius: '50%',
      border: '3px solid #e2e8f0',
      borderTopColor: '#6366f1',
      animation: 'spin 0.8s linear infinite',
    }} />
  )
}
