/**
 * ExtractionPanel
 * ───────────────
 * Shown when a piece hasn't been extracted yet.
 * Clicking "Extract" streams real-time progress from the server.
 */

import { useState, useRef, useEffect } from 'react'
import type { ThemeTokens } from '../theme'
import type { PieceMeta, ExtractionEvent } from '../api/pieceApi'
import { streamExtraction } from '../api/pieceApi'

interface Props {
  piece: PieceMeta
  theme: ThemeTokens
  onDone: () => void          // called when extraction completes successfully
}

type Phase = 'idle' | 'extracting' | 'pyin' | 'done' | 'error'

const STEP_LABEL: Record<string, string> = {
  extract: '⚙️  Step 1 / 2 — Extracting audio features (librosa)…',
  pyin:    '🎵  Step 2 / 2 — Tracking melody pitch (pYIN + KS key detection)…',
}

export function ExtractionPanel({ piece, theme, onDone }: Props) {
  const [phase,  setPhase]  = useState<Phase>('idle')
  const [logs,   setLogs]   = useState<string[]>([])
  const [errMsg, setErrMsg] = useState('')
  const cancelRef  = useRef<(() => void) | null>(null)
  const logEndRef  = useRef<HTMLDivElement>(null)

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // Cleanup SSE on unmount
  useEffect(() => () => { cancelRef.current?.() }, [])

  function startExtraction() {
    setPhase('extracting')
    setLogs([])
    setErrMsg('')

    const cancel = streamExtraction(piece.file_name, (evt: ExtractionEvent) => {
      switch (evt.type) {
        case 'step':
          setPhase(evt.step === 'pyin' ? 'pyin' : 'extracting')
          setLogs(l => [...l, STEP_LABEL[evt.step!] ?? evt.step!])
          break
        case 'log':
          setLogs(l => [...l, evt.line!])
          break
        case 'done':
          setPhase('done')
          setLogs(l => [...l, '✅  Done! Loading visualisation…'])
          setTimeout(onDone, 800)
          break
        case 'error':
          setPhase('error')
          setErrMsg(evt.error ?? 'Unknown error')
          setLogs(l => [...l, `❌  ${evt.error}`])
          break
      }
    })
    cancelRef.current = cancel
  }

  const isDark = theme.pageBg.startsWith('#0') || theme.pageBg.startsWith('#1')
  const running = phase === 'extracting' || phase === 'pyin'

  return (
    <div style={{
      maxWidth: 640,
      margin: '40px auto',
      padding: 28,
      borderRadius: 14,
      background: theme.cardBg,
      border: theme.cardBorder,
      boxShadow: theme.cardShadow,
      fontFamily: theme.fontFamily,
    }}>
      {/* Piece info */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: theme.labelColor, marginBottom: 4 }}>
          {piece.music_name || piece.file_name}
        </div>
        <div style={{ fontSize: 11, color: theme.labelSecondaryColor }}>
          {piece.composer} · {piece.instrument} · {piece.period}
        </div>
      </div>

      {/* Status badge */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 10px', borderRadius: 20,
        background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
        marginBottom: 18,
      }}>
        <span style={{ fontSize: 10, color: theme.labelSecondaryColor }}>
          {phase === 'idle'       && '○ Not yet extracted'}
          {phase === 'extracting' && '⟳ Extracting audio features…'}
          {phase === 'pyin'       && '⟳ Tracking melody pitch…'}
          {phase === 'done'       && '✓ Complete'}
          {phase === 'error'      && '✗ Failed'}
        </span>
      </div>

      {/* Extract button */}
      {(phase === 'idle' || phase === 'error') && (
        <div>
          <button
            onClick={startExtraction}
            style={{
              padding: '9px 22px',
              borderRadius: 8,
              border: 'none',
              background: '#4361EE',
              color: '#fff',
              fontFamily: theme.fontFamily,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              letterSpacing: '0.02em',
            }}
          >
            {phase === 'error' ? '↺  Retry' : '▶  Extract & Visualise'}
          </button>
          <div style={{
            marginTop: 10, fontSize: 10,
            color: theme.labelSecondaryColor, lineHeight: 1.6,
          }}>
            This will run <code>extract_features.py</code> then <code>add_pitch_contour.py</code>
            &nbsp;on the server. Takes ~1–3 min depending on piece length.
          </div>
        </div>
      )}

      {/* Progress bar */}
      {running && (
        <div style={{
          height: 3, borderRadius: 2,
          background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
          marginBottom: 12, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: phase === 'pyin' ? '65%' : '35%',
            background: '#4361EE',
            borderRadius: 2,
            transition: 'width 0.8s ease',
          }} />
        </div>
      )}

      {/* Log output */}
      {logs.length > 0 && (
        <div style={{
          marginTop: 14,
          maxHeight: 240,
          overflowY: 'auto',
          background: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.04)',
          borderRadius: 8,
          padding: '10px 14px',
          fontSize: 11,
          lineHeight: 1.8,
          color: theme.labelColor,
          fontFamily: 'monospace',
          border: theme.cardBorder,
        }}>
          {logs.map((l, i) => (
            <div key={i} style={{
              opacity: i === logs.length - 1 ? 1 : 0.65,
              whiteSpace: 'pre-wrap',
            }}>
              {l}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}

      {errMsg && (
        <div style={{
          marginTop: 12, padding: '8px 12px', borderRadius: 6,
          background: isDark ? '#2a0a0a' : '#fff0f0',
          color: '#e05', fontSize: 11, fontFamily: 'monospace',
        }}>
          {errMsg}
        </div>
      )}
    </div>
  )
}
