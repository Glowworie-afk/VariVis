/**
 * SymbolicHeatmapPage.tsx  —  33-feature Delta Heatmap
 *
 * Layout (top → bottom, no overlap)
 *   1. Header + legend
 *   2. Tooltip area (240 px fixed)
 *        left  ~185 px  ← feature description panel
 *        right  flex-1  ← FeatureDistChart (width measured via ResizeObserver)
 *   3. Heatmap table (fills container width, no horizontal scroll)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
  matched: boolean; file_name: string; midi_name: string
  segments: SegmentData[]; feature_defs: FeatureDef[]
}
interface AudioSegmentData {
  label: string; audio_features: Record<string, number>
}
interface AudioSymbolicResponse {
  file_name: string
  audio_estimable_keys: string[]
  segments: AudioSegmentData[]
}
interface Props { fileName: string }

// Keys whose audio estimates are reliable enough to display
const AUDIO_ESTIMABLE_KEYS = new Set([
  'pitch_class_entropy',
  'most_common_pc',
  'most_common_pc_prevalence',
  'pitch_variety',
  'tonal_clarity',
  'chromatic_density',
  'note_density',
])

// ── Constants ──────────────────────────────────────────────────────────────

const CAT_COLORS: Record<Cat, string> = {
  P: '#6366f1', M: '#0ea5e9', R: '#10b981', T: '#f59e0b',
}
const CAT_LABEL: Record<Cat, string> = {
  P: 'Pitch', M: 'Melodic', R: 'Rhythmic', T: 'Texture',
}
const CHART_TYPE_LABEL: Record<ChartType, string> = {
  ratio:      '比率型  [0, 1]',
  entropy:    '熵值型  [0, 1]',
  continuous: '连续型  [0, ∞)',
  count:      '整数计数型',
  signed:     '有符号型  [−1, +1]',
}

/** One-line Chinese description for every feature */
const FEAT_DESC: Record<string, string> = {
  // Pitch
  pitch_range:               '最高音与最低音的距离（半音数），反映键盘使用范围。',
  mean_pitch:                '所有音符的平均 MIDI 音高编号，表示旋律重心所在音区。',
  pitch_std:                 '音高分布的离散程度：大=高低来回跳，小=集中在某区。',
  pitch_variety:             '使用了多少种不同音级（最多12个），多=调式色彩丰富。',
  most_common_pc_prevalence: '出现最多的音级占全部音符的比例，高=调性中心感强。',
  pitch_class_entropy:       '12个音级分布的均匀度（归一化熵），高≈无调性。',
  bass_register_ratio:       'MIDI<48（C3以下）的音符占比，高=低音声部活跃。',
  high_register_ratio:       'MIDI>72（C5以上）的音符占比，高=旋律走向高音区。',
  most_common_pc:            '出现频率最高的音级编号（0=C … 11=B）。古典变奏中通常恒为主音。',
  tonal_clarity:             '音级分布与24个大/小调模板的最大 Pearson 相关，越高调性越明确。',
  chromatic_density:         '实际使用的音级数 ÷ 12，越接近1说明半音材料越丰富。',
  interval_class_variety:    '出现了多少种不同的音程类（IC 0–6），钢琴曲通常接近满值。',
  // Melodic
  mean_melodic_interval:     '相邻音符间平均跨度（半音），大=跳进多，小=级进为主。',
  repeated_notes_ratio:      '音程=0（原地重复）的比例，高=鼓点感或吟诵风格。',
  stepwise_ratio:            '音程≤2半音（级进）的比例，高=旋律流畅自然。',
  chromatic_ratio:           '音程=1半音的比例，高=半音化风格，增加表情或紧张感。',
  leap_ratio:                '音程>4半音（跳进）的比例，高=旋律起伏大。',
  large_leap_ratio:          '音程>7半音（大跳，超过纯五度）的比例，高=有戏剧性大跳。',
  direction_of_motion:       '(上行音程数−下行音程数)/(总音程数)，正=整体上行趋势。',
  arpeggiation_ratio:        '三度/五度音程的比例，高=分解和弦、琶音织体风格。',
  melodic_interval_variety:  '使用了多少种不同大小的旋律音程，多=旋律变化丰富。',
  interval_entropy:          '旋律音程分布的均匀度，高=无固定模式，低=反复使用同一音程。',
  // Rhythmic
  note_density:              '每秒音符数，直接反映变奏的快慢疏密程度。',
  mean_note_duration:        '音符平均持续时长（秒），短=快速跑动，长=悠长歌唱。',
  duration_variability:      '时值的变异系数（std/mean），高=长短音符混杂、节奏层次丰富。',
  short_note_ratio:          '时值<中位数×0.5的音符占比，高=大量装饰音或快速跑动。',
  long_note_ratio:           '时值>中位数×2的音符占比，高=有明显保持音或长音。',
  rest_ratio:                '休止占总时长的比例，高=音符稀疏、有呼吸感。',
  rhythmic_value_variety:    '使用了多少种不同时值（0.04s为一档），多=节奏层次丰富。',
  duration_entropy:          '时值分布的均匀度，低=节奏模式固定，高=时值自由混合。',
  // Texture
  max_simultaneous_notes:    '任意时刻最多同时发声的音符数，反映和弦最大厚度（声部数）。',
  mean_simultaneous_notes:   '加权平均同时发声音符数，>1说明有持续的复音/和弦织体。',
  chord_onset_ratio:         '50ms内有多个音符同时起音的起始点占比，高=以和弦演奏为主。',
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
      {/* Category badge */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: c + '18', border: `1px solid ${c}44`,
        borderRadius: 6, padding: '2px 8px', alignSelf: 'flex-start',
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: c }}>{def.cat}</span>
        <span style={{ fontSize: 10, color: c + 'cc' }}>{CAT_LABEL[def.cat]}</span>
      </div>

      {/* Name */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', lineHeight: 1.3 }}>
          {def.label_zh}
        </div>
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
          {def.label_en}
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: '#f1f5f9' }} />

      {/* Description */}
      <div style={{ fontSize: 11, color: '#475569', lineHeight: 1.6, flex: 1 }}>
        {FEAT_DESC[def.key] ?? '—'}
      </div>

      {/* Chart type badge */}
      <div style={{
        fontSize: 10, color: '#94a3b8',
        background: '#f8fafc', borderRadius: 4,
        padding: '2px 6px', alignSelf: 'flex-start',
        border: '1px solid #e2e8f0',
      }}>
        {CHART_TYPE_LABEL[def.chart_type]}
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
  audioValues?: number[]   // audio-estimated values (same length as rawValues), or undefined
}

const AUDIO_ORANGE = '#f97316'

function FeatureDistChart({ def, rawValues, rowLabels, hoveredIdx, svgWidth, audioValues }: ChartProps) {
  const { cat, chart_type: ct } = def
  const cc = CAT_COLORS[cat]
  const n  = rawValues.length

  const mean   = rawValues.reduce((s, v) => s + v, 0) / n
  const std    = Math.sqrt(rawValues.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
  const median = [...rawValues].sort((a, b) => a - b)[Math.floor(n / 2)]

  // Y range includes both MIDI and audio values so the curve fits in the same scale
  const [yMin, yMax] = (() => {
    if (ct === 'signed') {
      const allVals = audioValues ? [...rawValues, ...audioValues] : rawValues
      const mx = Math.max(Math.abs(Math.min(...allVals)), Math.abs(Math.max(...allVals)), 0.05)
      return [-mx * 1.2, mx * 1.2]
    }
    if (ct === 'ratio' || ct === 'entropy') return [0, 1]
    const allVals = audioValues ? [...rawValues, ...audioValues] : rawValues
    return [0, Math.max(...allVals) * 1.18 || 1]
  })()

  const hasAudio = audioValues && audioValues.length === n
  const legendH  = hasAudio ? 13 : 0
  const W = svgWidth, H = 118 + legendH
  const pL = 40, pR = hasAudio ? 56 : 10, pT = 14, pB = 20
  const cW = W - pL - pR, cH = H - pT - pB - legendH
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
    ct === 'ratio'      ? { y: yS(median), color: '#f59e0b', txt: `中位 ${median < 1 ? median.toFixed(2) : median.toFixed(1)}` }
    : ct === 'entropy'  ? { y: yS(mean),   color: '#14b8a6', txt: `均值 ${mean.toFixed(2)}` }
    : ct === 'continuous' ? { y: yS(mean), color: cc,        txt: `均值 ${mean < 1 ? mean.toFixed(2) : mean.toFixed(1)}` }
    : null

  // Build polyline points for audio curve
  const audioPolyline = hasAudio
    ? audioValues!.map((v, i) => `${xC(i).toFixed(1)},${yS(v).toFixed(1)}`).join(' ')
    : ''

  const fmt = (v: number) => ct === 'count' ? Math.round(v).toString() : Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1)

  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      <rect x={pL} y={pT} width={cW} height={cH} fill="#f8fafc" rx={2} />

      {/* SD band for continuous */}
      {ct === 'continuous' && std > 0 && (() => {
        const y1 = Math.max(pT, yS(mean + std))
        const y2 = Math.min(pT + cH, yS(mean - std))
        return <rect x={pL} y={y1} width={cW} height={Math.max(0, y2 - y1)} fill={cc + '18'} />
      })()}

      {/* Zero axis for signed */}
      {ct === 'signed' && <line x1={pL} y1={z0} x2={pL+cW} y2={z0} stroke="#94a3b8" strokeWidth={1.5} />}

      {/* Reference line */}
      {refLine && <>
        <line x1={pL} y1={refLine.y} x2={pL+cW} y2={refLine.y}
          stroke={refLine.color} strokeWidth={1.5} strokeDasharray="5,3" />
        <text x={pL+cW+3} y={refLine.y+4} fontSize={8} fill={refLine.color}>{refLine.txt}</text>
      </>}

      {/* Bars (MIDI values) */}
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

      {/* Audio polyline (drawn on top of bars) */}
      {hasAudio && <>
        <polyline
          points={audioPolyline}
          fill="none"
          stroke={AUDIO_ORANGE}
          strokeWidth={1.8}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {audioValues!.map((v, i) => {
          const hov = i === hoveredIdx
          return (
            <g key={i}>
              <circle cx={xC(i)} cy={yS(v)} r={hov ? 4 : 2.8}
                fill={AUDIO_ORANGE} stroke="#fff" strokeWidth={1} />
              {hov && (
                <text x={xC(i)} y={yS(v) - 6} textAnchor="middle"
                  fontSize={9} fill={AUDIO_ORANGE} fontWeight={700}>
                  {fmt(v)}
                </text>
              )}
            </g>
          )
        })}
        {/* Legend (top-right inside chart area) */}
        <g transform={`translate(${pL + cW + 4}, ${pT + 2})`}>
          <rect x={0} y={0} width={50} height={22} rx={3} fill="white" fillOpacity={0.9} stroke="#e2e8f0" strokeWidth={0.8} />
          <rect x={4} y={6} width={12} height={5} fill={cc + '66'} rx={1} />
          <text x={19} y={11} fontSize={7.5} fill="#64748b">MIDI</text>
          <line x1={4} y1={17} x2={16} y2={17} stroke={AUDIO_ORANGE} strokeWidth={1.8} />
          <circle cx={10} cy={17} r={2} fill={AUDIO_ORANGE} />
          <text x={19} y={20} fontSize={7.5} fill="#64748b">Audio</text>
        </g>
      </>}

      {/* Y axis + ticks */}
      <line x1={pL} y1={pT} x2={pL} y2={pT+cH} stroke="#e2e8f0" />
      {yTicks.map((v, ti) => (
        <g key={ti}>
          <line x1={pL-3} y1={yS(v)} x2={pL} y2={yS(v)} stroke="#e2e8f0" />
          <text x={pL-5} y={yS(v)+3.5} textAnchor="end" fontSize={8} fill="#94a3b8">
            {Math.abs(v) < 1 && v !== 0 ? v.toFixed(2) : v.toFixed(1)}
          </text>
        </g>
      ))}

      {/* X labels */}
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
      悬停列标题查看该特征的分布图
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────

export default function SymbolicHeatmapPage({ fileName }: Props) {
  const [data,      setData]      = useState<SymbolicResponse | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [audioData, setAudioData] = useState<AudioSymbolicResponse | null>(null)
  const [sortCol,   setSortCol]   = useState<string | null>(null)
  const [hovRow,    setHovRow]    = useState<number | null>(null)
  const [hovCol,    setHovCol]    = useState<string | null>(null)
  const [catFilter, setCatFilter] = useState<'All' | Cat>('All')

  // Widths — measured via ref-callbacks so they fire even after a loading early-return
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

  // containerRef still needed for heatmap cell-width calculation
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

  // fetch MIDI symbolic + audio symbolic in parallel
  useEffect(() => {
    if (!fileName) return
    setLoading(true); setError(null); setData(null); setAudioData(null)
    const midiP = fetch(`/api/symbolic/${fileName}`)
      .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e.detail ?? r.statusText) }))
    const audioP = fetch(`/api/symbolic_audio/${fileName}`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
    Promise.all([midiP, audioP])
      .then(([midi, audio]) => {
        setData(midi as SymbolicResponse)
        if (audio) setAudioData(audio as AudioSymbolicResponse)
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [fileName])

  // derived matrices
  const derived = useMemo(() => {
    if (!data) return null
    const { feature_defs: defs, segments } = data
    const labels = segments.map(s => s.label)
    const nR = segments.length, nC = defs.length
    const rawMat: number[][] = segments.map(s => defs.map(d => s.features[d.key] ?? 0))
    const themeIdx = segments.findIndex(s => s.label === 'T')
    const zMat: number[][] = Array.from({length: nR}, () => new Array(nC).fill(0))
    for (let c = 0; c < nC; c++) {
      const zc = zScore(rawMat.map(r => r[c]))
      for (let r = 0; r < nR; r++) zMat[r][c] = zc[r]
    }
    const thZ = themeIdx >= 0 ? zMat[themeIdx] : new Array(nC).fill(0)
    const deltaMat: number[][] = zMat.map((row, ri) =>
      ri === themeIdx ? new Array(nC).fill(0) : row.map((z, ci) => z - thZ[ci])
    )
    // category groups for header
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

  // Build audio lookup: label → feature map
  const audioByLabel = useMemo(() => {
    if (!audioData) return null
    const map: Record<string, Record<string, number>> = {}
    for (const seg of audioData.segments) map[seg.label] = seg.audio_features
    return map
  }, [audioData])

  const tooltip = useMemo(() => {
    if (!derived || !hovCol) return null
    // only show tooltip if hovered column is currently visible
    const visibleKeys = catFilter === 'All' ? derived.defs.map(d => d.key) : derived.defs.filter(d => d.cat === catFilter).map(d => d.key)
    if (!visibleKeys.includes(hovCol)) return null
    const ci = derived.defs.findIndex(d => d.key === hovCol)
    if (ci < 0) return null
    const def = derived.defs[ci]
    // Include audio values only for estimable features
    const audioValues = (audioByLabel && AUDIO_ESTIMABLE_KEYS.has(def.key))
      ? rowOrder.map(ri => audioByLabel[derived.labels[ri]]?.[def.key] ?? 0)
      : undefined
    return {
      def,
      rawValues:  rowOrder.map(ri => derived.rawMat[ri][ci]),
      rowLabels:  rowOrder.map(ri => derived.labels[ri]),
      hoveredIdx: hovRow !== null ? rowOrder.indexOf(hovRow) : null,
      audioValues,
    }
  }, [derived, hovCol, rowOrder, hovRow, catFilter, audioByLabel])

  // ── Render ────────────────────────────────────────────────────────
  if (!fileName) return <div style={{padding:40,color:'#94a3b8'}}>请先选择曲目。</div>
  if (loading)   return (
    <div style={{padding:40,display:'flex',alignItems:'center',gap:10,color:'#94a3b8'}}>
      <div style={{width:18,height:18,border:'2px solid #e2e8f0',borderTopColor:'#6366f1',borderRadius:'50%',animation:'spin .8s linear infinite'}}/>
      正在从 MIDI 提取 33 个符号特征…
    </div>
  )
  if (error) return (
    <div style={{padding:40}}>
      <div style={{color:'#e63946',fontWeight:600}}>提取失败</div>
      <div style={{fontSize:13,color:'#64748b',marginTop:6}}>{error}</div>
    </div>
  )
  if (!derived) return null

  const { defs, segments, deltaMat, rawMat, themeIdx } = derived

  // filter columns by selected category
  const visibleDefs = catFilter === 'All' ? defs : defs.filter(d => d.cat === catFilter)
  // recompute catGroups for visible columns
  const visibleCatGroups: {cat: string; count: number}[] = []
  visibleDefs.forEach(d => {
    const last = visibleCatGroups[visibleCatGroups.length - 1]
    if (!last || last.cat !== d.cat) visibleCatGroups.push({cat: d.cat, count: 1}); else last.count++
  })

  const nCols   = visibleDefs.length
  const ROW_LBL = 40
  const CELL_H  = 16
  const COL_H   = 40
  const showColTitles = catFilter !== 'All'

  return (
    <div ref={containerRef} style={{padding:'6px 10px 8px',fontFamily:'Inter,sans-serif',display:'flex',flexDirection:'column',height:'auto',boxSizing:'border-box',width:'100%'}}>

      {/* ── 1. Header ──────────────────────────────────────────── */}
      <div style={{marginBottom:4}}>
        <div style={{fontSize:15,fontWeight:700,color:'#1e293b'}}>Delta Heatmap — {fileName}</div>
        <div style={{fontSize:11,color:'#94a3b8',marginTop:3}}>
          33 symbolic features · colour = z-score deviation of each variation from theme · click column to sort
        </div>
      </div>

      {/* ── 2. Category filter + colour scale ──────────────── */}
      <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:4,flexWrap:'wrap'}}>
        {/* All button */}
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

      {/* ── 3. Tooltip area ────────────────────────────────────── */}
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
                    audioValues={tooltip.audioValues}
                  />
                )}
              </div>
            </>
          : <Placeholder />
        }
      </div>

      {/* ── 4. Heatmap ─────────────────────────────────────────── */}
      <div style={{flex:'0 0 auto',overflow:'hidden'}}>
        <table style={{borderCollapse:'collapse',tableLayout:'fixed',width:'100%'}}>
          <colgroup>
            <col style={{width:ROW_LBL}}/>
            {visibleDefs.map(d => <col key={d.key}/>)}
          </colgroup>
          <thead>
            {/* Category row — always shown */}
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
            {/* Feature label row — only when a category is selected */}
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
                  <td style={{
                    position:'sticky',left:0,zIndex:1,
                    background: isHovR?'#e8eeff' : isTheme?'#f1f5f9':'#fff',
                    fontWeight: isTheme?700:500,fontSize:11,
                    color: isTheme?'#6366f1':'#334155',
                    textAlign:'center',height:CELL_H,
                    borderBottom:'1px solid #f0f0f0',
                    borderRight:'2px solid #e2e8f0',
                  }}>
                    {seg.label}
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
