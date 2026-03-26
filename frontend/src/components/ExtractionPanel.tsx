/**
 * ExtractionPanel
 * ───────────────
 * Shown when a piece hasn't been extracted yet.
 * Extraction is disabled on the deployed version (no audio files on server).
 */

import type { ThemeTokens } from '../theme'
import type { PieceMeta } from '../api/pieceApi'

interface Props {
  piece: PieceMeta
  theme: ThemeTokens
  onDone: () => void
}

export function ExtractionPanel({ piece, theme }: Props) {
  const isDark = theme.pageBg.startsWith('#0') || theme.pageBg.startsWith('#1')

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
          ○ Not yet extracted
        </span>
      </div>

      {/* Extract button — disabled on deployed version */}
      <div>
        <button
          disabled
          style={{
            padding: '9px 22px',
            borderRadius: 8,
            border: 'none',
            background: isDark ? '#333' : '#ccc',
            color: isDark ? '#666' : '#999',
            fontFamily: theme.fontFamily,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'not-allowed',
            letterSpacing: '0.02em',
          }}
        >
          ▶  Extract & Visualise
        </button>
        <div style={{
          marginTop: 10, fontSize: 10,
          color: theme.labelSecondaryColor, lineHeight: 1.6,
        }}>
          Extraction is only available when running locally.
        </div>
      </div>
    </div>
  )
}
