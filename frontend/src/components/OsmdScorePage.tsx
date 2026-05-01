/**
 * OsmdScorePage.tsx
 * ─────────────────
 * Renders an annotated MusicXML score using OpenSheetMusicDisplay (OSMD).
 *
 * Features:
 *  • Skeleton notes (highest pitch per 0.5-beat slot) pre-coloured red by backend.
 *  • Zoom set to 0.65 so ~6 measures fit per row.
 *  • Variation selector pills (Theme / V1 / V2 / …) — click to show only that section.
 *  • Cyan bar highlight synced to audio playback.
 *  • Amber bar highlight for MIDI section selection.
 *
 * Key layout rule:
 *   OSMD reads container.clientWidth during render().
 *   If display:none → clientWidth=0 → blank output.
 *   Fix: set status→'rendering' (makes container visible) THEN wait two rAF
 *   for browser to flush, THEN call render().
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import type { PieceData, Segment } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import { API_BASE } from '../api/pieceApi'
import type { MidiSectionRef } from './ChromaticismPage'

// ── Types ─────────────────────────────────────────────────────────────

interface AnnotatedResponse {
  matched:    boolean
  source?:    string
  file_name?: string
  xml?:       string
  message?:   string
}

interface Props {
  data:              PieceData
  theme:             ThemeTokens
  isDark:            boolean
  lang:              Lang
  fileName:          string
  highlightMeasures?: MidiSectionRef | null
  /** Current bar being played (0-based). Highlighted in cyan during playback. */
  playbackBar?:      number | null
  /** barmap[i] = start time (seconds) of bar i — used to map segments → bar ranges */
  barmap?:           number[]
}

type Status = 'idle' | 'fetching' | 'rendering' | 'ready' | 'error'

/** Wait for N animation frames so the browser has flushed layout. */
function waitFrames(n = 2): Promise<void> {
  return new Promise(resolve => {
    let count = 0
    const tick = () => { if (++count >= n) resolve(); else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
}

/**
 * Given a segment's time range and the barmap, return the inclusive 0-based
 * bar index range [minBar, maxBar] that overlaps the segment.
 */
function segmentToBars(
  seg: Segment,
  barmap: number[],
): { minBar: number; maxBar: number } {
  if (!barmap.length) return { minBar: 0, maxBar: 9999 }

  // First bar whose start time ≥ segment start (binary search from left)
  let minBar = 0
  for (let i = 0; i < barmap.length; i++) {
    if (barmap[i] >= seg.start_sec - 0.1) { minBar = i; break }
    minBar = i
  }

  // Last bar whose start time < segment end
  let maxBar = barmap.length - 1
  for (let i = barmap.length - 1; i >= 0; i--) {
    if (barmap[i] < seg.end_sec + 0.1) { maxBar = i; break }
  }

  return { minBar, maxBar }
}

// ── Component ─────────────────────────────────────────────────────────

export function OsmdScorePage({
  data, theme, isDark, lang, fileName,
  highlightMeasures, playbackBar, barmap = [],
}: Props) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en

  const containerRef = useRef<HTMLDivElement>(null)
  const osmdRef      = useRef<OpenSheetMusicDisplay | null>(null)
  const xmlRef       = useRef<string>('')       // cached XML so re-filter doesn't re-fetch

  const [status,        setStatus]        = useState<Status>('idle')
  const [errMsg,        setErrMsg]        = useState('')
  const [srcNote,       setSrcNote]       = useState('')
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null)  // null = all

  // Derived bar range from selected segment
  const selectedSeg = selectedLabel
    ? data.segments.find(s => s.label === selectedLabel) ?? null
    : null
  const { minBar, maxBar } = selectedSeg && barmap.length
    ? segmentToBars(selectedSeg, barmap)
    : { minBar: 0, maxBar: 9999 }

  // ── Core OSMD render helper ────────────────────────────────────────
  // Accepts pre-loaded XML. Sets measure bounds + zoom, then renders.
  const renderOsmd = useCallback(async (
    xml: string,
    minMeasure: number,
    maxMeasure: number,
  ) => {
    if (!containerRef.current) return

    setStatus('rendering')
    await waitFrames(2)
    if (!containerRef.current) return

    // Tear down old instance
    if (osmdRef.current) {
      try { (osmdRef.current as any).clear?.() } catch { /* ignore */ }
      osmdRef.current = null
    }
    containerRef.current.innerHTML = ''

    const osmd = new OpenSheetMusicDisplay(containerRef.current, {
      autoResize:              false,   // we control re-render manually
      backend:                 'svg',
      drawingParameters:       'default',
      colorStemsLikeNoteheads: true,
      disableCursor:           true,
    })

    // Zoom out to fit ~6 measures per row
    osmd.zoom = 0.65

    try {
      await osmd.load(xml)

      // Set measure draw range before render
      const rules = (osmd as any).EngravingRules ?? (osmd as any).rules
      if (rules) {
        rules.MinMeasureToDrawIndex = minMeasure
        rules.MaxMeasureToDrawIndex = maxMeasure === 9999 ? Number.MAX_SAFE_INTEGER : maxMeasure
      }

      await osmd.render()
    } catch (renderErr) {
      setStatus('error')
      setErrMsg(String(renderErr))
      return
    }

    osmdRef.current = osmd
    setStatus('ready')
  }, [])

  // ── Fetch XML + initial render ────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    setStatus('fetching')
    setErrMsg('')
    setSrcNote('')
    setSelectedLabel(null)
    xmlRef.current = ''

    fetch(`${API_BASE}/score/annotated/${encodeURIComponent(fileName)}`)
      .then(async r => {
        const body = await r.json()
        if (!r.ok) throw new Error(body?.detail ?? `HTTP ${r.status}`)
        return body as AnnotatedResponse
      })
      .then(async d => {
        if (cancelled) return
        if (!d.matched || !d.xml) {
          setStatus('error')
          setErrMsg(d.message ?? t('未找到乐谱或 MIDI', 'No score or MIDI found'))
          return
        }

        const src = d.source ?? ''
        setSrcNote(
          src.startsWith('midi')   ? t('来源：MIDI 转换', 'Source: MIDI conversion')
          : src.startsWith('local') ? t('来源：IMSLP 乐谱', 'Source: IMSLP score file')
          : t('来源：缓存', 'Source: cache'),
        )

        xmlRef.current = d.xml
        if (!cancelled) await renderOsmd(d.xml, 0, 9999)
      })
      .catch(e => {
        if (!cancelled) { setStatus('error'); setErrMsg(String(e)) }
      })

    return () => { cancelled = true }
  }, [fileName])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Re-render when variation filter changes ───────────────────────
  useEffect(() => {
    if (!xmlRef.current || status === 'fetching') return
    renderOsmd(xmlRef.current, minBar, maxBar)
  }, [selectedLabel])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Highlight measures when a MIDI section is selected ────────────
  useEffect(() => {
    const osmd = osmdRef.current
    if (!osmd || status !== 'ready') return

    const measureList = (osmd as any).graphic?.MeasureList
      ?? (osmd as any).GraphicSheet?.MeasureList
    if (!measureList) return

    const resetColor     = '#000000'
    const highlightColor = '#F59E0B'

    try {
      measureList.forEach((row: any[]) => {
        row?.forEach((measure: any) => {
          measure?.staffEntries?.forEach((se: any) => {
            se?.graphicalVoiceEntries?.forEach((gve: any) => {
              gve?.notes?.forEach((n: any) => {
                if (n?.sourceNote) n.sourceNote.NoteheadColor = resetColor
              })
            })
          })
        })
      })

      if (highlightMeasures) {
        const { barStart, barEnd } = highlightMeasures
        const slice = measureList.slice(barStart, barEnd)
        slice.forEach((row: any[]) => {
          row?.forEach((measure: any) => {
            measure?.staffEntries?.forEach((se: any) => {
              se?.graphicalVoiceEntries?.forEach((gve: any) => {
                gve?.notes?.forEach((n: any) => {
                  if (n?.sourceNote) n.sourceNote.NoteheadColor = highlightColor
                })
              })
            })
          })
        })

        try {
          const target = measureList[barStart]?.[0]
          const ps = target?.PositionAndShape ?? target?.boundingBox
          if (ps) {
            const svgEl = containerRef.current?.querySelector('svg')
            if (svgEl) {
              const scaleX = svgEl.clientWidth / (svgEl.viewBox?.baseVal?.width || svgEl.clientWidth)
              const targetY = (ps.absolutePosition?.y ?? ps.y ?? 0) * scaleX * 10
              containerRef.current?.scrollTo({ top: Math.max(0, targetY - 60), behavior: 'smooth' })
            }
          }
        } catch { /* scroll is best-effort */ }
      }

      osmd.render()
    } catch { /* OSMD internals may vary */ }
  }, [highlightMeasures, status])

  // ── Playback bar highlight (cyan) ─────────────────────────────────
  const lastPlaybackBarRef = useRef<number | null>(null)

  useEffect(() => {
    const osmd = osmdRef.current
    if (!osmd || status !== 'ready') return
    if (playbackBar === lastPlaybackBarRef.current) return
    lastPlaybackBarRef.current = playbackBar ?? null

    const measureList = (osmd as any).graphic?.MeasureList
      ?? (osmd as any).GraphicSheet?.MeasureList
    if (!measureList) return

    const PLAYBACK_COLOR = '#22d3ee'
    const AMBER_COLOR    = '#F59E0B'
    const DEFAULT_COLOR  = '#000000'

    try {
      measureList.forEach((row: any[], rowIdx: number) => {
        row?.forEach((measure: any) => {
          const isInSection = highlightMeasures
            && rowIdx >= highlightMeasures.barStart
            && rowIdx <  highlightMeasures.barEnd
          measure?.staffEntries?.forEach((se: any) => {
            se?.graphicalVoiceEntries?.forEach((gve: any) => {
              gve?.notes?.forEach((n: any) => {
                if (n?.sourceNote)
                  n.sourceNote.NoteheadColor = isInSection ? AMBER_COLOR : DEFAULT_COLOR
              })
            })
          })
        })
      })

      if (playbackBar != null && playbackBar < measureList.length) {
        const row = measureList[playbackBar]
        row?.forEach((measure: any) => {
          measure?.staffEntries?.forEach((se: any) => {
            se?.graphicalVoiceEntries?.forEach((gve: any) => {
              gve?.notes?.forEach((n: any) => {
                if (n?.sourceNote) n.sourceNote.NoteheadColor = PLAYBACK_COLOR
              })
            })
          })
        })

        try {
          const target = measureList[playbackBar]?.[0]
          const ps = target?.PositionAndShape ?? target?.boundingBox
          if (ps) {
            const svgEl = containerRef.current?.querySelector('svg')
            if (svgEl) {
              const scaleX = svgEl.clientWidth / (svgEl.viewBox?.baseVal?.width || svgEl.clientWidth)
              const targetY = (ps.absolutePosition?.y ?? ps.y ?? 0) * scaleX * 10
              const container = containerRef.current
              if (container) {
                const visTop = container.scrollTop + 40
                const visBot = container.scrollTop + container.clientHeight - 40
                if (targetY < visTop || targetY > visBot) {
                  container.scrollTo({ top: Math.max(0, targetY - 80), behavior: 'smooth' })
                }
              }
            }
          }
        } catch { /* scroll is best-effort */ }
      }

      osmd.render()
    } catch { /* OSMD internals may vary */ }
  }, [playbackBar, status])

  // ── Derived ───────────────────────────────────────────────────────
  const containerVisible = status === 'rendering' || status === 'ready'

  // Segment pills: "全部/All" + one per segment
  const segLabels = data.segments.map(s => s.label)

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '10px 14px', fontFamily: theme.fontFamily }}>

      {/* ── Header row ── */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap',
        gap: 10, marginBottom: 8,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: theme.labelColor }}>
          {t(' 骨架乐谱', ' Annotated Score')}
        </span>

        {status === 'ready' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 12, height: 12, borderRadius: 2, background: '#ef4444' }} />
            <span style={{ fontSize: 9, color: '#ef4444', fontWeight: 600 }}>
              {t('骨干音（每拍最高音）', 'Skeleton note (highest pitch/beat)')}
            </span>
          </div>
        )}

        {playbackBar != null && status === 'ready' && (
          <span style={{
            padding: '2px 10px', borderRadius: 20,
            background: '#22d3ee22', border: '1px solid #22d3ee66',
            fontSize: 10, fontWeight: 700, color: '#22d3ee',
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: '#22d3ee', animation: 'pulse 1s infinite',
            }} />
            {t(`第 ${playbackBar + 1} 小节`, `m. ${playbackBar + 1}`)}
          </span>
        )}

        {highlightMeasures && status === 'ready' && (
          <span style={{
            padding: '2px 10px', borderRadius: 20,
            background: '#F59E0B22', border: '1px solid #F59E0B66',
            fontSize: 10, fontWeight: 700, color: '#F59E0B',
          }}>
            ▶ {highlightMeasures.label}
            <span style={{ fontWeight: 400, marginLeft: 5 }}>
              {t(`第 ${highlightMeasures.barStart}–${highlightMeasures.barEnd} 小节`,
                 `mm. ${highlightMeasures.barStart}–${highlightMeasures.barEnd}`)}
            </span>
          </span>
        )}

        {srcNote && status === 'ready' && (
          <span style={{
            fontSize: 8, color: theme.labelSecondaryColor,
            marginLeft: 'auto', fontStyle: 'italic',
          }}>
            {srcNote}
          </span>
        )}
      </div>

      {/* ── Variation selector pills ── */}
      {segLabels.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10,
        }}>
          {/* "All" pill */}
          <button
            onClick={() => setSelectedLabel(null)}
            style={{
              padding: '3px 11px', borderRadius: 20, border: 'none',
              cursor: 'pointer', fontSize: 10, fontWeight: 600,
              background: selectedLabel === null ? '#6366f1' : (isDark ? '#2a2a3e' : '#f1f5f9'),
              color:      selectedLabel === null ? '#fff'    : theme.labelColor,
              transition: 'background 0.15s',
            }}
          >
            {t('全部', 'All')}
          </button>

          {data.segments.map(seg => {
            const isActive = selectedLabel === seg.label
            // Choose pill accent based on segment type
            const accent =
              seg.label === 'T'  ? '#10b981' :   // green = theme
              seg.label === 'C'  ? '#f59e0b' :   // amber = coda
              '#6366f1'                           // indigo = variations

            return (
              <button
                key={seg.label}
                onClick={() => setSelectedLabel(seg.label === selectedLabel ? null : seg.label)}
                style={{
                  padding: '3px 11px', borderRadius: 20, border: 'none',
                  cursor: 'pointer', fontSize: 10, fontWeight: 600,
                  background: isActive ? accent : (isDark ? '#2a2a3e' : '#f1f5f9'),
                  color:      isActive ? '#fff'  : theme.labelColor,
                  transition: 'background 0.15s',
                }}
                title={`${t('时长', 'dur.')}: ${seg.duration_sec.toFixed(1)}s`}
              >
                {seg.label === 'T' ? t('主题', 'Theme')
                 : seg.label === 'C' ? t('尾声', 'Coda')
                 : seg.label}
              </button>
            )
          })}
        </div>
      )}

      {/* ── Fetching spinner ── */}
      {status === 'fetching' && (
        <div style={{ padding: '36px 0', textAlign: 'center', fontSize: 11, color: theme.labelSecondaryColor }}>
          <div>{t('⏳ 正在生成标注乐谱（首次约 10–20 秒）…', '⏳ Generating annotated score (first run ~10–20 s)…')}</div>
          <div style={{ fontSize: 9, marginTop: 8, opacity: 0.6 }}>
            {t('music21 解析中…', 'music21 parsing…')}
          </div>
        </div>
      )}

      {/* ── Rendering spinner ── */}
      {status === 'rendering' && (
        <div style={{ marginBottom: 8, textAlign: 'center', fontSize: 11, color: theme.labelSecondaryColor }}>
          {t(' 正在渲染乐谱…', ' Rendering score…')}
        </div>
      )}

      {/* ── Error ── */}
      {status === 'error' && (
        <div style={{ padding: '20px 0', fontSize: 11, color: '#ef4444', lineHeight: 1.7 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            {t('无法加载乐谱', 'Could not load score')}
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.85 }}>{errMsg}</div>
          <div style={{ marginTop: 10, fontSize: 9, color: theme.labelSecondaryColor }}>
            {t(
              '需要 MIDI（TV_MIDI/）或 MXL（scores/）文件，且后端须安装 music21。',
              'Requires a MIDI (TV_MIDI/) or MXL (scores/) file, and music21 installed in the backend.',
            )}
          </div>
        </div>
      )}

      {/* ── OSMD container ── */}
      <div
        ref={containerRef}
        style={{
          display:      containerVisible ? 'block' : 'none',
          border:       `1px solid ${isDark ? '#2d2d45' : '#e2e8f0'}`,
          borderRadius: 8,
          overflow:     'auto',
          background:   isDark ? '#1a1929' : '#ffffff',
          padding:      '12px 8px 4px',
          width:        '100%',
          boxSizing:    'border-box',
          maxHeight:    'calc(100vh - 240px)',
          minHeight:    containerVisible ? 60 : undefined,
        }}
      />

      {/* ── Footer ── */}
      {status === 'ready' && (
        <div style={{ marginTop: 8, fontSize: 9, color: theme.labelSecondaryColor, lineHeight: 1.6 }}>
          {t(
            '骨干音（红色）= 每 0.5 拍格内音高最高的音符，近似主旋律声部。',
            'Skeleton notes (red) = highest-pitched note per 0.5-beat slot ≈ melody voice.',
          )}
        </div>
      )}

    </div>
  )
}
