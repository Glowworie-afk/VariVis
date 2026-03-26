// VariationCard — label + pitch contour + meta + audio seek
import type { Segment } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { ContourRange } from '../utils/pitchContour'
import { PitchContour, labelColor } from './PitchContour'

interface Props {
  segment: Segment
  range: ContourRange          // global range for aligned Y axis
  theme: ThemeTokens
  selectionState: 'none' | 'primary' | 'secondary'
  onClick: () => void
  onPlay?: () => void          // seek audio to this segment's start
  isPlaying?: boolean          // true = this segment is currently playing
  cardWidth?: number
  contourHeight?: number
}

export function VariationCard({
  segment,
  range,
  theme,
  selectionState,
  onClick,
  onPlay,
  isPlaying = false,
  cardWidth = 160,
  contourHeight = 72,
}: Props) {
  const { label, duration_sec, features } = segment
  const mins = Math.floor(duration_sec / 60)
  const secs = Math.round(duration_sec % 60)
  const durStr = mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`

  const accent = labelColor(segment.index)

  const borderStyle = (() => {
    if (isPlaying)                        return `2px solid ${accent}`
    if (selectionState === 'primary')     return `2px solid ${accent}`
    if (selectionState === 'secondary')   return `2px dashed ${accent}`
    return theme.cardBorder
  })()

  const elevate = selectionState !== 'none' || isPlaying

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 5,
        padding: '10px 8px 8px',
        borderRadius: 10,
        cursor: 'pointer',
        background: isPlaying
          ? (theme.pageBg.startsWith('#0') || theme.pageBg.startsWith('#1')
              ? `${accent}18` : `${accent}10`)
          : theme.cardBg,
        border: borderStyle,
        boxShadow: elevate
          ? `0 4px 16px ${accent}33`
          : theme.cardShadow,
        transition: 'transform 0.15s ease, box-shadow 0.15s ease, border 0.15s ease, background 0.15s ease',
        transform: elevate ? 'translateY(-4px)' : 'none',
        minWidth: cardWidth,
        maxWidth: cardWidth,
        userSelect: 'none',
        position: 'relative',
      }}
    >
      {/* Now-playing animated indicator */}
      {isPlaying && (
        <div style={{
          position: 'absolute', top: 5, right: 6,
          display: 'flex', gap: 2, alignItems: 'flex-end', height: 10,
        }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              width: 2, borderRadius: 1,
              background: accent,
              animation: `eq-bar 0.7s ease-in-out ${i * 0.15}s infinite alternate`,
              height: i === 1 ? 10 : 6,
            }} />
          ))}
        </div>
      )}

      {/* Label */}
      <span style={{
        fontSize: theme.fontSizeLabel,
        fontWeight: 700,
        fontFamily: theme.fontFamily,
        color: (selectionState !== 'none' || isPlaying) ? accent : theme.labelColor,
        letterSpacing: '0.04em',
      }}>
        {label}
      </span>

      {/* Pitch contour */}
      <PitchContour
        segment={segment}
        range={range}
        width={cardWidth - 16}
        height={contourHeight}
        theme={theme}
        color={accent}
        showGrid
        showLabel={false}
      />

      {/* Meta row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontSize: theme.fontSizeMeta,
        fontFamily: theme.fontFamily,
        color: theme.labelSecondaryColor,
        width: '100%',
      }}>
        <span>{durStr}</span>
        <span>·</span>
        <span>{features.onset_density.toFixed(1)}/s</span>

        {/* Play button — seek to this segment */}
        {onPlay && (
          <button
            onClick={e => { e.stopPropagation(); onPlay() }}
            title={`Play from ${label} (${durStr})`}
            style={{
              marginLeft: 'auto',
              width: 18, height: 18,
              borderRadius: '50%',
              border: `1px solid ${accent}66`,
              background: isPlaying ? accent : 'transparent',
              color: isPlaying ? '#fff' : accent,
              fontSize: 8,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
              lineHeight: 1,
            }}
          >
            ▶
          </button>
        )}
      </div>

      {/* Selection badge */}
      {selectionState !== 'none' && (
        <div style={{
          fontSize: 9,
          fontFamily: theme.fontFamily,
          color: accent,
          letterSpacing: '0.06em',
          opacity: 0.8,
        }}>
          {selectionState === 'primary' ? '● A' : '◌ B'}
        </div>
      )}
    </div>
  )
}
