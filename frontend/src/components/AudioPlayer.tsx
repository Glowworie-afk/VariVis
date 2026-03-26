/**
 * AudioPlayer
 * ───────────
 * Compact inline audio player for a single piece.
 *
 * Props:
 *   src            — URL of the audio file
 *   theme          — theme tokens
 *   onTimeUpdate   — called with current playback time (seconds) every ~250ms
 *   seekToRef      — assign a seekTo(sec) function so parents can trigger seeks
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import type { ThemeTokens } from '../theme'

interface Props {
  src: string
  theme: ThemeTokens
  onTimeUpdate?: (time: number) => void
  seekToRef?: React.MutableRefObject<((sec: number) => void) | null>
}

export function AudioPlayer({ src, theme, onTimeUpdate, seekToRef }: Props) {
  const audioRef    = useRef<HTMLAudioElement>(null)
  const [playing,   setPlaying]   = useState(false)
  const [current,   setCurrent]   = useState(0)
  const [duration,  setDuration]  = useState(0)
  const [loading,   setLoading]   = useState(true)

  // Expose seekTo via ref so parent can seek programmatically
  useEffect(() => {
    if (!seekToRef) return
    seekToRef.current = (sec: number) => {
      const el = audioRef.current
      if (!el) return
      el.currentTime = sec
      el.play().catch(() => {})
      setPlaying(true)
    }
    return () => { if (seekToRef) seekToRef.current = null }
  }, [seekToRef])

  const handleTimeUpdate = useCallback(() => {
    const t = audioRef.current?.currentTime ?? 0
    setCurrent(t)
    onTimeUpdate?.(t)
  }, [onTimeUpdate])

  const handleLoaded = () => {
    setDuration(audioRef.current?.duration ?? 0)
    setLoading(false)
  }

  function togglePlay() {
    const el = audioRef.current
    if (!el) return
    if (playing) { el.pause(); setPlaying(false) }
    else         { el.play().catch(() => {}); setPlaying(true) }
  }

  function handleScrub(e: React.ChangeEvent<HTMLInputElement>) {
    const t = parseFloat(e.target.value)
    if (audioRef.current) audioRef.current.currentTime = t
    setCurrent(t)
    onTimeUpdate?.(t)
  }

  function fmt(sec: number) {
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const isDark = theme.pageBg.startsWith('#0') || theme.pageBg.startsWith('#1')
  const pct    = duration > 0 ? (current / duration) * 100 : 0

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 0',
        fontFamily: theme.fontFamily,
      }}
      onClick={e => e.stopPropagation()} // prevent collapse toggle
    >
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoaded}
        onEnded={() => setPlaying(false)}
        preload="metadata"
      />

      {/* Play / Pause */}
      <button
        onClick={togglePlay}
        disabled={loading}
        title={playing ? 'Pause' : 'Play'}
        style={{
          width: 26, height: 26, borderRadius: '50%',
          border: 'none',
          background: loading ? (isDark ? '#333' : '#ddd') : '#4361EE',
          color: '#fff',
          fontSize: 10, cursor: loading ? 'default' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {loading ? '…' : (playing ? '⏸' : '▶')}
      </button>

      {/* Current time */}
      <span style={{
        fontSize: 10, color: theme.labelSecondaryColor,
        fontFamily: 'monospace', minWidth: 30, textAlign: 'right',
        flexShrink: 0,
      }}>
        {fmt(current)}
      </span>

      {/* Seek bar — custom styled range */}
      <div style={{ flex: 1, minWidth: 60, maxWidth: 200, position: 'relative', height: 16, display: 'flex', alignItems: 'center' }}>
        {/* Track fill */}
        <div style={{
          position: 'absolute', left: 0, top: '50%',
          transform: 'translateY(-50%)',
          width: '100%', height: 3, borderRadius: 2,
          background: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
          pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', left: 0, top: '50%',
          transform: 'translateY(-50%)',
          width: `${pct}%`, height: 3, borderRadius: 2,
          background: '#4361EE',
          pointerEvents: 'none',
          transition: 'width 0.1s linear',
        }} />
        <input
          type="range"
          min={0} max={duration || 1} step={0.5}
          value={current}
          onChange={handleScrub}
          style={{
            position: 'absolute', width: '100%',
            opacity: 0, cursor: 'pointer', height: '100%',
          }}
        />
      </div>

      {/* Duration */}
      <span style={{
        fontSize: 10, color: theme.labelSecondaryColor,
        fontFamily: 'monospace', minWidth: 30,
        flexShrink: 0,
      }}>
        {fmt(duration)}
      </span>
    </div>
  )
}
