import { forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback } from 'react'
import type { ThemeTokens } from '@/constants/theme'

// Imperative handle exposed to parent components via ref.
export interface AudioPlayerHandle {
  seekTo: (sec: number) => void
  play:   () => void
  pause:  () => void
}

interface Props {
  src:              string
  theme:            ThemeTokens
  onTimeUpdate?:    (time: number) => void
  onPlayingChange?: (isPlaying: boolean) => void
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(
  function AudioPlayer({ src, theme, onTimeUpdate, onPlayingChange }, ref) {
    const audioRef   = useRef<HTMLAudioElement>(null)
    const [playing,  setPlaying]  = useState(false)
    const [current,  setCurrent]  = useState(0)
    const [duration, setDuration] = useState(0)
    const [loading,  setLoading]  = useState(true)

    const onPlayingChangeRef = useRef(onPlayingChange)
    useEffect(() => { onPlayingChangeRef.current = onPlayingChange })

    useImperativeHandle(ref, () => ({
      seekTo: (sec: number) => {
        const el = audioRef.current
        if (el) el.currentTime = sec
      },
      play: () => {
        const el = audioRef.current
        if (!el) return
        el.play().catch(() => {})
        setPlaying(true)
        onPlayingChangeRef.current?.(true)
      },
      pause: () => {
        const el = audioRef.current
        if (!el) return
        el.pause()
        setPlaying(false)
        onPlayingChangeRef.current?.(false)
      },
    }), [])

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
      if (playing) {
        el.pause()
        setPlaying(false)
        onPlayingChange?.(false)
      } else {
        el.play().catch(() => {})
        setPlaying(true)
        onPlayingChange?.(true)
      }
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
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', fontFamily: theme.fontFamily }}
        onClick={e => e.stopPropagation()}
      >
        <audio
          ref={audioRef}
          src={src}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoaded}
          onEnded={() => { setPlaying(false); onPlayingChange?.(false) }}
          preload="metadata"
        />

        <button
          onClick={togglePlay}
          disabled={loading}
          title={playing ? 'Pause' : 'Play'}
          style={{
            width: 26, height: 26, borderRadius: '50%', border: 'none',
            background: loading ? (isDark ? '#333' : '#ddd') : '#4361EE',
            color: '#fff', fontSize: 10, cursor: loading ? 'default' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}
        >
          {loading ? '…' : (playing ? '⏸' : '▶')}
        </button>

        <span style={{
          fontSize: 10, color: theme.labelSecondaryColor,
          fontFamily: 'monospace', minWidth: 30, textAlign: 'right', flexShrink: 0,
        }}>
          {fmt(current)}
        </span>

        <div style={{ flex: 1, minWidth: 60, position: 'relative', height: 16, display: 'flex', alignItems: 'center' }}>
          <div style={{
            position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
            width: '100%', height: 3, borderRadius: 2,
            background: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
            pointerEvents: 'none',
          }} />
          <div style={{
            position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
            width: `${pct}%`, height: 3, borderRadius: 2, background: '#4361EE',
            pointerEvents: 'none', transition: 'width 0.1s linear',
          }} />
          <input
            type="range" min={0} max={duration || 1} step={0.5} value={current}
            onChange={handleScrub}
            style={{ position: 'absolute', width: '100%', opacity: 0, cursor: 'pointer', height: '100%' }}
          />
        </div>

        <span style={{
          fontSize: 10, color: theme.labelSecondaryColor,
          fontFamily: 'monospace', minWidth: 30, flexShrink: 0,
        }}>
          {fmt(duration)}
        </span>
      </div>
    )
  }
)
