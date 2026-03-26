/**
 * ComparisonGrid
 * ──────────────
 * Horizontal scrollable row of VariationCards.
 *
 * Selection logic:
 *   • Click a card once    → selects as "A" (primary)
 *   • Click a second card  → selects as "B" (secondary)
 *   • Click a selected card → deselects it
 *   • "Enlarge" button (or double-click) → open ContourModal for A alone
 *   • "Compare" button (visible when A+B selected) → open ContourModal overlay
 *   • Clear button → deselect all
 *
 * Audio props (optional):
 *   currentTime      — current playback position in seconds (from AudioPlayer)
 *   onSeekToSegment  — called with start_sec when the ▶ button on a card is clicked
 */

import { useState, useCallback } from 'react'
import type { PieceData } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import { globalContourRange } from '../utils/pitchContour'
import { VariationCard } from './VariationCard'
import { ContourModal } from './ContourModal'

interface Props {
  data: PieceData
  theme: ThemeTokens
  lang?: Lang
  currentTime?: number          // audio playback position (seconds)
  onSeekToSegment?: (startSec: number) => void
}

export function ComparisonGrid({ data, theme, lang = 'zh', currentTime = -1, onSeekToSegment }: Props) {
  const [primaryIdx,   setPrimaryIdx]   = useState<number | null>(null)
  const [secondaryIdx, setSecondaryIdx] = useState<number | null>(null)
  const [modalOpen,    setModalOpen]    = useState(false)

  // Pre-compute global range once (all segments share same Y axis)
  const range = globalContourRange(data.segments)

  const handleCardClick = useCallback((idx: number) => {
    if (idx === primaryIdx) {
      setPrimaryIdx(secondaryIdx)
      setSecondaryIdx(null)
    } else if (idx === secondaryIdx) {
      setSecondaryIdx(null)
    } else if (primaryIdx === null) {
      setPrimaryIdx(idx)
    } else {
      setSecondaryIdx(idx)
    }
  }, [primaryIdx, secondaryIdx])

  const handleDoubleClick = useCallback((idx: number) => {
    setPrimaryIdx(idx)
    setSecondaryIdx(null)
    setModalOpen(true)
  }, [])

  const clearSelection = () => {
    setPrimaryIdx(null)
    setSecondaryIdx(null)
    setModalOpen(false)
  }

  const modalSegments = (() => {
    if (primaryIdx === null) return null
    const a = data.segments[primaryIdx]
    if (secondaryIdx !== null) {
      const b = data.segments[secondaryIdx]
      return [a, b] as [typeof a, typeof b]
    }
    return [a] as [typeof a]
  })()

  const hasSelection = primaryIdx !== null
  const hasBoth      = primaryIdx !== null && secondaryIdx !== null

  const isDark = theme.pageBg.includes('1a') || theme.pageBg.startsWith('#0') || theme.pageBg.startsWith('#1')

  // Determine which segment index is currently playing
  const playingIdx = currentTime >= 0
    ? data.segments.findIndex(
        seg => currentTime >= seg.start_sec && currentTime < seg.end_sec
      )
    : -1

  return (
    <div>
      {/* ── Action bar ── */}
      {hasSelection && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          marginBottom: 8,
          borderRadius: 8,
          background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
          border: theme.cardBorder,
          flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11, color: theme.labelSecondaryColor, fontFamily: theme.fontFamily }}>
            {hasBoth
              ? `A = ${data.segments[primaryIdx!].label}  ·  B = ${data.segments[secondaryIdx!].label}`
              : lang === 'zh'
                ? `已选：${data.segments[primaryIdx!].label}`
                : `Selected: ${data.segments[primaryIdx!].label}`}
          </span>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Btn
              label={lang === 'zh' ? '⛶  放大 A' : '⛶  Enlarge A'}
              onClick={() => { setSecondaryIdx(null); setModalOpen(true) }}
              theme={theme}
            />
            {hasBoth && (
              <Btn
                label={lang === 'zh' ? '⊕  叠加 A + B' : '⊕  Overlay A + B'}
                onClick={() => setModalOpen(true)}
                theme={theme}
                accent
              />
            )}
            <Btn label={lang === 'zh' ? '✕ 清除' : '✕ Clear'} onClick={clearSelection} theme={theme} />
          </div>
        </div>
      )}

      {/* ── Hint when nothing selected ── */}
      {!hasSelection && (
        <div style={{
          fontSize: 10,
          color: theme.labelSecondaryColor,
          fontFamily: theme.fontFamily,
          padding: '2px 8px 8px',
          opacity: 0.7,
        }}>
          {lang === 'zh'
          ? '点击卡片选为 A · 再点另一张选为 B · 双击放大 · ▶ 跳转播放'
          : 'Click a card to select A · click another for B · double-click to enlarge · ▶ to play segment'}
        </div>
      )}

      {/* ── Card grid (all cards, wrapping) ── */}
      <div style={{ paddingBottom: 8, paddingTop: 4 }}>
        <div style={{
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 10,
          padding: '4px 8px',
        }}>
          {data.segments.map((seg, i) => {
            const state =
              i === primaryIdx   ? 'primary'   :
              i === secondaryIdx ? 'secondary' : 'none'

            return (
              <div
                key={seg.label}
                onDoubleClick={() => handleDoubleClick(i)}
              >
                <VariationCard
                  segment={seg}
                  range={range}
                  theme={theme}
                  selectionState={state}
                  isPlaying={i === playingIdx}
                  onClick={() => handleCardClick(i)}
                  onPlay={onSeekToSegment
                    ? () => onSeekToSegment(seg.start_sec)
                    : undefined}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Modal ── */}
      {modalOpen && modalSegments && (
        <ContourModal
          segments={modalSegments}
          range={range}
          theme={theme}
          lang={lang}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  )
}

// ── Small button helper ──────────────────────────────────────────────
function Btn({
  label, onClick, theme, accent = false,
}: { label: string; onClick: () => void; theme: ThemeTokens; accent?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        borderRadius: 6,
        border: theme.cardBorder,
        background: accent ? '#4361EE' : 'transparent',
        color: accent ? '#fff' : theme.labelColor,
        fontFamily: theme.fontFamily,
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        letterSpacing: '0.02em',
      }}
    >
      {label}
    </button>
  )
}
