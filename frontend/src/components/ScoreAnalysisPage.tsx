/**
 * ScoreAnalysisPage.tsx
 * ─────────────────────
 * Tab for fuzzy-matching an IMSLP score PDF and streaming a
 * Claude music-theory analysis of its pages.
 */

import { useState, useEffect, useRef } from 'react'
import type { PieceMeta } from '../api/pieceApi'
import { API_BASE } from '../api/pieceApi'
import type { Lang } from '../App'
import { getTheme } from '../theme'

// ── Types ──────────────────────────────────────────────────────────

interface Props {
  meta:    PieceMeta
  theme:   ReturnType<typeof getTheme>
  isDark:  boolean
  lang:    Lang
}

interface MatchResult {
  matched:   string | null
  score:     number
  available: string[]
}

type AnalysisState = 'idle' | 'loading' | 'streaming' | 'done' | 'error'

// ── Markdown renderer ──────────────────────────────────────────────

function parseCells(line: string): string[] {
  return line.split('|').slice(1, -1).map(c => c.trim())
}

function isSeparatorRow(line: string): boolean {
  return /^[\|\s\-:]+$/.test(line)
}

interface MdRendererProps {
  text:   string
  theme:  ReturnType<typeof getTheme>
  isDark: boolean
}

function MarkdownRenderer({ text, theme, isDark }: MdRendererProps) {
  const lines   = text.split('\n')
  const nodes: React.ReactNode[] = []
  let i   = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // ── Heading 2
    if (line.startsWith('## ')) {
      nodes.push(
        <div key={key++} style={{
          fontWeight: 700, fontSize: 13, color: theme.labelColor,
          margin: '16px 0 6px',
        }}>
          {line.slice(3)}
        </div>
      )
      i++; continue
    }

    // ── Heading 1
    if (line.startsWith('# ')) {
      nodes.push(
        <div key={key++} style={{
          fontWeight: 700, fontSize: 15, color: theme.labelColor,
          margin: '18px 0 8px',
        }}>
          {line.slice(2)}
        </div>
      )
      i++; continue
    }

    // ── Markdown table (header row followed by separator)
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      isSeparatorRow(lines[i + 1])
    ) {
      const headers = parseCells(line)
      i += 2   // skip separator

      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(parseCells(lines[i]))
        i++
      }

      nodes.push(
        <div key={key++} style={{ overflowX: 'auto', marginBottom: 18 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead>
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi} style={{
                    padding: '8px 12px', textAlign: 'left',
                    borderBottom: '2px solid #4361EE',
                    color: '#4361EE', fontWeight: 700,
                    background: isDark
                      ? 'rgba(67,97,238,0.12)'
                      : 'rgba(67,97,238,0.07)',
                    whiteSpace: 'nowrap',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} style={{
                  background: ri % 2 === 0
                    ? 'transparent'
                    : (isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)'),
                }}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{
                      padding: '7px 12px', verticalAlign: 'top', lineHeight: 1.6,
                      color: theme.labelColor,
                      borderBottom: `1px solid ${isDark
                        ? 'rgba(255,255,255,0.07)'
                        : 'rgba(0,0,0,0.07)'}`,
                    }}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // ── Empty line
    if (!line.trim()) {
      i++; continue
    }

    // ── Plain text / other
    nodes.push(
      <div key={key++} style={{
        fontSize: 12, color: theme.labelColor,
        lineHeight: 1.75, marginBottom: 4,
        whiteSpace: 'pre-wrap',
      }}>
        {line}
      </div>
    )
    i++
  }

  return <>{nodes}</>
}

// ── ScoreAnalysisPage ─────────────────────────────────────────────

export function ScoreAnalysisPage({ meta, theme, isDark, lang }: Props) {
  const [matchResult,    setMatchResult]    = useState<MatchResult | null>(null)
  const [matchLoading,   setMatchLoading]   = useState(true)
  const [selectedPdf,    setSelectedPdf]    = useState<string>('')
  const [analysisState,  setAnalysisState]  = useState<AnalysisState>('idle')
  const [analysisText,   setAnalysisText]   = useState('')
  const [statusMsg,      setStatusMsg]      = useState('')
  const [errorMsg,       setErrorMsg]       = useState('')

  const esRef     = useRef<EventSource | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // ── Auto-match on mount ─────────────────────────────────────────
  useEffect(() => {
    setMatchLoading(true)
    const url =
      `${API_BASE}/score/match` +
      `?file_name=${encodeURIComponent(meta.file_name)}` +
      `&music_name=${encodeURIComponent(meta.music_name)}`

    fetch(url)
      .then(r => r.json())
      .then((data: MatchResult) => {
        setMatchResult(data)
        setSelectedPdf(data.matched ?? '')
        setMatchLoading(false)
      })
      .catch(() => {
        setMatchResult({ matched: null, score: 0, available: [] })
        setMatchLoading(false)
      })
  }, [meta.file_name, meta.music_name])

  // ── Auto-scroll while streaming ─────────────────────────────────
  useEffect(() => {
    if (analysisState === 'streaming') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [analysisText, analysisState])

  // ── Cleanup SSE on unmount ──────────────────────────────────────
  useEffect(() => () => { esRef.current?.close() }, [])

  // ── Start analysis ──────────────────────────────────────────────
  function startAnalysis() {
    if (!selectedPdf || analysisState === 'loading' || analysisState === 'streaming') return

    esRef.current?.close()
    setAnalysisState('loading')
    setAnalysisText('')
    setStatusMsg('')
    setErrorMsg('')

    const url =
      `${API_BASE}/score/analyze` +
      `?file_name=${encodeURIComponent(meta.file_name)}` +
      `&music_name=${encodeURIComponent(meta.music_name)}` +
      `&pdf_name=${encodeURIComponent(selectedPdf)}`

    const es = new EventSource(url)
    esRef.current = es

    es.onmessage = (e: MessageEvent) => {
      const raw: string = e.data

      if (raw === 'DONE') {
        setAnalysisState('done')
        es.close()
        return
      }
      if (raw.startsWith('ERROR:')) {
        setAnalysisState('error')
        setErrorMsg(raw.slice(6))
        es.close()
        return
      }
      if (raw.startsWith('STATUS:')) {
        setStatusMsg(raw.slice(7))
        return
      }
      if (raw.startsWith('TEXT:')) {
        setAnalysisState('streaming')
        // Decode escaped newlines sent over SSE
        const chunk = raw.slice(5).replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
        setAnalysisText(prev => prev + chunk)
      }
    }

    es.onerror = () => {
      setAnalysisState(prev => (prev === 'done' ? 'done' : 'error'))
      setErrorMsg(
        lang === 'zh'
          ? '连接中断，请重试'
          : 'Connection lost. Please retry.'
      )
      es.close()
    }
  }

  const isAnalyzing = analysisState === 'loading' || analysisState === 'streaming'

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div style={{ padding: '12px 4px', fontFamily: theme.fontFamily }}>

      {/* ── Score file selector ── */}
      <div style={{
        padding: '10px 14px', borderRadius: 8, marginBottom: 14,
        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
        border: theme.cardBorder,
      }}>
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.09em',
          textTransform: 'uppercase', color: theme.labelSecondaryColor,
          marginBottom: 8,
        }}>
          {lang === 'zh' ? '乐谱文件' : 'Score File'}
        </div>

        {matchLoading && (
          <div style={{ fontSize: 11, color: theme.labelSecondaryColor }}>
            {lang === 'zh' ? '正在匹配乐谱…' : 'Matching score…'}
          </div>
        )}

        {!matchLoading && matchResult && matchResult.available.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <select
              value={selectedPdf}
              onChange={e => setSelectedPdf(e.target.value)}
              style={{
                flex: 1, minWidth: 220, padding: '5px 9px', borderRadius: 6,
                border: theme.cardBorder, background: theme.cardBg,
                color: theme.labelColor, fontFamily: theme.fontFamily,
                fontSize: 11, cursor: 'pointer', outline: 'none',
              }}
            >
              <option value="">
                {lang === 'zh' ? '— 选择乐谱 —' : '— Select score —'}
              </option>
              {matchResult.available.map(pdf => (
                <option key={pdf} value={pdf}>{pdf}</option>
              ))}
            </select>

            {/* Auto-match badge */}
            {matchResult.matched && selectedPdf === matchResult.matched && (
              <span style={{
                fontSize: 10, padding: '2px 9px', borderRadius: 10, flexShrink: 0,
                background: isDark
                  ? 'rgba(16,185,129,0.18)'
                  : 'rgba(16,185,129,0.12)',
                color: '#10b981',
              }}>
                {lang === 'zh'
                  ? `自动匹配 ${Math.round(matchResult.score * 100)}%`
                  : `Auto-matched ${Math.round(matchResult.score * 100)}%`}
              </span>
            )}
          </div>
        )}

        {!matchLoading && matchResult && matchResult.available.length === 0 && (
          <div style={{ fontSize: 11, color: '#e05' }}>
            {lang === 'zh'
              ? '未找到 IMSLP 乐谱文件（请将 PDF 放至 IMSLP/ 目录）'
              : 'No IMSLP score files found (place PDFs in the IMSLP/ folder)'}
          </div>
        )}
      </div>

      {/* ── Analyze button + status ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        marginBottom: 16, flexWrap: 'wrap',
      }}>
        <button
          onClick={startAnalysis}
          disabled={!selectedPdf || isAnalyzing}
          style={{
            padding: '8px 22px', borderRadius: 8, border: 'none',
            background: selectedPdf && !isAnalyzing
              ? '#4361EE'
              : (isDark ? '#333' : '#ccc'),
            color: '#fff', fontFamily: theme.fontFamily,
            fontSize: 12, fontWeight: 600,
            cursor: selectedPdf && !isAnalyzing ? 'pointer' : 'not-allowed',
            transition: 'background 0.2s',
          }}
        >
          {isAnalyzing
            ? (lang === 'zh' ? '分析中…' : 'Analyzing…')
            : (lang === 'zh' ? '✦ 分析乐谱' : '✦ Analyze Score')}
        </button>

        {statusMsg && (
          <span style={{
            fontSize: 11, color: theme.labelSecondaryColor, fontStyle: 'italic',
          }}>
            {statusMsg}
          </span>
        )}

        {analysisState === 'done' && (
          <span style={{ fontSize: 11, color: '#10b981' }}>
            {lang === 'zh' ? '✓ 分析完成' : '✓ Analysis complete'}
          </span>
        )}
      </div>

      {/* ── Error message ── */}
      {analysisState === 'error' && errorMsg && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 14,
          background: isDark ? '#2a1010' : '#fff5f5',
          border: '1px solid #e05',
          fontSize: 11, color: isDark ? '#f88' : '#c00',
          fontFamily: 'monospace', lineHeight: 1.6,
        }}>
          {errorMsg}
        </div>
      )}

      {/* ── Streaming / finished analysis ── */}
      {(analysisState === 'streaming' || analysisState === 'done') && analysisText && (
        <div style={{
          padding: '16px 18px', borderRadius: 10,
          background: isDark ? 'rgba(255,255,255,0.025)' : '#fafafa',
          border: theme.cardBorder,
        }}>
          <MarkdownRenderer text={analysisText} theme={theme} isDark={isDark} />

          {/* Blinking cursor while streaming */}
          {analysisState === 'streaming' && (
            <>
              <span style={{
                display: 'inline-block', width: 7, height: 14,
                background: '#4361EE', borderRadius: 1,
                verticalAlign: 'middle',
                animation: 'scoreCursor 0.85s steps(1) infinite',
              }} />
              <style>{`@keyframes scoreCursor{0%,49%{opacity:1}50%,100%{opacity:0}}`}</style>
            </>
          )}

          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
