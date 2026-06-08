/**
 * SymbolicHeatmap.tsx  —  33-feature Feature Comparison Matrix
 *
 * Layout (top → bottom, no overlap)
 *   1. Header + legend
 *   2. Tooltip area (240 px fixed)
 *        left  ~185 px  ← feature description panel
 *        right  flex-1  ← FeatureDistChart (width measured via ResizeObserver)
 *   3. Heatmap table (fills container width, no horizontal scroll)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '@/api/pieceApi'

// ── Types ──────────────────────────────────────────────────────────────────

type ChartType = 'ratio' | 'entropy' | 'continuous' | 'count' | 'signed'
type Cat       = 'P' | 'M' | 'R' | 'T'

interface FeatureDef {
  key:        string
  label_zh:   string
  label_en:   string
  cat:        Cat
  chart_type: ChartType
}
interface SegmentData {
  label: string; n_notes: number; features: Record<string, number>
}
interface SymbolicResponse {
  matched: boolean; file_name: string; midi_name?: string
  segments: SegmentData[]; feature_defs: FeatureDef[]
  message?: string
}
interface Props { fileName: string; musicName?: string }

// ── Constants ──────────────────────────────────────────────────────────────

const CAT_COLORS: Record<Cat, string> = {
  P: '#6366f1', M: '#0ea5e9', R: '#10b981', T: '#f59e0b',
}
const CAT_LABEL: Record<Cat, string> = {
  P: 'Pitch', M: 'Melodic', R: 'Rhythmic', T: 'Texture',
}

/** One-line English description for every feature */
const FEAT_DESC: Record<string, string> = {
  pitch_range:               'Semitone span from lowest to highest note; reflects keyboard range used.',
  mean_pitch:                'Average MIDI pitch number; indicates the registral centre of gravity.',
  pitch_std:                 'Spread of pitch values; high = wide leaps, low = confined to a narrow band.',
  pitch_variety:             'Number of distinct pitch classes used (max 12); high = rich modal colour.',
  most_common_pc_prevalence: 'Fraction of notes on the most frequent pitch class; high = strong tonal centre.',
  pitch_class_entropy:       'Evenness of the 12-pc distribution (normalised entropy); high ≈ atonal.',
  bass_register_ratio:       'Fraction of notes below MIDI 48 (C3); high = active bass voice.',
  high_register_ratio:       'Fraction of notes above MIDI 72 (C5); high = melody pushed into treble.',
  most_common_pc:            'Most frequent pitch class (0=C … 11=B). Usually constant across variations.',
  tonal_clarity:             'Max Pearson correlation with 24 major/minor templates; high = clear key.',
  chromatic_density:         'Distinct pitch classes used ÷ 12; near 1 = chromatic saturation.',
  interval_class_variety:    'Number of distinct interval classes (IC 0–6) present.',
  mean_melodic_interval:     'Mean absolute interval between consecutive notes (semitones); high = leaping.',
  repeated_notes_ratio:      'Fraction of zero-semitone intervals; high = drumming or chanting style.',
  stepwise_ratio:            'Fraction of intervals ≤ 2 semitones; high = smooth stepwise melody.',
  chromatic_ratio:           'Fraction of semitone (1 st) intervals; high = chromatic expressive style.',
  leap_ratio:                'Fraction of intervals > 4 semitones; high = wide melodic contour.',
  large_leap_ratio:          'Fraction of intervals > 7 semitones (beyond a perfect fifth); high = dramatic leaps.',
  direction_of_motion:       '(ascending − descending intervals) / total; positive = overall upward trend.',
  arpeggiation_ratio:        'Fraction of third/fifth intervals; high = arpeggiated or broken-chord texture.',
  melodic_interval_variety:  'Number of distinct interval sizes used; high = diverse melodic vocabulary.',
  interval_entropy:          'Evenness of interval distribution; high = no fixed pattern, low = repetitive.',
  note_density:              'Notes per second; directly reflects the tempo and texture density.',
  mean_note_duration:        'Average note duration (s); short = fast runs, long = sustained singing style.',
  duration_variability:      'Coefficient of variation (std/mean) of durations; high = mixed note lengths.',
  short_note_ratio:          'Fraction of notes shorter than 0.5× median duration; high = ornaments or runs.',
  long_note_ratio:           'Fraction of notes longer than 2× median duration; high = held or pedal tones.',
  rest_ratio:                'Fraction of segment duration with no note sounding; high = sparse, breathing.',
  rhythmic_value_variety:    'Number of distinct duration bins (0.04 s per bin); high = rhythmically layered.',
  duration_entropy:          'Evenness of duration distribution; low = fixed pattern, high = free mixture.',
  max_simultaneous_notes:    'Peak simultaneous note count; reflects maximum chord thickness (voice count).',
  mean_simultaneous_notes:   'Time-weighted average polyphony; > 1 indicates sustained chordal texture.',
  chord_onset_ratio:         'Fraction of onsets with multiple notes within 50 ms; high = chord-dominated.',
}

// ── Helpers ────────────────────────────────────────────────────────────────

function dispLabel(label: string): string {
  if (label === 'Theme' || label === 'T') return 'T'
  if (label === 'C' || label.toLowerCase() === 'coda') return 'C'
  const m1 = label.match(/^Var[.\s]+(\d+)$/i)
  if (m1) return `V${parseInt(m1[1], 10)}`
  const m2 = label.match(/^[Vv](\d+)$/)
  if (m2) return `V${parseInt(m2[1], 10)}`
  return label
}

function deltaColor(z: number, isTheme: boolean): string {
  if (isTheme) return 'hsl(0,0%,82%)'
  const t = Math.max(-3, Math.min(3, z)) / 3
  if (t < 0) {
    const a = -t
    return `rgb(${Math.round(255*(1-a*.82))},${Math.round(255*(1-a*.68))},255)`
  }
  const a = t
  return `rgb(255,${Math.round(255*(1-a*.82))},${Math.round(255*(1-a*.82))})`
}

function zScore(vals: number[]): number[] {
  const n = vals.length
  const m = vals.reduce((s, v) => s + v, 0) / n
  const s = Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / n)
  return vals.map(v => s < 1e-9 ? 0 : (v - m) / s)
}

// ── Description panel ──────────────────────────────────────────────────────

function DescPanel({ def }: { def: FeatureDef }) {
  const c = CAT_COLORS[def.cat]
  return (
    <div style={{
      width: 188, minWidth: 188, padding: '4px 4px',
      borderRight: '1px solid #f0f0f0',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: c + '18', border: `1px solid ${c}44`,
        borderRadius: 6, padding: '2px 8px', alignSelf: 'flex-start',
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: c }}>{def.cat}</span>
        <span style={{ fontSize: 10, color: c + 'cc' }}>{CAT_LABEL[def.cat]}</span>
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', lineHeight: 1.3 }}>
          {def.label_en}
        </div>
      </div>
      <div style={{ height: 1, background: '#f1f5f9' }} />
      <div style={{ fontSize: 11, color: '#475569', lineHeight: 1.6, flex: 1 }}>
        {FEAT_DESC[def.key] ?? '—'}
      </div>
    </div>
  )
}

// ── FeatureDistChart ───────────────────────────────────────────────────────

interface ChartProps {
  def:         FeatureDef
  rawValues:   number[]
  rowLabels:   string[]
  hoveredIdx:  number | null
  svgWidth:    number
}

function FeatureDistChart({ def, rawValues, rowLabels, hoveredIdx, svgWidth }: ChartProps) {
  const { cat, chart_type: ct } = def
  const cc = CAT_COLORS[cat]
  const n  = rawValues.length

  const mean   = rawValues.reduce((s, v) => s + v, 0) / n
  const std    = Math.sqrt(rawValues.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
  const median = [...rawValues].sort((a, b) => a - b)[Math.floor(n / 2)]

  const [yMin, yMax] = (() => {
    if (ct === 'signed') {
      const mx = Math.max(Math.abs(Math.min(...rawValues)), Math.abs(Math.max(...rawValues)), 0.05)
      return [-mx * 1.2, mx * 1.2]
    }
    if (ct === 'ratio' || ct === 'entropy') return [0, 1]
    return [0, Math.max(...rawValues) * 1.18 || 1]
  })()

  const W = svgWidth, H = 118
  const pL = 40, pR = 10, pT = 14, pB = 20
  const cW = W - pL - pR, cH = H - pT - pB
  const xS = cW / n
  const bW = Math.max(8, xS * 0.7)

  const yS = (v: number) => pT + cH * (1 - Math.max(0, Math.min(1, (v - yMin) / (yMax - yMin))))
  const xC = (i: number) => pL + (i + 0.5) * xS
  const z0 = yS(0)

  const yTicks = ct === 'signed'
    ? [yMin, 0, yMax]
    : ct === 'ratio' || ct === 'entropy' ? [0, 0.5, 1]
    : [0, yMax / 2, yMax]

  const refLine =
    ct === 'ratio'      ? { y: yS(median), color: '#f59e0b', txt: `med ${median < 1 ? median.toFixed(2) : median.toFixed(1)}` }
    : ct === 'entropy'  ? { y: yS(mean),   color: '#14b8a6', txt: `avg ${mean.toFixed(2)}` }
    : ct === 'continuous' ? { y: yS(mean), color: cc,        txt: `avg ${mean < 1 ? mean.toFixed(2) : mean.toFixed(1)}` }
    : null

  const fmt = (v: number) => ct === 'count' ? Math.round(v).toString() : Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1)

  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      <rect x={pL} y={pT} width={cW} height={cH} fill="#f8fafc" rx={2} />
      {ct === 'continuous' && std > 0 && (() => {
        const y1 = Math.max(pT, yS(mean + std))
        const y2 = Math.min(pT + cH, yS(mean - std))
        return <rect x={pL} y={y1} width={cW} height={Math.max(0, y2 - y1)} fill={cc + '18'} />
      })()}
      {ct === 'signed' && <line x1={pL} y1={z0} x2={pL+cW} y2={z0} stroke="#94a3b8" strokeWidth={1.5} />}
      {refLine && <>
        <line x1={pL} y1={refLine.y} x2={pL+cW} y2={refLine.y}
          stroke={refLine.color} strokeWidth={1.5} strokeDasharray="5,3" />
        <text x={pL+cW+3} y={refLine.y+4} fontSize={8} fill={refLine.color}>{refLine.txt}</text>
      </>}
      {rawValues.map((val, i) => {
        const hov  = i === hoveredIdx
        const fill = hov ? cc : cc + '55'
        const x    = xC(i)
        const top  = ct === 'signed' ? Math.min(z0, yS(val)) : yS(val)
        const bot  = ct === 'signed' ? Math.max(z0, yS(val)) : pT + cH
        const barH = Math.max(2, bot - top)
        const barFill = ct === 'signed' && val < 0 ? cc + '88' : fill
        const labelV = (ct === 'signed' && val < 0) ? bot + 11 : top - 5
        return (
          <g key={i}>
            <rect x={x - bW/2} y={top} width={bW} height={barH} fill={barFill} rx={2} />
            {hov && <text x={x} y={labelV} textAnchor="middle" fontSize={10} fill={cc} fontWeight={700}>{fmt(val)}</text>}
          </g>
        )
      })}
      <line x1={pL} y1={pT} x2={pL} y2={pT+cH} stroke="#e2e8f0" />
      {yTicks.map((v, ti) => (
        <g key={ti}>
          <line x1={pL-3} y1={yS(v)} x2={pL} y2={yS(v)} stroke="#e2e8f0" />
          <text x={pL-5} y={yS(v)+3.5} textAnchor="end" fontSize={8} fill="#94a3b8">
            {Math.abs(v) < 1 && v !== 0 ? v.toFixed(2) : v.toFixed(1)}
          </text>
        </g>
      ))}
      {rowLabels.map((lbl, i) => (
        <text key={i} x={xC(i)} y={pT + cH + 16} textAnchor="middle" fontSize={9}
          fill={i === hoveredIdx ? '#1e293b' : '#94a3b8'}
          fontWeight={i === hoveredIdx ? 700 : 400}>
          {lbl}
        </text>
      ))}
    </svg>
  )
}

// ── Placeholder ────────────────────────────────────────────────────────────

function Placeholder() {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color:'#cbd5e1', fontSize:13, gap:8, userSelect:'none' }}>
      <svg width={18} height={18} viewBox="0 0 20 20" fill="none">
        <rect x={1} y={12} width={3} height={7} rx={1} fill="#e2e8f0"/>
        <rect x={6} y={7} width={3} height={12} rx={1} fill="#e2e8f0"/>
        <rect x={11} y={3} width={3} height={16} rx={1} fill="#e2e8f0"/>
        <rect x={16} y={9} width={3} height={10} rx={1} fill="#e2e8f0"/>
      </svg>
      Hover column headers to view distributions · Click row labels to view variation profiles
    </div>
  )
}

// ── VariationProfilePanel ───────────────────────────────────────────────────

interface ProfilePanelProps {
  seg:      SegmentData
  deltaRow: number[]
  rawRow:   number[]
  defs:     FeatureDef[]
  isTheme:  boolean
  onClose:  () => void
  width:    number
}

function VariationProfilePanel({ seg, deltaRow, defs, isTheme, onClose, width }: ProfilePanelProps) {
  const items = defs
    .map((d, i) => ({ def: d, delta: deltaRow[i] }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  const CAP   = 3
  const ROW_H = 14
  const LABEL_W  = 126
  const VAL_W    = 38
  const BAR_AREA = Math.max(80, width - 16 - LABEL_W - VAL_W - 8)
  const BAR_HALF = BAR_AREA / 2
  const SCALE    = BAR_HALF / CAP
  const SVG_H    = items.length * ROW_H + 6

  const fmt = (v: number) => Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1)

  return (
    <div style={{
      background: '#fff', borderRadius: 8,
      border: '1px solid #e2e8f0',
      boxShadow: '0 1px 6px rgba(0,0,0,.04)',
      marginBottom: 6, overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '5px 10px', borderBottom: '1px solid #f0f0f0', background: '#f8fafc',
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 8 }}>
          {isTheme ? 'Theme — Baseline' : `${dispLabel(seg.label)} — Feature Profile`}
          {isTheme && (
            <span style={{ fontSize: 10, fontWeight: 400, color: '#94a3b8' }}>
              All Δ = 0 — heatmap baseline row
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {(Object.keys(CAT_COLORS) as Cat[]).map(cat => (
            <span key={cat} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#64748b' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: CAT_COLORS[cat], display: 'inline-block' }} />
              {CAT_LABEL[cat]}
            </span>
          ))}
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 16, lineHeight: 1, padding: '0 4px', marginLeft: 4 }}
          >×</button>
        </div>
      </div>
      <div style={{ overflowY: 'auto', maxHeight: 200 }}>
        <svg width={width - 16} height={SVG_H} style={{ display: 'block', margin: '2px 8px' }}>
          <text x={LABEL_W + 2} y={10} fontSize={8} fill="#cbd5e1" textAnchor="start">−3σ</text>
          <text x={LABEL_W + BAR_AREA - 2} y={10} fontSize={8} fill="#cbd5e1" textAnchor="end">+3σ</text>
          <line x1={LABEL_W + BAR_HALF} y1={0} x2={LABEL_W + BAR_HALF} y2={SVG_H}
            stroke="#e2e8f0" strokeWidth={1} />
          {items.map((item, i) => {
            const cc  = CAT_COLORS[item.def.cat]
            const bW  = Math.min(BAR_HALF, Math.abs(item.delta) * SCALE)
            const bX  = item.delta >= 0 ? LABEL_W + BAR_HALF : LABEL_W + BAR_HALF - bW
            const y   = i * ROW_H + 4
            const mid = y + ROW_H / 2
            const prominent = Math.abs(item.delta) > 1.5
            return (
              <g key={item.def.key}>
                <circle cx={5} cy={mid} r={3} fill={cc} />
                <text x={13} y={mid + 3.5} fontSize={9} fill={prominent ? '#1e293b' : '#64748b'}
                  fontWeight={prominent ? 600 : 400}>
                  {item.def.label_en}
                </text>
                {bW > 0.5 && (
                  <rect x={bX} y={y + 2} width={bW} height={ROW_H - 5}
                    fill={cc + (prominent ? 'bb' : '66')} rx={1.5} />
                )}
                <text
                  x={LABEL_W + BAR_AREA + 4} y={mid + 3.5}
                  fontSize={9}
                  fill={prominent ? cc : '#94a3b8'}
                  fontWeight={prominent ? 700 : 400}
                >
                  {item.delta > 0 ? '+' : ''}{fmt(item.delta)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────

export function SymbolicHeatmap({ fileName, musicName }: Props) {
  const [data,        setData]        = useState<SymbolicResponse | null>(null)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [sortCol,     setSortCol]     = useState<string | null>(null)
  const [hovRow,      setHovRow]      = useState<number | null>(null)
  const [hovCol,      setHovCol]      = useState<string | null>(null)
  const [catFilter,   setCatFilter]   = useState<'All' | Cat>('All')
  const [selectedRow, setSelectedRow] = useState<number | null>(null)

  const [chartPanelW, setChartPanelW] = useState(0)
  const _chartRo = useRef<ResizeObserver | null>(null)
  const chartPanelRef = useCallback((el: HTMLDivElement | null) => {
    _chartRo.current?.disconnect()
    _chartRo.current = null
    if (!el) return
    const ro = new ResizeObserver(es => setChartPanelW(es[0]?.contentRect.width ?? 660))
    ro.observe(el)
    _chartRo.current = ro
  }, [])

  const [containerW, setContainerW] = useState(900)
  const _contRo = useRef<ResizeObserver | null>(null)
  const containerRef = useCallback((el: HTMLDivElement | null) => {
    _contRo.current?.disconnect()
    _contRo.current = null
    if (!el) return
    const ro = new ResizeObserver(es => setContainerW(es[0]?.contentRect.width ?? 900))
    ro.observe(el)
    _contRo.current = ro
  }, [])

  useEffect(() => {
    if (!fileName) return
    setLoading(true); setError(null); setData(null)
    fetch(`${API_BASE}/symbolic/${fileName}`)
      .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e.detail ?? r.statusText) }))
      .then(midi => { setData(midi as SymbolicResponse); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [fileName])

  const derived = useMemo(() => {
    if (!data) return null
    const { feature_defs: defs, segments } = data
    const labels = segments.map(s => s.label)
    const nR = segments.length, nC = defs.length
    const rawMat: number[][] = segments.map(s => defs.map(d => s.features[d.key] ?? 0))
    const themeIdx = segments.findIndex(s => s.label === 'Theme' || s.label === 'T')
    const zMat: number[][] = Array.from({length: nR}, () => new Array(nC).fill(0))
    for (let c = 0; c < nC; c++) {
      const zc = zScore(rawMat.map(r => r[c]))
      for (let r = 0; r < nR; r++) zMat[r][c] = zc[r]
    }
    const thZ = themeIdx >= 0 ? zMat[themeIdx] : new Array(nC).fill(0)
    const deltaMat: number[][] = zMat.map((row, ri) =>
      ri === themeIdx ? new Array(nC).fill(0) : row.map((z, ci) => z - thZ[ci])
    )
    const catGroups: {cat: string; count: number}[] = []
    defs.forEach(d => {
      const last = catGroups[catGroups.length-1]
      if (!last || last.cat !== d.cat) catGroups.push({cat:d.cat,count:1}); else last.count++
    })
    return { defs, segments, labels, rawMat, deltaMat, themeIdx, catGroups }
  }, [data])

  const rowOrder = useMemo(() => {
    if (!derived) return []
    const base = derived.segments.map((_, i) => i)
    if (!sortCol) return base
    const ci = derived.defs.findIndex(d => d.key === sortCol)
    return ci < 0 ? base : [...base].sort((a,b) => derived.deltaMat[a][ci] - derived.deltaMat[b][ci])
  }, [derived, sortCol])

  const tooltip = useMemo(() => {
    if (!derived || !hovCol) return null
    const visibleKeys = catFilter === 'All' ? derived.defs.map(d => d.key) : derived.defs.filter(d => d.cat === catFilter).map(d => d.key)
    if (!visibleKeys.includes(hovCol)) return null
    const ci = derived.defs.findIndex(d => d.key === hovCol)
    if (ci < 0) return null
    const def = derived.defs[ci]
    return {
      def,
      rawValues:  rowOrder.map(ri => derived.rawMat[ri][ci]),
      rowLabels:  rowOrder.map(ri => dispLabel(derived.labels[ri])),
      hoveredIdx: hovRow !== null ? rowOrder.indexOf(hovRow) : null,
    }
  }, [derived, hovCol, rowOrder, hovRow, catFilter])

  const profilePanel = useMemo(() => {
    if (!derived || selectedRow === null) return null
    return {
      seg:      derived.segments[selectedRow],
      deltaRow: derived.deltaMat[selectedRow],
      rawRow:   derived.rawMat[selectedRow],
      isTheme:  selectedRow === derived.themeIdx,
    }
  }, [derived, selectedRow])

  if (!fileName) return <div style={{padding:40,color:'#94a3b8'}}>Select a piece to view the heatmap.</div>
  if (loading)   return (
    <div style={{padding:40,display:'flex',alignItems:'center',gap:10,color:'#94a3b8'}}>
      <div style={{width:18,height:18,border:'2px solid #e2e8f0',borderTopColor:'#6366f1',borderRadius:'50%',animation:'spin .8s linear infinite'}}/>
      Extracting symbolic features…
    </div>
  )
  if (error) return (
    <div style={{padding:40}}>
      <div style={{color:'#e63946',fontWeight:600}}>Extraction failed</div>
      <div style={{fontSize:13,color:'#64748b',marginTop:6}}>{error}</div>
    </div>
  )
  if (!derived) return null

  if (derived.segments.length === 0) return (
    <div style={{padding:40,textAlign:'center'}}>
      <div style={{fontSize:13,color:'#94a3b8',lineHeight:1.7}}>
        <div style={{fontSize:16,marginBottom:6}}>📄</div>
        <div style={{fontWeight:600,color:'#64748b',marginBottom:4}}>No segment data</div>
        <div style={{fontSize:11}}>
          {data?.message ?? 'No rehearsal marks found in the MusicXML — automatic segmentation unavailable.'}
        </div>
      </div>
    </div>
  )

  const { defs, segments, deltaMat, rawMat, themeIdx } = derived

  const visibleDefs = catFilter === 'All' ? defs : defs.filter(d => d.cat === catFilter)
  const visibleCatGroups: {cat: string; count: number}[] = []
  visibleDefs.forEach(d => {
    const last = visibleCatGroups[visibleCatGroups.length - 1]
    if (!last || last.cat !== d.cat) visibleCatGroups.push({cat: d.cat, count: 1}); else last.count++
  })

  const ROW_LBL = 40
  const CELL_H  = 16
  const COL_H   = 40
  const showColTitles = catFilter !== 'All'

  return (
    <div ref={containerRef} style={{padding:'6px 10px 8px',fontFamily:'Inter,sans-serif',display:'flex',flexDirection:'column',height:'auto',boxSizing:'border-box',width:'100%'}}>

      <div style={{marginBottom:4}}>
        <div style={{fontSize:15,fontWeight:700,color:'#1e293b'}}>Feature Comparison Heatmap — {musicName ?? fileName}</div>
        <div style={{fontSize:11,color:'#94a3b8',marginTop:3}}>
          33 symbolic features · colour = z-score deviation of each variation from theme · click column to sort
        </div>
      </div>

      <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:4,flexWrap:'wrap'}}>
        <button
          onClick={() => { setCatFilter('All'); setSortCol(null) }}
          style={{
            fontSize:11,padding:'2px 9px',borderRadius:4,border:'none',cursor:'pointer',fontWeight:600,
            background: catFilter === 'All' ? '#334155' : '#f1f5f9',
            color:      catFilter === 'All' ? '#fff'    : '#64748b',
          }}
        >All</button>
        {(Object.keys(CAT_COLORS) as Cat[]).map(cat => (
          <button key={cat}
            onClick={() => { setCatFilter(catFilter === cat ? 'All' : cat); setSortCol(null) }}
            style={{
              fontSize:11,padding:'2px 9px',borderRadius:4,border:'none',cursor:'pointer',fontWeight:700,
              background: catFilter === cat ? CAT_COLORS[cat] : CAT_COLORS[cat]+'22',
              color:      catFilter === cat ? '#fff'          : CAT_COLORS[cat],
            }}
          >
            {cat} <span style={{fontWeight:400,fontSize:10}}>{CAT_LABEL[cat]}</span>
          </button>
        ))}
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:5,fontSize:10,color:'#94a3b8'}}>
          <div style={{width:56,height:7,background:'linear-gradient(to right,rgb(51,110,255),white,rgb(255,60,60))',borderRadius:3}}/>
          below → above
        </div>
      </div>

      {profilePanel && (
        <VariationProfilePanel
          seg={profilePanel.seg}
          deltaRow={profilePanel.deltaRow}
          rawRow={profilePanel.rawRow}
          defs={defs}
          isTheme={profilePanel.isTheme}
          onClose={() => setSelectedRow(null)}
          width={containerW - 20}
        />
      )}

      <div style={{
        height:130,minHeight:130,flexShrink:0,
        background:'#fff',borderRadius:8,
        border:'1px solid #e2e8f0',
        boxShadow:'0 1px 6px rgba(0,0,0,.04)',
        marginBottom:6,overflow:'hidden',
        display:'flex',
      }}>
        {tooltip
          ? <>
              <DescPanel def={tooltip.def} />
              <div ref={chartPanelRef}
                style={{flex:1,padding:'4px 4px',overflow:'hidden',display:'flex',alignItems:'flex-start'}}>
                {chartPanelW > 0 && (
                  <FeatureDistChart
                    def={tooltip.def}
                    rawValues={tooltip.rawValues}
                    rowLabels={tooltip.rowLabels}
                    hoveredIdx={tooltip.hoveredIdx}
                    svgWidth={Math.max(100, chartPanelW - 20)}
                  />
                )}
              </div>
            </>
          : <Placeholder />
        }
      </div>

      <div style={{flex:'0 0 auto',overflow:'hidden'}}>
        <table style={{borderCollapse:'collapse',tableLayout:'fixed',width:'100%'}}>
          <colgroup>
            <col style={{width:ROW_LBL}}/>
            {visibleDefs.map(d => <col key={d.key}/>)}
          </colgroup>
          <thead>
            <tr>
              <th style={{height:14}}/>
              {visibleCatGroups.map(g => (
                <th key={g.cat} colSpan={g.count} style={{
                  background: CAT_COLORS[g.cat as Cat]+'1a',
                  color: CAT_COLORS[g.cat as Cat],
                  fontSize:10,fontWeight:700,textAlign:'center',
                  borderBottom:`2px solid ${CAT_COLORS[g.cat as Cat]}`,
                  padding:'2px 0',letterSpacing:.6,
                }}>
                  {catFilter === 'All' ? `${g.cat} · ${CAT_LABEL[g.cat as Cat]}` : CAT_LABEL[g.cat as Cat]}
                </th>
              ))}
            </tr>
            {showColTitles && (
              <tr>
                <th style={{width:ROW_LBL,height:COL_H,position:'sticky',left:0,background:'#f8fafc',zIndex:2}}/>
                {visibleDefs.map((d, ci) => {
                  const prevCat  = ci > 0 ? visibleDefs[ci-1].cat : null
                  const isSorted = sortCol === d.key
                  const isHov    = hovCol === d.key
                  const bL       = prevCat !== d.cat ? `2px solid ${CAT_COLORS[d.cat]}44` : '1px solid #f0f0f0'
                  return (
                    <th key={d.key}
                      onClick={() => setSortCol(isSorted ? null : d.key)}
                      onMouseEnter={() => setHovCol(d.key)}
                      onMouseLeave={() => setHovCol(null)}
                      title={`${d.label_en}\n${d.label_zh}\n${FEAT_DESC[d.key]??''}`}
                      style={{
                        height:COL_H,cursor:'pointer',verticalAlign:'bottom',
                        borderLeft:bL,
                        background: isHov ? CAT_COLORS[d.cat]+'18' : isSorted ? CAT_COLORS[d.cat]+'0e' : 'transparent',
                        transition:'background .12s',padding:'0 1px 4px',
                      }}
                    >
                      <div style={{
                        writingMode:'vertical-rl',transform:'rotate(180deg)',
                        fontSize:9,whiteSpace:'nowrap',lineHeight:1.2,
                        color: isHov||isSorted ? CAT_COLORS[d.cat] : '#64748b',
                        fontWeight: isSorted ? 700 : 400,
                      }}>
                        {d.label_en}{isSorted?' ↑':''}
                      </div>
                    </th>
                  )
                })}
              </tr>
            )}
          </thead>
          <tbody>
            {rowOrder.map(ri => {
              const seg     = segments[ri]
              const isTheme = ri === themeIdx
              const isHovR  = hovRow === ri
              return (
                <tr key={seg.label}
                  onMouseEnter={() => setHovRow(ri)}
                  onMouseLeave={() => setHovRow(null)}
                  style={{background: isHovR?'#f0f4ff' : isTheme?'#f9fafb':'transparent'}}
                >
                  <td
                    onClick={() => setSelectedRow(ri === selectedRow ? null : ri)}
                    style={{
                      position:'sticky',left:0,zIndex:1,
                      background: ri === selectedRow ? '#ede9fe'
                                : isHovR ? '#e8eeff'
                                : isTheme ? '#f1f5f9' : '#fff',
                      fontWeight: isTheme?700:500,fontSize:11,
                      color: ri === selectedRow ? '#7c3aed'
                           : isTheme ? '#6366f1' : '#334155',
                      textAlign:'center',height:CELL_H,
                      borderBottom:'1px solid #f0f0f0',
                      borderRight: ri === selectedRow ? '2px solid #7c3aed' : '2px solid #e2e8f0',
                      cursor:'pointer',
                      userSelect:'none',
                      transition:'background .1s, color .1s',
                    }}
                    title="Click to view variation profile"
                  >
                    {dispLabel(seg.label)}
                  </td>
                  {visibleDefs.map((d, ci) => {
                    const fullCi  = defs.findIndex(fd => fd.key === d.key)
                    const delta   = deltaMat[ri][fullCi]
                    const raw     = rawMat[ri][fullCi]
                    const isHovC  = hovCol === d.key
                    const prevCat = ci > 0 ? visibleDefs[ci-1].cat : null
                    const bL      = prevCat !== d.cat ? `2px solid ${CAT_COLORS[d.cat]}44` : '1px solid rgba(255,255,255,.3)'
                    return (
                      <td key={d.key}
                        onMouseEnter={() => setHovCol(d.key)}
                        onMouseLeave={() => setHovCol(null)}
                        title={`${d.label_en}\nRaw: ${raw.toFixed(4)}\nΔ z-score: ${delta>0?'+':''}${delta.toFixed(3)}`}
                        style={{
                          background: deltaColor(delta, isTheme),
                          borderLeft:bL,
                          borderBottom:'1px solid rgba(255,255,255,.28)',
                          height:CELL_H,
                          outline: isHovC ? `2px solid ${CAT_COLORS[d.cat]}` : 'none',
                          outlineOffset:-2,
                          transition:'outline .1s',
                          cursor:'default',
                        }}
                      />
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )
}
