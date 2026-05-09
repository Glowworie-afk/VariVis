/**
 * RubatoCurvePage.tsx
 * Rubato (expressive timing deviation) curve.
 * X axis = bar, Y axis = deviation from MIDI template in ms.
 * Positive → performer slows down; negative → rushes.
 * Each variation section is colour-coded.
 */

import { useEffect, useMemo, useState } from 'react'

const API_BASE = 'http://localhost:8000/api'

// ── Palette (13 sections: T + V1–V12) ──────────────────────────────────────
const SEC_COLORS = [
  '#6366f1','#f59e0b','#10b981','#ef4444','#3b82f6',
  '#a855f7','#f97316','#14b8a6','#e11d48','#84cc16',
  '#0ea5e9','#d946ef','#fb923c',
]

// ── Types ───────────────────────────────────────────────────────────────────
interface Beat {
  beat:    number
  bar:     number
  t_midi:  number
  t_audio: number
  dev_ms:  number
  section: string
}

interface Section {
  label:     string
  bar_start: number
  bar_end:   number
  mean_dev:  number
  std_dev:   number
  max_dev:   number
  min_dev:   number
}

interface RubatoData {
  matched:    boolean
  file_name:  string
  beats:      Beat[]
  sections:   Section[]
  var_labels: string[]
  message?:   string
}

// ── dispLabel: convert "T"/"V1" → "T"/"v1" ─────────────────────────────────
function dispLabel(lbl: string): string {
  if (lbl === 'T' || lbl === 'Theme') return 'T'
  const m = lbl.match(/^V(\d+)$/i) || lbl.match(/^Var\.(\d+)$/i)
  if (m) return `v${parseInt(m[1], 10)}`
  return lbl
}

// ── Props ────────────────────────────────────────────────────────────────────
interface Props {
  fileName: string
}

// ── Component ────────────────────────────────────────────────────────────────
export default function RubatoCurvePage({ fileName }: Props) {
  const [data,    setData]    = useState<RubatoData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [hovSec,  setHovSec]  = useState<string | null>(null)

  useEffect(() => {
    setLoading(true); setError(''); setData(null)
    fetch(`${API_BASE}/rubato/${fileName}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [fileName])

  // ── SVG layout ─────────────────────────────────────────────────────────
  const W = 820, H = 260
  const pL = 52, pR = 20, pT = 18, pB = 42

  const chartW = W - pL - pR
  const chartH = H - pT - pB

  const derived = useMemo(() => {
    if (!data?.matched || !data.beats.length) return null
    const devs  = data.beats.map(b => b.dev_ms)
    const maxAbs = Math.max(...devs.map(Math.abs), 50)
    const yMax  = Math.ceil(maxAbs / 50) * 50   // round up to 50ms grid
    const maxBar = data.beats[data.beats.length - 1].bar

    const colorMap: Record<string, string> = {}
    data.var_labels.forEach((lbl, i) => {
      colorMap[lbl] = SEC_COLORS[i % SEC_COLORS.length]
    })

    const xS = (bar: number) => pL + (bar / maxBar) * chartW
    const yS = (dev: number) => pT + chartH / 2 - (dev / yMax) * (chartH / 2)

    return { devs, yMax, maxBar, colorMap, xS, yS }
  }, [data])

  // ── Render ──────────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center',
      height:'100%', color:'#94a3b8', fontSize:13 }}>
      Loading rubato data…
    </div>
  )
  if (error || !data) return (
    <div style={{ padding:16, color:'#ef4444', fontSize:12 }}>{error || 'No data'}</div>
  )
  if (!data.matched) return (
    <div style={{ padding:16, color:'#94a3b8', fontSize:12 }}>{data.message}</div>
  )
  if (!derived) return null

  const { yMax, maxBar, colorMap, xS, yS } = derived
  const { beats, sections, var_labels } = data

  // Y grid lines
  const yTicks = [-yMax, -yMax/2, 0, yMax/2, yMax]

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12, padding:'10px 4px', height:'100%', boxSizing:'border-box' }}>

      {/* Title */}
      <div style={{ fontSize:12, fontWeight:600, color:'#1e293b', paddingLeft:4 }}>
        Rubato Curve
        <span style={{ fontSize:10, fontWeight:400, color:'#94a3b8', marginLeft:8 }}>
          deviation from MIDI template (ms) · +&nbsp;=&nbsp;slower · −&nbsp;=&nbsp;faster
        </span>
      </div>

      {/* SVG */}
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow:'visible', maxWidth: W }}>

        {/* Section background bands */}
        {sections.map((sec, i) => {
          const x0 = xS(sec.bar_start)
          const x1 = xS(sec.bar_end)
          const col = colorMap[sec.label] ?? '#999'
          const isHov = hovSec === sec.label
          return (
            <g key={sec.label}
              onMouseEnter={() => setHovSec(sec.label)}
              onMouseLeave={() => setHovSec(null)}
            >
              <rect x={x0} y={pT} width={x1-x0} height={chartH}
                fill={col} opacity={isHov ? 0.18 : 0.07}
                style={{ cursor:'default', transition:'opacity .1s' }}
              />
              {/* Section divider */}
              {i > 0 && (
                <line x1={x0} y1={pT} x2={x0} y2={pT+chartH}
                  stroke={col} strokeWidth={1} strokeDasharray="3 2" opacity={0.5} />
              )}
              {/* Section label at top */}
              <text x={(x0+x1)/2} y={pT-5} textAnchor="middle"
                fontSize={9} fill={col} fontWeight={isHov ? 700 : 500} opacity={isHov ? 1 : 0.8}>
                {dispLabel(sec.label)}
              </text>
            </g>
          )
        })}

        {/* Y grid lines + labels */}
        {yTicks.map(v => (
          <g key={v}>
            <line x1={pL} y1={yS(v)} x2={pL+chartW} y2={yS(v)}
              stroke={v === 0 ? '#94a3b8' : '#e2e8f0'}
              strokeWidth={v === 0 ? 1.5 : 1}
              strokeDasharray={v === 0 ? '' : '4 3'}
            />
            <text x={pL-6} y={yS(v)+3.5} textAnchor="end"
              fontSize={9} fill="#94a3b8">
              {v > 0 ? `+${v}` : v}
            </text>
          </g>
        ))}

        {/* Rubato curve — polyline coloured per section */}
        {sections.map(sec => {
          const secBeats = beats.filter(b => b.section === sec.label)
          if (secBeats.length < 2) return null
          const pts = secBeats.map(b => `${xS(b.bar).toFixed(1)},${yS(b.dev_ms).toFixed(1)}`).join(' ')
          const col = colorMap[sec.label] ?? '#999'
          const isHov = hovSec === sec.label
          return (
            <polyline key={sec.label} points={pts}
              fill="none" stroke={col}
              strokeWidth={isHov ? 2.2 : 1.5}
              opacity={hovSec && !isHov ? 0.25 : 0.9}
              style={{ transition:'opacity .1s, stroke-width .1s' }}
            />
          )
        })}

        {/* Y axis label */}
        <text x={12} y={pT + chartH/2} textAnchor="middle"
          fontSize={9} fill="#94a3b8"
          transform={`rotate(-90, 12, ${pT + chartH/2})`}>
          deviation (ms)
        </text>

        {/* X axis label */}
        <text x={pL + chartW/2} y={H-4} textAnchor="middle" fontSize={9} fill="#94a3b8">
          bar
        </text>
      </svg>

      {/* Hover tooltip: section stats */}
      {hovSec && (() => {
        const sec = sections.find(s => s.label === hovSec)
        if (!sec) return null
        const col = colorMap[hovSec] ?? '#999'
        return (
          <div style={{
            display:'flex', gap:16, padding:'6px 12px',
            background:'#f8fafc', borderRadius:6, border:`1px solid ${col}44`,
            fontSize:11, color:'#475569', alignSelf:'flex-start',
          }}>
            <span style={{ fontWeight:700, color:col }}>{dispLabel(hovSec)}</span>
            <span>mean <b style={{color:'#1e293b'}}>{sec.mean_dev > 0 ? '+' : ''}{sec.mean_dev} ms</b></span>
            <span>σ <b style={{color:'#1e293b'}}>{sec.std_dev} ms</b></span>
            <span>range <b style={{color:'#1e293b'}}>{sec.min_dev > 0 ? '+' : ''}{sec.min_dev} ~ {sec.max_dev > 0 ? '+' : ''}{sec.max_dev} ms</b></span>
          </div>
        )
      })()}

      {/* Legend */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:'4px 10px', paddingLeft:4 }}>
        {var_labels.map((lbl, i) => (
          <span key={lbl}
            onMouseEnter={() => setHovSec(lbl)}
            onMouseLeave={() => setHovSec(null)}
            style={{
              display:'inline-flex', alignItems:'center', gap:4,
              fontSize:10, color: hovSec === lbl ? '#1e293b' : '#64748b',
              cursor:'default', fontWeight: hovSec === lbl ? 700 : 400,
              transition:'color .1s',
            }}>
            <span style={{ width:10, height:3, borderRadius:2,
              background: SEC_COLORS[i % SEC_COLORS.length],
              display:'inline-block' }} />
            {dispLabel(lbl)}
          </span>
        ))}
      </div>

    </div>
  )
}
