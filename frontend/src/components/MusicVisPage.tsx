/**
 * MusicVisPage.tsx
 * ─────────────────
 * Score viewer with theme/variation section selector.
 * Renders MusicXML via OSMD; section pills filter which measures are drawn.
 *
 * "Harmonic Function" view:
 *   • coloured overlay on the score (T=green, S=indigo, D=red, O=grey)
 *   • per-section stacked-bar stats beneath the score
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import { API_BASE } from '../api/pieceApi'

// ── Types ─────────────────────────────────────────────────────────────

interface Section {
  label:     string
  norm:      string
  start_idx: number
  end_idx:   number
}

interface ChordMeasure {
  seq:      number
  function: string
  chord:    string
  T: number; S: number; D: number; O: number
}

interface MeasurePos { x: number; y: number; w: number; h: number; seqIdx: number }

// ── Colour palette ────────────────────────────────────────────────────

const FN_COLOR: Record<string, string> = {
  T: 'rgba(16,185,129,0.22)',
  S: 'rgba(99,102,241,0.22)',
  D: 'rgba(239,68,68,0.22)',
  O: 'rgba(156,163,175,0.12)',
}
const FN_SOLID: Record<string, string> = {
  T: '#10b981', S: '#6366f1', D: '#ef4444', O: '#9ca3af',
}

// ── HarmonicStatsChart ────────────────────────────────────────────────

interface StatProps {
  sections:      Section[]
  activeSection: Section | null
  chordData:     ChordMeasure[]
  theme:         ThemeTokens
  lang:          Lang
}

function HarmonicStatsChart({ sections, activeSection, chordData, theme, lang }: StatProps) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en

  // When a section pill is active → show only that section's bar.
  // When "All" is selected → show all Theme + Variation sections.
  const rows = activeSection
    ? [{ label: activeSection.label, start: activeSection.start_idx, end: activeSection.end_idx }]
    : sections
        .filter(s => {
          const low = s.label.toLowerCase()
          return low.startsWith('tema') || low.startsWith('theme') || low.startsWith('var')
        })
        .map(s => ({ label: s.label, start: s.start_idx, end: s.end_idx }))

  return (
    <div style={{
      background:   theme.surface,
      border:       `1px solid ${theme.borderColor}`,
      borderRadius: 8,
      padding:      '8px 10px 6px',
      marginBottom: 8,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: theme.labelColor, marginBottom: 6 }}>
        {t('和声功能分布', 'Harmonic Function Distribution')}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        {(['T', 'S', 'D', 'O'] as const).map(fn => (
          <span key={fn} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9 }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: FN_SOLID[fn] }} />
            <span style={{ color: theme.labelSecondaryColor }}>
              {fn} –{' '}
              {fn === 'T' ? t('主功能', 'Tonic') :
               fn === 'S' ? t('下属功能', 'Subdominant') :
               fn === 'D' ? t('属功能', 'Dominant') :
                            t('其他', 'Other')}
            </span>
          </span>
        ))}
      </div>

      {/* Per-section bars */}
      {rows.map(row => {
        const ms = chordData.filter(m => m.seq >= row.start && m.seq < row.end)
        if (ms.length === 0) return null
        const tot = ms.length
        const agg = { T: 0, S: 0, D: 0, O: 0 }
        ms.forEach(m => { agg.T += m.T; agg.S += m.S; agg.D += m.D; agg.O += m.O })
        ;(Object.keys(agg) as (keyof typeof agg)[]).forEach(k => { agg[k] /= tot })

        const label = row.label === 'Tema' ? t('主题', 'Theme') : row.label

        return (
          <div key={row.label} style={{ marginBottom: 5 }}>
            <div style={{ fontSize: 9, color: theme.labelColor, marginBottom: 2, fontWeight: 600 }}>{label}</div>
            <div style={{
              display: 'flex', height: 15, borderRadius: 4,
              overflow: 'hidden', border: `1px solid ${theme.borderColor}`,
            }}>
              {(['T', 'S', 'D', 'O'] as const).map(fn => {
                const pct = agg[fn]
                if (pct < 0.005) return null
                return (
                  <div
                    key={fn}
                    title={`${fn}: ${(pct * 100).toFixed(1)}%`}
                    style={{
                      width:      `${pct * 100}%`,
                      background: FN_SOLID[fn],
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 7, color: '#fff', fontWeight: 700,
                      overflow: 'hidden', transition: 'width 0.3s',
                    }}
                  >
                    {pct > 0.12 ? `${(pct * 100).toFixed(0)}%` : ''}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────

interface Props { theme: ThemeTokens; lang: Lang; xmlFile: string }

export function MusicVisPage({ theme, lang, xmlFile }: Props) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en

  const [sections,      setSections]      = useState<Section[]>([])
  const [activeSection, setActiveSection] = useState<Section | null>(null)
  const [status,        setStatus]        = useState<'idle'|'fetching'|'rendering'|'ready'|'error'>('idle')
  const [errMsg,        setErrMsg]        = useState('')

  // ── Harmonic Function view (fixed) ────────────────────────────────
  const view = 'harmonic' as const
  const [chordData,    setChordData]    = useState<ChordMeasure[]>([])
  const [chordKey,     setChordKey]     = useState('')
  const [chordLoading, setChordLoading] = useState(false)
  const [measurePos,   setMeasurePos]   = useState<MeasurePos[]>([])

  const containerRef = useRef<HTMLDivElement>(null)
  const osmdRef      = useRef<OpenSheetMusicDisplay | null>(null)
  const xmlCacheRef  = useRef<string>('')   // cached XML text to avoid re-fetch on section change

  // ── Fetch sections when file changes ──────────────────────────────
  useEffect(() => {
    if (!xmlFile) return
    setActiveSection(null)
    setSections([])
    xmlCacheRef.current = ''

    fetch(`${API_BASE}/musicvis/sections/${encodeURIComponent(xmlFile)}`)
      .then(r => r.json())
      .then(d => { if (d.sections) setSections(d.sections) })
      .catch(() => {})
  }, [xmlFile])

  // ── Fetch chord data when file changes ────────────────────────────
  useEffect(() => {
    if (!xmlFile) return
    setChordData([])
    setChordKey('')
    setMeasurePos([])
    setChordLoading(true)

    fetch(`${API_BASE}/musicvis/chords/${encodeURIComponent(xmlFile)}`)
      .then(r => r.json())
      .then(d => {
        if (d.measures) setChordData(d.measures)
        if (d.key)      setChordKey(d.key)
      })
      .catch(() => {})
      .finally(() => setChordLoading(false))
  }, [xmlFile])

  // ── Inject / remove harmonic backgrounds in the OSMD SVG ──────────
  // Inserts coloured <rect> elements as the very first child of the OSMD SVG
  // so they appear behind all note heads, stems, and barlines.
  // Each measure gets:
  //   • a light fill covering the full system height (treble + bass staves)
  //   • a thin solid strip at the bottom edge as a clean function indicator
  useEffect(() => {
    const svgEl = containerRef.current?.querySelector('svg')
    if (!svgEl) return

    // Always clean up first
    svgEl.querySelector('#vv-harmonic-bg')?.remove()

    if (view !== 'harmonic' || status !== 'ready' || !chordData.length || !measurePos.length) return

    const ns = 'http://www.w3.org/2000/svg'
    const g  = document.createElementNS(ns, 'g')
    g.id     = 'vv-harmonic-bg'

    measurePos.forEach(mp => {
      const cm = chordData[mp.seqIdx]
      if (!cm) return
      const fn = cm.function

      // ① Light background fill — tints the full measure column
      const bg = document.createElementNS(ns, 'rect')
      bg.setAttribute('x',      String(mp.x))
      bg.setAttribute('y',      String(mp.y))
      bg.setAttribute('width',  String(mp.w))
      bg.setAttribute('height', String(mp.h))
      bg.setAttribute('fill',   FN_COLOR[fn] ?? 'transparent')
      g.appendChild(bg)

      // ② Solid indicator strip at the bottom edge
      // Coordinates are already × 10, so 15 SVG units ≈ 1.5 engraving units ≈ 1.5 mm
      const strip = document.createElementNS(ns, 'rect')
      strip.setAttribute('x',      String(mp.x))
      strip.setAttribute('y',      String(mp.y + mp.h - 15))
      strip.setAttribute('width',  String(mp.w))
      strip.setAttribute('height', '15')
      strip.setAttribute('fill',   FN_SOLID[fn] ?? '#666')
      strip.setAttribute('opacity', '0.8')
      g.appendChild(strip)
    })

    // insertBefore firstChild → rendered behind everything else in the SVG
    svgEl.insertBefore(g, svgEl.firstChild)
  }, [view, status, chordData, measurePos])

  // ── OSMD render ────────────────────────────────────────────────────
  const renderOsmd = useCallback(async (
    xmlText: string,
    minMeasure: number,
    maxMeasure: number,
  ) => {
    if (!containerRef.current) return

    // Tear down previous instance
    if (osmdRef.current) {
      try { (osmdRef.current as any).clear?.() } catch {}
      osmdRef.current = null
    }
    containerRef.current.innerHTML = ''

    // Make container visible BEFORE render so OSMD can measure clientWidth
    setStatus('rendering')
    await new Promise<void>(resolve => {
      let c = 0
      const tick = () => { if (++c >= 2) resolve(); else requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    })
    if (!containerRef.current) return

    const osmd = new OpenSheetMusicDisplay(containerRef.current, {
      autoResize: false, backend: 'svg',
      drawingParameters: 'default',
      colorStemsLikeNoteheads: false,
      disableCursor: true,
      // Suppress title / composer — shown via the file selector above instead.
      drawTitle:    false,
      drawSubtitle: false,
      drawComposer: false,
      drawLyricist: false,
    })
    osmd.zoom = 0.7

    try {
      await osmd.load(xmlText)

      // Apply section measure filter.
      //
      // OSMD has two ways to specify the draw range:
      //   • MaxMeasureToDrawNumber / MinMeasureToDrawNumber  (1-based "number" variants)
      //   • MaxMeasureToDrawIndex  / MinMeasureToDrawIndex   (0-based array index variants)
      //
      // render() only overwrites MaxMeasureToDrawIndex from MaxMeasureToDrawNumber when the
      // first SourceMeasure is an ImplicitMeasure (pickup bar).  For pieces that start on a
      // downbeat (no pickup), ImplicitMeasure=false and MaxMeasureToDrawIndex is NEVER updated,
      // so it stays at the default Number.MAX_VALUE and all measures are drawn.
      //
      // Fix: always set MaxMeasureToDrawIndex directly as well, so section filtering works
      // regardless of whether the piece has a pickup bar.
      // MinMeasureToDrawIndex is always safe to set directly (its Number variant defaults to 0,
      // condition > 1 is false, so it is never overwritten by render()).
      const rules = (osmd as any).EngravingRules ?? (osmd as any).rules
      if (rules) {
        const hi = maxMeasure >= 9999 ? Number.MAX_VALUE : maxMeasure - 1
        rules.MinMeasureToDrawIndex  = minMeasure
        rules.MaxMeasureToDrawIndex  = hi   // set directly — works for pieces without pickup
        rules.MaxMeasureToDrawNumber = hi   // also set Number variant — for pieces WITH pickup
      }

      await osmd.render()
    } catch (e) {
      setStatus('error'); setErrMsg(String(e)); return
    }

    osmdRef.current = osmd

    // ── Extract measure bounding boxes (all staves) ───────────────
    // Covers the full piano system (treble + bass) by spanning from the top of
    // the first staff to the bottom of the last staff in each measure column.
    try {
      const gSheet = (osmd as any).GraphicSheet
      const posList: MeasurePos[] = []
      if (gSheet?.MeasureList) {
        ;(gSheet.MeasureList as any[][]).forEach((staffMeasures, i) => {
          if (i < minMeasure) return
          if (maxMeasure < 9999 && i >= maxMeasure) return
          if (!staffMeasures?.length) return

          // Collect all staves with valid position data
          const valid = staffMeasures.filter(
            m => m?.PositionAndShape?.AbsolutePosition && m?.PositionAndShape?.Size?.width > 0
          )
          if (!valid.length) return

          const first = valid[0].PositionAndShape
          const last  = valid[valid.length - 1].PositionAndShape

          // OSMD renders SVG positions as AbsolutePosition * unitInPixels (= 10).
          // The SVG viewBox is set to container_px / zoom, so multiplying by 10
          // puts our rects in the same coordinate space as the OSMD content.
          const U = 10
          const x = first.AbsolutePosition.x * U
          const y = first.AbsolutePosition.y * U
          const w = first.Size.width * U
          // Height: top of first staff → bottom of last staff (covers full piano system)
          const h = (last.AbsolutePosition.y + last.Size.height - first.AbsolutePosition.y) * U

          if (w <= 0 || h <= 0) return
          posList.push({ x, y, w, h, seqIdx: i })
        })
      }
      setMeasurePos(posList)
    } catch (_) {
      // Silently ignore — harmonic overlay just won't show
    }

    setStatus('ready')
  }, [])

  // ── Fetch XML + render on file or section change ───────────────────
  useEffect(() => {
    if (!xmlFile) return
    const min = activeSection?.start_idx ?? 0
    const max = activeSection?.end_idx   ?? 9999

    setStatus('fetching')

    if (xmlCacheRef.current) {
      renderOsmd(xmlCacheRef.current, min, max)
      return
    }

    fetch(`${API_BASE}/musicvis/xml/${encodeURIComponent(xmlFile)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
      .then(xml => {
        xmlCacheRef.current = xml
        renderOsmd(xml, min, max)
      })
      .catch(e => { setStatus('error'); setErrMsg(String(e)) })
  }, [xmlFile, activeSection, renderOsmd, view])

  const containerVisible = status === 'rendering' || status === 'ready'

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '10px 14px', fontFamily: theme.fontFamily, height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>

      {/* ── Top bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: theme.labelColor }}>
           {t('和声指纹', 'Harmonic Fingerprint')}
        </span>
        <span style={{ fontSize: 9, color: theme.labelSecondaryColor, fontStyle: 'italic' }}>
          Miller et al., CGF 2022
        </span>

        <span style={{ fontSize: 10, color: theme.labelSecondaryColor, marginLeft: 'auto', fontStyle: 'italic' }}>
          {xmlFile}
        </span>
      </div>

      {/* ── Key + loading indicator ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {chordKey && (
          <span style={{ fontSize: 9, color: theme.labelSecondaryColor }}>
            {t('调性', 'Key')}: <strong>{chordKey}</strong>
          </span>
        )}
        {chordLoading && (
          <span style={{ fontSize: 9, color: theme.labelSecondaryColor, fontStyle: 'italic' }}>
            {t('⏳ 分析和弦…', '⏳ Analysing chords…')}
          </span>
        )}
      </div>

      {/* ── Section pills ── */}
      {sections.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
          <button
            onClick={() => setActiveSection(null)}
            style={{
              padding: '3px 11px', borderRadius: 20, border: 'none',
              cursor: 'pointer', fontSize: 10, fontWeight: 600,
              background: activeSection === null ? '#6366f1' : theme.surface,
              color:      activeSection === null ? '#fff'    : theme.labelColor,
            }}
          >
            {t('全部', 'All')}
          </button>
          {sections.map(sec => {
            const isActive = activeSection?.label === sec.label
            const accent =
              sec.label.toLowerCase().startsWith('tema') ||
              sec.label.toLowerCase().startsWith('theme') ? '#10b981' :
              sec.label.toLowerCase().startsWith('coda')  ? '#f59e0b' : '#6366f1'
            return (
              <button key={sec.label}
                onClick={() => setActiveSection(isActive ? null : sec)}
                style={{
                  padding: '3px 11px', borderRadius: 20, border: 'none',
                  cursor: 'pointer', fontSize: 10, fontWeight: 600,
                  background: isActive ? accent : theme.surface,
                  color:      isActive ? '#fff'  : theme.labelColor,
                  transition: 'background 0.15s',
                }}
                title={`m.${sec.start_idx}–${sec.end_idx - 1}`}
              >
                {sec.label === 'Tema' ? t('主题', 'Theme') : sec.label}
              </button>
            )
          })}
        </div>
      )}

      {/* ── Harmonic stats chart (harmonic view only, theme+variation sections only) ── */}
      {view === 'harmonic' && !chordLoading && chordData.length > 0 &&
       sections.some(s => { const l = s.label.toLowerCase(); return l.startsWith('tema') || l.startsWith('theme') || l.startsWith('var') }) && (
        <HarmonicStatsChart
          sections={sections}
          activeSection={activeSection}
          chordData={chordData}
          theme={theme}
          lang={lang}
        />
      )}

      {/* ── Status messages ── */}
      {status === 'fetching' && (
        <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 11, color: theme.labelSecondaryColor }}>
          {t('⏳ 获取乐谱…', '⏳ Fetching score…')}
        </div>
      )}
      {status === 'rendering' && (
        <div style={{ marginBottom: 6, textAlign: 'center', fontSize: 11, color: theme.labelSecondaryColor }}>
          {t(' 渲染中…', ' Rendering…')}
        </div>
      )}
      {status === 'error' && (
        <div style={{ fontSize: 11, color: '#ef4444', padding: '8px 0' }}>
          {t('无法加载乐谱：', 'Could not load score: ')}{errMsg}
        </div>
      )}

      {/* ── Score area ── */}
      <div
        ref={containerRef}
        style={{
          display:      containerVisible ? 'flex' : 'none',
          flex:         1,
          minHeight:    0,
          border:       `1px solid ${theme.borderColor}`,
          borderRadius: 8,
          background:   '#ffffff',
          overflow:     'auto',
          padding:      '8px',
          boxSizing:    'border-box',
        }}
      />

      {/* ── Colour legend (harmonic view) ── */}
      {view === 'harmonic' && containerVisible && (
        <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
          {(['T', 'S', 'D', 'O'] as const).map(fn => (
            <span key={fn} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}>
              <span style={{
                display: 'inline-block', width: 12, height: 12,
                borderRadius: 2, background: FN_SOLID[fn],
              }} />
              <span style={{ color: theme.labelSecondaryColor }}>
                {fn} –{' '}
                {fn === 'T' ? t('主功能', 'Tonic') :
                 fn === 'S' ? t('下属功能', 'Subdominant') :
                 fn === 'D' ? t('属功能', 'Dominant') :
                              t('其他', 'Other')}
              </span>
            </span>
          ))}
        </div>
      )}


    </div>
  )
}
